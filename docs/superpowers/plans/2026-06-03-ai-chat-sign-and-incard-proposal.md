# AI Chat — Sign-Clone Fix + In-Card Proposal Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `postMessage … could not be cloned` error when signing AI `act` cards, and let users build/validate/sign multisig proposals fully in-card (Ultra/UltraWeb) without opening the `<Transaction>` modal; fold in findings F2 (wall-clock), F3 (approver existence), F5 (refuse-reason humanizing).

**Architecture:** Deep plain-clone action data at the wallet-wrapper chokepoint. A new `useProposalSigner` composable reuses the standalone `BlockchainService.getProposalTxData` to build the `eosio.msig::proposex` action and an `eosio.msig::validatetrx` dry-run, signing both through the same Ultra/UltraWeb wallet wrappers the act card uses. `ProposalCard.vue` gains an in-card propose editor (name, expiration, approvers via the global `SignatureForm`); Anchor/Ledger keep the modal fallback.

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, `@ultraos/ultra-signer-lib`/`@wharfkit` (already wired via `BlockchainService`), Hono backend (vitest). Frontend verification is `vue-tsc` typecheck (`npm run build`) + manual preview — the frontend has no unit-test runner (Playwright e2e only; signing is never exercised live).

**Safety:** No task signs or broadcasts a real transaction. Manual verification stops before clicking Sign.

---

### Task 1: Fix sign-clone bug at the wallet wrappers

**Files:**
- Modify: `src/wallets/ultra.ts:93-114`
- Modify: `src/wallets/ultra-web.ts:86-105`

**Why:** `action.data` arrives as a Vue reactive Proxy (the reply lives in a `ref` in `useAiChat.ts`); the SDK `postMessage`s it and `structuredClone` rejects proxies. Deep plain-clone each action before building `sdkActions`.

- [ ] **Step 1: Add the clone in `ultra.ts`.** Replace the `sdkActions` map (lines 106-111) with:

```typescript
    // Deep plain-clone each action: action.data may be a Vue reactive Proxy
    // (AI chat replies live in a ref), and the SDK postMessages this argument —
    // structuredClone rejects proxies ("#<Object> could not be cloned"). The
    // JSON round-trip matches getProposalTxData's existing idiom; chat/modal
    // action data is plain JSON (no BigInt/Date).
    const sdkActions: BlockchainTransaction[] = actions.map((a) => ({
        contract: a.contract,
        action: a.action,
        data: a.data === undefined ? a.data : JSON.parse(JSON.stringify(a.data)),
        authorization: a.authorization
            ? JSON.parse(JSON.stringify(a.authorization))
            : [{ actor, permission }],
    }));
```

- [ ] **Step 2: Apply the identical clone in `ultra-web.ts`** (lines 98-103), same replacement (the `getSDK(environment)` line above it is unchanged).

- [ ] **Step 3: Typecheck.**

Run: `npm run build`
Expected: PASS (vue-tsc + vite build complete, no type errors).

- [ ] **Step 4: Commit.**

```bash
git add src/wallets/ultra.ts src/wallets/ultra-web.ts
git commit -m "fix(ai): deep-clone action data before wallet signTransaction (postMessage clone bug)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: F2 — raise hosted wall-clock budget 15s → 30s

**Files:**
- Modify: `backend/src/pipeline/harness.ts:46-59`
- Modify: `docs/00-ai-global-guidelines.md:195`
- Test: `backend/test/pipeline/harness.test.ts` (run only — no value is pinned to 15000)

- [ ] **Step 1: Update the comment + value in `harness.ts`.** Change the comment block (lines 46-53) opening line and the `maxWallMs` value:

In the comment, replace `15 s wall-clock` with `30 s wall-clock`. Then change line 57:

```typescript
    maxWallMs: 30_000,
```

Add this sentence to the comment block (after the existing `…retry cap of 2…` line):

```typescript
// The 30 s (raised from 15 s) bound accommodates the multi-turn tool-use loop
// (account-verification get_account calls + Haiku turns) that legitimately
// exceeds 15 s on hosted Haiku — ~40% of valid act/propose requests were
// spuriously returning refuse:wall-clock. Still a hard DoS ceiling, still
// env-overridable via LLM_MAX_WALL_MS. Fails-closed behavior unchanged.
```

- [ ] **Step 2: Update the §4.7 doc.** In `docs/00-ai-global-guidelines.md:195`, change:

```markdown
- Per-call wall-clock budget (`max_wall_ms = 30s`, raised from 15s to fit the multi-turn tool-use loop on hosted Haiku; still env-overridable via `LLM_MAX_WALL_MS`). Exceeded → abort, log, return `refuse`.
```

- [ ] **Step 3: Run backend tests.**

Run: `npm --prefix backend test`
Expected: PASS (the suite has no assertion pinning `maxWallMs` to 15000; `harness.test.ts` overrides `maxWallMs` per-test).

- [ ] **Step 4: Commit.**

```bash
git add backend/src/pipeline/harness.ts docs/00-ai-global-guidelines.md
git commit -m "fix(ai): raise hosted wall-clock budget 15s->30s (F2 spurious timeouts)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: F5 — humanize unknown refuse reasons

**Files:**
- Modify: `src/components/ai/ProposalCard.vue:224-226` (the `refuseHeading` `default` branch)

- [ ] **Step 1: Replace the `default` branch** (lines 224-225) with a humanizer:

```typescript
        default:
            // Humanize model-emitted reasons not in the curated set above
            // (e.g. "actor-mismatch" -> "Actor mismatch") so the model's
            // specific reason still reaches the user. Falls back to a generic
            // line for empty/garbage reasons.
            if (reason && /^[a-z0-9-]+$/.test(reason)) {
                const spaced = reason.replace(/-/g, ' ');
                return spaced.charAt(0).toUpperCase() + spaced.slice(1) + '.';
            }
            return "I couldn't complete that request — try rephrasing.";
```

- [ ] **Step 2: Typecheck.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/components/ai/ProposalCard.vue
git commit -m "fix(ai): humanize unknown refuse reasons in chat card (F5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `useProposalSigner` composable

**Files:**
- Create: `src/components/ai/useProposalSigner.ts`

**Responsibility:** Build the `eosio.msig::proposex` action from the backend's proposal via the standalone `BlockchainService.getProposalTxData`, sign it through the Ultra/UltraWeb wrappers (mirrors `useActionSigner`), run an optional on-chain `eosio.msig::validatetrx` dry-run, and check approver existence (F3). One `getProposalTxData` call feeds both proposex and validatetrx (DRY — same inner `trx`).

- [ ] **Step 1: Create the file** with this full content:

```typescript
// In-card multisig proposal signer for AI `propose` replies. Mirrors
// useActionSigner: only `ultra` / `ultra-web` sign here; anchor/ledger keep
// the <Transaction> modal. Reuses BlockchainService.getProposalTxData (the
// same standalone builder the modal uses) so the inner trx is serialized
// identically. The validate-on-chain path mirrors ultra.proposer's
// --validate-trx (eosio.msig::validatetrx — chain validates then aborts).

import { ref } from 'vue';
import type { Action, AuthState } from '../../interfaces';
import * as Ultra from '../../wallets/ultra';
import * as UltraWeb from '../../wallets/ultra-web';
import { BlockchainService } from '../../utilities/blockchain';

export type ApproverCheck = { actor: string; exists: boolean };

export function useProposalSigner() {
    const signing = ref<boolean>(false);
    const validating = ref<boolean>(false);
    const txHash = ref<string | null>(null);
    const error = ref<string | null>(null);
    // null = not validated yet; otherwise the on-chain dry-run outcome.
    const validation = ref<{ ok: boolean; message: string } | null>(null);
    // F3: per-approver on-chain existence (empty until checkApprovers runs).
    const approverChecks = ref<ApproverCheck[]>([]);

    function extractError(err: any): string {
        if (err?.data?.error?.details?.length > 0) return err.data.error.details[0].message;
        return err?.message ?? 'Transaction failed';
    }

    // Build the proposex data + a validatetrx data twin from ONE getProposalTxData
    // call. `requested`/`actions` are deep-cloned to plain JSON (they arrive as
    // reactive proxies from the chat reply / editor refs).
    async function buildData(
        proposer: string,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ) {
        const plainRequested = JSON.parse(JSON.stringify(requested));
        const plainActions = JSON.parse(JSON.stringify(actions));
        const proposeData = await BlockchainService.getProposalTxData(
            proposer,
            proposalName,
            plainRequested,
            plainActions,
            expiration
        );
        // validatetrx omits proposal_name; same trx + requested.
        const validateData = {
            account: proposer,
            requested: proposeData.requested,
            trx: proposeData.trx,
        };
        return { proposeData, validateData };
    }

    async function signWallet(action: Action, state: AuthState) {
        return state.type === 'ultra'
            ? await Ultra.signTransaction([action], state.accountName, state.accountPerm ?? 'active')
            : await UltraWeb.signTransaction(
                  [action],
                  state.accountName,
                  state.accountPerm ?? 'active',
                  state.environment ?? ''
              );
    }

    // F3: check each requested approver exists on the active endpoint. Missing
    // accounts are flagged (non-blocking — the proposer may intend a not-yet-
    // created account, but is warned).
    async function checkApprovers(requested: Array<{ actor: string; permission: string }>): Promise<void> {
        const unique = [...new Set(requested.map((r) => r.actor).filter((a) => a.length > 0))];
        const results = await Promise.all(
            unique.map(async (actor) => ({ actor, exists: !!(await BlockchainService.getAccountData(actor)) }))
        );
        approverChecks.value = results;
    }

    // Optional on-chain dry-run (eosio.msig::validatetrx). The chain validates
    // and intentionally aborts; success is the "validated transaction and
    // aborted it" message, surfaced either as a thrown error or a failed result.
    async function validateOnChain(
        state: AuthState,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ): Promise<void> {
        if (validating.value) return;
        error.value = null;
        validation.value = null;
        if (state.type !== 'ultra' && state.type !== 'ultra-web') {
            error.value = 'This wallet type validates in the transaction modal.';
            return;
        }
        validating.value = true;
        try {
            const { validateData } = await buildData(
                state.accountName,
                proposalName,
                requested,
                actions,
                expiration
            );
            const action: Action = {
                contract: 'eosio.msig',
                action: 'validatetrx',
                data: validateData,
                authorization: [{ actor: state.accountName, permission: state.accountPerm ?? 'active' }],
            };
            const result = await signWallet(action, state);
            if (result?.status === 'success') {
                // Unexpected: validatetrx should abort. Treat as validated anyway.
                validation.value = { ok: true, message: 'Validation passed.' };
            } else {
                const msg = result?.message ?? '';
                validation.value = abortIsSuccess(msg)
                    ? { ok: true, message: 'Validation passed (chain validated and aborted).' }
                    : { ok: false, message: msg || 'Validation failed.' };
            }
        } catch (err) {
            const msg = extractError(err);
            validation.value = abortIsSuccess(msg)
                ? { ok: true, message: 'Validation passed (chain validated and aborted).' }
                : { ok: false, message: msg };
        } finally {
            validating.value = false;
        }
    }

    function abortIsSuccess(msg: string): boolean {
        return /validated transaction and aborted it/i.test(msg);
    }

    // Build + sign the proposex action.
    async function sign(
        state: AuthState,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ): Promise<void> {
        if (signing.value || txHash.value) return;
        error.value = null;
        if (!state.accountName) {
            error.value = 'Connect a wallet account to sign.';
            return;
        }
        if (state.type !== 'ultra' && state.type !== 'ultra-web') {
            error.value = 'This wallet type signs in the transaction modal.';
            return;
        }
        if (!proposalName || requested.length === 0) {
            error.value = 'Enter a proposal name and at least one approver.';
            return;
        }
        signing.value = true;
        try {
            const { proposeData } = await buildData(
                state.accountName,
                proposalName,
                requested,
                actions,
                expiration
            );
            const action: Action = {
                contract: 'eosio.msig',
                action: 'proposex',
                data: proposeData,
                authorization: [{ actor: state.accountName, permission: state.accountPerm ?? 'active' }],
            };
            const result = await signWallet(action, state);
            if (!result || result.status !== 'success' || !result.data) {
                error.value = result?.message ?? 'Proposal signing failed';
                return;
            }
            txHash.value = result.data.transactionHash ?? null;
        } catch (err) {
            error.value = extractError(err);
        } finally {
            signing.value = false;
        }
    }

    return {
        signing,
        validating,
        txHash,
        error,
        validation,
        approverChecks,
        checkApprovers,
        validateOnChain,
        sign,
    };
}
```

- [ ] **Step 2: Verify `BlockchainService` import path + `getAccountData` signature.** Confirm `src/utilities/blockchain.ts` exports `BlockchainService` (class) with static `getProposalTxData` and `getAccountData(name)` (it does — lines 276, 337). Confirm `Action` and `AuthState` are exported from `../../interfaces`.

Run: `npm run build`
Expected: PASS (composable typechecks; it is imported nowhere yet, so no behavior change).

- [ ] **Step 3: Commit.**

```bash
git add src/components/ai/useProposalSigner.ts
git commit -m "feat(ai): useProposalSigner — build/validate/sign msig proposal in-card

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: In-card proposal editor in `ProposalCard.vue`

**Files:**
- Modify: `src/components/ai/ProposalCard.vue` (the `propose` branch, template lines 64-89; `<script setup>` lines 133-189)

**Note:** `<SignatureForm>` and `<Icon>` are globally registered (`src/main.ts`) — use them in the template without imports, as the card already does for `<Icon>`.

- [ ] **Step 1: Replace the `propose` template branch** (lines 64-89) with the editor. For Ultra/UltraWeb show the editor; for other wallets keep the existing modal breadcrumb:

```vue
    <!-- propose — multisig proposal. Ultra ext/web build + sign in-card (no
         modal): editable name, expiration, approvers (SignatureForm quick-add
         grabs all producers/admins/props). Anchor/Ledger keep the modal flow. -->
    <div v-else-if="props.reply?.kind === 'propose'" class="flex flex-col gap-2 text-xs">
        <div class="flex items-center gap-2 font-mono text-purple-300">
            <Icon icon="fa-file-contract" class="text-purple-400" />
            <span>multisig proposal</span>
        </div>
        <div v-if="props.reply.rationale" class="text-neutral-400 italic">{{ props.reply.rationale }}</div>

        <!-- Inner actions (read-only review) -->
        <div class="flex flex-col gap-1">
            <div class="text-neutral-500">Inner actions ({{ props.reply.actions.length }}):</div>
            <div v-for="(a, i) in props.reply.actions" :key="i" class="font-mono text-neutral-300 pl-3">
                {{ i + 1 }}. {{ a.contract }}<span class="text-neutral-500">::</span>{{ a.action }}
            </div>
        </div>

        <template v-if="canDirectSignPropose">
            <template v-if="proposeTxHash">
                <a
                    v-if="proposeTxLink"
                    :href="proposeTxLink"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="flex items-center gap-1 text-green-400"
                    data-testid="ai-propose-success"
                >
                    ✓ Proposal submitted · <span class="font-mono underline">{{ proposeShortHash }}</span>
                </a>
                <div v-else class="flex items-center gap-1 text-green-400" data-testid="ai-propose-success">
                    ✓ Proposal submitted · <span class="font-mono">{{ proposeShortHash }}</span>
                </div>
            </template>
            <template v-else>
                <!-- proposal name -->
                <label class="text-neutral-500">Proposal name</label>
                <input
                    v-model="proposalName"
                    maxlength="13"
                    class="bg-neutral-950 rounded border border-neutral-800 px-2 py-1 font-mono text-neutral-200 focus:outline-none focus:border-purple-500"
                    data-testid="ai-propose-name"
                />
                <!-- expiration (optional; blank = 30-day default) -->
                <label class="text-neutral-500">Expiration (blank = 30 days)</label>
                <input
                    v-model="proposalExpiration"
                    placeholder="YYYY-MM-DDTHH:MM:SS or seconds"
                    class="bg-neutral-950 rounded border border-neutral-800 px-2 py-1 font-mono text-neutral-200 focus:outline-none focus:border-purple-500"
                />
                <!-- approvers (reuses the modal's SignatureForm + quick-add) -->
                <label class="text-neutral-500">Requested approvers</label>
                <SignatureForm
                    v-if="props.state"
                    :signatures="approvers"
                    :state="props.state"
                    @set-signatures="onSetApprovers"
                />
                <!-- F3: warn on approvers that don't exist on-chain -->
                <div
                    v-for="c in missingApprovers"
                    :key="c.actor"
                    class="text-amber-400"
                    data-testid="ai-propose-approver-warning"
                >
                    ⚠ {{ c.actor }} not found on this chain
                </div>

                <div class="flex gap-2 pt-1">
                    <button
                        class="self-start px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200 disabled:opacity-50"
                        :disabled="validating || signing"
                        @click="onValidate"
                        data-testid="ai-propose-validate"
                    >
                        {{ validating ? 'Validating…' : 'Validate on-chain' }}
                    </button>
                    <button
                        class="self-start px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-white"
                        :disabled="signing"
                        @click="onSignProposal"
                        data-testid="ai-propose-sign"
                    >
                        {{ signing ? 'Signing…' : 'Sign & submit proposal' }}
                    </button>
                </div>
                <div v-if="proposeValidation" :class="proposeValidation.ok ? 'text-green-400' : 'text-red-400'">
                    {{ proposeValidation.message }}
                </div>
                <div v-if="proposeError" class="text-red-400" data-testid="ai-propose-error">{{ proposeError }}</div>
            </template>
        </template>
        <div v-else class="flex flex-col gap-1">
            <div class="text-neutral-500">Requested approvers:</div>
            <div v-for="(r, i) in props.reply.requested" :key="i" class="font-mono text-neutral-300 pl-3">
                {{ r.actor }}<span class="text-neutral-500">@</span>{{ r.permission }}
            </div>
            <div class="text-neutral-500 pt-1">
                Open the transaction modal, toggle "Create Proposal", and enter the proposal name + approvers above.
            </div>
        </div>
    </div>
```

- [ ] **Step 2: Add the script wiring.** In `<script setup>`, after the `useActionSigner` destructure (line 158), add:

```typescript
import { useProposalSigner } from './useProposalSigner';

// Proposal editor state (Ultra/UltraWeb only).
const proposalName = ref<string>(props.reply?.kind === 'propose' ? props.reply.proposalName : '');
const proposalExpiration = ref<string>('');
const approvers = ref<Array<{ actor: string; permission: string }>>(
    props.reply?.kind === 'propose'
        ? props.reply.requested.map((r) => ({ actor: r.actor, permission: r.permission }))
        : []
);

const {
    signing: proposeSigning,
    validating,
    txHash: proposeTxHash,
    error: proposeError,
    validation: proposeValidation,
    approverChecks,
    checkApprovers,
    validateOnChain,
    sign: signProposal,
} = useProposalSigner();

const canDirectSignPropose = computed(
    () =>
        props.reply?.kind === 'propose' &&
        !!props.state?.accountName &&
        (props.state?.type === 'ultra' || props.state?.type === 'ultra-web')
);

const proposeTxLink = computed<string | null>(() =>
    proposeTxHash.value && props.state?.endpoint
        ? getTransactionLink(getEnvironmentName(props.state.endpoint), proposeTxHash.value) ?? null
        : null
);
const proposeShortHash = computed(() =>
    proposeTxHash.value ? `${proposeTxHash.value.slice(0, 8)}…${proposeTxHash.value.slice(-6)}` : ''
);
const missingApprovers = computed(() => approverChecks.value.filter((c) => !c.exists));

function onSetApprovers(next: Array<{ actor: string; permission: string }>) {
    approvers.value = next;
    void checkApprovers(next);
}
async function onValidate() {
    if (props.reply?.kind !== 'propose' || !props.state) return;
    await validateOnChain(
        props.state,
        proposalName.value,
        approvers.value,
        props.reply.actions,
        proposalExpiration.value
    );
}
async function onSignProposal() {
    if (props.reply?.kind !== 'propose' || !props.state) return;
    await signProposal(
        props.state,
        proposalName.value,
        approvers.value,
        props.reply.actions,
        proposalExpiration.value
    );
    if (proposeTxHash.value) emit('signed', proposeTxHash.value);
}
```

> **Naming note:** `proposeSigning` is destructured but the template uses `signing` for the act path. The template's propose buttons reference `signing` and `validating` — bind them to `proposeSigning`. To avoid a clash with the act `signing`, in the template replace the propose buttons' `:disabled="signing …"` / `{{ signing ? … }}` with `proposeSigning`. Update the Step-1 template accordingly: use `proposeSigning` in the two propose buttons and the `signing ? 'Signing…'` label.

- [ ] **Step 3: Run an initial approver check on mount** so warnings show before editing. After the script additions, add:

```typescript
import { onMounted } from 'vue';
onMounted(() => {
    if (props.reply?.kind === 'propose' && canDirectSignPropose.value) {
        void checkApprovers(approvers.value);
    }
});
```

(Combine the `onMounted`/`ref`/`computed` imports into the existing `import { computed, ref } from 'vue';` line — make it `import { computed, onMounted, ref } from 'vue';`.)

- [ ] **Step 4: Typecheck.**

Run: `npm run build`
Expected: PASS. If `proposeSigning` vs `signing` binding errors appear, fix the propose buttons to use `proposeSigning` (see Step-2 naming note).

- [ ] **Step 5: Commit.**

```bash
git add src/components/ai/ProposalCard.vue
git commit -m "feat(ai): in-card multisig proposal editor (name/expiry/approvers, validate, sign)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Route `propose` in-card for Ultra/UltraWeb in `useAiChat.ts`

**Files:**
- Modify: `src/composables/useAiChat.ts:111-125`

**Why:** Currently every `propose` emits to the modal bus. For Ultra/UltraWeb the card now handles it in-card; only Anchor/Ledger should still open the modal (mirrors the existing `act` logic).

- [ ] **Step 1: Replace the `if (reply.kind === 'propose')` block** (lines 111-115) with wallet-type gating mirroring the `act` branch:

```typescript
            if (reply.kind === 'propose') {
                // Ultra ext/web build + sign the proposal in-card (ProposalCard
                // drives useProposalSigner → eosio.msig::proposex). Anchor/Ledger
                // keep the <Transaction> modal flow, so emit to the bus for them.
                const walletType = ctx?.type;
                if (walletType !== 'ultra' && walletType !== 'ultra-web') {
                    emitter.emit('updateAppActions', reply.actions);
                }
            } else if (reply.kind === 'act') {
```

(Leave the existing `act` branch body unchanged — only the `propose` branch above it changes.)

- [ ] **Step 2: Typecheck.**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual preview verification (no signing).** With the dev server running (do not start/stop servers if already running), in the AI chat as an Ultra wallet on testnet: send case E′ from the findings (`propose transfer 10 UOS from myacct.test to whale.test, require ceo.test and cfo.test to approve, name the proposal myprop1`). Confirm: the card shows the in-card editor (name prefilled `myprop1`, approver rows `ceo.test`/`cfo.test`, quick-add buttons), the `<Transaction>` modal does NOT open, and "Validate on-chain"/"Sign & submit proposal" buttons render. **STOP — do not click Sign.** Optionally click "Validate on-chain" only if explicitly cleared to (it costs a wallet signature). Verify an `act` card still shows "Sign & submit" and signing path no longer throws the clone error (Task 1) — but **do not click Sign**.

- [ ] **Step 4: Commit.**

```bash
git add src/composables/useAiChat.ts
git commit -m "feat(ai): route propose in-card for Ultra/UltraWeb; modal fallback for anchor/ledger

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Sign-clone fix → Task 1 ✓
- In-card proposal build/sign → Tasks 4, 5, 6 ✓
- Full editor (name/expiration/approvers + quick-add) → Task 5 (SignatureForm) ✓
- Client-side validation (getProposalTxData) + optional on-chain validatetrx → Task 4 (`buildData`, `validateOnChain`) ✓
- F3 approver existence → Task 4 (`checkApprovers`) + Task 5 (warnings) ✓
- F2 wall-clock → Task 2 ✓
- F5 refuse reason → Task 3 ✓
- Anchor/Ledger modal fallback → Tasks 5 (`canDirectSignPropose` else-branch), 6 ✓

**Type consistency:** `useProposalSigner` returns `{ signing, validating, txHash, error, validation, approverChecks, checkApprovers, validateOnChain, sign }`; Task 5 destructures `signing` as `proposeSigning` and uses the rest by those exact names. `Action`/`AuthState` from `../../interfaces`. `getProposalTxData(proposer, proposal_name, requested, actions, expiration)` and `getAccountData(name)` match `blockchain.ts`.

**Placeholder scan:** none — every step shows real code/commands.

**Risk note:** Task 5 is the largest edit; the `proposeSigning` vs `signing` naming clash is called out explicitly. If `SignatureForm`'s `onMounted` (`signatures.value = props.signatures`) mutates the passed array, the card passes a fresh mapped array (`approvers`), so the reply's `requested` is not mutated.
