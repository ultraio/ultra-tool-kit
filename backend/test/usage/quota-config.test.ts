import { describe, expect, it } from 'vitest';
import { readQuotaConfig, dailyCapMicroUsd } from '../../src/usage/quota-config.js';

const BASE = {
    QUOTA_RATE_PER_DAY: '0.02',
    QUOTA_FREE_FLOOR_USD: '0.01',
    QUOTA_MAX_CAP_USD: '1.00',
    QUOTA_SESSION_CAP_USD: '0.25',
    QUOTA_PRICE_MAX_AGE_S: '3600',
    UOS_PRICE_USD_FALLBACK: '0.02',
    QUOTA_DISABLED: 'false',
};

describe('readQuotaConfig', () => {
    it('parses defaults from env strings', () => {
        const c = readQuotaConfig(BASE);
        expect(c).toEqual({
            ratePerDay: 0.02,
            freeFloorUsd: 0.01,
            maxCapUsd: 1.0,
            sessionCapUsd: 0.25,
            priceMaxAgeS: 3600,
            priceFallbackUsd: 0.02,
            disabled: false,
        });
    });

    it('falls back to documented defaults when vars are absent', () => {
        const c = readQuotaConfig({});
        expect(c.ratePerDay).toBe(0.02);
        expect(c.freeFloorUsd).toBe(0.01);
        expect(c.maxCapUsd).toBe(1.0);
        expect(c.sessionCapUsd).toBe(0.25);
        expect(c.priceMaxAgeS).toBe(3600);
        expect(c.priceFallbackUsd).toBe(0.004);
        expect(c.disabled).toBe(false);
    });

    it('treats QUOTA_DISABLED=true as disabled', () => {
        expect(readQuotaConfig({ ...BASE, QUOTA_DISABLED: 'true' }).disabled).toBe(true);
    });
});

describe('dailyCapMicroUsd', () => {
    const c = readQuotaConfig(BASE);
    it('returns the free floor at zero stake', () => {
        expect(dailyCapMicroUsd(c, 0, 0.02)).toBe(10_000); // $0.01
    });
    it('maps $1 staked → $0.02/day', () => {
        // 50 UOS * $0.02 = $1 staked → 1 * 0.02 = $0.02/day
        expect(dailyCapMicroUsd(c, 50, 0.02)).toBe(20_000); // $0.02
    });
    it('clamps to the max cap above ~$50 staked', () => {
        // 5000 UOS * $0.02 = $100 staked → 100 * 0.02 = $2 → clamped to $1
        expect(dailyCapMicroUsd(c, 5000, 0.02)).toBe(1_000_000); // $1.00
    });
    it('never drops below the free floor for tiny stakes', () => {
        expect(dailyCapMicroUsd(c, 0.001, 0.02)).toBe(10_000); // $0.01 floor
    });
});
