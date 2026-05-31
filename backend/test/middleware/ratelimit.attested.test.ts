// rateLimit middleware — attested per-pubkey path (W9, docs/00 §3.7).
//
// When c.var.identity is set, the bucket is keyed on sha256(pubkey) and sized
// by PUBKEY_RATE_LIMITS (looser than per-IP). Distinct pubkeys keep independent
// buckets; the same pubkey across distinct IPs shares ONE bucket (keyed on
// pubkey, not IP). usage-aggregate is mocked at the boundary.

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

import {
    createRateLimitStore,
    rateLimit,
    PUBKEY_RATE_LIMITS,
} from '../../src/middleware/ratelimit.js';
import type { ReadUsageOpts } from '../../src/ratelimit/usage-aggregate.js';

const NOW = 1_700_000_000_000;
const IP_1 = { incoming: { socket: { remoteAddress: '192.0.2.1' } } } as const;
const IP_2 = { incoming: { socket: { remoteAddress: '192.0.2.2' } } } as const;

function makeApp() {
    const store = createRateLimitStore();
    const app = new Hono();
    app.use('/protected', async (c, n) => {
        const pk = c.req.header('x-test-pubkey');
        if (pk) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (c as any).set('identity', { pubkey: pk, account: 'a', permission: 'active', signableAccounts: [] });
        }
        await n();
    });
    app.use(
        '/protected',
        rateLimit(store, { readUsage: vi.fn((_o?: ReadUsageOpts) => ({ costUsdGlobal: 0 })), now: () => NOW, devBypass: false })
    );
    app.post('/protected', (c) => c.json({ ok: true }));
    return { app, store };
}

describe('rateLimit middleware — attested per-pubkey path', () => {
    it('per-pubkey minute tier fires at PUBKEY_RATE_LIMITS.perMinute (30, not the IP 10)', async () => {
        const { app } = makeApp();
        for (let i = 0; i < PUBKEY_RATE_LIMITS.perMinute; i++) {
            const r = await app.request('/protected', { method: 'POST', headers: { 'x-test-pubkey': 'PKA' } }, IP_1);
            expect(r.status).toBe(200);
            expect(await r.json()).toEqual({ ok: true });
        }
        const refused = await app.request(
            '/protected',
            { method: 'POST', headers: { 'x-test-pubkey': 'PKA' } },
            IP_1
        );
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });
    });

    it('distinct pubkeys do not share buckets', async () => {
        const { app } = makeApp();
        for (let i = 0; i < PUBKEY_RATE_LIMITS.perMinute; i++) {
            await app.request('/protected', { method: 'POST', headers: { 'x-test-pubkey': 'PKA' } }, IP_1);
        }
        const refusedA = await app.request(
            '/protected',
            { method: 'POST', headers: { 'x-test-pubkey': 'PKA' } },
            IP_1
        );
        expect(await refusedA.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });

        // PKB is untouched.
        const okB = await app.request('/protected', { method: 'POST', headers: { 'x-test-pubkey': 'PKB' } }, IP_1);
        expect(okB.status).toBe(200);
        expect(await okB.json()).toEqual({ ok: true });
    });

    it('same pubkey across distinct IPs shares one bucket (keyed on sha256(pubkey), not IP)', async () => {
        const { app, store } = makeApp();
        // Alternate IPs but keep the same pubkey PKC. After 30 total the next
        // is refused regardless of source IP — proves bucket is pubkey-keyed.
        for (let i = 0; i < PUBKEY_RATE_LIMITS.perMinute; i++) {
            const env = i % 2 === 0 ? IP_1 : IP_2;
            const r = await app.request('/protected', { method: 'POST', headers: { 'x-test-pubkey': 'PKC' } }, env);
            expect(r.status).toBe(200);
        }
        const refused = await app.request(
            '/protected',
            { method: 'POST', headers: { 'x-test-pubkey': 'PKC' } },
            IP_2
        );
        expect(await refused.json()).toEqual({ kind: 'refuse', reason: 'rate-limit-minute' });

        // The bucket is keyed on `pubkey:<sha256(pubkey)>` (§3.7) — NOT the raw
        // pubkey and NOT either IP. This pins the hashing so a regression to a
        // raw-pubkey key (or IP key) is caught.
        const hashedKey = `pubkey:${createHash('sha256').update('PKC').digest('hex')}`;
        expect(store.has(hashedKey)).toBe(true);
        expect(store.has('PKC')).toBe(false);
        expect(store.has('192.0.2.1')).toBe(false);
        expect(store.has('192.0.2.2')).toBe(false);
    });
});
