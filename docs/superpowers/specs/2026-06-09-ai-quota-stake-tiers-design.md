# AI Quota — Stake-to-Unlock Daily Cost Caps (W10)

> Status: design / approved-in-substance, pending spec review.
> Branch: `feature/ai-enhancement`.
> Canonical docs this binds to: `docs/01-ai-enhancement-roadmap.md` (§6 wave list),
> `docs/00-ai-global-guidelines.md` (§3 identity/rate-limit/cost model, §4.2 RPC allowlist).
> This spec proposes a new wave **W10** and the doc edits it requires.

---

## 1. Goal

Add a **cost-based** daily cap to the AI backend, on top of the existing
request-count rate limits, and let a user **raise their own daily cap by staking
UOS** on-chain. Staking is a refundable bond — no money is spent, no new
contract is deployed. The backend reads the account's staked UOS, converts it to
a USD/day budget via a live price, and refuses once the day's accumulated LLM
spend reaches that budget.

This closes the gap the current model leaves open: today the only cost defense
is per-IP request *counts* plus a global `$50/month` backstop (guidelines §3.2).
Nothing caps the *dollar* spend of a single identity per day, and there is no
per-user way to earn more budget.

---

## 2. Context & what we reuse

- **Backend is anonymous + stateless, no database** (roadmap decision 1, §9;
  `backend/CLAUDE.md` hard rule 1). In-process counters + JSONL are the
  sanctioned state model. `balance-gate.ts` already states "single instance v1
  per roadmap §9" — our storage choice aligns with a locked decision, it does
  not introduce a new one.
- **Identity is dual-path (W9, guidelines §3.7).** Attested requests carry
  `Authorization: Attestation` → `c.var.identity = { pubkey, account, … }`
  (account is signature-verified, never FE-supplied). Unattested requests fall
  back to per-IP. We key the daily cost cap the same way.
- **`balance-gate.ts` is the template.** It runs after attestation, reads chain
  state for the verified active account only, caches per `(endpoint, account)`
  for 5 min, injects a stub reader for tests, and refuses with HTTP 200
  `{ kind: 'refuse', … }`. The quota gate mirrors this exactly.
- **`usage-log.ts` already computes per-turn cost.** `computeCostUsd(modelTag,
  tokensIn, tokensOut)` is exported; the route sets `c.var.lastUsage` and
  `c.var.providerModel`. We reuse `computeCostUsd` — we do **not** re-derive
  pricing and do **not** modify the §7 row schema (CI greps its keyset).
- **`get_table_rows` tool + allowlist** (`pipeline/tools/get_table_rows.ts`,
  guidelines §4.2) is the read path for both `eosio.system/userres` (stake) and
  `eosio.oracle` (price). Its `TABLE_ALLOWLIST` is CI-synced to the §4.2
  markdown — adding rows is a doc-first change.

---

## 3. Non-goals (YAGNI)

- **No new smart contract.** Staked UOS is read from `eosio.system/userres`.
- **No prepaid/credit ledger.** Stake is a threshold that unlocks a daily cap;
  it is never consumed or burned down.
- **No database, no Redis, no external price API.** In-memory store + on-chain
  oracle, behind interfaces so a Redis impl can drop in later (deferred, §9 of
  the roadmap already lists "cross-process rate limiting (Redis)" as post-v1).
- **No cross-replica coordination.** Single replica (see §11). Multi-replica is
  the future `UsageStore`-swap, not this wave.
- **Per-session cap is advisory only** (client controls `sessionId`).

---

## 4. Economic model

Continuous linear mapping from staked value to a daily USD budget:

```
stakedUos   = eosio.system/userres.power_weight  (scope = verified account)
uosPriceUsd = eosio.oracle moving-average  (cached ~5 min; config fallback when stale)
dailyCapUsd = clamp(stakedUos * uosPriceUsd * RATE, FREE_FLOOR, MAX_CAP)
```

Locked defaults (all env-configurable):

| Param | Value | Meaning |
|---|---|---|
| `QUOTA_RATE_PER_DAY` | `0.02` | Daily budget = 2% of staked USD value (→ locked stake is 50× the daily budget) |
| `QUOTA_FREE_FLOOR_USD` | `0.01` | Daily budget at zero stake (anon + connected-no-stake) |
| `QUOTA_MAX_CAP_USD` | `1.00` | Per-user/day ceiling; saturates at ~$50 of staked UOS |
| `QUOTA_SESSION_CAP_USD` | `0.25` | Advisory per-session soft cap (runaway-conversation guard) |

Resulting curve:

| Staked (USD value) | Daily cap |
|---|---|
| $0 (anon / no stake) | $0.01 |
| $1 | $0.02 |
| $10 | $0.20 |
| $25 | $0.50 |
| ≥ $50 | $1.00 (max) |

Notes:
- Per-turn cost on Haiku 4.5 targets ≈ $0.0008 (roadmap §3), so the $0.01 free
  floor is ~a dozen small turns/day; $1.00 max is ~1,200 turns/day.
- The global `$50/month` sponsor cap (§3.2 tier 5) **still binds** above all of
  this as the ultimate backstop.
- **Only attested accounts can exceed the free floor.** Unattested (per-IP)
  callers have no verified account, so they always get `FREE_FLOOR`. This is
  intentional Sybil resistance: spending the sponsor's money beyond the floor
  requires proving account ownership *and* locking UOS.

### 4.1 Spend accounting precision

Track accumulated spend in **integer micro-USD** (1e-6 USD), not floats. Turn
costs are sub-cent (`computeCostUsd` already rounds to 6 decimals); integer
accumulation avoids drift across hundreds of turns. Caps are compared in the
same unit (`capUsd * 1e6`).

---

## 5. Architecture & components

All new code under `backend/src/`. Three thin interfaces (each one impl now,
swap-ready):

### 5.1 `usage/store.ts` — `UsageStore` (in-memory)

```ts
interface UsageStore {
  getSpentMicroUsd(key: string, dayUtc: string): number;
  addSpentMicroUsd(key: string, dayUtc: string, deltaMicroUsd: number): number; // returns new total
  getSessionMicroUsd(sessionId: string): number;
  addSessionMicroUsd(sessionId: string, deltaMicroUsd: number): number;
}
```

- `Map`-backed. Daily key resets lazily when `dayUtc` rolls over (compare stored
  day; reset on mismatch). Session totals kept in a bounded LRU-ish map.
- Identity key: `acct:<account>` (attested) or `ip:<sha256(ip)>` (unattested),
  reusing the existing hashing (`clientIpOf`).
- Process-lifetime only (single instance). Documented as such, mirroring
  `balance-gate.ts`'s cache comment.

### 5.2 `usage/stake.ts` — `StakeReader`

- `getStakedUos(account, endpoint): Promise<number>`: `get_table_rows` on
  `(eosio.system, userres)`, scope = account, read `power_weight` (an `asset`),
  divide by UOS precision (4 → ÷10⁴). Missing row → `0`.
- **Self-stake only.** `userres.power_weight` is "my staked UOS" as a user sees
  it. Delegated-out (`delband`) is out of scope (decided in brainstorm).
- Cache per `(endpoint, account)` for ~5 min (stake rarely changes); same TTL
  and injectable-reader pattern as `balance-gate.ts` (tests stub the reader).
- Requires allowlist row `(eosio.system, userres)` (see §8).

### 5.3 `usage/price.ts` — `PriceSource`

- `getUosPriceUsd(endpoint): Promise<number>`: read the `eosio.oracle`
  moving-average price via `get_table_rows`, normalize by the feed's precision
  (8-decimal `DUOS` per exploration → ÷10⁸), check the row's `timestamp` for
  staleness.
- **Staleness fallback:** if the oracle read fails, returns ≤0, or is older than
  `QUOTA_PRICE_MAX_AGE_S` (default 3600s), fall back to env constant
  `UOS_PRICE_USD_FALLBACK` (default e.g. `0.02`). Never throw into the gate —
  fail to the fallback so a flaky oracle never blocks chat.
- Cache the price for ~5 min per endpoint.
- Requires allowlist row `(eosio.oracle, <table>)` — see §13 (exact table/scope/
  param is a pre-implementation verification item).

### 5.4 `middleware/quota-gate.ts` — the gate (straddles `next()`)

Runs **after** attestation + balance-gate, **after** the existing rate-limit,
wrapping the route handler (same straddle position as `usage-log`):

1. Resolve identity key (`acct:` / `ip:`) and `sessionId`.
2. Compute `dailyCapUsd`:
   - attested → `clamp(stakedUos × uosPriceUsd × RATE, FREE_FLOOR, MAX_CAP)`
   - unattested → `FREE_FLOOR`
   (stake + price both cached; a read failure on either degrades safely — stake
   read fail → treat as 0 stake → free floor; price fail → fallback constant.)
3. Read `store.getSpentMicroUsd(key, today)` and `getSessionMicroUsd(sessionId)`.
4. If `spentToday ≥ dailyCapUsd` → **short-circuit** HTTP 200
   `{ kind: 'refuse', reason: 'quota-daily', quota: { spentUsd, capUsd, stakedUos, uosPriceUsd, nextTier } }`
   (same `quota` shape as `GET /api/ai-quota` in §5.5, minus `spentTodayUsd`).
   If `sessionSpend ≥ SESSION_CAP` → `reason: 'quota-session'`.
   (HTTP 200 + `kind: refuse` matches §3.2 — never 429, avoids retry storms.)
5. Otherwise `await next()`, then in `finally`: read `c.var.lastUsage` +
   `c.var.providerModel`, `computeCostUsd(...)`, convert to micro-USD, and
   `store.addSpentMicroUsd` + `addSessionMicroUsd`. Best-effort; a store write
   never fails the request (mirrors `usage-log`).

`reason` strings extend the existing refuse-reason set (`rate-limit-*`,
`sponsor-cap`, `insufficient-uos`).

### 5.5 `GET /api/ai-quota` — caller's quota view

New read-only route returning the caller's current numbers for the FE badge:

```jsonc
{ "spentTodayUsd": 0.004, "dailyCapUsd": 0.02, "stakedUos": 50.0,
  "uosPriceUsd": 0.02, "sessionSpentUsd": 0.001,
  "nextTier": { "stakeUosForMax": 2500.0, "maxDailyUsd": 1.00 } }
```

Reuses the same `UsageStore` / `StakeReader` / `PriceSource`. Identity resolved
the same way (attestation header optional). Keep the existing global aggregate
endpoint (`GET /api/ai-usage`) unchanged.

---

## 6. Enforcement semantics

- **Check-then-accumulate.** The gate rejects only when *already* at/over cap;
  the last allowed turn may slightly overshoot, bounded by the harness's
  `max_output_tokens` (guidelines §4.7). No pre-reservation/estimate machinery.
- **Window:** UTC calendar day (`dayUtc = ts.slice(0,10)`), configurable later
  if needed. Counter auto-resets lazily on day rollover.
- **Identity precedence:** verified attested account > hashed IP. Mutually
  exclusive per request, exactly like the §3.7 rate-limit key.
- **Degrade-safe reads:** stake/price read failures never block chat; they
  collapse the user to the free floor (stake) or the fallback price.

---

## 7. Frontend

`src/components/ai/` + `useAiChat.ts` only (roadmap decision 10 freezes
everything else):

- Extend the existing cost badge to show `spent / cap today` from
  `GET /api/ai-quota` (the composable already polls usage).
- On a `quota-daily` / `quota-session` refuse, render the structured hint inline:
  "Daily AI budget reached — stake UOS to raise your limit" with the
  `nextTier` numbers.
- Optional (nice-to-have, can defer): a button that asks the AI to compose a
  `eosio.system::delegatebw` action to stake, routed through the existing
  in-card signer / `<Transaction>` modal — the AI helping a user raise their own
  cap. Gated behind the normal validation pipeline; no special path.

---

## 8. Required canonical-doc edits (DOC-FIRST — own PR)

Per roadmap §2 ("schema changes are their own PR; one concept per PR") and §4.2
("new tool / new allowlist row → doc change first, then PR"), these land
**before** code, ideally as PR 1 of the wave:

1. **`docs/00-ai-global-guidelines.md §4.2`** — add allowlist rows
   `(eosio.system, userres)` and `(eosio.oracle, <table>)`. The
   `get_table_rows.ts` sync test + CI grep #8 will then pass.
2. **`docs/00-ai-global-guidelines.md §3`** — add **§3.8 "Per-identity daily
   cost cap (stake-tiered)"** describing the formula, the attested-only-above-
   floor rule, the degrade-safe behavior, and the new refuse reasons
   (`quota-daily`, `quota-session`). Note it composes with §3.2/§3.7, does not
   replace them, and the global monthly cap still binds.
3. **`docs/01-ai-enhancement-roadmap.md §6`** — add row **W10 — Stake-tiered
   daily cost cap**, with acceptance criteria and the guidelines §s it satisfies
   (§3.8, §4.2, §7). Update §9 if any sub-item is explicitly deferred.

---

## 9. Configuration (env, documented in `backend/.env.example`)

```
QUOTA_RATE_PER_DAY=0.02
QUOTA_FREE_FLOOR_USD=0.01
QUOTA_MAX_CAP_USD=1.00
QUOTA_SESSION_CAP_USD=0.25
QUOTA_PRICE_MAX_AGE_S=3600
UOS_PRICE_USD_FALLBACK=0.02
QUOTA_DISABLED=false        # master kill-switch: when true, gate is a no-op (like BALANCE_THRESHOLD_UOS=0)
```

A `QUOTA_DISABLED=true` no-op path (no stake/price reads at all) mirrors
`balance-gate`'s `thresholdUos<=0` escape hatch — lets ops disable the whole
feature instantly without redeploying code.

Also: move `ANTHROPIC_API_KEY` out of `backend/.env` into the cluster's
ExternalSecret/Vault path on deploy (surfaced during exploration; not strictly
part of W10 but should ride along with the Helm work).

---

## 10. Security alignment

- **No new trust boundary on the LLM path** — the gate reads chain state and
  gates a counter; it touches neither the prompt nor the validation gates.
- **Account is signature-verified** (`identity.account`, §3.7 / RFC §5.6) — a
  caller cannot claim another account's stake.
- **Stake read is the active account only**, one RPC, cached — same
  anti-burst reasoning as balance-gate (no `signableAccounts` fan-out).
- **Citation gate unaffected**: quota numbers are server-computed telemetry,
  never injected into LLM context, so they cannot leak into a reply or be
  spoofed via prompt injection.
- **CI greps**: no new banned tokens introduced (no JWT, no `c.var.auth`, no
  provider `fetch` outside `src/llm/`). The gate sets `c.var.quota`, reads no
  `JWT_SECRET`.

---

## 11. Deployment (GKE / Helm)

Copy `helm-charts/starter/backend`; per-env values in `ultra-apps` (ArgoCD).

- **`replicaCount: 1`, `autoscaling.enabled: false`.** Required for the
  in-memory store to be a true single source of truth. This *also fixes a latent
  bug*: today's in-process rate buckets + the `$50/mo` global cap are per-pod, so
  at `replicaCount: 2` the real ceiling is doubled. Single replica makes §3.2 /
  §3.7 correct as written.
- Config via ConfigMap (the `QUOTA_*` vars, per-env RPC `nodeEosUrl`); secrets
  (`ANTHROPIC_API_KEY`) via ExternalSecret → Vault.
- `/api/ai-quota` and existing routes behind the standard NGINX ingress;
  `limit-connections` annotation stays as a coarse pre-filter.
- When multi-replica becomes necessary, swap `UsageStore` for a Redis impl
  (roadmap §9 already names this) — no enforcement-logic change.

---

## 12. Testing

Unit:
- `UsageStore`: accumulate, day rollover reset, key isolation, session totals,
  micro-USD integer math.
- Tier formula: boundaries ($0 → floor, exact $50 → max, clamp above), attested
  vs unattested.
- `StakeReader`: `power_weight` asset parse + precision, missing row → 0, read
  failure → 0 (degrade-safe), cache hit/expiry.
- `PriceSource`: precision normalize, stale timestamp → fallback, read failure →
  fallback, cache.

Middleware/integration (mock RPC + mock provider cost, inject readers):
- Allows under cap; refuses at cap with correct `reason` + `quota` payload
  (HTTP 200).
- Attested account with N staked UOS gets the expected cap; unattested gets
  free floor.
- Accumulation: a turn's `computeCostUsd` is added to the daily + session totals.
- `QUOTA_DISABLED=true` → gate is a pure no-op, no RPC reads.
- `get_table_rows` allowlist sync test passes with the two new rows.

Determinism/contract: no change to the §6 baseline (quota gates *access*, not
*which action* is emitted).

---

## 13. Pre-implementation verification items

These must be confirmed against the deployed testnet **before** wiring
`PriceSource` (the oracle contract is generic; the live feed depends on deployed
config):

1. The exact `eosio.oracle` **table, scope, and `param`** (SMA window) that
   represents the canonical live UOS/USD rate, and its **symbol precision**
   (exploration saw `8,DUOS` on `finalaverage`). Pick the row used and pin it.
2. The UOS **symbol precision** on `userres.power_weight` (assumed `4,UOS` —
   confirm against a real account row).
3. That the public RPC endpoints in use return `userres` and the oracle table
   via `get_table_rows` without auth (they should — same as existing reads).

The `UOS_PRICE_USD_FALLBACK` constant is the safety net if (1) is wrong or the
feed is unavailable, so this is verification, not a blocker.

---

## 14. Open questions / risks

- **Oracle feed identity (item 13.1)** is the only real unknown; fallback
  constant de-risks it.
- **Free floor on shared IPs**: $0.01/day per IP could pinch carrier-NAT pools
  for unattested users. Mitigated because the existing per-IP *count* limits
  already shape that traffic, and connecting a wallet (attested) lifts them off
  the IP key entirely. Tunable.
- **Price drift between cache refreshes** (≤5 min) is immaterial at this cap
  granularity.
