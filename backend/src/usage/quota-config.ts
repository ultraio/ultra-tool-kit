// Quota configuration + the stake→daily-cap formula (docs/00 §3.8).
// All values come from env strings; the parser applies the documented
// defaults so a bare deploy still has a sane cap. Caps are computed and
// compared in integer MICRO-USD (1e-6 USD) to avoid float drift over a day
// of sub-cent turn costs.

export type QuotaConfig = {
    ratePerDay: number; // fraction of staked USD value granted per day
    freeFloorUsd: number; // daily cap at zero stake
    maxCapUsd: number; // per-identity/day ceiling
    sessionCapUsd: number; // advisory per-session soft cap
    priceMaxAgeS: number; // oracle staleness threshold (seconds)
    priceFallbackUsd: number; // UOS/USD used when the oracle read is stale/failed
    disabled: boolean; // master kill-switch → gate is a no-op
};

export const MICRO = 1_000_000;

function num(env: Record<string, string | undefined>, key: string, dflt: number): number {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return dflt;
    const n = Number(raw);
    return Number.isFinite(n) ? n : dflt;
}

export function readQuotaConfig(env: Record<string, string | undefined>): QuotaConfig {
    return {
        ratePerDay: num(env, 'QUOTA_RATE_PER_DAY', 0.02),
        freeFloorUsd: num(env, 'QUOTA_FREE_FLOOR_USD', 0.01),
        maxCapUsd: num(env, 'QUOTA_MAX_CAP_USD', 1.0),
        sessionCapUsd: num(env, 'QUOTA_SESSION_CAP_USD', 0.25),
        priceMaxAgeS: num(env, 'QUOTA_PRICE_MAX_AGE_S', 3600),
        // Default deliberately ≤ market (≈$0.0041 on 2026-06-10): an oracle
        // outage must not inflate caps. Tune per env.
        priceFallbackUsd: num(env, 'UOS_PRICE_USD_FALLBACK', 0.004),
        disabled: env.QUOTA_DISABLED === 'true',
    };
}

// dailyCap = clamp(stakedUos * uosPriceUsd * RATE, FREE_FLOOR, MAX_CAP), in micro-USD.
export function dailyCapMicroUsd(cfg: QuotaConfig, stakedUos: number, uosPriceUsd: number): number {
    const rawUsd = Math.max(0, stakedUos) * Math.max(0, uosPriceUsd) * cfg.ratePerDay;
    const clampedUsd = Math.min(cfg.maxCapUsd, Math.max(cfg.freeFloorUsd, rawUsd));
    return Math.round(clampedUsd * MICRO);
}
