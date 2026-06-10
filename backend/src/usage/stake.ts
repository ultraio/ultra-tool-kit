// StakeReader — reads an account's self-staked UOS (docs/00 §3.8).
// Bespoke internal read (NOT an LLM tool): direct, host-allowlist-guarded
// POST to /v1/chain/get_table_rows for (eosio, userres) scoped to the
// verified active account. NOTE: the deployed system contract account is
// `eosio` — `eosio.system` is only the repo name and does not exist on-chain
// (verified 2026-06-10 testnet). power_weight is an asset serialized as a
// string ("125.00000000 UOS", 8 dp); we return its UOS amount as a float.
// Degrade-safe: any failure → 0 (caller falls to the free floor).
// Cached per (endpoint, account) for 5 min, mirroring balance-gate.ts.

import { isAllowedEndpoint } from '../pipeline/tools/host-allowlist.js';
import { logger } from '../middleware/logging.js';

const CONTRACT = 'eosio';
const TABLE = 'userres';
const CACHE_TTL_MS = 5 * 60_000;

export type StakeReaderDeps = {
    allowlist: readonly string[];
    fetchImpl?: typeof globalThis.fetch;
    now?: () => number; // ms; default Date.now
    cacheTtlMs?: number;
};

type CacheEntry = { uos: number; atMs: number };

// "125.00000000 UOS" or { amount: "12500000000", symbol: "8,UOS" } → 125.
function parsePowerWeight(pw: unknown): number {
    if (typeof pw === 'string') {
        const n = Number(pw.trim().split(' ')[0]);
        return Number.isFinite(n) ? n : 0;
    }
    if (pw && typeof pw === 'object' && 'amount' in pw && 'symbol' in pw) {
        const amount = Number((pw as { amount: unknown }).amount);
        const symbol = String((pw as { symbol: unknown }).symbol); // "8,UOS"
        const precision = Number(symbol.split(',')[0]);
        if (!Number.isFinite(amount) || !Number.isFinite(precision)) return 0;
        return amount / 10 ** precision;
    }
    return 0;
}

export class StakeReader {
    private cache = new Map<string, CacheEntry>();
    private now: () => number;
    private ttl: number;

    constructor(private deps: StakeReaderDeps) {
        this.now = deps.now ?? (() => Date.now());
        this.ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
    }

    async getStakedUos(account: string, endpoint: string): Promise<number> {
        const key = `${endpoint}|${account}`;
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.atMs < this.ttl) return cached.uos;

        let uos = 0;
        try {
            uos = await this.read(account, endpoint);
            this.cache.set(key, { uos, atMs: this.now() });
        } catch (err) {
            // Degrade-safe: do NOT cache a failure (next turn retries).
            logger.debug(
                { account, err: err instanceof Error ? err.message : String(err) },
                'stake-reader: read failed; counting stake as 0'
            );
        }
        return uos;
    }

    private async read(account: string, endpoint: string): Promise<number> {
        const url = new URL('/v1/chain/get_table_rows', endpoint).toString();
        if (!isAllowedEndpoint(url, this.deps.allowlist)) {
            throw new Error(`endpoint rejected by host allowlist: ${endpoint}`);
        }
        const fetchImpl = this.deps.fetchImpl ?? globalThis.fetch;
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: CONTRACT, scope: account, table: TABLE, limit: 1, json: true }),
        });
        if (!res.ok) throw new Error(`get_table_rows failed: HTTP ${res.status}`);
        const body = (await res.json()) as { rows?: unknown[] };
        const row = Array.isArray(body.rows) ? body.rows[0] : undefined;
        if (!row || typeof row !== 'object') return 0;
        return parsePowerWeight((row as { power_weight?: unknown }).power_weight);
    }
}
