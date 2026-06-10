import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { quotaGate, type QuotaGateDeps } from '../../src/middleware/quota-gate.js';
import type { AttestedIdentity, IdentityVariables } from '../../src/middleware/attestation.js';
import { InMemoryUsageStore } from '../../src/usage/store.js';
import { readQuotaConfig } from '../../src/usage/quota-config.js';

const CFG = readQuotaConfig({
    QUOTA_RATE_PER_DAY: '0.02',
    QUOTA_FREE_FLOOR_USD: '0.01',
    QUOTA_MAX_CAP_USD: '1.00',
    QUOTA_SESSION_CAP_USD: '0.25',
});

// A handler that simulates a chat turn costing `costUsd` by setting the same
// c.var fields the real ai-chat route sets, then replying like the route does.
function chatHandlerSetting(costUsd: number) {
    return async (c: any) => {
        c.set('providerModel', 'anthropic:haiku-4-5');
        // 0 input + N output tokens chosen so computeCostUsd ≈ costUsd:
        // cost = out/1e6 * 5.0 (haiku-4-5 out rate)  → out = costUsd/5 * 1e6
        c.set('lastUsage', { input: 0, output: Math.round((costUsd / 5.0) * 1_000_000) });
        return c.json({ reply: { kind: 'answer', text: 'hi' }, usage: {} }, 200);
    };
}

function makeApp(deps: QuotaGateDeps, costUsd: number) {
    const app = new Hono();
    app.use('/api/ai-chat', quotaGate(deps));
    app.post('/api/ai-chat', chatHandlerSetting(costUsd));
    return app;
}

// Loosely-typed body reader: res.json() is `unknown` under strict TS, and these
// assertions access nested properties. Test-only `any`, justified per backend/CLAUDE.md.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

function post(app: Hono, body: object, identity?: AttestedIdentity) {
    const app2 = app;
    // Inject identity the way the attestation middleware would (c.var.identity).
    // Same Hono<IdentityVariables> pattern as balance-gate.test.ts.
    const withIdentity = new Hono<IdentityVariables>();
    if (identity)
        withIdentity.use('/api/ai-chat', async (c, next) => {
            c.set('identity', identity);
            await next();
        });
    withIdentity.route('/', app2);
    return withIdentity.request('/api/ai-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('quotaGate', () => {
    it('is a no-op when disabled (no reads, no refuse)', async () => {
        const cfg = { ...CFG, disabled: true };
        const readStakedUos = vi.fn();
        const readUosPrice = vi.fn();
        const app = makeApp({ config: cfg, store: new InMemoryUsageStore(), readStakedUos, readUosPrice }, 0.001);
        const res = await post(app, { sessionId: 's1', messages: [] });
        expect(res.status).toBe(200);
        expect((await json(res)).reply.kind).toBe('answer');
        expect(readStakedUos).not.toHaveBeenCalled();
        expect(readUosPrice).not.toHaveBeenCalled();
    });

    it('allows an unattested caller under the free floor, then accumulates cost', async () => {
        const store = new InMemoryUsageStore();
        const app = makeApp(
            {
                config: CFG,
                store,
                readStakedUos: async () => 0,
                readUosPrice: async () => 0.02,
                now: () => new Date('2026-06-09T00:00:00Z'),
            },
            0.003
        );
        const res = await post(app, { sessionId: 's1', messages: [] });
        expect(res.status).toBe(200);
        expect((await json(res)).reply.kind).toBe('answer');
        // $0.003 → 3000 micro-USD accumulated on the ip: key.
        // (key is ip:<hash> — assert via a follow-up over-cap refuse instead.)
    });

    it('refuses with quota-daily once the free-floor cap is reached', async () => {
        const store = new InMemoryUsageStore();
        const deps: QuotaGateDeps = {
            config: CFG,
            store,
            readStakedUos: async () => 0,
            readUosPrice: async () => 0.02,
            now: () => new Date('2026-06-09T12:00:00Z'),
        };
        // Free floor = $0.01 = 10000 micro. First turn costs $0.009 (under), second is blocked.
        const app1 = makeApp(deps, 0.009);
        await post(app1, { sessionId: 's1', messages: [] }); // spends 9000 micro on ip:key
        const app2 = makeApp(deps, 0.009); // same store/deps
        const res = await post(app2, { sessionId: 's2', messages: [] }); // 9000 ≥ 10000? no → allowed
        expect((await json(res)).reply.kind).toBe('answer'); // 9000 < 10000, still under
        const app3 = makeApp(deps, 0.009);
        const res3 = await post(app3, { sessionId: 's3', messages: [] }); // now 18000 ≥ 10000 → refuse
        const body3 = await json(res3);
        expect(res3.status).toBe(200);
        // Bare Reply shape — same as ratelimit.ts / balance-gate.ts refuses.
        expect(body3.kind).toBe('refuse');
        expect(body3.reason).toBe('quota-daily');
        expect(body3.quota.capUsd).toBe(0.01);
    });

    it('gives an attested staker a higher cap', async () => {
        const store = new InMemoryUsageStore();
        const readStakedUos = vi.fn(async () => 500); // 500 UOS
        const deps: QuotaGateDeps = {
            config: CFG,
            store,
            readStakedUos, // → $10 staked → $0.20/day cap
            readUosPrice: async () => 0.02,
            now: () => new Date('2026-06-09T12:00:00Z'),
        };
        const identity = { account: 'whale', pubkey: 'PUB', permission: 'active', signableAccounts: [] };

        // Turn 1: $0.05 < $0.20 cap → allowed
        const app1 = makeApp(deps, 0.05);
        const res1 = await post(app1, { sessionId: 's1', messages: [] }, identity);
        expect((await json(res1)).reply.kind).toBe('answer');
        expect(readStakedUos).toHaveBeenCalledWith('whale', expect.anything());

        // After turn 1: acct:whale key holds 50_000 micro ($0.05).
        // Turn 2: $0.05 more = 100_000 micro total.
        // At free floor (10_000): 100_000 ≥ 10_000 → would refuse.
        // Under $0.20 cap (200_000): 100_000 < 200_000 → must still be 'answer'.
        const app2 = makeApp(deps, 0.05);
        const res2 = await post(app2, { sessionId: 's2', messages: [] }, identity);
        const body2 = await json(res2);
        expect(body2.reply.kind).toBe('answer'); // stake-tiered cap allowed it
    });

    it('refuses with quota-session when the session soft cap is hit', async () => {
        const store = new InMemoryUsageStore();
        // Pre-load the session over the $0.25 cap.
        store.addSessionMicroUsd('s1', 300_000); // $0.30 > $0.25
        const deps: QuotaGateDeps = {
            config: CFG,
            store,
            readStakedUos: async () => 0,
            readUosPrice: async () => 0.02,
            now: () => new Date('2026-06-09T12:00:00Z'),
        };
        const app = makeApp(deps, 0.001);
        const res = await post(app, { sessionId: 's1', messages: [] });
        const body = await json(res);
        expect(body.kind).toBe('refuse');
        expect(body.reason).toBe('quota-session');
    });
});
