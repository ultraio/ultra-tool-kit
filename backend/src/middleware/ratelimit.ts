// PER-IP rate limit. Identity model documented in docs/00 §3.
//
// v1 is bounded but not Sybil-resistant — a botnet of ~200 distinct
// IPs can drain the $50/month sponsor cap. Wallet-native attestation
// (docs/proposals/wallet-native-attestation.md) is the named upgrade
// that closes this.
//
// Loopback bypass for local dev: DEV_RATELIMIT_BYPASS=true + 127.0.0.1/::1
// short-circuits ALL tiers. Production = CI grep failure (ai-ci-greps.sh #5).
//
// Hosted deploy WARNING: clientIpOf() reads the connection-level remote
// address. v1 binds loopback only so this is trustworthy. When hosted-deploy
// lands, this MUST be replaced with a trusted-proxy header read
// (CF-Connecting-IP for Cloudflare). Trusting X-Forwarded-For naively
// allows trivial per-request IP spoofing.
//
// Tier order (per-IP token buckets in-process, refuse HTTP 200 on breach
// per guidelines §3.3 closing — never 429, avoids client retry storms):
//   1. Per-minute   →  10 requests   → refuse `rate-limit-minute`
//   2. Per-hour     →  60 requests   → refuse `rate-limit-hour`
//   3. Per-day      →  30 requests   → refuse `rate-limit-day`
//   4. Per-month    → 300 requests   → refuse `rate-limit-month`
//   5. Global month → $50 USD        → refuse `sponsor-cap`

import type { MiddlewareHandler } from 'hono';

import { clientIpOf } from './logging.js';
import { readMonthlyAggregate } from '../ratelimit/usage-aggregate.js';

// Exported so tests can assert against the same constants the middleware uses.
export const RATE_LIMITS = {
    perMinute: 10,
    perHour: 60,
    perDay: 30,
    perMonthPerIP: 300,
    globalMonthUsd: 50,
} as const;

type Bucket = { tokens: number; lastRefillMs: number };
type IpBuckets = { minute: Bucket; hour: Bucket; day: Bucket; month: Bucket };

// Loopback addresses we treat as "this machine" for DEV_RATELIMIT_BYPASS.
// IPv6 includes the mapped form (`::ffff:127.0.0.1`) that Node emits for IPv4
// sockets when the listener is dual-stack.
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(addr: string | undefined): boolean {
    return addr !== undefined && LOOPBACK_ADDRS.has(addr);
}

function freshBucket(capacity: number, now: number): Bucket {
    return { tokens: capacity, lastRefillMs: now };
}

// Refill rate = capacity / window. The bucket starts full, refills
// monotonically as wall time advances, and caps at `capacity`. `take` returns
// true iff one token was available, in which case it consumes one.
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
    readUsage?: typeof readMonthlyAggregate;
    now?: () => number;
    devBypass?: boolean;
};

type RefuseReason =
    | 'rate-limit-minute'
    | 'rate-limit-hour'
    | 'rate-limit-day'
    | 'rate-limit-month'
    | 'sponsor-cap';

// Single shared store. Lives for the lifetime of the process; cross-process
// limiting is post-v1 per roadmap §9.
export function createRateLimitStore() {
    return new Map<string, IpBuckets>();
}
export type RateLimitStore = ReturnType<typeof createRateLimitStore>;

function getOrCreate(store: RateLimitStore, ip: string, now: number): IpBuckets {
    let buckets = store.get(ip);
    if (!buckets) {
        buckets = {
            minute: freshBucket(RATE_LIMITS.perMinute, now),
            hour: freshBucket(RATE_LIMITS.perHour, now),
            day: freshBucket(RATE_LIMITS.perDay, now),
            month: freshBucket(RATE_LIMITS.perMonthPerIP, now),
        };
        store.set(ip, buckets);
    }
    return buckets;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS; // Approximate; the calendar-month boundary is
                              // enforced by the sponsor-cap aggregate, not by
                              // the token bucket. 30d is the bucket refill
                              // window — close enough for a per-IP soft cap.

export function rateLimit(store: RateLimitStore, deps: RatelimitDeps = {}): MiddlewareHandler {
    const readUsage = deps.readUsage ?? readMonthlyAggregate;
    const clock = deps.now ?? (() => Date.now());
    const devBypass = deps.devBypass ?? false;

    return async (c, next) => {
        const ip = clientIpOf(c) ?? 'unknown';

        // Local-dev short-circuit. NEVER fires in production: the env-var
        // gate is loopback-bound and committing `DEV_RATELIMIT_BYPASS=true`
        // to .env* is a CI grep failure (ai-ci-greps.sh #5).
        if (devBypass && isLoopback(ip)) {
            await next();
            return;
        }

        const now = clock();
        const buckets = getOrCreate(store, ip, now);

        // Tiers 1–4 in order — smaller windows first so a per-minute breach
        // short-circuits without draining the hour/day/month buckets.
        const tieredChecks: Array<[Bucket, number, number, RefuseReason]> = [
            [buckets.minute, RATE_LIMITS.perMinute, MINUTE_MS, 'rate-limit-minute'],
            [buckets.hour, RATE_LIMITS.perHour, HOUR_MS, 'rate-limit-hour'],
            [buckets.day, RATE_LIMITS.perDay, DAY_MS, 'rate-limit-day'],
            [buckets.month, RATE_LIMITS.perMonthPerIP, MONTH_MS, 'rate-limit-month'],
        ];
        for (const [bucket, capacity, windowMs, reason] of tieredChecks) {
            if (!take(bucket, capacity, windowMs, now)) {
                return c.json({ kind: 'refuse', reason }, 200);
            }
        }

        // Tier 5 — global month USD cap. Read from logs/usage.jsonl via the
        // wrapped aggregate. Missing file → $0 consumed.
        const agg = readUsage({ now: new Date(now) });
        if (agg.costUsdGlobal >= RATE_LIMITS.globalMonthUsd) {
            return c.json({ kind: 'refuse', reason: 'sponsor-cap' }, 200);
        }

        await next();
    };
}
