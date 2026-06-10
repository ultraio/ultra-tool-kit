import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAiQuotaRouter } from '../../src/routes/ai-quota.js';
import { InMemoryUsageStore } from '../../src/usage/store.js';
import { readQuotaConfig } from '../../src/usage/quota-config.js';
import type { IdentityVariables } from '../../src/middleware/attestation.js';

const CFG = readQuotaConfig({
    QUOTA_RATE_PER_DAY: '0.02',
    QUOTA_FREE_FLOOR_USD: '0.01',
    QUOTA_MAX_CAP_USD: '1.00',
});

// Response.json() is `unknown` under strict TS; tests assert on parsed bodies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

function mount(store: InMemoryUsageStore, identity?: object) {
    const app = new Hono<IdentityVariables>();
    if (identity)
        app.use('/api/ai-quota', async (c, next) => {
            c.set('identity', identity as never);
            await next();
        });
    app.route(
        '/api/ai-quota',
        createAiQuotaRouter({
            config: CFG,
            store,
            readStakedUos: async () => 500,
            readUosPrice: async () => 0.02,
            now: () => new Date('2026-06-09T12:00:00Z'),
        })
    );
    return app;
}

describe('GET /api/ai-quota', () => {
    it('reports the free floor for an unattested caller', async () => {
        const res = await mount(new InMemoryUsageStore()).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(res.status).toBe(200);
        expect(b.dailyCapUsd).toBe(0.01);
        expect(b.stakedUos).toBe(0);
        expect(b.spentTodayUsd).toBe(0);
    });

    it('reports the stake-tiered cap for an attested staker', async () => {
        const res = await mount(new InMemoryUsageStore(), {
            account: 'whale',
            pubkey: 'P',
            permission: 'active',
            signableAccounts: [],
        }).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        // 500 UOS * $0.02 = $10 staked → $0.20/day
        expect(b.stakedUos).toBe(500);
        expect(b.dailyCapUsd).toBe(0.2);
    });

    it('reflects spend already accumulated for the identity key', async () => {
        const store = new InMemoryUsageStore();
        store.addSpentMicroUsd('acct:whale', '2026-06-09', 50_000); // $0.05
        const res = await mount(store, {
            account: 'whale',
            pubkey: 'P',
            permission: 'active',
            signableAccounts: [],
        }).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(b.spentTodayUsd).toBe(0.05);
    });
});
