# Handoff: AI balance gate → active-account-only + `BALANCE_THRESHOLD_UOS=0` disables it

> Branch: `feature/ai-enhancement`. Self-contained — assumes no memory of the prior session.

## Why this is needed (confirmed live)

The AI backend's UOS balance gate (`backend/src/middleware/balance-gate.ts`) gates attested
`POST /api/ai-chat` requests: it reads the caller's UOS balance and refuses with
`{ kind: 'refuse', reason: 'insufficient-uos' }` below a threshold.

It currently **sums UOS across the attestation's entire `signableAccounts` list**. That is wrong for
Ultra accounts: a wallet key is frequently an *authority* on many other accounts, so the wallet's
attestation enumerates **75–100+ accounts** for admin/governance keys. Summing that list:

- Fires one `get_currency_balance` RPC **per account** → 75+ sequential calls per turn → the public
  RPC node (`ultra.eosusa.io`) throttles the burst → reads fail → the gate counts 0 → **false
  `insufficient-uos`** even when the active account holds plenty.
  - **Reproduced:** account `ultra.prop1` holds 100.94 UOS on mainnet, but every AI turn refused
    `insufficient-uos`; its attestation listed **75** `signableAccounts`. A single-account test call
    for the same account/endpoint passed — proving the burst is the cause.
- Is also semantically wrong: the gating balance should be the user's **active/selected account**,
  not the sum of every account their admin key can touch.

## What to change

### 1. `backend/src/middleware/balance-gate.ts` — active account only + threshold-0 skip
- **Gate on the active account only.** Read UOS for `identity.account` (the VERIFIED attestation
  payload's primary account, already on `c.var.identity`) with a **single** `get_currency_balance`
  read. **Delete the `for (… of identity.signableAccounts)` loop.**
  - Security (RFC §5.6) preserved: `identity.account` comes from the cryptographically-verified
    payload — never an FE-supplied value.
- **`thresholdUos <= 0` disables the gate.** Short-circuit at the top of the handler: when
  `deps.thresholdUos <= 0`, set `c.set('totalUos', 0)` and `await next()` with **NO RPC read**. This
  is the explicit "gate off" switch operators expect from `BALANCE_THRESHOLD_UOS=0`.
- **Keep:** the `!identity` anonymous no-op; the 5-min in-process cache (now keyed on the single
  active account, `${endpoint}|${identity.account}`); `endpointFromBody`; fail-closed-on-read-error
  (read throws → count 0 → refuse); the bare `c.json({kind:'refuse',reason:'insufficient-uos'}, 200)`;
  and `c.set('totalUos', uos)` on pass.
- The `BalanceGateDeps.readUosBalance(account, endpoint)` injectable stays (tests stub it).

### 2. Tests — `backend/test/middleware/balance-gate.test.ts`
Rewrite for the new behavior:
- attested + active account ≥ threshold → pass (assert reader called exactly **once**), `totalUos` set.
- attested + active account < threshold → `{ kind:'refuse', reason:'insufficient-uos' }`.
- **`thresholdUos: 0` → pass with NO read** (assert the injected reader is **never** called).
- anonymous (no identity) → no-op pass, reader never called.
- (optional) cache: a second turn for the same `(endpoint, account)` within TTL does not re-read.
Delete the multi-account summing assertions.
Also check `backend/test/routes/ai-chat.attested.test.ts` (it injects `readUosBalance` + asserts
insufficient-uos / pass). Its fixture uses a single-account attestation, so it should still pass —
verify and adjust if it assumed summing.

### 3. Docs
- `docs/proposals/wallet-native-attestation.md` §9 step 6 (and any §5.6 wording that says "sum UOS
  across `payload.signableAccounts`") → change to: gate on the **active account** (`payload.account`)
  only, with the rationale above (admin keys sign for 100+ accounts; summing is impractical and
  semantically wrong). Note `signableAccounts` stays signature-covered but the gate no longer sums it.
- `backend/.env.example` — `BALANCE_THRESHOLD_UOS` comment: "Default 1.0. Set to **0 to DISABLE** the
  balance gate (no RPC read; every attested caller passes)."

### 4. Gotcha to call out
`tsx watch` (`npm run dev`) does **not** reload `.env`. After changing `BALANCE_THRESHOLD_UOS`, fully
restart the backend.

## Verify
- `npm --prefix backend test` green; `npm --prefix backend run typecheck` clean.
- Manual: an attested admin account (many `signableAccounts`) with ≥1 UOS in its **active** account
  passes with **one** RPC read; `BALANCE_THRESHOLD_UOS=0` → no read, passes.

## Already in place (don't redo)
- The chain-host allowlist fix is committed (`backend/src/pipeline/tools/host-allowlist.ts` now
  includes the real mainnet/testnet RPC hosts: `ultra.eosusa.io`, etc.), so the active-account read
  actually reaches the chain.
- The frontend already maps `insufficient-uos` to a clear message in `ProposalCard.vue`.
