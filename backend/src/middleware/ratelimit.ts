// Two-tier rate limiter — see docs/03-guardrails.md §2 Layer 2.
//
// Tier 1: in-process token bucket (LRU map keyed by `${userId}:${ip}`).
// Tier 2: Postgres aggregate over usage_log filtered by request_kind='chat'.
//
// On exceed, the middleware writes an `incidents` row and replies HTTP 200 with
// a `{ kind: 'refuse', reason: 'rate-limit', detail }` body. We never return 429.

import type { MiddlewareHandler } from 'hono';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { incidents } from '../db/schema.js';
import { logger } from './logging.js';

const LRU_CAP = 1000;

type Bucket = {
    minuteWindowStart: number;
    minuteCount: number;
    hourWindowStart: number;
    hourCount: number;
};

const buckets = new Map<string, Bucket>();

function readNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limits(): { perMinute: number; perHour: number; perDay: number; dailyCostUsd: number } {
    return {
        perMinute: readNumberEnv('RATE_PER_MINUTE', 6),
        perHour: readNumberEnv('RATE_PER_HOUR', 30),
        perDay: readNumberEnv('RATE_TURNS_PER_DAY', 200),
        dailyCostUsd: readNumberEnv('RATE_DAILY_COST_USD', 0.5),
    };
}

function touchLru(key: string, bucket: Bucket): void {
    // Map preserves insertion order; delete + reinsert moves to most-recent.
    buckets.delete(key);
    buckets.set(key, bucket);
    while (buckets.size > LRU_CAP) {
        const oldest = buckets.keys().next();
        if (oldest.done) break;
        buckets.delete(oldest.value);
    }
}

type Tier = 'minute' | 'hour' | 'day' | 'cost';
type Verdict = { ok: true } | { ok: false; tier: Tier };

function checkTier1(key: string, perMinute: number, perHour: number): Verdict {
    const now = Date.now();
    const existing = buckets.get(key);
    const bucket: Bucket = existing ?? {
        minuteWindowStart: now,
        minuteCount: 0,
        hourWindowStart: now,
        hourCount: 0,
    };

    if (now - bucket.minuteWindowStart >= 60_000) {
        bucket.minuteWindowStart = now;
        bucket.minuteCount = 0;
    }
    if (now - bucket.hourWindowStart >= 3_600_000) {
        bucket.hourWindowStart = now;
        bucket.hourCount = 0;
    }

    if (bucket.minuteCount >= perMinute) {
        touchLru(key, bucket);
        return { ok: false, tier: 'minute' };
    }
    if (bucket.hourCount >= perHour) {
        touchLru(key, bucket);
        return { ok: false, tier: 'hour' };
    }

    bucket.minuteCount += 1;
    bucket.hourCount += 1;
    touchLru(key, bucket);
    return { ok: true };
}

async function checkTier2(userId: string, perDay: number, dailyCostUsd: number): Promise<Verdict> {
    const db = getDb();
    const rows = (await db.execute(sql`
        select
          count(*) filter (where created_at > now() - interval '1 day') as turns_today,
          coalesce(sum(cost_usd) filter (where created_at > now() - interval '1 day'), 0) as cost_today
        from usage_log
        where user_id = ${userId} and request_kind = 'chat'
    `)) as unknown as Array<{ turns_today: string | number; cost_today: string | number }>;

    const r = rows[0];
    if (!r) return { ok: true };
    const turns = typeof r.turns_today === 'string' ? Number(r.turns_today) : r.turns_today;
    const cost = typeof r.cost_today === 'string' ? Number(r.cost_today) : r.cost_today;
    if (turns >= perDay) return { ok: false, tier: 'day' };
    if (cost >= dailyCostUsd) return { ok: false, tier: 'cost' };
    return { ok: true };
}

const DETAIL_TEXT: Record<Tier, string> = {
    minute: "You're sending requests too quickly — slow down for a minute.",
    hour: "You've hit the hourly request cap. Try again in a bit.",
    day: "You've hit the daily request cap. Resets at 00:00 UTC.",
    cost: "You've hit the daily AI budget. Resets at 00:00 UTC.",
};

async function recordIncident(userId: string, tier: Tier): Promise<void> {
    try {
        await getDb().insert(incidents).values({ userId, kind: 'rate-limit', detail: { tier } });
    } catch (err) {
        logger.warn(
            { err: err instanceof Error ? err.message : String(err), tier },
            'failed to record rate-limit incident'
        );
    }
}

export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
    const userId = c.get('userId');
    const ip =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        c.req.header('x-real-ip') ??
        'local';
    const key = `${userId}:${ip}`;
    const { perMinute, perHour, perDay, dailyCostUsd } = limits();

    const tier1 = checkTier1(key, perMinute, perHour);
    if (!tier1.ok) {
        await recordIncident(userId, tier1.tier);
        return c.json({ kind: 'refuse', reason: 'rate-limit', detail: DETAIL_TEXT[tier1.tier] }, 200);
    }

    const tier2 = await checkTier2(userId, perDay, dailyCostUsd);
    if (!tier2.ok) {
        await recordIncident(userId, tier2.tier);
        return c.json({ kind: 'refuse', reason: 'rate-limit', detail: DETAIL_TEXT[tier2.tier] }, 200);
    }

    await next();
};

// test-only: clear in-memory bucket state between tests
export function __resetRateLimitState(): void {
    buckets.clear();
}
