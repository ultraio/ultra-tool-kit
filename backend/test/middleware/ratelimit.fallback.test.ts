// rateLimit middleware — per-IP fallback path (W9, docs/00 §3.7).
//
// When NO identity is set (unattested, or attestation verification failed and
// fell through), the IP path applies EXACTLY: bucket keyed on the raw IP, sized
// by RATE_LIMITS (10/min). Distinct IPs stay independent. usage-aggregate is
// mocked at the boundary.

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import { createRateLimitStore, rateLimit, RATE_LIMITS } from '../../src/middleware/ratelimit.js';
import type { ReadUsageOpts } from '../../src/ratelimit/usage-aggregate.js';

const NOW = 1_700_000_000_000;
const IP_A = { incoming: { socket: { remoteAddress: '192.0.2.1' } } } as const;
const IP_B = { incoming: { socket: { remoteAddress: '192.0.2.2' } } } as const;

function makeApp() {
    const store = createRateLimitStore();
    const app = new Hono();
    // No identity-setting middleware — every request stays on the per-IP path.
    app.use(
        '/protected',
        rateLimit(store, { readUsage: vi.fn((_o?: ReadUsageOpts) => ({ costUsdGlobal: 0 })), now: () => NOW, devBypass: false })
    );
    app.post('/protected', (c) => c.json({ ok: true }));
    return { app, store };
}

describe('rateLimit middleware — per-IP fallback (no identity)', () => {
    it('per-minute IP tier fires at RATE_LIMITS.perMinute (10, NOT the pubkey 30)', async () => {
        const { app } = makeApp();
        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            const r = await app.request('/protected', { method: 'POST' }, IP_A);
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ ok: true });
        }
        const refused = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });
    });

    it('distinct IPs stay independent', async () => {
        const { app } = makeApp();
        for (let i = 0; i < RATE_LIMITS.perMinute; i++) {
            await app.request('/protected', { method: 'POST' }, IP_A);
        }
        const refusedA = await app.request('/protected', { method: 'POST' }, IP_A);
        expect(await refusedA.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });

        const okB = await app.request('/protected', { method: 'POST' }, IP_B);
        expect(okB.status).toBe(200);
        expect(await okB.json()).toEqual({ ok: true });
    });
});
