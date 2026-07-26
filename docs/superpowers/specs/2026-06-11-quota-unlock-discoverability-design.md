# AI Quota & Unlock Discoverability — Design

> Status: design / approved-in-substance, pending spec review.
> Branch: `feature/ai-enhancement`.
> Builds on W9 (UOS balance gate, `docs/00 §3.7`) and W10 (stake-tiered daily
> cost cap, `docs/00 §3.8`). This is a UX/discoverability follow-up, not a new
> gate — both gates already exist and bind server-side.

---

## 1. Goal

Surface, **proactively** (on chat-drawer open) and with **real numbers**, two
things a user currently only discovers by being blocked mid-send:

1. **Minimum UOS to unlock AI chat** (W9 balance gate). Today the only UI is a
   reactive refuse line ("…doesn't hold enough UOS…") with no threshold number.
2. **Daily AI budget + how to raise it** (W10 quota). Today the spent/cap badge
   is operator-only (`isDev`), so end users never see their cap until they hit
   it; the "stake UOS to raise" hint appears only on a `quota-daily`/
   `quota-session` refuse.

Staking remains a **deliberate manual action** — the UI is informational only,
never auto-composing a stake transaction (W10 spec §7: `eosio.system` is
undeployed/not in the catalog, so the planner cannot emit `delegatebw`).

---

## 2. Two distinct numbers (do not conflate)

- **Unlock threshold (W9):** *liquid* UOS balance of the verified active account
  (`get_currency_balance`), compared against `BALANCE_THRESHOLD_UOS`. Below it →
  chat is refused (`insufficient-uos`).
- **Daily-cap tier (W10):** *staked* UOS (`eosio/userres.power_weight`) → priced
  → `dailyCapUsd`. Raising the cap means **staking**, which is separate from
  holding the liquid unlock minimum.

The UI must keep these visibly separate: "hold ≥ N UOS to use AI" vs "stake UOS
to raise your daily budget".

---

## 3. Backend — extend `GET /api/ai-quota`

One endpoint, one fetch, powers every proactive display. Add three fields to the
existing response (all W10 fields unchanged):

```jsonc
{
  // existing (W10):
  "spentTodayUsd": 0.004, "dailyCapUsd": 0.20, "stakedUos": 500,
  "uosPriceUsd": 0.004, "sessionSpentUsd": 0.001,
  "nextTier": { "stakeUosForMax": 12500, "maxDailyUsd": 1.0 },

  // new (this design):
  "heldUos": 12.5,        // liquid UOS of the verified active account
  "thresholdUos": 1.0,    // BALANCE_THRESHOLD_UOS — the unlock minimum
  "locked": false         // see semantics below
}
```

### 3.1 Field semantics

- `thresholdUos` = the balance gate's configured threshold (`cfg.balanceThresholdUos`,
  default `1.0`). Reported as-is.
- `heldUos` = liquid UOS of `identity.account`, read via the **same reader the
  W9 gate uses** (`readUosBalance` seam → `get_balance`/`get_currency_balance`,
  host-allowlist-guarded). `0` when anonymous or when the read fails.
- `locked` = `isAttested && thresholdUos > 0 && heldUos < thresholdUos`.

### 3.2 Mirror the gate's rules exactly (so the badge never lies)

- **Anonymous** caller (no `c.var.identity`): no balance read, `heldUos: 0`,
  `locked: false` — anonymous users run at the free floor and are never balance-
  gated (`balance-gate.ts:82-85` passes them through).
- **`thresholdUos <= 0`** (gate disabled): no balance read, `locked: false`.
- **Read failure (attested):** `heldUos: 0` → `locked: true`. This matches the
  gate's **fail-closed** behavior (`balance-gate.ts:114`, counts a failed read as
  0 UOS and refuses). The badge therefore agrees with what a real send would do.
- The unlock fields are **independent of `QUOTA_DISABLED`**. `QUOTA_DISABLED`
  governs the W10 cap fields only; the balance gate is a separate feature. When
  `QUOTA_DISABLED=true` the route still reports `heldUos`/`thresholdUos`/`locked`
  from the balance config, and the cap fields fall to the free floor as today.

### 3.3 Wiring

- `AiQuotaDeps` gains `readUosBalance: (account, endpoint) => Promise<number>`
  and `thresholdUos: number`.
- In `index.ts`, the shared `quotaDeps` is extended to pass the same
  `readUosBalance` (the `deps.readUosBalance ?? default` already constructed for
  the balance gate) and `cfg.balanceThresholdUos ?? 1.0`.
- The balance read is cached the same way the gate caches (per `endpoint|account`,
  ~5 min) — a dedicated small cache in the route, or reuse via the injected
  reader. Since the gate and route hold separate reader instances, each keeps its
  own cache; acceptable (the route is hit on drawer-open + per-turn refresh).

### 3.4 The reactive `insufficient-uos` refuse

Left **unchanged** (`balance-gate.ts:123`, bare `{ kind, reason }`). The proactive
unlock panel (FE §4) now carries the numbers, so enriching the refuse is
redundant. (If we later want the numbers in the refuse too, the gate already has
`uos` and `thresholdUos` in scope — a one-line follow-up, out of scope here.)

---

## 4. Frontend — three drawer states

`ChatDrawer.vue` already fetches `quota` on open. Render the footer / usage area
by state:

### 4.1 Anonymous (`!loggedIn`)
Existing sign-in CTA, plus one teaser line:
> "Sign in and stake UOS to raise your daily AI budget."

### 4.2 Logged in + locked (`quota?.locked === true`)
**Replace the textarea** with an unlock panel mirroring the sign-in CTA structure:
> "AI needs ≥ {thresholdUos} UOS. Your account holds {heldUos} UOS."

No input, no send button (prevents a wasted call that would only refuse). When
`quota` later reports `locked:false` (balance cleared / re-fetched), the normal
input returns. If `quota` is `null` (fetch failed), fall back to showing the
normal input — never hard-lock the UI on a missing fetch.

### 4.3 Logged in + unlocked
Normal input, plus a **usage line directly under the input** (Claude-desktop-style
"usage under the chat"), folded into the existing
`Cmd/Ctrl+Enter · {n}/{MAX}` hint row so no new band is added:
> "Daily AI budget: ${spentTodayUsd} / ${dailyCapUsd} · stake UOS to raise"

The "stake UOS to raise" portion is informational (inline text or title tooltip):
when `nextTier.stakeUosForMax !== null`, "stake ~{N} UOS for the ${Z}/day max".
Text only — no button, no transaction compose.

If `quota` is `null` (fetch not yet returned / failed), omit the budget line
silently (don't show `$0.00 / $0.00`).

### 4.4 Number formatting
- USD: `toFixed(4)` for spent, `toFixed(2)` for caps (consistent with CostBadge).
- UOS: `toLocaleString()` for `heldUos`/`thresholdUos`/`stakeUosForMax`.
- All values `Number(...)`-coerced before formatting (defensive, matching the
  W10 `fetchQuota` parse discipline).

### 4.5 Operator badge unchanged
The header `CostBadge` stays `isDev`-only — it shows sponsor-budget telemetry not
meant for end users. The new under-input budget line is the user-facing surface.

---

## 5. Components touched

| File | Change |
|---|---|
| `backend/src/routes/ai-quota.ts` | Add `readUosBalance` + `thresholdUos` to deps; compute + return `heldUos`/`thresholdUos`/`locked` per §3 |
| `backend/src/index.ts` | Pass `readUosBalance` + `cfg.balanceThresholdUos` into the shared `quotaDeps` |
| `src/utilities/aiClient.ts` | Extend `QuotaView` with `heldUos`/`thresholdUos`/`locked` (Number-coerced) |
| `src/components/ai/ChatDrawer.vue` | Three-state footer: anon teaser, locked unlock-panel, unlocked under-input budget line |
| `docs/00-ai-global-guidelines.md` | Note in §3.8 that `/api/ai-quota` also surfaces the unlock threshold/held/locked |

No change to `quota-gate.ts`, `MessageBubble.vue` (its W10 quota-refuse hint
stays), `CostBadge.vue`, or `balance-gate.ts`.

---

## 6. Testing

**Backend (`backend/test/routes/ai-quota.test.ts`, extend):**
- attested, `heldUos < thresholdUos` → `locked: true`, fields echoed.
- attested, `heldUos >= thresholdUos` → `locked: false`.
- anonymous → `heldUos: 0`, `locked: false`, balance reader **not called**.
- `thresholdUos <= 0` → `locked: false`, balance reader **not called**.
- balance reader throws → `heldUos: 0`, `locked: true` (fail-closed).
- Inject `readUosBalance` as a stub (no live RPC), same pattern as the existing
  stake/price stubs.

**Frontend:**
- `npm run build` green (vue-tsc + vite).
- Live preview (as with W10): the three states render with correct numbers —
  anon teaser, locked panel (held/threshold), unlocked under-input budget line.

**Wiring (`backend/test/quota-wiring.test.ts`, extend or add):**
- anon GET `/api/ai-quota` returns the new fields with `locked:false`.

---

## 7. Non-goals / constraints

- **No auto-composed staking.** Informational text only (W10 §7).
- **No new gate.** Both gates already enforce server-side; this only surfaces
  their state. The FE never becomes the source of truth — a stale/`null` quota
  fetch must never lock a user the server would allow (§4.2 fallback).
- **No change to the operator-only `CostBadge`** or to sponsor-budget exposure.
- **One concept per PR** (roadmap §2): this is the discoverability layer over
  W9+W10, not a behavioral change to either gate.

---

## 8. Open questions / risks

- **Extra balance RPC on the quota route.** The route now does a
  `get_currency_balance` read (cached ~5 min). Hit only on drawer-open + per-turn
  refresh, degrade-safe — negligible. Mirrors the gate's existing read.
- **`heldUos` momentarily stale vs a just-sent stake/transfer** (≤ cache TTL).
  Immaterial at this granularity; the server gate is always authoritative on the
  next send.
