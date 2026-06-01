// UOS balance gate (W9). docs/00 §3.7 + RFC §9.
//
// Runs after attestation, before ratelimit. When c.var.identity is set, reads
// UOS for the VERIFIED active account (identity.account — RFC §5.6; never an
// FE-supplied value) with ONE get_currency_balance call and refuses below
// BALANCE_THRESHOLD_UOS. Admin/governance keys often enumerate 75-100+
// signableAccounts; summing all of them fires 75+ sequential reads per turn,
// the public RPC throttles the burst, reads fail, the gate counts 0, and
// legitimate funded accounts are falsely refused — so we gate on the single
// active account only. When no identity is present (unattested / per-IP path)
// it is a no-op. thresholdUos <= 0 disables the gate entirely with no RPC read.
// Per-(endpoint, account) reads are cached in-process for 5 minutes.

import type { Context, MiddlewareHandler } from 'hono';

import { logger } from './logging.js';
import type { IdentityVariables } from './attestation.js';
import { getBalanceSpec } from '../pipeline/tools/get_balance.js';
import type { ToolCtx } from '../pipeline/tools/types.js';
import type { CatalogIndex } from '../pipeline/catalog.js';

const UOS_SYMBOL = 'UOS';
const UOS_CODE = 'eosio.token';
const CACHE_TTL_MS = 5 * 60_000;

export type BalanceGateDeps = {
    thresholdUos: number;
    catalog: CatalogIndex;
    allowlist: readonly string[];
    fetchImpl?: typeof globalThis.fetch;
    // Injectable per-account UOS reader (tests stub this). Default reads via the
    // W4 get_balance tool against the request's endpoint.
    readUosBalance?: (account: string, endpoint: string) => Promise<number>;
    now?: () => number; // ms; default Date.now
    cacheTtlMs?: number;
};

type CacheEntry = { uos: number; atMs: number };

function makeDefaultReader(
    catalog: CatalogIndex,
    allowlist: readonly string[],
    fetchImpl?: typeof globalThis.fetch
): (account: string, endpoint: string) => Promise<number> {
    return async (account, endpoint) => {
        const ctx: ToolCtx = { endpoint, allowlist, catalog, fetchImpl };
        const rows = await getBalanceSpec.call({ account, symbol: UOS_SYMBOL, code: UOS_CODE }, ctx);
        if (!Array.isArray(rows)) return 0;
        let sum = 0;
        for (const r of rows) {
            if (r && typeof r === 'object' && 'amount' in r) {
                const amt = Number((r as { amount: unknown }).amount);
                if (Number.isFinite(amt)) sum += amt;
            }
        }
        return sum;
    };
}

// Read context.endpoint from a clone of the request body (never consumes the
// stream the route handler reads). Mirrors usage-log.ts. '' on any failure.
async function endpointFromBody(c: Context<IdentityVariables>): Promise<string> {
    try {
        const cloned = c.req.raw.clone();
        const body = (await cloned.json()) as { context?: { endpoint?: string } };
        return typeof body.context?.endpoint === 'string' ? body.context.endpoint : '';
    } catch {
        return '';
    }
}

export function balanceGate(deps: BalanceGateDeps): MiddlewareHandler<IdentityVariables> {
    const reader = deps.readUosBalance ?? makeDefaultReader(deps.catalog, deps.allowlist, deps.fetchImpl);
    const now = deps.now ?? (() => Date.now());
    const ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
    // Per (endpoint, account) cache. Lives for the process lifetime (single
    // instance v1 per roadmap §9). Keyed on endpoint too because balances are
    // chain-specific.
    const cache = new Map<string, CacheEntry>();

    return async (c, next) => {
        const identity = c.get('identity');
        if (!identity) {
            await next();
            return;
        }

        // threshold <= 0 disables the gate — skip RPC read entirely.
        if (deps.thresholdUos <= 0) {
            c.set('totalUos', 0);
            await next();
            return;
        }

        const endpoint = await endpointFromBody(c);

        // Gate on the verified active account only (identity.account — RFC §5.6).
        // One read regardless of how many signableAccounts the attestation lists.
        const { account } = identity;
        const key = `${endpoint}|${account}`;
        const cached = cache.get(key);

        let uos: number;
        if (cached && now() - cached.atMs < ttl) {
            uos = cached.uos;
        } else {
            try {
                uos = await reader(account, endpoint);
                cache.set(key, { uos, atMs: now() });
            } catch (err) {
                // Transient read failure: treat as 0 and do NOT cache (so the
                // next turn retries). An empty / undeterminable endpoint also
                // lands here (get_balance throws on a bad URL) — fail CLOSED.
                uos = 0;
                logger.debug(
                    { account, err: err instanceof Error ? err.message : String(err) },
                    'balance-gate: UOS read failed; counting active account as 0'
                );
            }
        }

        if (uos < deps.thresholdUos) {
            return c.json({ kind: 'refuse', reason: 'insufficient-uos' }, 200);
        }
        c.set('totalUos', uos);
        await next();
    };
}
