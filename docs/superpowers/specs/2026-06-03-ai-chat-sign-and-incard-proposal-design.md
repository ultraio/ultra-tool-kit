# AI Chat — Sign-Clone Fix + In-Card Proposal Flow (+ F2/F3/F5)

- **Date:** 2026-06-03
- **Branch:** `feature/ai-enhancement` (commit directly here)
- **Origin:** Fix session following `.scratch/ai-chat-validation-findings.md`. Two user-reported issues plus three folded-in findings.

## Problem

1. **Sign-clone bug.** Clicking "Sign & submit" on the AI chat `act` card throws `Failed to execute 'postMessage' on 'Window': #<Object> could not be cloned.` and nothing happens.
2. **Proposal UX.** `propose` replies currently hand off to the `<Transaction>` modal. We want to mimic the whole proposal-creation process **in-card** — user reviews, edits if needed, validates, and signs without opening the modal.
3. Fold in prior findings **F2** (wall-clock reliability), **F3** (approver validation), **F5** (refuse-reason mapping).

## Root causes (confirmed by code trace)

- **Sign-clone:** `useActionSigner.sign()` → `Ultra/UltraWeb.signTransaction(actions, …)` maps actions but keeps `data: a.data`, where `a` / `a.data` are Vue **reactive Proxies** (the reply is stored in a `ref` in `useAiChat.ts` and flows through props). The wallet SDK `postMessage`s the argument; `structuredClone` cannot clone a Proxy. The modal's proposal path is unaffected because `getProposalTxData` already does `JSON.parse(JSON.stringify(transaction))`.
  - `src/components/ai/useActionSigner.ts:23-46`, `src/wallets/ultra.ts:93-114`, `src/wallets/ultra-web.ts:86-105`.
- **Proposal flow:** `useAiChat.ts:111-115` emits `propose` actions to the modal bus (`updateAppActions`). `BlockchainService.getProposalTxData(proposer, proposal_name, requested, actions, expiration)` (`src/utilities/blockchain.ts:337-379`) is fully standalone — builds + serializes the inner trx (via `signerApi.buildTransaction`), zeroes ref_block, sets expiration, returns the `eosio.msig::proposex` data `{ proposer, proposal_name, requested, trx }`. Signing reuses `Ultra/UltraWeb.signTransaction` exactly like the act card.
- **validatetrx:** `ultra.proposer`'s `--validate-trx` (`propose.js:192-223`) calls action `eosio.msig::validatetrx` with `{ account: proposer, requested, trx }`; the chain validates and **intentionally aborts**, returning the string `"validated transaction and aborted it"` on success.

## Design

### 1. Sign-clone fix (chokepoint)
In `src/wallets/ultra.ts` and `src/wallets/ultra-web.ts` `signTransaction`, deep plain-clone each action before building `sdkActions`. Add a tiny local helper `toPlain(v) = JSON.parse(JSON.stringify(v))` (matches the existing codebase idiom). Clone `contract`, `action`, `data`, `authorization`. Protects the act card and every caller of these wrappers. Low risk — AI/modal action data is plain JSON (no BigInt/Date).

### 2. In-card proposal flow (Ultra / UltraWeb only)
- **New composable `src/components/ai/useProposalSigner.ts`** — mirrors `useActionSigner`:
  - `build({ proposalName, actions, requested, expiration, proposer })` → calls `getProposalTxData` and wraps the result into the `eosio.msig::proposex` action; surfaces serialization errors (client-side validation).
  - `sign(...)` → `Ultra/UltraWeb.signTransaction([proposexAction], proposer, perm[, env])`; exposes `signing`, `txHash`, `error`, explorer link (reuse `getTransactionLink`).
  - `validateOnChain(...)` → builds the `eosio.msig::validatetrx` action and signs/pushes it; success = abort-message detection (handles both success-payload and thrown-error forms); exposes `validating`, `validationResult`.
- **`ProposalCard.vue` `propose` branch (Ultra/UltraWeb)** — full in-card editor:
  - Inner action(s) shown read-only for review (reuse existing action-render markup).
  - **Editable:** proposal name (prefilled from `reply.proposalName`), expiration (default 30 days), approver list (prefilled from `reply.requested`) with quick-add groups **Admins / Props / Producers / Self** — reuse `SignatureForm`'s gather logic (`get_producers` is unbounded, so all approvers are grabbed).
  - Buttons: **Validate on-chain** (optional, labeled as a dry-run that creates nothing), **Sign & submit proposal**.
- **Anchor / Ledger** — unchanged: `propose` still emits to the `<Transaction>` modal; the card shows the existing "open the modal" hint for these wallet types.

### 3. Validation
- **Client-side (always):** `getProposalTxData` building/serializing the inner trx validates ABIs + data encoding; errors surfaced inline.
- **F3 approver existence:** each `requested[].actor` checked via `/v1/chain/get_account` against the active endpoint (reuse the fetch pattern in `wallet-accounts.ts::validateAccountsAgainstEndpoint`). Non-existent approvers get a non-blocking warning indicator (proposer may intend a not-yet-created account, but is warned).
- **On-chain (optional):** `eosio.msig::validatetrx` per §validatetrx above.

### 4. F2 — wall-clock (backend)
Raise hosted `DEFAULT_BUDGET.maxWallMs` from `15_000` to `30_000` in `backend/src/pipeline/harness.ts` (still env-overridable via `LLM_MAX_WALL_MS`; Ollama's 60s branch unchanged). Confirm during implementation that the multi-turn tool-use loop (not a bug) is the cause. Update `docs/00-ai-global-guidelines.md` §4.7 to reflect the new bound (backend/CLAUDE.md: doc changes with the code). Fails-closed behavior unchanged.

### 5. F5 — refuse reason (frontend)
`ProposalCard.vue::refuseHeading` `default` branch: humanize unknown reasons (`actor-mismatch` → "Actor mismatch") via hyphen→space + sentence-case, instead of the fully generic message. Known reasons keep their curated headings.

## Components / files

| File | Change |
|---|---|
| `src/wallets/ultra.ts` | `toPlain` clone in `signTransaction` |
| `src/wallets/ultra-web.ts` | `toPlain` clone in `signTransaction` |
| `src/components/ai/useProposalSigner.ts` | **new** — build / validate / sign proposal |
| `src/components/ai/ProposalCard.vue` | in-card propose editor + sign + validate UI; F5 humanized reason |
| `src/composables/useAiChat.ts` | route `propose` in-card for Ultra/UltraWeb; modal fallback for Anchor/Ledger |
| `src/utilities/blockchain.ts` | add `validateProposalOnChain` (validatetrx) helper |
| `backend/src/pipeline/harness.ts` | hosted `maxWallMs` 15s → 30s |
| `docs/00-ai-global-guidelines.md` | §4.7 wall-clock bound update |

## Testing
- Backend: `npm --prefix backend test` (vitest) stays green.
- Frontend: `npm run build` typecheck; manual verification via preview tools on the running dev server (render the in-card proposal editor, exercise validation states) — **no real signing**.
- Safety: no test signs or broadcasts a real transaction.

## Non-goals
- No change to the deterministic gate stack (`validate.ts`) beyond what F-items require.
- No refactor of the `<Transaction>` modal itself (Anchor/Ledger keep using it).
- No new LLM provider / backend persistence.
