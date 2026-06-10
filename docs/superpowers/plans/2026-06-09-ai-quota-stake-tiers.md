# AI Quota — Stake-Tiered Daily Cost Caps (W10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-identity daily *cost* cap to the AI backend, where an attested user raises their own cap by staking UOS on-chain (a refundable bond the backend reads — no new contract, no DB).

**Architecture:** Three in-memory/stateless modules behind thin interfaces — `UsageStore` (per-identity daily + per-session micro-USD counters), `StakeReader` (reads `eosio/userres.power_weight`), `PriceSource` (reads `eosio.oracle` UOS/USD, config fallback) — plus a `quotaGate` middleware that straddles the chat handler: it refuses when the day's spend ≥ `clamp(stakedUos × uosPrice × RATE, FREE_FLOOR, MAX_CAP)`, then accumulates the turn's actual cost after. A new `GET /api/ai-quota` exposes the caller's numbers for the FE badge. Single replica makes the in-memory counter authoritative (also fixes the existing per-pod doubling of the §3.2 caps).

**Tech Stack:** TypeScript (strict), Hono middleware, Vitest. Asset parsing is plain string math (no `@wharfkit/antelope` needed); chain reads follow the existing `get_table_rows` fetch pattern.

**Spec:** `docs/superpowers/specs/2026-06-09-ai-quota-stake-tiers-design.md`. Read it first.

**Conventions (from `backend/CLAUDE.md`):** TypeScript strict, no `any` without justification, async functions (not Promise chains), typed errors, tests live under `backend/test/` mirroring `src/`, mock at injection boundaries (no live LLM/RPC in unit tests). Run `npm --prefix backend test` and `npm --prefix backend run build`-equivalent typecheck. Commit messages: conventional, scoped `(ai)`, with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `docs/00-ai-global-guidelines.md` | Add §3.8 (stake-tiered daily cost cap) | Modify |
| `docs/01-ai-enhancement-roadmap.md` | Add §6 row W10 | Modify |
| `backend/src/usage/quota-config.ts` | Parse `QUOTA_*` env → typed `QuotaConfig`; `dailyCapMicroUsd()` formula | Create |
| `backend/src/usage/store.ts` | `UsageStore` interface + in-memory impl (daily + session micro-USD counters) | Create |
| `backend/src/usage/stake.ts` | `StakeReader` — bespoke `userres` read, 5-min cache | Create |
| `backend/src/usage/price.ts` | `PriceSource` — bespoke oracle read + staleness fallback, 5-min cache | Create |
| `backend/src/middleware/quota-gate.ts` | `quotaGate` middleware: cap check (before) + cost accumulate (after) | Create |
| `backend/src/routes/ai-quota.ts` | `GET /api/ai-quota` — caller's quota view | Create |
| `backend/src/index.ts` | Wire `quotaGate` into the `/api/ai-chat` chain + mount `/api/ai-quota`; read `QUOTA_*` config | Modify |
| `backend/.env.example` | Document `QUOTA_*` + `UOS_PRICE_USD_FALLBACK` | Modify |
| `backend/test/usage/*.test.ts` | Unit tests per module | Create |
| `backend/test/middleware/quota-gate.test.ts` | Gate integration | Create |
| `backend/test/routes/ai-quota.test.ts` | Route test | Create |
| `src/utilities/aiClient.ts` | `fetchQuota()`; extend `ReplyRefuse` with optional `quota` payload | Modify |
| `src/composables/useAiChat.ts` | Fetch `/api/ai-quota`; expose `quota` state | Modify |
| `src/components/ai/CostBadge.vue` | Badge `spent / cap` (today) | Modify |
| `src/components/ai/MessageBubble.vue` | Render the quota refuse hint | Modify |

---

## Pre-flight — VERIFIED 2026-06-10 against `https://api.testnet.ultra.io`

- [x] **Test runner + green baseline:** `npm --prefix backend test` → 47 files / 408 tests PASS.

- [x] **Oracle feed identity (spec §13.1) — RESOLVED.** `finalaverage` scope `1` is EMPTY on testnet. The live moving average is on table **`finalrates`**, scope **`1`**, at `rows[0].rolling_moving_average.average`:
  `{ "timestamp": 1781109060, "price": "0.00408043 DUOS" }`
  — `timestamp` is unix SECONDS; `price` is an asset STRING with 8-dp `DUOS` symbol (≈ $0.0041/UOS at verification time). Task 5's constants, row accessor, and fixtures use this shape.

- [x] **UOS precision on `userres` — RESOLVED, two corrections.** The deployed system contract account is **`eosio`**, NOT `eosio.system` (that account does not exist on-chain — RPC returns "Fail to retrieve account for eosio.system"). A real row (`code=eosio, scope=eosio.token, table=userres`):
  `{ "owner": "eosio.token", "power_weight": "0.00000000 UOS", "ram_bytes": 524288000, "flags": 0 }`
  — `power_weight` is an asset STRING with **8** decimal places (not 4). The ABI confirms `user_resources.power_weight: asset`. The string parser is precision-agnostic; the precision only matters for fixtures and the `{amount, symbol}` fallback form.

- [x] **Fallback price default lowered to `0.004`** (was `0.02`): market is ≈$0.0041/UOS, and the conservative failure mode is a fallback at-or-below market (an oracle outage must not inflate caps ~5×). Env-tunable per environment as before.

---

## Task 1: Doc-first — guidelines §3.8 + roadmap W10 row

**Files:**
- Modify: `docs/00-ai-global-guidelines.md` (add §3.8 after §3.7)
- Modify: `docs/01-ai-enhancement-roadmap.md` (add W10 row to §6 table)

No tests (docs). This lands first per roadmap §2 ("§6 is the only feature list").

- [ ] **Step 1: Add §3.8 to `docs/00-ai-global-guidelines.md`**

Insert immediately after the §3.7 block (before `## 4. Security baseline`):

```markdown
### 3.8 Per-identity daily cost cap (stake-tiered)

Layered ON TOP of §3.2 / §3.7 (request-count limits) and the §3.2 tier-5 global
monthly USD cap — it does not replace them; all still bind. This caps the
**dollar** spend of a single identity per UTC day.

- **Cap formula:** `dailyCapUsd = clamp(stakedUos × uosPriceUsd × RATE, FREE_FLOOR, MAX_CAP)`.
  Defaults: `RATE=0.02`/day, `FREE_FLOOR=$0.01`, `MAX_CAP=$1.00`. All env-tunable.
- **Identity key:** verified attested account (`acct:<account>`, §3.7) else
  hashed client IP (`ip:<sha256>`, §3.2). Mutually exclusive per request.
- **Attested-only above the floor.** Unattested (per-IP) callers have no
  signature-verified account, so they always get `FREE_FLOOR`. Earning a higher
  cap requires proving account ownership (attestation) AND staking UOS — Sybil
  resistance.
- **Stake** = the system contract's `eosio/userres.power_weight` for the verified
  active account (self-stake only). **Price** = `eosio.oracle` UOS/USD moving-average; on stale
  or failed read, fall back to env `UOS_PRICE_USD_FALLBACK`. Both are **internal
  middleware reads** (host-allowlist-guarded direct RPC) — NOT new LLM tools, so
  no §4.2 allowlist row.
- **Degrade-safe:** a stake read failure → treat as 0 stake (free floor); a price
  read failure/staleness → fallback constant. Reads never block chat.
- **Enforcement:** check-then-accumulate. Refuse when the day's accumulated spend
  ≥ cap, with HTTP 200 `{ kind: 'refuse', reason: 'quota-daily', quota: {...} }`
  (never 429, per §3.2). An advisory per-session soft cap emits
  `reason: 'quota-session'`. Spend is accumulated in integer micro-USD after each
  turn from `computeCostUsd` (the same value §7 logs).
- **Kill switch:** `QUOTA_DISABLED=true` makes the gate a pure no-op (no RPC
  reads), mirroring `BALANCE_THRESHOLD_UOS=0` (§3.7).
- **Single instance.** The daily/session counters are in-process (roadmap
  decision 1, §9). Multi-replica requires the deferred Redis-backed store (§9).
```

- [ ] **Step 2: Add the W10 row to `docs/01-ai-enhancement-roadmap.md` §6 table**

Append after the W9 row in the §6 table:

```markdown
| W10 | Stake-tiered daily cost cap | 2d | Per-identity daily USD cap on AI spend; attested users raise their cap by staking UOS (read from `eosio/userres`, priced via `eosio.oracle` with config fallback). In-memory counters; single replica. `GET /api/ai-quota` powers the FE badge. No new contract, no new LLM tool. | §3.8, §7 |
```

- [ ] **Step 3: Commit**

```bash
git add docs/00-ai-global-guidelines.md docs/01-ai-enhancement-roadmap.md
git commit -m "$(printf 'docs(ai): W10 — guidelines §3.8 + roadmap row for stake-tiered cost cap\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 2: `quota-config.ts` — env parsing + cap formula

**Files:**
- Create: `backend/src/usage/quota-config.ts`
- Test: `backend/test/usage/quota-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/usage/quota-config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- quota-config`
Expected: FAIL — `Cannot find module '../../src/usage/quota-config.js'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/usage/quota-config.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- quota-config`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/usage/quota-config.ts backend/test/usage/quota-config.test.ts
git commit -m "$(printf 'feat(ai): quota-config — env parsing + stake→daily-cap formula (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 3: `store.ts` — in-memory `UsageStore`

**Files:**
- Create: `backend/src/usage/store.ts`
- Test: `backend/test/usage/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/test/usage/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InMemoryUsageStore } from '../../src/usage/store.js';

describe('InMemoryUsageStore', () => {
    it('accumulates daily spend per key and returns the new total', () => {
        const s = new InMemoryUsageStore();
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-09')).toBe(0);
        expect(s.addSpentMicroUsd('acct:alice', '2026-06-09', 500)).toBe(500);
        expect(s.addSpentMicroUsd('acct:alice', '2026-06-09', 250)).toBe(750);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-09')).toBe(750);
    });

    it('resets the daily counter when the day rolls over', () => {
        const s = new InMemoryUsageStore();
        s.addSpentMicroUsd('acct:alice', '2026-06-09', 900);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-10')).toBe(0);
        s.addSpentMicroUsd('acct:alice', '2026-06-10', 100);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-10')).toBe(100);
    });

    it('isolates keys from each other', () => {
        const s = new InMemoryUsageStore();
        s.addSpentMicroUsd('acct:alice', '2026-06-09', 500);
        s.addSpentMicroUsd('ip:deadbeef', '2026-06-09', 300);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-09')).toBe(500);
        expect(s.getSpentMicroUsd('ip:deadbeef', '2026-06-09')).toBe(300);
    });

    it('tracks per-session totals independently of the daily counter', () => {
        const s = new InMemoryUsageStore();
        expect(s.getSessionMicroUsd('sess-1')).toBe(0);
        expect(s.addSessionMicroUsd('sess-1', 400)).toBe(400);
        expect(s.addSessionMicroUsd('sess-1', 100)).toBe(500);
        expect(s.getSessionMicroUsd('sess-2')).toBe(0);
    });

    it('bounds the session map: oldest session is evicted once over the cap (spec §5.1)', () => {
        const s = new InMemoryUsageStore({ maxSessions: 2 });
        s.addSessionMicroUsd('s1', 100);
        s.addSessionMicroUsd('s2', 200);
        s.addSessionMicroUsd('s3', 300); // a 3rd new session evicts s1 (insertion order)
        expect(s.getSessionMicroUsd('s1')).toBe(0);
        expect(s.getSessionMicroUsd('s2')).toBe(200);
        expect(s.getSessionMicroUsd('s3')).toBe(300);
    });

    it('prunes stale-day daily entries once over the key cap', () => {
        const s = new InMemoryUsageStore({ maxDailyKeys: 2 });
        s.addSpentMicroUsd('ip:a', '2026-06-09', 1);
        s.addSpentMicroUsd('ip:b', '2026-06-09', 1);
        s.addSpentMicroUsd('ip:c', '2026-06-10', 1); // over cap → drops the 06-09 keys
        expect(s.getSpentMicroUsd('ip:c', '2026-06-10')).toBe(1);
        expect(s.getSpentMicroUsd('ip:a', '2026-06-09')).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- usage/store`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/usage/store.ts`:

```ts
// Per-identity daily + per-session spend counters, in micro-USD (docs/00 §3.8).
// In-memory only: process-lifetime, single-instance v1 (roadmap decision 1, §9).
// The interface is the seam a future Redis-backed impl drops into without
// touching the gate.
//
// Both maps are BOUNDED (spec §5.1 "bounded LRU-ish") — sessionId and the ip:
// key are attacker-influenced, so unbounded maps would be a memory-growth
// vector. Sessions evict oldest-inserted past maxSessions; the daily map drops
// stale-day entries past maxDailyKeys.

export interface UsageStore {
    getSpentMicroUsd(key: string, dayUtc: string): number;
    addSpentMicroUsd(key: string, dayUtc: string, deltaMicroUsd: number): number;
    getSessionMicroUsd(sessionId: string): number;
    addSessionMicroUsd(sessionId: string, deltaMicroUsd: number): number;
}

type DayEntry = { day: string; micro: number };

export type UsageStoreOpts = {
    maxSessions?: number; // default 10_000
    maxDailyKeys?: number; // default 50_000
};

export class InMemoryUsageStore implements UsageStore {
    // identity key → {day, micro}. A single slot per key: when the stored day
    // differs from the queried day the slot is treated as empty (lazy rollover).
    private daily = new Map<string, DayEntry>();
    private sessions = new Map<string, number>();
    private maxSessions: number;
    private maxDailyKeys: number;

    constructor(opts: UsageStoreOpts = {}) {
        this.maxSessions = opts.maxSessions ?? 10_000;
        this.maxDailyKeys = opts.maxDailyKeys ?? 50_000;
    }

    getSpentMicroUsd(key: string, dayUtc: string): number {
        const e = this.daily.get(key);
        return e && e.day === dayUtc ? e.micro : 0;
    }

    addSpentMicroUsd(key: string, dayUtc: string, deltaMicroUsd: number): number {
        const e = this.daily.get(key);
        const base = e && e.day === dayUtc ? e.micro : 0;
        const micro = base + deltaMicroUsd;
        this.daily.set(key, { day: dayUtc, micro });
        if (this.daily.size > this.maxDailyKeys) {
            // Stale-day entries are dead weight after rollover — sweep them.
            for (const [k, v] of this.daily) {
                if (v.day !== dayUtc) this.daily.delete(k);
            }
        }
        return micro;
    }

    getSessionMicroUsd(sessionId: string): number {
        return this.sessions.get(sessionId) ?? 0;
    }

    addSessionMicroUsd(sessionId: string, deltaMicroUsd: number): number {
        const micro = (this.sessions.get(sessionId) ?? 0) + deltaMicroUsd;
        if (!this.sessions.has(sessionId) && this.sessions.size >= this.maxSessions) {
            const oldest = this.sessions.keys().next().value;
            if (oldest !== undefined) this.sessions.delete(oldest);
        }
        this.sessions.set(sessionId, micro);
        return micro;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- usage/store`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/usage/store.ts backend/test/usage/store.test.ts
git commit -m "$(printf 'feat(ai): in-memory UsageStore for daily+session micro-USD counters (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 4: `stake.ts` — `StakeReader`

**Files:**
- Create: `backend/src/usage/stake.ts`
- Test: `backend/test/usage/stake.test.ts`

Reuses the host-allowlist guard (`isAllowedEndpoint` from `pipeline/tools/host-allowlist.js`) and the `/v1/chain/get_table_rows` fetch shape from `get_table_rows.ts`. Injectable `fetchImpl` for tests (no live RPC).

- [ ] **Step 1: Write the failing test**

Create `backend/test/usage/stake.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { StakeReader } from '../../src/usage/stake.js';

const ALLOWLIST = ['127.0.0.1', 'localhost', '*.ultra.io'];
const ENDPOINT = 'https://api.testnet.ultra.io';

function fetchReturning(rows: unknown[]) {
    return vi.fn(async () =>
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- usage/stake`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/usage/stake.ts`:

```ts
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
        const symbol = String((pw as { symbol: unknown }).symbol); // "4,UOS"
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- usage/stake`
Expected: PASS (all six cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/usage/stake.ts backend/test/usage/stake.test.ts
git commit -m "$(printf 'feat(ai): StakeReader — read self-staked UOS from eosio.system/userres (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 5: `price.ts` — `PriceSource`

**Files:**
- Create: `backend/src/usage/price.ts`
- Test: `backend/test/usage/price.test.ts`

Reads the `eosio.oracle` moving-average price; on stale/failed read returns the configured fallback. Same host-allowlist guard + injectable `fetchImpl`.

> Row shape VERIFIED 2026-06-10 on testnet (see Pre-flight): table `finalrates`, scope `1`, accessor `rows[0].rolling_moving_average.average` = `{ timestamp: <unix seconds>, price: "0.00408043 DUOS" }` — `price` is an asset STRING (8-dp DUOS). `finalaverage` is empty on testnet; do not use it.

- [ ] **Step 1: Write the failing test**

Create `backend/test/usage/price.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { PriceSource } from '../../src/usage/price.js';

const ALLOWLIST = ['127.0.0.1', 'localhost', '*.ultra.io'];
const ENDPOINT = 'https://api.testnet.ultra.io';
const FALLBACK = 0.05;
const MAX_AGE_S = 3600;

function fetchReturning(row: unknown) {
    return vi.fn(async () =>
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
        const fetchImpl = fetchReturning({ rolling_moving_average: { average: { price: '0.02000000 DUOS', timestamp: NOW_S } } });
        const p = new PriceSource({ allowlist: ALLOWLIST, fetchImpl, fallbackUsd: FALLBACK, maxAgeS: MAX_AGE_S, nowS: () => NOW_S });
        expect(await p.getUosPriceUsd('https://evil.example.com')).toBe(FALLBACK);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- usage/price`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/usage/price.ts`:

```ts
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
                body: JSON.stringify({ code: ORACLE_CODE, scope: ORACLE_SCOPE, table: ORACLE_TABLE, limit: 1, json: true }),
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- usage/price`
Expected: PASS (all five cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/usage/price.ts backend/test/usage/price.test.ts
git commit -m "$(printf 'feat(ai): PriceSource — UOS/USD from eosio.oracle with staleness fallback (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 6: `quota-gate.ts` — the middleware

**Files:**
- Create: `backend/src/middleware/quota-gate.ts`
- Test: `backend/test/middleware/quota-gate.test.ts`

Straddles `next()`: resolves identity → cap (before), refuses if over, accumulates the turn's cost (after). Mirrors `balance-gate.ts` (identity read, `QUOTA_DISABLED` no-op) and `usage-log.ts` (clone body for `sessionId`; read `c.var.lastUsage`/`providerModel` in `finally`; `computeCostUsd`). Identity key uses the same sha256-of-IP as usage-log; reuse `clientIpOf` from `logging.js` and hash with `node:crypto`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/middleware/quota-gate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { quotaGate, type QuotaGateDeps } from '../../src/middleware/quota-gate.js';
import { InMemoryUsageStore } from '../../src/usage/store.js';
import { readQuotaConfig } from '../../src/usage/quota-config.js';

const CFG = readQuotaConfig({
    QUOTA_RATE_PER_DAY: '0.02',
    QUOTA_FREE_FLOOR_USD: '0.01',
    QUOTA_MAX_CAP_USD: '1.00',
    QUOTA_SESSION_CAP_USD: '0.25',
});

// A handler that simulates a chat turn costing `costUsd` by setting the same
// c.var fields the real ai-chat route sets, then replying like the route does.
function chatHandlerSetting(costUsd: number) {
    return async (c: any) => {
        c.set('providerModel', 'anthropic:haiku-4-5');
        // 0 input + N output tokens chosen so computeCostUsd ≈ costUsd:
        // cost = out/1e6 * 5.0 (haiku-4-5 out rate)  → out = costUsd/5 * 1e6
        c.set('lastUsage', { input: 0, output: Math.round((costUsd / 5.0) * 1_000_000) });
        return c.json({ reply: { kind: 'answer', text: 'hi' }, usage: {} }, 200);
    };
}

function makeApp(deps: QuotaGateDeps, costUsd: number) {
    const app = new Hono();
    app.use('/api/ai-chat', quotaGate(deps));
    app.post('/api/ai-chat', chatHandlerSetting(costUsd));
    return app;
}

function post(app: Hono, body: object, identity?: object) {
    const app2 = app;
    // Inject identity the way the attestation middleware would (c.var.identity).
    const withIdentity = new Hono();
    if (identity) withIdentity.use('/api/ai-chat', async (c, next) => { c.set('identity', identity); await next(); });
    withIdentity.route('/', app2);
    return withIdentity.request('/api/ai-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('quotaGate', () => {
    it('is a no-op when disabled (no reads, no refuse)', async () => {
        const cfg = { ...CFG, disabled: true };
        const readStakedUos = vi.fn();
        const readUosPrice = vi.fn();
        const app = makeApp({ config: cfg, store: new InMemoryUsageStore(), allowlist: [], readStakedUos, readUosPrice }, 0.001);
        const res = await post(app, { sessionId: 's1', messages: [] });
        expect(res.status).toBe(200);
        expect((await res.json()).reply.kind).toBe('answer');
        expect(readStakedUos).not.toHaveBeenCalled();
        expect(readUosPrice).not.toHaveBeenCalled();
    });

    it('allows an unattested caller under the free floor, then accumulates cost', async () => {
        const store = new InMemoryUsageStore();
        const app = makeApp(
            { config: CFG, store, allowlist: [], readStakedUos: async () => 0, readUosPrice: async () => 0.02, now: () => new Date('2026-06-09T00:00:00Z') },
            0.003
        );
        const res = await post(app, { sessionId: 's1', messages: [] });
        expect(res.status).toBe(200);
        expect((await res.json()).reply.kind).toBe('answer');
        // $0.003 → 3000 micro-USD accumulated on the ip: key.
        // (key is ip:<hash> — assert via a follow-up over-cap refuse instead.)
    });

    it('refuses with quota-daily once the free-floor cap is reached', async () => {
        const store = new InMemoryUsageStore();
        const deps: QuotaGateDeps = {
            config: CFG, store, allowlist: [],
            readStakedUos: async () => 0, readUosPrice: async () => 0.02,
            now: () => new Date('2026-06-09T12:00:00Z'),
        };
        // Free floor = $0.01 = 10000 micro. First turn costs $0.009 (under), second is blocked.
        const app1 = makeApp(deps, 0.009);
        await post(app1, { sessionId: 's1', messages: [] }); // spends 9000 micro on ip:key
        const app2 = makeApp(deps, 0.009); // same store/deps
        const res = await post(app2, { sessionId: 's2', messages: [] }); // 9000 ≥ 10000? no → allowed
        expect((await res.json()).reply.kind).toBe('answer'); // 9000 < 10000, still under
        const app3 = makeApp(deps, 0.009);
        const res3 = await post(app3, { sessionId: 's3', messages: [] }); // now 18000 ≥ 10000 → refuse
        const body3 = await res3.json();
        expect(res3.status).toBe(200);
        // Bare Reply shape — same as ratelimit.ts / balance-gate.ts refuses.
        expect(body3.kind).toBe('refuse');
        expect(body3.reason).toBe('quota-daily');
        expect(body3.quota.capUsd).toBe(0.01);
    });

    it('gives an attested staker a higher cap', async () => {
        const store = new InMemoryUsageStore();
        const deps: QuotaGateDeps = {
            config: CFG, store, allowlist: [],
            readStakedUos: async () => 500, // 500 UOS
            readUosPrice: async () => 0.02, // → $10 staked → $0.20/day cap
            now: () => new Date('2026-06-09T12:00:00Z'),
        };
        const app = makeApp(deps, 0.05);
        const res = await post(app, { sessionId: 's1', messages: [] }, { account: 'whale', pubkey: 'PUB', permission: 'active', signableAccounts: [] });
        expect((await res.json()).reply.kind).toBe('answer'); // $0.05 < $0.20 cap
    });

    it('refuses with quota-session when the session soft cap is hit', async () => {
        const store = new InMemoryUsageStore();
        // Pre-load the session over the $0.25 cap.
        store.addSessionMicroUsd('s1', 300_000); // $0.30 > $0.25
        const deps: QuotaGateDeps = { config: CFG, store, allowlist: [], readStakedUos: async () => 0, readUosPrice: async () => 0.02, now: () => new Date('2026-06-09T12:00:00Z') };
        const app = makeApp(deps, 0.001);
        const res = await post(app, { sessionId: 's1', messages: [] });
        const body = await res.json();
        expect(body.kind).toBe('refuse');
        expect(body.reason).toBe('quota-session');
    });
});
```

> Note for the implementer: the unattested-accumulation case is asserted indirectly via the over-cap refuse test (the `ip:` hash is internal). That is intentional — do not expose the key.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- quota-gate`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/middleware/quota-gate.ts`:

```ts
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

import { clientIpOf, logger } from './logging.js';
import type { IdentityVariables } from './attestation.js';
import type { UsageStore } from '../usage/store.js';
import { type QuotaConfig, dailyCapMicroUsd, MICRO } from '../usage/quota-config.js';
import { computeCostUsd } from './usage-log.js';

export type QuotaGateDeps = {
    config: QuotaConfig;
    store: UsageStore;
    allowlist: readonly string[];
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
        const key = identity
            ? `acct:${identity.account}`
            : `ip:${sha256Hex(clientIpOf(c) ?? 'unknown')}`;

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
```

> Refuse shape (verified against the codebase): middleware refuses are the BARE Reply — `ratelimit.ts:198` and `balance-gate.ts:123` both return `c.json({ kind: 'refuse', reason }, 200)` without the route's `{ reply, usage }` wrapper, and the FE's `src/utilities/aiClient.ts` `parse()` explicitly accepts both shapes (`'kind' in body` fallback). The gate follows the middleware convention and adds the structured `quota` payload. Do NOT wrap in `{ reply, usage }` — the `usage` sidecar type requires `cost_usd`/`tokens_in`/`tokens_out`, so `usage: {}` wouldn't typecheck anyway.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- quota-gate`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/quota-gate.ts backend/test/middleware/quota-gate.test.ts
git commit -m "$(printf 'feat(ai): quotaGate middleware — daily cost cap + accumulation (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 7: `GET /api/ai-quota` route

**Files:**
- Create: `backend/src/routes/ai-quota.ts`
- Test: `backend/test/routes/ai-quota.test.ts`

Returns the caller's quota view. Reuses the same identity resolution, store, stake/price readers, and config. Identity is optional (attestation header) — but the route itself does NOT mount the attestation middleware in this task; instead it accepts a pre-resolved identity via `c.var.identity` if a middleware set it, else treats the caller as unattested. Wiring (mounting attestation in front) happens in Task 8.

- [ ] **Step 1: Write the failing test**

Create `backend/test/routes/ai-quota.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createAiQuotaRouter } from '../../src/routes/ai-quota.js';
import { InMemoryUsageStore } from '../../src/usage/store.js';
import { readQuotaConfig } from '../../src/usage/quota-config.js';

const CFG = readQuotaConfig({ QUOTA_RATE_PER_DAY: '0.02', QUOTA_FREE_FLOOR_USD: '0.01', QUOTA_MAX_CAP_USD: '1.00' });

function mount(store: InMemoryUsageStore, identity?: object) {
    const app = new Hono();
    if (identity) app.use('/api/ai-quota', async (c, next) => { c.set('identity', identity); await next(); });
    app.route(
        '/api/ai-quota',
        createAiQuotaRouter({
            config: CFG,
            store,
            allowlist: [],
            readStakedUos: async () => 500,
            readUosPrice: async () => 0.02,
            now: () => new Date('2026-06-09T12:00:00Z'),
        })
    );
    return app;
}

describe('GET /api/ai-quota', () => {
    it('reports the free floor for an unattested caller', async () => {
        const res = await mount(new InMemoryUsageStore()).request('/api/ai-quota?sessionId=s1');
        const b = await res.json();
        expect(res.status).toBe(200);
        expect(b.dailyCapUsd).toBe(0.01);
        expect(b.stakedUos).toBe(0);
        expect(b.spentTodayUsd).toBe(0);
    });

    it('reports the stake-tiered cap for an attested staker', async () => {
        const res = await mount(new InMemoryUsageStore(), { account: 'whale', pubkey: 'P', permission: 'active', signableAccounts: [] })
            .request('/api/ai-quota?sessionId=s1');
        const b = await res.json();
        // 500 UOS * $0.02 = $10 staked → $0.20/day
        expect(b.stakedUos).toBe(500);
        expect(b.dailyCapUsd).toBe(0.2);
    });

    it('reflects spend already accumulated for the identity key', async () => {
        const store = new InMemoryUsageStore();
        // unattested key is ip:<hash of 'unknown'> in test (no connInfo) — assert via attested key instead.
        store.addSpentMicroUsd('acct:whale', '2026-06-09', 50_000); // $0.05
        const res = await mount(store, { account: 'whale', pubkey: 'P', permission: 'active', signableAccounts: [] })
            .request('/api/ai-quota?sessionId=s1');
        const b = await res.json();
        expect(b.spentTodayUsd).toBe(0.05);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- ai-quota`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `backend/src/routes/ai-quota.ts`:

```ts
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
    allowlist: readonly string[];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- ai-quota`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/ai-quota.ts backend/test/routes/ai-quota.test.ts
git commit -m "$(printf 'feat(ai): GET /api/ai-quota — caller quota view (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 8: Wire it into `index.ts` + `.env.example`

**Files:**
- Modify: `backend/src/index.ts`
- Modify: `backend/.env.example`
- Test: extend `backend/test/` app-integration (reuse existing `createApp` test harness if present; otherwise add a focused test below)

- [ ] **Step 1: Write the failing integration test**

Create `backend/test/quota-wiring.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppConfig } from '../src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';

// Minimal mock provider: returns a cheap answer turn.
function mockProvider(): ChatProvider {
    return {
        modelTag: () => 'anthropic:haiku-4-5',
        // The route calls into the harness; for wiring we only need /api/ai-quota,
        // which never calls the provider. Cast to satisfy the interface.
    } as unknown as ChatProvider;
}

const CFG: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'anthropic',
    allowedChainHosts: ['127.0.0.1', 'localhost', '*.ultra.io'],
    balanceThresholdUos: 0, // disable balance gate
};

describe('quota wiring', () => {
    it('mounts GET /api/ai-quota and returns the free floor for an anon caller', async () => {
        const app = await createApp(CFG, {
            provider: mockProvider(),
            readStakedUos: async () => 0,
            readUosPrice: async () => 0.02,
        });
        const res = await app.request('/api/ai-quota?sessionId=s1');
        expect(res.status).toBe(200);
        const b = await res.json();
        expect(b.dailyCapUsd).toBe(0.01);
    });
});
```

> If `createApp`'s `CreateAppDeps` does not yet accept `readStakedUos` / `readUosPrice`, this test fails to typecheck — that is the failing state Step 2 expects.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- quota-wiring`
Expected: FAIL — `createApp` deps don't include `readStakedUos`/`readUosPrice`, or `/api/ai-quota` 404s.

- [ ] **Step 3: Wire `index.ts`**

In `backend/src/index.ts`:

(a) Add imports near the other middleware imports:
```ts
import { quotaGate } from './middleware/quota-gate.js';
import { createAiQuotaRouter } from './routes/ai-quota.js';
import { InMemoryUsageStore } from './usage/store.js';
import { StakeReader } from './usage/stake.js';
import { PriceSource } from './usage/price.js';
import { readQuotaConfig } from './usage/quota-config.js';
```

(b) Extend `CreateAppDeps` with test seams:
```ts
export type CreateAppDeps = {
    provider?: ChatProvider;
    usageLogPath?: string;
    readUosBalance?: (account: string, endpoint: string) => Promise<number>;
    attestationNow?: () => number;
    // W10 test seams:
    readStakedUos?: (account: string, endpoint: string) => Promise<number>;
    readUosPrice?: (endpoint: string) => Promise<number>;
    usageStore?: import('./usage/store.js').UsageStore;
};
```

(c) Inside `createApp`, after `const rateLimitStore = createRateLimitStore();` build the quota deps:
```ts
    // W10 (docs/00 §3.8): per-identity daily cost cap. Single in-memory store
    // shared by the gate and the /api/ai-quota read (single instance, roadmap §9).
    const quotaConfig = readQuotaConfig(process.env);
    const usageStore = deps.usageStore ?? new InMemoryUsageStore();
    const stakeReader = new StakeReader({ allowlist: cfg.allowedChainHosts });
    const priceSource = new PriceSource({
        allowlist: cfg.allowedChainHosts,
        fallbackUsd: quotaConfig.priceFallbackUsd,
        maxAgeS: quotaConfig.priceMaxAgeS,
    });
    const readStakedUos = deps.readStakedUos ?? ((acct, ep) => stakeReader.getStakedUos(acct, ep));
    const readUosPrice = deps.readUosPrice ?? ((ep) => priceSource.getUosPriceUsd(ep));
    const quotaDeps = { config: quotaConfig, store: usageStore, allowlist: cfg.allowedChainHosts, readStakedUos, readUosPrice };
```

(d) Mount `quotaGate` on `/api/ai-chat` AFTER `usageLog` and BEFORE `app.route('/api/ai-chat', ...)`:
```ts
    app.use('/api/ai-chat', usageLog({ logPath: deps.usageLogPath }));
    app.use('/api/ai-chat', quotaGate(quotaDeps)); // W10: after usageLog, before the router
    app.route(
        '/api/ai-chat',
        createAiChatRouter({ provider, catalog, eosioTypes, allowedChainHosts: cfg.allowedChainHosts })
    );
```

(e) Mount the quota read route. The chat chain's attestation middleware is scoped to `/api/ai-chat`, so `/api/ai-quota` needs its own attestation pass to read identity. Mount it before the route:
```ts
    app.use('/api/ai-quota', attestation({
        allowedOrigins: cfg.allowedOrigins,
        expectedChainId: cfg.attestationChainId,
        now: deps.attestationNow,
    }));
    app.route('/api/ai-quota', createAiQuotaRouter(quotaDeps));
```
(Place this near the existing `app.route('/api/ai-usage', ...)`. Keep `/api/ai-usage` unchanged.)

- [ ] **Step 4: Update `backend/.env.example`**

Append (with comments mirroring §3.8 defaults):
```bash
# W10 — per-identity daily cost cap (docs/00 §3.8). All optional; defaults shown.
QUOTA_DISABLED=false
QUOTA_RATE_PER_DAY=0.02          # daily budget = 2% of staked USD value
QUOTA_FREE_FLOOR_USD=0.01        # daily cap at zero stake (anon + no-stake)
QUOTA_MAX_CAP_USD=1.00           # per-identity/day ceiling (saturates ~$50 staked)
QUOTA_SESSION_CAP_USD=0.25       # advisory per-session soft cap
QUOTA_PRICE_MAX_AGE_S=3600       # oracle price staleness threshold (seconds)
UOS_PRICE_USD_FALLBACK=0.004     # UOS/USD when the oracle read is stale/failed (≤ market ≈$0.0041 on 2026-06-10)
```

- [ ] **Step 5: Run the wiring test + full suite**

Run: `npm --prefix backend test -- quota-wiring`
Expected: PASS.
Run: `npm --prefix backend test`
Expected: PASS (no regressions). Run the typecheck the project uses for the backend (e.g. `npm --prefix backend run build` or `tsc -p backend`); expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/index.ts backend/.env.example backend/test/quota-wiring.test.ts
git commit -m "$(printf 'feat(ai): wire quotaGate + /api/ai-quota; document QUOTA_* env (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 9: Frontend — quota badge + refuse hint

**Files:**
- Modify: `src/utilities/aiClient.ts` (add `fetchQuota()`; extend `ReplyRefuse` with an optional `quota` payload)
- Modify: `src/composables/useAiChat.ts` (fetch `/api/ai-quota`; expose `quota` ref; handle `quota-*` refuse)
- Modify: `src/components/ai/CostBadge.vue` (the cost badge — currently reads `getAiUsage` and refreshes on drawer open)
- Modify: `src/components/ai/MessageBubble.vue` (where refuse replies render)

First read the current FE wiring to match patterns exactly:

- [ ] **Step 1: Read the FE files to find the seams**

Run:
```bash
sed -n '1,80p' src/utilities/aiClient.ts
grep -n "ai-usage\|lastUsage\|cost\|badge\|VITE_AI_BACKEND_URL" src/composables/useAiChat.ts
ls src/components/ai
grep -rn "kind === 'refuse'\|reason" src/components/ai
```
Expected: shows how the composable currently calls the backend (base URL, `sessionId`, attestation header), how the cost badge reads usage, and where refuse replies render. Match these patterns; do not introduce a new HTTP client.

- [ ] **Step 2: Add quota fetch + state to `useAiChat.ts`**

Add a `quota` ref and a `refreshQuota()` that GETs `${VITE_AI_BACKEND_URL}/api/ai-quota?sessionId=<sessionId>&endpoint=<activeEndpoint>`, forwarding the SAME `Authorization: Attestation` header the chat request uses. The header-building lives in `src/utilities/aiClient.ts` — add a sibling `fetchQuota()` there and call it from the composable. Also extend `ReplyRefuse` in `aiClient.ts` with the gate's structured payload (optional — only quota refuses carry it):
```ts
export type ReplyRefuse = {
    kind: 'refuse';
    reason: string;
    quota?: {
        spentUsd: number;
        capUsd: number;
        stakedUos: number;
        uosPriceUsd: number;
        nextTier: { stakeUosForMax: number | null; maxDailyUsd: number };
    };
};
```
Quota view shape returned by `fetchQuota()`:
```ts
type QuotaView = {
    spentTodayUsd: number; dailyCapUsd: number; stakedUos: number;
    uosPriceUsd: number; sessionSpentUsd: number;
    nextTier: { stakeUosForMax: number | null; maxDailyUsd: number };
};
```
Call `refreshQuota()` on chat-panel open and after each turn completes (next to where `lastUsage` is already updated). Keep it best-effort: on fetch failure, leave the previous value (never throw into the UI).

- [ ] **Step 3: Render the badge + refuse hint**

- Badge (`CostBadge.vue`): show `spentTodayUsd / dailyCapUsd` (format as `$0.004 / $0.20`). If `quota` is null, fall back to the existing global-usage display (`getAiUsage`).
- Refuse hint (`MessageBubble.vue`, where `kind === 'refuse'` renders): add a branch for `reason === 'quota-daily'` / `'quota-session'` that shows: "Daily AI budget reached ($X used of $Y). Stake UOS to raise your limit — staking ~N UOS unlocks the $Z/day max." using `reply.quota.{spentUsd,capUsd,nextTier.stakeUosForMax,nextTier.maxDailyUsd}`. Text only (no auto-compose — see spec §7).

- [ ] **Step 4: Verify in the running app**

This is a previewable change. Verify per the preview workflow:
```
# Backend (separate shell): npm --prefix backend run dev  (or the project's backend start script)
# Frontend dev server is started by preview_start.
```
- Start the preview (`preview_start`), open the AI chat panel.
- `preview_snapshot` → confirm the badge shows `spent / cap`.
- Drive a turn; `preview_network` → confirm a `GET /api/ai-quota` fires and returns the expected shape; `preview_console_logs` → no errors.
- To see the refuse hint without spending real budget: temporarily set `QUOTA_FREE_FLOOR_USD=0` on the backend and send one turn → expect the `quota-daily` hint to render. Revert the env after.
- `preview_screenshot` → capture the badge + the refuse hint as proof; share with the user.

- [ ] **Step 5: Run FE typecheck/build + commit**

Run: `npm run build`
Expected: `vue-tsc` + `vite build` green.

```bash
git add src/utilities/aiClient.ts src/composables/useAiChat.ts src/components/ai
git commit -m "$(printf 'feat(ai): FE quota badge + stake-to-raise refuse hint (W10)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 10: Code-simplifier pass + final verification

Per `backend/CLAUDE.md` / roadmap §7.1 — mandatory before the wave's final state.

- [ ] **Step 1: Run the full backend suite + typecheck + FE build**

Run: `npm --prefix backend test`  → Expected: PASS.
Run: the backend typecheck (`npm --prefix backend run build` or `tsc -p backend --noEmit`) → Expected: no errors.
Run: `npm run build` → Expected: green.
Run: `bash scripts/ai-ci-greps.sh` → Expected: green (no new banned tokens; no new tool name, so grep #8 is unaffected).

- [ ] **Step 2: Dispatch the code-simplifier over the wave diff**

Take `git diff --name-only main...HEAD` (excluding `*.md` docs and `.env.example`) and dispatch the `code-simplifier` subagent with the §7.1 brief. **Exclusions (do NOT simplify):** the cap formula in `quota-config.ts`, the degrade-safe fallbacks in `stake.ts`/`price.ts`, the refuse/accumulate branches in `quota-gate.ts` (load-bearing per §3.8), and all tests/fixtures.

- [ ] **Step 3: Re-run tests after the simplifier**

Run: `npm --prefix backend test` and `npm run build`.
Expected: PASS. Any file the simplifier breaks → revert that file's simplifier diff and note it.

- [ ] **Step 4: Final commit (if the simplifier changed anything)**

```bash
git add -A
git commit -m "$(printf 'refactor(ai): simplifier pass over W10 quota wave\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

- [ ] **Step 5: Deployment note (Helm) — record, do not execute here**

Add a one-line note to the PR body (not code): the W10 service MUST deploy with `replicaCount: 1` and `autoscaling.enabled: false` (spec §11) so the in-memory counters are authoritative — and confirm the deployed `eosio.oracle` feed matches the `ORACLE_*` constants in `price.ts` (spec §13.1), else rely on `UOS_PRICE_USD_FALLBACK`. The Helm chart / ArgoCD values live in `~/ultra/helm-charts` + `~/ultra/ultra-apps` and are a separate deploy PR, out of scope for this code wave.

---

## Self-review notes (author)

- **Spec coverage:** §4 formula → Task 2; §4.1 micro-USD → Tasks 2/3; §5.1 store → Task 3; §5.2 stake → Task 4; §5.3 price → Task 5; §5.4 gate → Task 6; §5.5 route → Task 7; §6 semantics (check-then-accumulate, UTC day, identity precedence, degrade-safe) → Tasks 2/6; §7 FE → Task 9; §8 docs → Task 1; §9 env → Task 8; §11 deploy → Task 10 step 5; §12 tests → each task's tests; §13 verification → Pre-flight + Task 5 note.
- **Type consistency:** `dailyCapMicroUsd(cfg, stakedUos, uosPriceUsd)`, `MICRO`, `UsageStore` method names, `QuotaGateDeps`/`AiQuotaDeps` reader signatures (`readStakedUos(account, endpoint)`, `readUosPrice(endpoint)`), and the bare middleware refuse shape `{ kind: 'refuse', reason, quota }` (matching `ratelimit.ts` / `balance-gate.ts`) are used identically across Tasks 2–8 and in the §3.8 doc text (Task 1).
- **Resolved during review (2026-06-10):** the refuse shape is no longer an open question — verified that middleware refuses are bare Reply (`ratelimit.ts:198`, `balance-gate.ts:123`) and `src/utilities/aiClient.ts` `parse()` accepts both shapes; the gate uses the bare shape. The in-memory store is bounded (session eviction + stale-day pruning) per spec §5.1 — `sessionId`/`ip:` keys are attacker-influenced, so unbounded maps were a memory-growth vector.
- **Known soft spots flagged for the implementer (not placeholders):** the oracle row shape/scope (Task 5 note + Pre-flight) and the FE seams (Task 9 step 1 reads them first). Each has an explicit verification step rather than an assumption baked silently into shipped logic.
