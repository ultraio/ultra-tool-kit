# One-click chat-sign for AI `act` replies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Sign & submit** button to the AI `act` card that signs the validated action list straight through the Ultra wallet (no Transaction modal).

**Architecture:** All changes live in `src/components/ai/**` + the AI composable `src/composables/useAiChat.ts`. A new composable `useActionSigner` calls `Ultra.signTransaction` / `UltraWeb.signTransaction` (the same wrappers `Transaction.vue`'s `confirm()` uses) for `ultra`/`ultra-web` wallets. `anchor`/`ledger` and `propose` keep the existing modal flow. `Transaction.vue`, `src/wallets/**`, and page logic are untouched (roadmap decision 10).

**Tech Stack:** Vue 3 `<script setup>`, TypeScript, Tailwind. No new dependencies. Verification: `npx vue-tsc --noEmit` + Prettier on changed files + manual wallet verification (no FE unit runner; user opted out of new test tooling).

**Spec:** `docs/superpowers/specs/2026-06-01-ai-chat-direct-sign-design.md`

**Conventions (project memos):**
- Prettier: 4-space indent, 120 width, single quotes, ES5 trailing commas. Husky pre-commit is INACTIVE — run `npx prettier --write` on ONLY your changed files before committing; do NOT reformat unrelated files.
- Do NOT `git add -A` — untracked `.scratch/` and `backend/docs/` must stay out. Stage explicit paths.
- Commit co-author line: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

- **Create** `src/components/ai/useActionSigner.ts` — direct-sign composable (reactive `signing`/`txHash`/`error` + `sign(actions, state)`).
- **Modify** `src/components/ai/ProposalCard.vue` — `act` branch: add `state` prop, render action data, Sign button + states; emit `signed`.
- **Modify** `src/components/ai/MessageBubble.vue` — forward `:state` to `ProposalCard`; re-emit `signed`.
- **Modify** `src/composables/useAiChat.ts` — suppress the modal-bus emit for `act` on `ultra`/`ultra-web`; keep it for `anchor`/`ledger` and `propose`.

Frozen (do NOT touch): `src/components/Transaction.vue`, `src/wallets/**`, page logic under `src/pages/**`.

---

## Task 1: `useActionSigner` composable

**Files:**
- Create: `src/components/ai/useActionSigner.ts`

- [ ] **Step 1: Create the composable**

```ts
// Direct chat-sign for AI `act` replies. Lets the AI ProposalCard sign a
// backend-validated action list straight through the Ultra wallet — no
// Transaction modal. The result-mapping mirrors Transaction.vue's confirm()
// EXACTLY (decision 10: we CALL the wallet wrappers, never modify them). Only
// `ultra` and `ultra-web` are handled here; anchor/ledger keep the modal flow.

import { ref } from 'vue';
import type { Action, AuthState } from '../../interfaces';
import * as Ultra from '../../wallets/ultra';
import * as UltraWeb from '../../wallets/ultra-web';

// Matches the IResponse shape returned by the wallet wrappers' signTransaction.
type SignResult = {
    status?: string;
    data?: { transactionHash?: string };
    message?: string;
};

export function useActionSigner() {
    const signing = ref<boolean>(false);
    const txHash = ref<string | null>(null);
    const error = ref<string | null>(null);

    // Mirrors confirm()'s catch-block error extraction.
    function extractError(err: any): string {
        if (err?.data?.error?.details?.length > 0) return err.data.error.details[0].message;
        return err?.message ?? 'Transaction signing failed';
    }

    async function sign(actions: Action[], state: AuthState): Promise<void> {
        if (signing.value || txHash.value) return; // re-entry / already submitted
        error.value = null;

        if (!state.accountName) {
            error.value = 'Connect a wallet account to sign.';
            return;
        }
        if (state.type !== 'ultra' && state.type !== 'ultra-web') {
            error.value = 'This wallet type signs in the transaction modal.';
            return;
        }

        signing.value = true;
        try {
            const result: SignResult =
                state.type === 'ultra'
                    ? await Ultra.signTransaction(actions, state.accountName, state.accountPerm ?? 'active')
                    : await UltraWeb.signTransaction(
                          actions,
                          state.accountName,
                          state.accountPerm ?? 'active',
                          state.environment
                      );

            if (!result || result.status !== 'success' || !result.data) {
                error.value = result?.message ?? 'Transaction signing failed';
                return;
            }
            txHash.value = result.data.transactionHash ?? null;
        } catch (err) {
            error.value = extractError(err);
        } finally {
            signing.value = false;
        }
    }

    return { signing, txHash, error, sign };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean (exit 0, no errors). If `UltraWeb.signTransaction`'s `environment` param rejects `string | undefined`, pass `state.environment ?? ''` to match its signature — verify against `src/wallets/ultra-web.ts` and mirror `Transaction.vue:338`.

- [ ] **Step 3: Prettier + commit**

```bash
npx prettier --write src/components/ai/useActionSigner.ts
git add src/components/ai/useActionSigner.ts
git commit -m "feat(ai): useActionSigner — direct Ultra/UltraWeb sign for chat act replies

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: ProposalCard — action data + Sign button (act branch)

**Files:**
- Modify: `src/components/ai/ProposalCard.vue` (the `act` `<div v-if="props.reply?.kind === 'act'">` block, lines ~5-14, and the `<script setup>`)

- [ ] **Step 1: Replace the `act` template block**

Replace the existing act block:
```html
    <div v-if="props.reply?.kind === 'act'" class="flex flex-col gap-2 text-xs">
        <div class="flex items-center gap-2 font-mono text-purple-300">
            <Icon icon="fa-bolt-lightning" class="text-purple-400" />
            <span>{{ firstAction?.contract }}<span class="text-neutral-500">::</span>{{ firstAction?.action }}</span>
        </div>
        <div v-if="props.reply.rationale" class="text-neutral-400 italic">
            {{ props.reply.rationale }}
        </div>
        <div class="text-neutral-500">Review and sign in the transaction modal.</div>
    </div>
```
with:
```html
    <div v-if="props.reply?.kind === 'act'" class="flex flex-col gap-2 text-xs">
        <div class="flex items-center gap-2 font-mono text-purple-300">
            <Icon icon="fa-bolt-lightning" class="text-purple-400" />
            <span>{{ firstAction?.contract }}<span class="text-neutral-500">::</span>{{ firstAction?.action }}</span>
        </div>
        <div v-if="props.reply.rationale" class="text-neutral-400 italic">
            {{ props.reply.rationale }}
        </div>

        <!-- The real fields being signed — the chat card is the review surface. -->
        <div
            v-if="firstAction && Object.keys(firstAction.data || {}).length > 0"
            class="flex flex-col gap-0.5 rounded bg-neutral-950/60 p-2 font-mono text-neutral-300"
        >
            <div v-for="(val, key) in firstAction.data" :key="key" class="flex gap-2">
                <span class="text-neutral-500">{{ key }}</span>
                <span class="break-all">{{ formatValue(val) }}</span>
            </div>
        </div>

        <!-- Ultra ext/web: one-click sign. Anchor/Ledger: modal breadcrumb. -->
        <template v-if="canDirectSign">
            <a
                v-if="signTxHash"
                :href="txLink"
                target="_blank"
                rel="noreferrer noopener"
                class="flex items-center gap-1 text-green-400"
                data-testid="ai-sign-success"
            >
                ✓ Submitted · <span class="font-mono underline">{{ shortHash }}</span>
            </a>
            <template v-else>
                <button
                    class="self-start px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-white"
                    :disabled="signing"
                    @click="onSign"
                    data-testid="ai-chat-sign"
                >
                    {{ signing ? 'Signing…' : 'Sign & submit' }}
                </button>
                <div v-if="signError" class="text-red-400" data-testid="ai-sign-error">{{ signError }}</div>
            </template>
        </template>
        <div v-else class="text-neutral-500">Review and sign in the transaction modal.</div>
    </div>
```

- [ ] **Step 2: Update the `<script setup>`**

The current script imports `computed, ref` and `Reply`, defines `props` (`reply`), `emit` (`reset`, `quick-reply`), `quickReply`, `firstAction`, `refuseHeading`, `sendQuickReply`. Make these changes:

Add imports after the existing ones:
```ts
import type { AuthState } from '../../interfaces';
import { useActionSigner } from './useActionSigner';
import { getTransactionLink, getEnvironmentName } from '../../utilities/networks';
```

Replace the `defineProps`:
```ts
const props = defineProps<{
    reply?: Reply;
    state?: AuthState;
}>();
```

Replace the `defineEmits` to add `signed`:
```ts
const emit = defineEmits<{
    (e: 'reset'): void;
    (e: 'quick-reply', text: string): void;
    (e: 'signed', txHash: string): void;
}>();
```

Add the signer wiring + helpers (after `firstAction`):
```ts
const { signing, txHash: signTxHash, error: signError, sign } = useActionSigner();

const canDirectSign = computed(
    () => props.reply?.kind === 'act' && (props.state?.type === 'ultra' || props.state?.type === 'ultra-web')
);

const txLink = computed(() =>
    signTxHash.value && props.state?.endpoint
        ? getTransactionLink(getEnvironmentName(props.state.endpoint), signTxHash.value)
        : '#'
);

const shortHash = computed(() =>
    signTxHash.value ? `${signTxHash.value.slice(0, 8)}…${signTxHash.value.slice(-6)}` : ''
);

function formatValue(v: unknown): string {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

async function onSign() {
    if (props.reply?.kind !== 'act' || !props.state) return;
    await sign(props.reply.actions, props.state);
    if (signTxHash.value) emit('signed', signTxHash.value);
}
```

- [ ] **Step 3: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean. (`getTransactionLink` and `getEnvironmentName` are exported from `src/utilities/networks.ts`; `Icon` is globally registered. No new FontAwesome icons are used — success/spinner states are text/unicode, so `src/icons.ts` needs NO change.)

- [ ] **Step 4: Prettier + commit**

```bash
npx prettier --write src/components/ai/ProposalCard.vue
git add src/components/ai/ProposalCard.vue
git commit -m "feat(ai): Sign & submit button on the act card (Ultra wallets), shows action data + tx link

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MessageBubble — forward `state`, re-emit `signed`

**Files:**
- Modify: `src/components/ai/MessageBubble.vue` (the `<ProposalCard>` usage, lines ~16-20, and `defineEmits`)

- [ ] **Step 1: Pass `state` and re-emit `signed`**

Replace:
```html
                <ProposalCard
                    :reply="props.content"
                    @reset="emit('reset')"
                    @quick-reply="(t) => emit('quick-reply', t)"
                />
```
with:
```html
                <ProposalCard
                    :reply="props.content"
                    :state="props.state"
                    @reset="emit('reset')"
                    @quick-reply="(t) => emit('quick-reply', t)"
                    @signed="(h) => emit('signed', h)"
                />
```

- [ ] **Step 2: Add `signed` to `defineEmits`**

Replace:
```ts
const emit = defineEmits<{
    (e: 'quick-reply', text: string): void;
    (e: 'reset'): void;
}>();
```
with:
```ts
const emit = defineEmits<{
    (e: 'quick-reply', text: string): void;
    (e: 'reset'): void;
    (e: 'signed', txHash: string): void;
}>();
```
(`props.state?: I.AuthState` already exists on MessageBubble — no prop change needed.)

- [ ] **Step 3: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Prettier + commit**

```bash
npx prettier --write src/components/ai/MessageBubble.vue
git add src/components/ai/MessageBubble.vue
git commit -m "feat(ai): forward auth state to ProposalCard and bubble up the signed event

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: useAiChat — suppress the modal for direct-signable acts

**Files:**
- Modify: `src/composables/useAiChat.ts` (the `if (reply.kind === 'act' || reply.kind === 'propose')` handoff block, ~lines 111-121)

- [ ] **Step 1: Replace the handoff block**

The block currently reads (inside `sendMessage`, where `const ctx = authState?.value;` is already in scope from line ~72):
```ts
            if (reply.kind === 'act' || reply.kind === 'propose') {
                // Hand off through the existing event-bus channel App.vue
                // already listens on. <Transaction> opens prefilled; the
                // user reviews and the wallet signs (§4.5). W6: propose
                // emits inner actions through the SAME channel — the user
                // clicks "Create Proposal" inside the modal and copies
                // proposalName + requested approvers from the bubble's
                // ProposalCard (Transaction.vue is frozen per decision 10 —
                // no programmatic pre-fill of proposalName / signatures).
                emitter.emit('updateAppActions', reply.actions);
            }
```
Replace it with:
```ts
            if (reply.kind === 'propose') {
                // propose (msig) always uses the <Transaction> modal — the user
                // enters the proposalName + approvers there (decision 10: no
                // programmatic pre-fill). Hand off via the existing bus channel.
                emitter.emit('updateAppActions', reply.actions);
            } else if (reply.kind === 'act') {
                // Ultra ext/web sign one-click from the chat card (no modal) —
                // ProposalCard drives Ultra.signTransaction directly. Anchor /
                // Ledger keep the modal flow, so emit to the bus for them and
                // App.vue opens <Transaction> as before.
                const walletType = ctx?.type;
                if (walletType !== 'ultra' && walletType !== 'ultra-web') {
                    emitter.emit('updateAppActions', reply.actions);
                }
            }
```

- [ ] **Step 2: Typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean. (`ctx` is `authState?.value` of type `I.AuthState | undefined`; `ctx?.type` is `WalletTypes | undefined` — the string comparison is valid.)

- [ ] **Step 3: Prettier + commit**

```bash
npx prettier --write src/composables/useAiChat.ts
git add src/composables/useAiChat.ts
git commit -m "feat(ai): chat act replies sign in-card for Ultra wallets; modal only for anchor/ledger/propose

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification

- [ ] **Step 1: Full typecheck**

Run: `npx vue-tsc --noEmit`
Expected: clean (exit 0).

- [ ] **Step 2: Confirm no frozen files changed**

Run: `git diff --name-only 63bc7f5..HEAD -- src/components/Transaction.vue src/wallets src/pages`
Expected: EMPTY output (no frozen files touched). Also `git status --short` should show only `.scratch/` and `backend/docs/` as untracked.

- [ ] **Step 3: Manual verification (user)**

With the Ultra extension connected on mainnet/testnet:
1. Open the AI chat, send "transfer 0.1 UOS from <your account> to <another account>".
2. The act card shows the action data (`from`/`to`/`quantity`/`memo`) and a **Sign & submit** button. The Transaction modal does NOT auto-open.
3. Click **Sign & submit** → the wallet signature prompt appears. Approve.
4. The card shows "✓ Submitted · <hash>" linking to the explorer.
5. Reject in the wallet → the card shows the error and the button re-enables.
6. (Regression) `propose:` flows and Anchor/Ledger still open the Transaction modal.

---

## Self-Review (done at plan-writing time)

- **Spec coverage:** useActionSigner (Task 1), Sign button + action-data display + states (Task 2), state forwarding + signed event (Task 3), modal-suppression for ultra/ultra-web (Task 4), verification (Task 5). All spec sections covered.
- **Type consistency:** `sign(actions: Action[], state: AuthState)` used identically in Task 1 (definition), Task 2 (`sign(props.reply.actions, props.state)`). `signed` event typed `(txHash: string)` in Tasks 2 & 3. `txHash` ref aliased to `signTxHash` in the card to avoid template name clash — consistent across Task 2 template + script.
- **No placeholders:** every code step is complete and compilable.
- **Decision 10:** only `src/components/ai/**` + `useAiChat.ts` changed; Task 5 step 2 asserts no frozen file moved.
