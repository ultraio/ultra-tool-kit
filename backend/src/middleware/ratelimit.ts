// Rate limit. Two keying paths share one token-bucket store (docs/00 §3.7).
//
// (A) ATTESTED path — when `c.var.identity` is present (set by the W9
//     attestation middleware), the bucket key is
//     `pubkey:<sha256(identity.pubkey)>` and the looser PUBKEY_RATE_LIMITS
//     tiers apply: 30/min, 200/hr, 200/day, 2000/mo. Pubkey ownership is real
//     Sybil resistance, so an attested caller gets a higher ceiling.
//
// (B) PER-IP path — when no identity is present (unattested, or attestation
//     verification failed and fell through), the bucket key is the raw client
//     IP and the existing RATE_LIMITS tiers apply EXACTLY as before:
//     10/min, 60/hr, 30/day, 300/mo. Behaviour is byte-for-byte unchanged from
//     the pre-W9 per-IP-only limiter.
//
// The global monthly USD sponsor cap (tier 5, $50) binds in BOTH paths.
//
// v1 per-IP is bounded but not Sybil-resistant — a botnet of ~200 distinct
// IPs can drain the $50/month sponsor cap. Wallet-native attestation
// (docs/proposals/wallet-native-attestation.md) is the named upgrade that
// closes this and supplies the attested (A) path above.
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
// Tier order (per-key token buckets in-process, refuse HTTP 200 on breach
// per guidelines §3.3 closing — never 429, avoids client retry storms).
// Per-IP limits shown; per-pubkey limits are the PUBKEY_RATE_LIMITS values:
//   1. Per-minute   →  10 (IP) / 30 (pubkey)    → refuse `rate-limit-minute`
//   2. Per-hour     →  60 (IP) / 200 (pubkey)   → refuse `rate-limit-hour`
//   3. Per-day      →  30 (IP) / 200 (pubkey)   → refuse `rate-limit-day`
//   4. Per-month    → 300 (IP) / 2000 (pubkey)  → refuse `rate-limit-month`
//   5. Global month → $50 USD                   → refuse `sponsor-cap`

import { createHash } from 'node:crypto';

import type { MiddlewareHandler } from 'hono';

import { clientIpOf } from './logging.js';
import type { IdentityVariables } from './attestation.js';
import { readMonthlyAggregate } from '../ratelimit/usage-aggregate.js';

// Exported so tests can assert against the same constants the middleware uses.
export const RATE_LIMITS = {
    perMinute: 10,
    perHour: 60,
    perDay: 30,
    perMonthPerIP: 300,
    globalMonthUsd: 50,
} as const;

// Per-pubkey tiers (W9, docs/00 §3.7). Looser than per-IP because pubkey
// ownership is real Sybil resistance. Exported so tests assert the same
// constants.
export const PUBKEY_RATE_LIMITS = {
    perMinute: 30,
    perHour: 200,
    perDay: 200,
    perMonthPerPubkey: 2000,
} as const;

type Bucket = { tokens: number; lastRefillMs: number };
type IpBuckets = { minute: Bucket; hour: Bucket; day: Bucket; month: Bucket };

// Resolved per-window capacities for one keying path. IP_LIMITS reproduces the
// pre-W9 RATE_LIMITS sizing exactly; PUBKEY_LIMITS sizes the attested path.
type Limits = { perMinute: number; perHour: number; perDay: number; perMonth: number };
const IP_LIMITS: Limits = {
    perMinute: RATE_LIMITS.perMinute,
    perHour: RATE_LIMITS.perHour,
    perDay: RATE_LIMITS.perDay,
    perMonth: RATE_LIMITS.perMonthPerIP,
};
const PUBKEY_LIMITS: Limits = {
    perMinute: PUBKEY_RATE_LIMITS.perMinute,
    perHour: PUBKEY_RATE_LIMITS.perHour,
    perDay: PUBKEY_RATE_LIMITS.perDay,
    perMonth: PUBKEY_RATE_LIMITS.perMonthPerPubkey,
};

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

function getOrCreate(store: RateLimitStore, key: string, now: number, limits: Limits): IpBuckets {
    let buckets = store.get(key);
    if (!buckets) {
        buckets = {
            minute: freshBucket(limits.perMinute, now),
            hour: freshBucket(limits.perHour, now),
            day: freshBucket(limits.perDay, now),
            month: freshBucket(limits.perMonth, now),
        };
        store.set(key, buckets);
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

export function rateLimit(store: RateLimitStore, deps: RatelimitDeps = {}): MiddlewareHandler<IdentityVariables> {
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

        // W9 keying: an attested caller (identity set by the attestation
        // middleware) gets a hashed-pubkey key + the looser PUBKEY_LIMITS;
        // everyone else stays on the raw-IP key + IP_LIMITS (unchanged).
        const identity = c.get('identity');
        const now = clock();
        let key: string;
        let limits: Limits;
        if (identity) {
            key = `pubkey:${createHash('sha256').update(identity.pubkey).digest('hex')}`;
            limits = PUBKEY_LIMITS;
        } else {
            key = ip;
            limits = IP_LIMITS;
        }
        const buckets = getOrCreate(store, key, now, limits);

        // Tiers 1–4 in order — smaller windows first so a per-minute breach
        // short-circuits without draining the hour/day/month buckets.
        const tieredChecks: Array<[Bucket, number, number, RefuseReason]> = [
            [buckets.minute, limits.perMinute, MINUTE_MS, 'rate-limit-minute'],
            [buckets.hour, limits.perHour, HOUR_MS, 'rate-limit-hour'],
            [buckets.day, limits.perDay, DAY_MS, 'rate-limit-day'],
            [buckets.month, limits.perMonth, MONTH_MS, 'rate-limit-month'],
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
