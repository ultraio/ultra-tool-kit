import { describe, expect, it, vi } from 'vitest';
import { PriceSource } from '../../src/usage/price.js';

const ALLOWLIST = ['127.0.0.1', 'localhost', '*.ultra.io'];
const ENDPOINT = 'https://api.testnet.ultra.io';
const FALLBACK = 0.05;
const MAX_AGE_S = 3600;

function fetchReturning(row: unknown) {
    return vi.fn(
        async () =>
            new Response(JSON.stringify({ rows: row === undefined ? [] : [row], more: false, next_key: '' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
    );
}

// "now" the source sees (unix seconds).
const NOW_S = 1_800_000_000;

describe('PriceSource.getUosPriceUsd', () => {
    it('parses a fresh oracle price (asset string, verified testnet shape) into USD', async () => {
        const row = { rolling_moving_average: { average: { price: '0.02000000 DUOS', timestamp: NOW_S - 10 } } };
        const p = new PriceSource({
            allowlist: ALLOWLIST,
            fetchImpl: fetchReturning(row),
            fallbackUsd: FALLBACK,
            maxAgeS: MAX_AGE_S,
            nowS: () => NOW_S,
        });
        expect(await p.getUosPriceUsd(ENDPOINT)).toBeCloseTo(0.02, 8);
    });

    it('falls back when the price row is older than maxAgeS', async () => {
        const row = { rolling_moving_average: { average: { price: '0.02000000 DUOS', timestamp: NOW_S - 7200 } } };
        const p = new PriceSource({
            allowlist: ALLOWLIST,
            fetchImpl: fetchReturning(row),
            fallbackUsd: FALLBACK,
            maxAgeS: MAX_AGE_S,
            nowS: () => NOW_S,
        });
        expect(await p.getUosPriceUsd(ENDPOINT)).toBe(FALLBACK);
    });

    it('falls back when there is no oracle row', async () => {
        const p = new PriceSource({
            allowlist: ALLOWLIST,
            fetchImpl: fetchReturning(undefined),
            fallbackUsd: FALLBACK,
            maxAgeS: MAX_AGE_S,
            nowS: () => NOW_S,
        });
        expect(await p.getUosPriceUsd(ENDPOINT)).toBe(FALLBACK);
    });

    it('falls back (no throw) when the fetch errors', async () => {
        const p = new PriceSource({
            allowlist: ALLOWLIST,
            fetchImpl: vi.fn(async () => {
                throw new Error('oracle down');
            }),
            fallbackUsd: FALLBACK,
            maxAgeS: MAX_AGE_S,
            nowS: () => NOW_S,
        });
        expect(await p.getUosPriceUsd(ENDPOINT)).toBe(FALLBACK);
    });

    it('falls back for an endpoint outside the host allowlist (no fetch)', async () => {
        const fetchImpl = fetchReturning({
            rolling_moving_average: { average: { price: '0.02000000 DUOS', timestamp: NOW_S } },
        });
        const p = new PriceSource({
            allowlist: ALLOWLIST,
            fetchImpl,
            fallbackUsd: FALLBACK,
            maxAgeS: MAX_AGE_S,
            nowS: () => NOW_S,
        });
        expect(await p.getUosPriceUsd('https://evil.example.com')).toBe(FALLBACK);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
