// PriceSource — reads UOS/USD from eosio.oracle (docs/00 §3.8).
// Bespoke internal read (NOT an LLM tool): the oracle table is scoped by a
// numeric scope, which the generic get_table_rows tool's SCOPE_RE rejects.
// Host-allowlist-guarded direct fetch. Degrade-safe: a stale row, a
// missing row, an out-of-allowlist endpoint, or any fetch error → the
// configured fallback constant. Cached per endpoint for 5 min.
//
// ORACLE_* constants reflect the deployed feed (VERIFIED 2026-06-10 testnet,
// spec §13.1): the live row is on `finalrates` scope '1' at
//   rows[0].rolling_moving_average.average = { timestamp: <unix s>, price: "0.00408043 DUOS" }
// (`finalaverage` is empty). `price` is an asset string with 8-dp DUOS.

import { isAllowedEndpoint } from '../pipeline/tools/host-allowlist.js';
import { logger } from '../middleware/logging.js';

const ORACLE_CODE = 'eosio.oracle';
const ORACLE_TABLE = 'finalrates';
const ORACLE_SCOPE = '1';
const CACHE_TTL_MS = 5 * 60_000;

export type PriceSourceDeps = {
    allowlist: readonly string[];
    fallbackUsd: number;
    maxAgeS: number;
    fetchImpl?: typeof globalThis.fetch;
    nowS?: () => number; // unix seconds; default Math.floor(Date.now()/1000)
    nowMs?: () => number; // ms, for cache; default Date.now
    cacheTtlMs?: number;
};

type CacheEntry = { price: number; atMs: number };

function parseAssetUsd(price: unknown): number | null {
    // "0.02000000 DUOS" → 0.02 (the node serializes asset as a string).
    if (typeof price === 'string') {
        const n = Number(price.trim().split(' ')[0]);
        return Number.isFinite(n) ? n : null;
    }
    // Defensive fallback for an { amount, symbol } object form.
    if (price && typeof price === 'object' && 'amount' in price && 'symbol' in price) {
        const amount = Number((price as { amount: unknown }).amount);
        const precision = Number(String((price as { symbol: unknown }).symbol).split(',')[0]);
        if (Number.isFinite(amount) && Number.isFinite(precision)) return amount / 10 ** precision;
    }
    return null;
}

export class PriceSource {
    private cache = new Map<string, CacheEntry>();
    private nowS: () => number;
    private nowMs: () => number;
    private ttl: number;

    constructor(private deps: PriceSourceDeps) {
        this.nowS = deps.nowS ?? (() => Math.floor(Date.now() / 1000));
        this.nowMs = deps.nowMs ?? (() => Date.now());
        this.ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
    }

    async getUosPriceUsd(endpoint: string): Promise<number> {
        const cached = this.cache.get(endpoint);
        if (cached && this.nowMs() - cached.atMs < this.ttl) return cached.price;

        const price = await this.readOrFallback(endpoint);
        this.cache.set(endpoint, { price, atMs: this.nowMs() });
        return price;
    }

    private async readOrFallback(endpoint: string): Promise<number> {
        try {
            const url = new URL('/v1/chain/get_table_rows', endpoint).toString();
            if (!isAllowedEndpoint(url, this.deps.allowlist)) return this.deps.fallbackUsd;
            const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    code: ORACLE_CODE,
                    scope: ORACLE_SCOPE,
                    table: ORACLE_TABLE,
                    limit: 1,
                    json: true,
                }),
            });
            if (!res.ok) return this.deps.fallbackUsd;
            const body = (await res.json()) as { rows?: unknown[] };
            const row = Array.isArray(body.rows) ? body.rows[0] : undefined;
            const rma =
                row && typeof row === 'object'
                    ? (row as { rolling_moving_average?: { average?: { price?: unknown; timestamp?: unknown } } })
                          .rolling_moving_average
                    : undefined;
            const avg = rma?.average;
            if (!avg) return this.deps.fallbackUsd;
            const ts = Number(avg.timestamp);
            if (!Number.isFinite(ts) || this.nowS() - ts > this.deps.maxAgeS) return this.deps.fallbackUsd;
            const usd = parseAssetUsd(avg.price);
            return usd !== null && usd > 0 ? usd : this.deps.fallbackUsd;
        } catch (err) {
            logger.debug(
                { err: err instanceof Error ? err.message : String(err) },
                'price-source: oracle read failed; using fallback'
            );
            return this.deps.fallbackUsd;
        }
    }
}
