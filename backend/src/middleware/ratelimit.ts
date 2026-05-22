// Per-pubkey rate limit (guidelines §3.3) — six tiers, all keyed on `sub`.
//
//   1. Per-minute   →  10 chat turns      → refuse `rate-limit-minute`
//   2. Per-hour     →  60 chat turns      → refuse `rate-limit-hour`
//   3. Per-day      → 500 chat turns      → refuse `rate-limit-day`
//   4. Per-day tokens → 50K in + 12K out  → refuse `budget-exceeded`
//   5. Per-day USD    → $0.10 / pubkey    → refuse `budget-exceeded`
//   6. Global daily   → $50 across subs   → refuse `sponsor-cap`
//
// Tiers 1–3 are in-process token buckets keyed on `sub` (backend/CLAUDE.md
// hard rule 1: no DB; counters lost on restart is acceptable for v1
// single-instance per roadmap §9). Tiers 4–6 read the day's
// logs/usage.jsonl aggregate via the read-only wrapper in
// ratelimit/usage-aggregate.ts — W8 writes the rows.
//
// On breach we ALWAYS reply HTTP 200 with `kind: 'refuse'` (never 429 —
// guidelines §3.3 closing: "avoids client retry storms"). DEV_AUTH_BYPASS
// requests skip tier 5 per §3.4.

import type { MiddlewareHandler } from 'hono';

import { type AuthContext, DEV_BYPASS_SUB } from './auth.js';
import { readDailyAggregate } from '../ratelimit/usage-aggregate.js';

// All tier knobs come from guidelines §3.3 verbatim. Exported so tests can
// assert against the same constants the middleware uses.
export const RATE_LIMITS = {
    perMinute: 10,
    perHour: 60,
    perDay: 500,
    perDayTokensIn: 50_000,
    perDayTokensOut: 12_000,
    perDayUsdSub: 0.1,
    globalDayUsd: 50,
} as const;

type Bucket = { tokens: number; lastRefillMs: number };
type SubBuckets = { minute: Bucket; hour: Bucket; day: Bucket };

function freshBucket(capacity: number, now: number): Bucket {
    return { tokens: capacity, lastRefillMs: now };
}

// Refill rate = capacity / window. We bypass any fancy clock-skew handling:
// the bucket starts full, refills monotonically as wall time advances, and
// caps at `capacity`. `take` returns true iff one token was available, in
// which case it consumes one. Refuse-not-throw: callers branch on the bool.
function take(bucket: Bucket, capacity: number, windowMs: number, now: number): boolean {
    const elapsed = Math.max(0, now - bucket.lastRefillMs);
    const refill = (elapsed * capacity) / windowMs;
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;
    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
    }
    return false;
}

export type RatelimitDeps = {
    readUsage?: typeof readDailyAggregate;
    now?: () => number;
};

type RefuseReason =
    | 'rate-limit-minute'
    | 'rate-limit-hour'
    | 'rate-limit-day'
    | 'budget-exceeded'
    | 'sponsor-cap';

// Single shared store. Lives for the lifetime of the process; cross-process
// limiting is post-v1 per roadmap §9.
export function createRateLimitStore() {
    return new Map<string, SubBuckets>();
}
export type RateLimitStore = ReturnType<typeof createRateLimitStore>;

function getOrCreate(store: RateLimitStore, sub: string, now: number): SubBuckets {
    let buckets = store.get(sub);
    if (!buckets) {
        buckets = {
            minute: freshBucket(RATE_LIMITS.perMinute, now),
            hour: freshBucket(RATE_LIMITS.perHour, now),
            day: freshBucket(RATE_LIMITS.perDay, now),
        };
        store.set(sub, buckets);
    }
    return buckets;
}

export function rateLimit(
    store: RateLimitStore,
    deps: RatelimitDeps = {}
): MiddlewareHandler<AuthContext> {
    const readUsage = deps.readUsage ?? readDailyAggregate;
    const clock = deps.now ?? (() => Date.now());

    return async (c, next) => {
        const auth = c.get('auth');
        // The auth middleware is responsible for attaching `auth` before
        // this runs; if it's missing we treat the request as a bug, not a
        // user-visible refuse — but degrade gracefully rather than throw.
        if (!auth) return c.json({ kind: 'refuse', reason: 'auth-required' }, 401);

        const sub = auth.sub;
        const now = clock();
        const buckets = getOrCreate(store, sub, now);

        // Tier 1–3 in order. Take from the smallest window first so a
        // per-minute breach short-circuits without consuming the hour/day
        // budget.
        const tieredChecks: Array<[Bucket, number, number, RefuseReason]> = [
            [buckets.minute, RATE_LIMITS.perMinute, 60_000, 'rate-limit-minute'],
            [buckets.hour, RATE_LIMITS.perHour, 60 * 60_000, 'rate-limit-hour'],
            [buckets.day, RATE_LIMITS.perDay, 24 * 60 * 60_000, 'rate-limit-day'],
        ];
        for (const [bucket, capacity, windowMs, reason] of tieredChecks) {
            if (!take(bucket, capacity, windowMs, now)) {
                return c.json({ kind: 'refuse', reason }, 200);
            }
        }

        // Tier 4–6 read the daily aggregate. If the file is missing we
        // treat every counter as zero (W8 prompt: "if the file is missing,
        // treat tier 5/6 consumed = $0"). Tier 5 is skipped under
        // DEV_AUTH_BYPASS per §3.4.
        const agg = readUsage({ sub, now: new Date(now) });

        if (agg.tokensIn >= RATE_LIMITS.perDayTokensIn || agg.tokensOut >= RATE_LIMITS.perDayTokensOut) {
            return c.json({ kind: 'refuse', reason: 'budget-exceeded' }, 200);
        }

        if (sub !== DEV_BYPASS_SUB && agg.costUsdSub >= RATE_LIMITS.perDayUsdSub) {
            return c.json({ kind: 'refuse', reason: 'budget-exceeded' }, 200);
        }

        if (agg.costUsdGlobal >= RATE_LIMITS.globalDayUsd) {
            return c.json({ kind: 'refuse', reason: 'sponsor-cap' }, 200);
        }

        await next();
    };
}
