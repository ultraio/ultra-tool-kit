// rateLimit middleware — monthly aggregate / sponsor-cap tier (W1.5-redo).
//
// usage-aggregate.ts is mocked at the boundary. Asserts the global $50/month
// cap fires when costUsdGlobal hits the ceiling, and confirms the read-usage
// predicate now receives `{ now: Date }` only (no `sub` — anonymous backend).

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createRateLimitStore, rateLimit, RATE_LIMITS } from '../../src/middleware/ratelimit.js';
import type { MonthlyAggregate, ReadUsageOpts } from '../../src/ratelimit/usage-aggregate.js';

const IP_A = { incoming: { socket: { remoteAddress: '192.0.2.1' } } } as const;

function makeApp(agg: MonthlyAggregate) {
    const store = createRateLimitStore();
    const app = new Hono();
    const readUsage = vi.fn((_o?: ReadUsageOpts) => agg);
    app.use('/protected', rateLimit(store, { readUsage }));
    app.post('/protected', (c) => c.json({ ok: true }));
    return { app, readUsage };
}

describe('rateLimit middleware — global month USD cap', () => {
    it('passes when costUsdGlobal is below the cap', async () => {
        const { app } = makeApp({ costUsdGlobal: RATE_LIMITS.globalMonthUsd - 0.01 });
        const res = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
    });

    it('refuses with sponsor-cap when costUsdGlobal hits the cap exactly', async () => {
        const { app } = makeApp({ costUsdGlobal: RATE_LIMITS.globalMonthUsd });
        const res = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'sponsor-cap' });
    });

    it('refuses with sponsor-cap when costUsdGlobal exceeds the cap', async () => {
        const { app } = makeApp({ costUsdGlobal: RATE_LIMITS.globalMonthUsd + 1 });
        const res = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'sponsor-cap' });
    });

    it('readUsage receives `{ now: Date }` (no sub — anonymous backend)', async () => {
        const { app, readUsage } = makeApp({ costUsdGlobal: 0 });
        await app.request('/protected', { method: 'POST' }, IP_A);
        expect(readUsage).toHaveBeenCalled();
        const opts = readUsage.mock.calls[0]![0];
        expect(opts).toBeDefined();
        expect(opts!.now).toBeInstanceOf(Date);
        // No `sub` field on the new opts shape.
        expect((opts as Record<string, unknown>).sub).toBeUndefined();
    });
});
