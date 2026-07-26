// GET /api/ai-quota — the caller's current quota + unlock view for the FE badge
// (docs/00 §3.8 cap, §3.7 balance gate). Identity is optional: if an upstream
// attestation middleware set c.var.identity we report the stake-tiered cap and
// the unlock state, else the free floor and unlocked. sessionId comes from the
// query string (this is a GET; no body). Reuses the gate's config + store +
// readers (single source of truth).

import { Hono } from 'hono';

import type { IdentityVariables } from '../middleware/attestation.js';
import type { UsageStore } from '../usage/store.js';
import { type QuotaConfig, dailyCapMicroUsd, nextTier, MICRO } from '../usage/quota-config.js';
import { identityKey } from '../usage/identity.js';

export type AiQuotaDeps = {
    config: QuotaConfig;
    store: UsageStore;
    readStakedUos: (account: string, endpoint: string) => Promise<number>;
    readUosPrice: (endpoint: string) => Promise<number>;
    // Liquid UOS reader (W9 balance gate). Powers the unlock view.
    readUosBalance: (account: string, endpoint: string) => Promise<number>;
    // BALANCE_THRESHOLD_UOS — the unlock minimum (<=0 disables the gate).
    thresholdUos: number;
    now?: () => Date;
};

export function createAiQuotaRouter(deps: AiQuotaDeps): Hono<IdentityVariables> {
    const now = deps.now ?? (() => new Date());
    const app = new Hono<IdentityVariables>();

    app.get('/', async (c) => {
        const identity = c.get('identity');
        const sessionId = c.req.query('sessionId') ?? '';
        const endpoint = c.req.query('endpoint') ?? '';
        const dayUtc = now().toISOString().slice(0, 10);

        const key = identityKey(c, identity);

        let stakedUos = 0;
        let uosPriceUsd = deps.config.priceFallbackUsd;
        let capMicro: number;
        if (identity && !deps.config.disabled) {
            stakedUos = await deps.readStakedUos(identity.account, endpoint);
            uosPriceUsd = await deps.readUosPrice(endpoint);
            capMicro = dailyCapMicroUsd(deps.config, stakedUos, uosPriceUsd);
        } else {
            capMicro = Math.round(deps.config.freeFloorUsd * MICRO);
        }

        // Unlock state (W9 balance gate, docs/00 §3.7): liquid UOS vs threshold.
        // Mirror the gate exactly — anonymous callers and a disabled gate
        // (threshold<=0) do NO read and are never locked; an attested read
        // failure counts as 0 UOS (fail-closed, like balance-gate.ts), so the
        // badge agrees with what a real send would do.
        let heldUos = 0;
        let locked = false;
        if (identity && deps.thresholdUos > 0) {
            try {
                heldUos = await deps.readUosBalance(identity.account, endpoint);
            } catch {
                heldUos = 0;
            }
            locked = heldUos < deps.thresholdUos;
        }

        const spentToday = deps.store.getSpentMicroUsd(key, dayUtc);
        const sessionSpent = sessionId ? deps.store.getSessionMicroUsd(sessionId) : 0;

        return c.json(
            {
                spentTodayUsd: spentToday / MICRO,
                dailyCapUsd: capMicro / MICRO,
                stakedUos,
                uosPriceUsd,
                sessionSpentUsd: sessionSpent / MICRO,
                nextTier: nextTier(deps.config, uosPriceUsd),
                heldUos,
                thresholdUos: deps.thresholdUos,
                locked,
            },
            200
        );
    });

    return app;
}
