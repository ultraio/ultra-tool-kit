// GET /api/ai-quota — the caller's current quota view for the FE badge
// (docs/00 §3.8). Identity is optional: if an upstream attestation middleware
// set c.var.identity we report the stake-tiered cap, else the free floor.
// sessionId comes from the query string (this is a GET; no body).
// Reuses the gate's config + store + readers (single source of truth).

import { createHash } from 'node:crypto';
import { Hono } from 'hono';

import { clientIpOf } from '../middleware/logging.js';
import type { IdentityVariables } from '../middleware/attestation.js';
import type { UsageStore } from '../usage/store.js';
import { type QuotaConfig, dailyCapMicroUsd, MICRO } from '../usage/quota-config.js';

export type AiQuotaDeps = {
    config: QuotaConfig;
    store: UsageStore;
    readStakedUos: (account: string, endpoint: string) => Promise<number>;
    readUosPrice: (endpoint: string) => Promise<number>;
    now?: () => Date;
};

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

export function createAiQuotaRouter(deps: AiQuotaDeps): Hono<IdentityVariables> {
    const now = deps.now ?? (() => new Date());
    const app = new Hono<IdentityVariables>();

    app.get('/', async (c) => {
        const identity = c.get('identity');
        const sessionId = c.req.query('sessionId') ?? '';
        const endpoint = c.req.query('endpoint') ?? '';
        const dayUtc = now().toISOString().slice(0, 10);

        const key = identity ? `acct:${identity.account}` : `ip:${sha256Hex(clientIpOf(c) ?? 'unknown')}`;

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

        const spentToday = deps.store.getSpentMicroUsd(key, dayUtc);
        const sessionSpent = sessionId ? deps.store.getSessionMicroUsd(sessionId) : 0;

        return c.json(
            {
                spentTodayUsd: spentToday / MICRO,
                dailyCapUsd: capMicro / MICRO,
                stakedUos,
                uosPriceUsd,
                sessionSpentUsd: sessionSpent / MICRO,
                nextTier: {
                    stakeUosForMax:
                        uosPriceUsd > 0
                            ? Math.ceil(deps.config.maxCapUsd / (uosPriceUsd * deps.config.ratePerDay))
                            : null,
                    maxDailyUsd: deps.config.maxCapUsd,
                },
            },
            200
        );
    });

    return app;
}
