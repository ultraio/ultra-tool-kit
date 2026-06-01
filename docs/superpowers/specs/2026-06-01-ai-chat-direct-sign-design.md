# Spec: one-click chat-sign for AI `act` replies (Ultra wallets)

> Branch: `feature/ai-enhancement`. Frontend (Vue 3). Self-contained.

## Problem

When the AI returns an `act` reply, the chat shows a summary card and the
`<Transaction>` modal **auto-opens** (prefilled); the user reviews there and
clicks **Confirm**, which runs `Transaction.vue`'s `confirm()` (builds the tx →
`Ultra.signTransaction(...)` → wallet prompt). The user wants to **sign directly
from the chat card** — one click on a **Sign** button takes them straight to the
wallet signature prompt, with no Transaction modal in between.

## Goal & scope

- A **Sign & submit** button on the AI `act` card that signs `reply.actions`
  directly through the wallet, no modal.
- **Wallet scope:** Ultra extension (`ultra`) and Ultra web (`ultra-web`) only.
  `anchor` / `ledger` keep today's auto-opening-modal flow (their signing is
  more involved and lives in the modal).
- **Action scope:** `act` only. `propose` (msig) keeps the modal — it needs the
  proposal-name + approver inputs that live there.

### Non-goals
- No change to `propose`/msig handling.
- No direct-sign for Anchor/Ledger.
- No new confirmation dialog — the wallet prompt is the final confirmation.

## Constraint: decision 10 (frozen files)

Roadmap decision 10 (a **user instruction**) freezes `Transaction.vue`'s existing
paths, `src/wallets/**`, and page logic outside `src/components/ai/**`. This
design honors it: all changes live in `src/components/ai/**` and the AI composable
`src/composables/useAiChat.ts`. We **call** `Ultra.signTransaction` /
`UltraWeb.signTransaction` (the same wrappers `confirm()` uses) — we do **not**
modify `Transaction.vue` or the wallet code. The Ultra sign path is a one-liner,
so mirroring it costs a few lines versus unfreezing the modal.

## Components & changes

### 1. `src/components/ai/useActionSigner.ts` (NEW)
A composable that owns the direct-sign path for the `act` case.

- Exposes reactive `signing: Ref<boolean>`, `txHash: Ref<string | null>`,
  `error: Ref<string | null>`, and an async `sign(actions, state)`.
- `state.type === 'ultra'`:
  `Ultra.signTransaction(actions, state.accountName, state.accountPerm ?? 'active')`
- `state.type === 'ultra-web'`:
  `UltraWeb.signTransaction(actions, state.accountName, state.accountPerm ?? 'active', state.environment)`
- Result mapping mirrors `Transaction.vue`'s `confirm()` exactly:
  - success = `result?.status === 'success' && result.data` → `txHash = result.data.transactionHash`
  - otherwise → `error = result?.message ?? 'Transaction signing failed'`
  - thrown error → `error = err?.data?.error?.details?.[0]?.message ?? err?.message ?? 'Transaction signing failed'`
- Guards: ignores re-entry while `signing` is true; no-op (sets error) if
  `state.type` is not `ultra`/`ultra-web` or `!state.accountName`.
- Signs **exactly** `reply.actions` — no client-side mutation (the action arrays
  already carry their `authorization`, and were validated by the backend §4.3
  gates before reaching the card).
- Imports `Ultra` from `../../wallets/ultra`, `UltraWeb` from
  `../../wallets/ultra-web` (using, not modifying).

### 2. `src/components/ai/ProposalCard.vue` (MODIFY — `act` branch only)
- Add prop `state?: I.AuthState`.
- Render the **real action data** for the first action (and any additional
  actions) compactly — `from`, `to`, `quantity`, `memo` (generic key/value of
  `action.data`) — so the card is a genuine review surface, not just the AI's
  prose `rationale`.
- If `state?.type === 'ultra' || 'ultra-web'`: render a **Sign & submit** button
  wired to `useActionSigner.sign(reply.actions, state)` (signs the full action
  array, not just the first). Button/states:
  - idle → "Sign & submit"
  - signing → spinner + "Signing…", disabled
  - success → replace button with "✓ Submitted" + tx-hash link
    (`getTransactionLink(getEnvironmentName(state.endpoint), txHash)` from
    `utilities/networks.ts`); button stays disabled (no double-submit)
  - error → show `error` text (red) under the button; button re-enabled for retry
- Else (`anchor`/`ledger` or no state): keep the existing
  "Review and sign in the transaction modal." breadcrumb (unchanged).
- Emit `signed` (with `txHash`) on success, for parent reaction (optional use).
- `propose`/`ask`/`refuse`/`answer` branches: unchanged.

### 3. `src/components/ai/MessageBubble.vue` (MODIFY)
- Forward `:state="props.state"` to `<ProposalCard>` (the `state` prop already
  exists on MessageBubble; it's just not passed down today).
- Re-emit `ProposalCard`'s `signed` event upward.

### 4. `src/composables/useAiChat.ts` (MODIFY — handoff at the `act|propose` block)
Currently always `emitter.emit('updateAppActions', reply.actions)` for
`act|propose`. New logic (uses the existing `stateRef`):
- `propose` → emit as today (modal).
- `act` + `anchor`/`ledger` → emit as today (modal fallback — unchanged for them).
- `act` + `ultra`/`ultra-web` → **do not emit** (no modal); the card's Sign
  button drives signing.

## Data flow

```
AI returns act
  → useAiChat: push assistant reply; if anchor/ledger → emit updateAppActions (modal opens, as today); if ultra/ultra-web → no emit
  → ProposalCard (ultra/ultra-web): shows action data + "Sign & submit"
  → click → useActionSigner.sign(actions, state) → Ultra/UltraWeb.signTransaction → wallet prompt → user signs
  → success: card shows ✓ + tx link; emit `signed`
  → error: card shows message; retry enabled
```

## Error handling & edge cases
- Re-entry: `signing` ref disables the button and short-circuits `sign()`.
- Post-success: button disabled — no double submit.
- Wallet rejection / throw: error extracted like `confirm()`, shown in-card.
- Not logged in: an `act` implies a session; still, hide/disable Sign when
  `!state.accountName`.
- Wrong wallet type (anchor/ledger): no Sign button — breadcrumb + modal path.

## Security
- The action was validated by the backend §4.3 gate stack before it reached the
  card; the card signs the unmodified `reply.actions`.
- The card surfaces the real fields for human review; the wallet prompt remains
  the final, authoritative confirmation. No validation is bypassed; no new trust
  is granted to client-supplied data.

## Testing

**Tooling decision (confirmed):** the frontend has **no unit-test runner** — no
`vitest`, no `@vue/test-utils`; only **Playwright** e2e in `tests/` (`test:e2e`).
We will **not** add a new test runner (avoid tooling scope creep). Coverage is via
a Playwright e2e test, following the existing patterns:
- `tests/ai-chat-smoke.spec.ts` mocks `/api/ai-chat` with `page.route(...)`.
- `tests/e2e/wallet-sign-transaction.e2e.spec.ts` mocks the Ultra wallet
  (`addInitScript` / injected `window` wallet) and asserts a sign flow.

**New e2e** `tests/e2e/ai-chat-sign.e2e.spec.ts` (mirror those patterns):
1. Mock `/api/ai-chat` to return an `act` reply (`eosio.token::transfer`,
   `from`/`to`/`quantity` populated) and `/api/ai-usage`.
2. Set up the mock Ultra wallet (reuse the wallet-sign-transaction harness) with a
   stubbed `signTransaction` returning `{ status:'success', data:{ transactionHash } }`.
3. Log in, open the chat, send a message, and assert:
   - the act card renders the action data and a **Sign & submit** button
     (add `data-testid="ai-chat-sign"`),
   - clicking it invokes the wallet's `signTransaction` (assert via the stub),
   - the success state renders the tx hash + explorer link,
   - the `<Transaction>` modal did **not** open for the `ultra` path.
4. Add an error variant: stub returns `{ status:'error', message }` → card shows
   the error and the button re-enables.

**`useActionSigner` logic** is small and mirrors `Transaction.vue`'s `confirm()`
result-mapping exactly; with no unit runner it is covered by the e2e above plus
manual verification. Keep its dispatch + mapping obvious and minimal so it needs no
isolated unit harness. Add a `data-testid` to the Sign button and success/error
nodes to keep the e2e robust.

## Files touched (all within decision-10 scope)
- NEW `src/components/ai/useActionSigner.ts`
- MOD `src/components/ai/ProposalCard.vue`
- MOD `src/components/ai/MessageBubble.vue`
- MOD `src/composables/useAiChat.ts`
- Tests under the chosen FE test harness.

Untouched (frozen): `src/components/Transaction.vue`, `src/wallets/**`, page logic.
