// rateLimit middleware — per-IP isolation + loopback bypass (W1.5-redo).
//
// usage-aggregate.ts is mocked at the boundary per the W1.5-redo spec — never
// touch the real logs/usage.jsonl in tests. Distinct client IPs MUST keep
// independent token buckets (gate 1 of the IP-keyed design); loopback bypass
// short-circuits ALL tiers when devBypass=true.

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createRateLimitStore, rateLimit, RATE_LIMITS } from '../../src/middleware/ratelimit.js';
import type { MonthlyAggregate, ReadUsageOpts } from '../../src/ratelimit/usage-aggregate.js';

const ZERO_AGG: MonthlyAggregate = { costUsdGlobal: 0 };

const LOOPBACK_V4 = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;
const LOOPBACK_V6 = { incoming: { socket: { remoteAddress: '::1' } } } as const;
// IPv4-mapped-IPv6 — what Node emits on a dual-stack listener for IPv4 peers.
const LOOPBACK_V6_MAPPED = { incoming: { socket: { remoteAddress: '::ffff:127.0.0.1' } } } as const;
const IP_A = { incoming: { socket: { remoteAddress: '192.0.2.1' } } } as const;
const IP_B = { incoming: { socket: { remoteAddress: '192.0.2.2' } } } as const;

function makeApp(opts: { devBypass?: boolean; now?: () => number; agg?: Partial<MonthlyAggregate> } = {}) {
    const store = createRateLimitStore();
    const app = new Hono();
    const readUsage = vi.fn((_o?: ReadUsageOpts) => ({ ...ZERO_AGG, ...(opts.agg ?? {}) }));
    app.use(
        '/protected',
        rateLimit(store, { readUsage, now: opts.now, devBypass: opts.devBypass ?? false })
    );
    app.post('/protected', (c) => c.json({ ok: true }));
    return { app, store, readUsage };
}

describe('rateLimit middleware — per-IP isolation', () => {
    it('distinct client IPs do not share buckets — IP-A burning minute cap leaves IP-B unaffected', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ now: () => t });

        // IP-A burns its per-minute bucket.
        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            const r = await app.request('/protected', { method: 'POST' }, IP_A);
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ ok: true });
        }
        const refusedA = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await refusedA.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });

        // IP-B is untouched.
        const okB = await app.request('/protected', { method: 'POST' }, IP_B);
        expect(okB.status).toBe(200);
        expect(await okB.json()).toEqual({ ok: true });
    });

    it('per-minute bucket fills, blocks on the 11th, refills monotonically as wall time advances', async () => {
        let now = 1_700_000_000_000;
        const { app } = makeApp({ now: () => now });

        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            const r = await app.request('/protected', { method: 'POST' }, IP_A);
            expect(r.status).toBe(200);
        }
        const breach = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await breach.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });

        // Advance one full minute — bucket refills to capacity.
        now += 60_000;
        const ok = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ ok: true });
    });
});

describe('rateLimit middleware — tier breaches', () => {
    // Note on tier ordering: in v1 (perMinute=10, perHour=60, perDay=30,
    // perMonth=300) the day bucket caps below the hour bucket, so the hour
    // tier is effectively unreachable from a fresh store via burst alone —
    // day always trips first. The month tier likewise sits below sustained
    // day usage across the calendar. The tests below exercise per-day (the
    // binding short-window cap) and probe the month bucket via direct store
    // manipulation, which is the realistic shape an integration test would
    // see (real-world depletion takes calendar days; not feasible to
    // simulate at unit-test speed).
    it('per-day tier trips when the day bucket exhausts', async () => {
        let now = 1_700_000_000_000;
        const { app } = makeApp({ now: () => now });

        // Burst the minute cap, then advance one minute and burst again.
        // After 3 minute-windows we've consumed 30 = perDay; the 31st
        // request trips the day tier. (perDay < perHour in v1, so day
        // trips before hour.)
        for (let i = 0; i < RATE_LIMITS.perDay; i++) {
            const r = await app.request('/protected', { method: 'POST' }, IP_A);
            expect(r.status).toBe(200);
            if ((i + 1) % RATE_LIMITS.perMinute === 0) now += 60_000;
        }
        const refused = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-day' });
    });

    it('per-month tier trips when month bucket is exhausted (direct depletion)', async () => {
        let now = 1_700_000_000_000;
        const { app, store } = makeApp({ now: () => now });

        // Warm the store by issuing one real request so the IpBuckets entry
        // for IP_A exists, then deplete the month bucket directly. The other
        // buckets stay full so the request only fails the month tier — a
        // unit-test stand-in for the real-world shape (sustained per-IP use
        // across multiple days drains month while day refills overnight).
        await app.request('/protected', { method: 'POST' }, IP_A);
        const buckets = store.get('192.0.2.1');
        expect(buckets).toBeDefined();
        buckets!.month.tokens = 0;
        buckets!.minute.tokens = RATE_LIMITS.perMinute;
        buckets!.hour.tokens = RATE_LIMITS.perHour;
        buckets!.day.tokens = RATE_LIMITS.perDay;

        now += 1_000; // monotonic clock advance (no meaningful refill across
                      // a 1s gap given the tier windows).
        const refused = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-month' });
    });
});

describe('rateLimit middleware — loopback bypass', () => {
    it('devBypass=true + 127.0.0.1 short-circuits ALL tiers (100 consecutive requests pass)', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ devBypass: true, now: () => t });

        for (let i = 0; i < 100; i++) {
            const r = await app.request('/protected', { method: 'POST' }, LOOPBACK_V4);
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ ok: true });
        }
    });

    it('devBypass=true + ::1 short-circuits ALL tiers', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ devBypass: true, now: () => t });

        for (let i = 0; i < 50; i++) {
            const r = await app.request('/protected', { method: 'POST' }, LOOPBACK_V6);
            expect(r.status).toBe(200);
        }
    });

    it('devBypass=true + ::ffff:127.0.0.1 (IPv4-mapped form) short-circuits ALL tiers', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ devBypass: true, now: () => t });

        for (let i = 0; i < 50; i++) {
            const r = await app.request('/protected', { method: 'POST' }, LOOPBACK_V6_MAPPED);
            expect(r.status).toBe(200);
        }
    });

    it('devBypass=false + loopback IP still applies the tiers (no bypass)', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ devBypass: false, now: () => t });

        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            await app.request('/protected', { method: 'POST' }, LOOPBACK_V4);
        }
        const refused = await app.request('/protected', { method: 'POST' }, LOOPBACK_V4);
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });
    });

    it('devBypass=true + non-loopback IP still applies the tiers (no bypass)', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ devBypass: true, now: () => t });

        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            await app.request('/protected', { method: 'POST' }, IP_A);
        }
        const refused = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });
    });
});

describe('rateLimit middleware — refuse responses always HTTP 200', () => {
    it('rate-limit refuses use HTTP 200 (not 429)', async () => {
        const t = 1_700_000_000_000;
        const { app } = makeApp({ now: () => t });
        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            await app.request('/protected', { method: 'POST' }, IP_A);
        }
        const res = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(res.status).toBe(200);
    });
});
