// Per-identity daily cost-cap gate (docs/00 §3.8). Straddles the chat handler:
//   BEFORE next(): resolve identity → dailyCap; refuse if today's spend ≥ cap
//                  (or the session soft cap is hit).
//   AFTER next():  read the turn's cost from c.var and accumulate it.
// Mirrors balance-gate.ts (identity read, QUOTA_DISABLED no-op) and
// usage-log.ts (body clone for sessionId; c.var.lastUsage/providerModel in
// finally; computeCostUsd). Refuses HTTP 200 with the BARE Reply shape
// { kind: 'refuse', reason, quota } — same as ratelimit.ts / balance-gate.ts
// (never 429, §3.2); the FE's aiClient parse() accepts bare Reply bodies.
//
// Order: mounted AFTER attestation + balance-gate + ratelimit + usageLog, so a
// rate-limited or balance-refused request never reaches the cap logic, and the
// usage-log row is still written for a quota refuse (cost 0, no providerModel).

import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';

import { clientIpOf } from './logging.js';
import type { IdentityVariables } from './attestation.js';
import type { UsageStore } from '../usage/store.js';
import { type QuotaConfig, dailyCapMicroUsd, MICRO } from '../usage/quota-config.js';
import { computeCostUsd } from './usage-log.js';

export type QuotaGateDeps = {
    config: QuotaConfig;
    store: UsageStore;
    readStakedUos: (account: string, endpoint: string) => Promise<number>;
    readUosPrice: (endpoint: string) => Promise<number>;
    now?: () => Date; // default new Date()
};

type QuotaVars = IdentityVariables & {
    Variables: {
        providerModel?: string;
        lastUsage?: { input: number; output: number };
    };
};

function sha256Hex(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

// Drain a clone of the body for { sessionId, context.endpoint }. Mirrors
// usage-log.ts / balance-gate.ts — never consumes the handler's stream.
async function bodyBits(c: Context): Promise<{ sessionId: string; endpoint: string }> {
    try {
        const cloned = c.req.raw.clone();
        const b = (await cloned.json()) as { sessionId?: string; context?: { endpoint?: string } };
        return {
            sessionId: typeof b.sessionId === 'string' ? b.sessionId : '',
            endpoint: typeof b.context?.endpoint === 'string' ? b.context.endpoint : '',
        };
    } catch {
        return { sessionId: '', endpoint: '' };
    }
}

export function quotaGate(deps: QuotaGateDeps): MiddlewareHandler<QuotaVars> {
    const now = deps.now ?? (() => new Date());

    return async (c, next) => {
        if (deps.config.disabled) {
            await next();
            return;
        }

        const identity = c.get('identity');
        const { sessionId, endpoint } = await bodyBits(c);
        const dayUtc = now().toISOString().slice(0, 10);

        // Identity key: verified attested account, else hashed client IP.
        const key = identity ? `acct:${identity.account}` : `ip:${sha256Hex(clientIpOf(c) ?? 'unknown')}`;

        // Cap: attested → stake-tiered; unattested → free floor (no reads).
        let capMicro: number;
        let stakedUos = 0;
        let uosPriceUsd = deps.config.priceFallbackUsd;
        if (identity) {
            stakedUos = await deps.readStakedUos(identity.account, endpoint);
            uosPriceUsd = await deps.readUosPrice(endpoint);
            capMicro = dailyCapMicroUsd(deps.config, stakedUos, uosPriceUsd);
        } else {
            capMicro = Math.round(deps.config.freeFloorUsd * MICRO);
        }

        const spentToday = deps.store.getSpentMicroUsd(key, dayUtc);
        const sessionSpent = sessionId ? deps.store.getSessionMicroUsd(sessionId) : 0;
        const sessionCapMicro = Math.round(deps.config.sessionCapUsd * MICRO);

        const quotaBody = (reason: 'quota-daily' | 'quota-session') => ({
            kind: 'refuse' as const,
            reason,
            quota: {
                spentUsd: spentToday / MICRO,
                capUsd: capMicro / MICRO,
                stakedUos,
                uosPriceUsd,
                nextTier: {
                    stakeUosForMax:
                        uosPriceUsd > 0
                            ? Math.ceil(deps.config.maxCapUsd / (uosPriceUsd * deps.config.ratePerDay))
                            : null,
                    maxDailyUsd: deps.config.maxCapUsd,
                },
            },
        });

        if (sessionId && sessionSpent >= sessionCapMicro) {
            return c.json(quotaBody('quota-session'), 200);
        }
        if (spentToday >= capMicro) {
            return c.json(quotaBody('quota-daily'), 200);
        }

        try {
            await next();
        } finally {
            // Accumulate the turn's actual cost (same value §7 logs).
            const providerModel = c.get('providerModel');
            const usage = c.get('lastUsage');
            if (providerModel && usage) {
                const costUsd = computeCostUsd(providerModel, usage.input, usage.output);
                const deltaMicro = Math.round(costUsd * MICRO);
                if (deltaMicro > 0) {
                    deps.store.addSpentMicroUsd(key, dayUtc, deltaMicro);
                    if (sessionId) deps.store.addSessionMicroUsd(sessionId, deltaMicro);
                }
            }
        }
    };
}
