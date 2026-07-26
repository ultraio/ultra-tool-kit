import { describe, expect, it, vi } from 'vitest';
import { StakeReader } from '../../src/usage/stake.js';

const ALLOWLIST = ['127.0.0.1', 'localhost', '*.ultra.io'];
const ENDPOINT = 'https://api.testnet.ultra.io';

function fetchReturning(rows: unknown[]) {
    return vi.fn(
        async () =>
            new Response(JSON.stringify({ rows, more: false, next_key: '' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
    );
}

describe('StakeReader.getStakedUos', () => {
    it('parses power_weight given as an asset string (8dp UOS, verified testnet shape)', async () => {
        const fetchImpl = fetchReturning([{ owner: 'alice', power_weight: '125.00000000 UOS' }]);
        const r = new StakeReader({ allowlist: ALLOWLIST, fetchImpl });
        expect(await r.getStakedUos('alice', ENDPOINT)).toBe(125);
    });

    it('parses power_weight given as an {amount, symbol} object (defensive fallback)', async () => {
        const fetchImpl = fetchReturning([
            { owner: 'alice', power_weight: { amount: '12500000000', symbol: '8,UOS' } },
        ]);
        const r = new StakeReader({ allowlist: ALLOWLIST, fetchImpl });
        expect(await r.getStakedUos('alice', ENDPOINT)).toBe(125);
    });

    it('returns 0 when the account has no userres row', async () => {
        const fetchImpl = fetchReturning([]);
        const r = new StakeReader({ allowlist: ALLOWLIST, fetchImpl });
        expect(await r.getStakedUos('nobody', ENDPOINT)).toBe(0);
    });

    it('returns 0 (degrade-safe) when the fetch throws', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('network down');
        });
        const r = new StakeReader({ allowlist: ALLOWLIST, fetchImpl });
        expect(await r.getStakedUos('alice', ENDPOINT)).toBe(0);
    });

    it('caches per (endpoint, account) within the TTL — one fetch for two reads', async () => {
        const fetchImpl = fetchReturning([{ owner: 'alice', power_weight: '10.00000000 UOS' }]);
        let t = 0;
        const r = new StakeReader({ allowlist: ALLOWLIST, fetchImpl, now: () => t, cacheTtlMs: 1000 });
        expect(await r.getStakedUos('alice', ENDPOINT)).toBe(10);
        t = 500;
        expect(await r.getStakedUos('alice', ENDPOINT)).toBe(10);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        t = 2000; // past TTL → re-fetch
        await r.getStakedUos('alice', ENDPOINT);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('rejects an endpoint outside the host allowlist (returns 0, no fetch)', async () => {
        const fetchImpl = fetchReturning([{ owner: 'alice', power_weight: '10.00000000 UOS' }]);
        const r = new StakeReader({ allowlist: ALLOWLIST, fetchImpl });
        expect(await r.getStakedUos('alice', 'https://evil.example.com')).toBe(0);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
