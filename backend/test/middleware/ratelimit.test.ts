// rateLimit middleware contract tests (guidelines §3.3).
//
// usage-aggregate.ts is mocked at the boundary per the W1.5 prompt — never
// touch the real logs/usage.jsonl in tests.

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import {
    createRateLimitStore,
    rateLimit,
    RATE_LIMITS,
} from '../../src/middleware/ratelimit.js';
import {
    DEV_BYPASS_CLAIMS,
    DEV_BYPASS_SUB,
    type AuthContext,
} from '../../src/middleware/auth.js';
import type { VerifiedClaims } from '../../src/auth/jwt.js';
import type { DailyAggregate, ReadUsageOpts } from '../../src/ratelimit/usage-aggregate.js';

const ZERO_AGG: DailyAggregate = {
    tokensIn: 0,
    tokensOut: 0,
    costUsdSub: 0,
    costUsdGlobal: 0,
};

function makeClaims(sub: string): VerifiedClaims {
    return {
        sub,
        pubkey: 'PUB_K1_test',
        account: 'duncan',
        permission: 'active',
        chainId: 'cid-1',
        iat: 0,
        exp: 0,
    };
}

function makeApp(opts: {
    sub: string;
    agg?: Partial<DailyAggregate>;
    now?: () => number;
    claims?: VerifiedClaims;
}) {
    const store = createRateLimitStore();
    const app = new Hono<AuthContext>();
    const readUsage = vi.fn((_o: ReadUsageOpts) => ({ ...ZERO_AGG, ...(opts.agg ?? {}) }));
    app.use('*', async (c, next) => {
        c.set('auth', opts.claims ?? makeClaims(opts.sub));
        await next();
    });
    app.use('/protected', rateLimit(store, { readUsage, now: opts.now }));
    app.post('/protected', (c) => c.json({ ok: true }));
    return { app, store, readUsage };
}

describe('rateLimit middleware', () => {
    describe('tier 1 per-minute', () => {
        it('refuses with rate-limit-minute after capacity is exhausted', async () => {
            const t = 1_700_000_000_000;
            const { app } = makeApp({ sub: 'k1:user-a', now: () => t });

            for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
                const ok = await app.request('/protected', { method: 'POST' });
                expect(ok.status).toBe(200);
            }
            const breach = await app.request('/protected', { method: 'POST' });
            expect(breach.status).toBe(200);
            expect(await breach.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });
        });

        it('per-minute refills as wall time advances', async () => {
            let now = 1_700_000_000_000;
            const { app } = makeApp({ sub: 'k1:user-b', now: () => now });

            for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
                await app.request('/protected', { method: 'POST' });
            }
            // Advance one full minute → bucket refills to capacity.
            now += 60_000;
            const ok = await app.request('/protected', { method: 'POST' });
            expect(ok.status).toBe(200);
        });
    });

    describe('tier 4 per-day tokens', () => {
        it('refuses with budget-exceeded when tokens_in hits the cap', async () => {
            const { app } = makeApp({
                sub: 'k1:user-c',
                agg: { tokensIn: RATE_LIMITS.perDayTokensIn },
            });
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ kind: 'refuse', reason: 'budget-exceeded' });
        });

        it('refuses with budget-exceeded when tokens_out hits the cap', async () => {
            const { app } = makeApp({
                sub: 'k1:user-d',
                agg: { tokensOut: RATE_LIMITS.perDayTokensOut },
            });
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ kind: 'refuse', reason: 'budget-exceeded' });
        });
    });

    describe('tier 5 per-pubkey USD', () => {
        it('refuses with budget-exceeded when costUsdSub hits the cap', async () => {
            const { app } = makeApp({
                sub: 'k1:user-e',
                agg: { costUsdSub: RATE_LIMITS.perDayUsdSub },
            });
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ kind: 'refuse', reason: 'budget-exceeded' });
        });

        it('DEV_AUTH_BYPASS sub skips tier 5 even when costUsdSub is over', async () => {
            const { app } = makeApp({
                sub: DEV_BYPASS_SUB,
                claims: DEV_BYPASS_CLAIMS,
                agg: { costUsdSub: RATE_LIMITS.perDayUsdSub * 1000 },
            });
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true });
        });
    });

    describe('tier 6 global $50 cap', () => {
        it('refuses with sponsor-cap when costUsdGlobal hits the cap', async () => {
            const { app } = makeApp({
                sub: 'k1:user-f',
                agg: { costUsdGlobal: RATE_LIMITS.globalDayUsd },
            });
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ kind: 'refuse', reason: 'sponsor-cap' });
        });

        it('global cap applies even under DEV_AUTH_BYPASS (only tier 5 is skipped)', async () => {
            const { app } = makeApp({
                sub: DEV_BYPASS_SUB,
                claims: DEV_BYPASS_CLAIMS,
                agg: { costUsdGlobal: RATE_LIMITS.globalDayUsd },
            });
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ kind: 'refuse', reason: 'sponsor-cap' });
        });
    });

    describe('aggregate reader integration', () => {
        it('treats a missing usage.jsonl as zero (no refuse)', async () => {
            const { app, readUsage } = makeApp({ sub: 'k1:user-g' }); // default ZERO_AGG
            const res = await app.request('/protected', { method: 'POST' });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ ok: true });
            expect(readUsage).toHaveBeenCalledWith(
                expect.objectContaining({ sub: 'k1:user-g' })
            );
        });
    });

    describe('refuse responses are always HTTP 200 (guidelines §3.3 closing)', () => {
        it('rate-limit and budget refuses never use 429', async () => {
            const { app } = makeApp({
                sub: 'k1:user-h',
                agg: { tokensIn: RATE_LIMITS.perDayTokensIn },
            });
            const res = await app.request('/protected', { method: 'POST' });
            // The whole point: never 429. Always 200 so the UI renders a
            // normal chat bubble (no client retry storms).
            expect(res.status).toBe(200);
        });
    });
});
