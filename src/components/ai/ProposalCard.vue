<template>
    <!-- act — composed action summary. Ultra ext/web wallets sign directly here
         via "Sign & submit" (useActionSigner → wallet, no modal). Anchor/Ledger
         fall back to the <Transaction> modal, which useAiChat opens via the bus. -->
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
            <template v-if="signTxHash">
                <!-- Link to the explorer when one exists for this chain; else
                     plain text (local/custom endpoints have no explorer URL). -->
                <a
                    v-if="txLink"
                    :href="txLink"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="flex items-center gap-1 text-green-400"
                    data-testid="ai-sign-success"
                >
                    ✓ Submitted · <span class="font-mono underline">{{ shortHash }}</span>
                </a>
                <div v-else class="flex items-center gap-1 text-green-400" data-testid="ai-sign-success">
                    ✓ Submitted · <span class="font-mono">{{ shortHash }}</span>
                </div>
            </template>
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

    <!-- propose — multisig proposal. Ultra ext/web build + sign in-card (no
         modal): editable name, expiration, approvers (SignatureForm quick-add
         grabs all producers/admins/props). Anchor/Ledger keep the modal flow. -->
    <div v-else-if="props.reply?.kind === 'propose'" class="flex flex-col gap-2 text-xs">
        <div class="flex items-center gap-2 font-mono text-purple-300">
            <Icon icon="fa-file-contract" class="text-purple-400" />
            <span>multisig proposal</span>
        </div>
        <div v-if="props.reply.rationale" class="text-neutral-400 italic">{{ props.reply.rationale }}</div>

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
                <label class="text-neutral-500">Proposal name</label>
                <input
                    v-model="proposalName"
                    maxlength="13"
                    class="bg-neutral-950 rounded border border-neutral-800 px-2 py-1 font-mono text-neutral-200 focus:outline-none focus:border-purple-500"
                    data-testid="ai-propose-name"
                />
                <label class="text-neutral-500">Expiration (blank = 30 days)</label>
                <input
                    v-model="proposalExpiration"
                    placeholder="YYYY-MM-DDTHH:MM:SS or seconds"
                    class="bg-neutral-950 rounded border border-neutral-800 px-2 py-1 font-mono text-neutral-200 focus:outline-none focus:border-purple-500"
                />
                <label class="text-neutral-500">Requested approvers</label>
                <SignatureForm
                    v-if="props.state"
                    :signatures="approvers"
                    :state="props.state"
                    @set-signatures="onSetApprovers"
                />
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
                        :disabled="validating || proposeSigning"
                        @click="onValidate"
                        data-testid="ai-propose-validate"
                    >
                        {{ validating ? 'Validating…' : 'Validate on-chain' }}
                    </button>
                    <button
                        class="self-start px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 disabled:text-neutral-400 text-white"
                        :disabled="proposeSigning"
                        @click="onSignProposal"
                        data-testid="ai-propose-sign"
                    >
                        {{ proposeSigning ? 'Signing…' : 'Sign & submit proposal' }}
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

    <!-- ask -->
    <div v-else-if="props.reply?.kind === 'ask'" class="flex flex-col gap-2 text-xs">
        <div class="flex items-start gap-2 text-neutral-200">
            <Icon icon="fa-circle-question" class="text-purple-400 mt-0.5" />
            <span>{{ props.reply.question }}</span>
        </div>
        <div class="flex gap-2">
            <input
                v-model="quickReply"
                @keyup.enter="sendQuickReply"
                class="flex-grow bg-neutral-950 rounded border border-neutral-800 px-2 py-1 text-neutral-200 focus:outline-none focus:border-purple-500"
                placeholder="Type your answer…"
            />
            <button class="px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white" @click="sendQuickReply">
                Send
            </button>
        </div>
    </div>

    <!-- refuse -->
    <div v-else-if="props.reply?.kind === 'refuse'" class="flex flex-col gap-2 text-xs text-neutral-400">
        <div class="flex items-center gap-2">
            <Icon icon="fa-ban" class="text-neutral-500" />
            <span class="text-neutral-300">{{ refuseHeading }}</span>
        </div>
        <div v-if="props.reply.reason.startsWith('rate-limit-')" class="pt-1">
            <button
                class="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200"
                @click="emit('reset')"
            >
                <Icon icon="fa-rotate-left" class="mr-1" />
                Reset session
            </button>
        </div>
    </div>

    <!-- answer -->
    <div v-else-if="props.reply?.kind === 'answer'" class="text-xs text-neutral-200 whitespace-pre-wrap">
        {{ props.reply.text }}
    </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Reply } from '../../utilities/aiClient';
import type { AuthState } from '../../interfaces';
import { useActionSigner } from './useActionSigner';
import { getTransactionLink, getEnvironmentName } from '../../utilities/networks';

const props = defineProps<{
    reply?: Reply;
    state?: AuthState;
}>();

const emit = defineEmits<{
    (e: 'reset'): void;
    (e: 'quick-reply', text: string): void;
    (e: 'signed', txHash: string): void;
}>();

const quickReply = ref<string>('');

const firstAction = computed(() => {
    if (props.reply?.kind !== 'act') return null;
    return props.reply.actions[0] ?? null;
});

const { signing, txHash: signTxHash, error: signError, sign } = useActionSigner();

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
    await validateOnChain(props.state, proposalName.value, approvers.value, props.reply.actions, proposalExpiration.value);
}
async function onSignProposal() {
    if (props.reply?.kind !== 'propose' || !props.state) return;
    await signProposal(props.state, proposalName.value, approvers.value, props.reply.actions, proposalExpiration.value);
    if (proposeTxHash.value) emit('signed', proposeTxHash.value);
}

onMounted(() => {
    if (props.reply?.kind === 'propose' && canDirectSignPropose.value) {
        void checkApprovers(approvers.value);
    }
});

const canDirectSign = computed(
    () =>
        props.reply?.kind === 'act' &&
        !!props.state?.accountName &&
        (props.state?.type === 'ultra' || props.state?.type === 'ultra-web')
);

// Explorer URL for the signed tx, or null when this chain has no known explorer
// (local / custom endpoints) — the template then shows plain text, not a dead link.
const txLink = computed<string | null>(() =>
    signTxHash.value && props.state?.endpoint
        ? getTransactionLink(getEnvironmentName(props.state.endpoint), signTxHash.value) ?? null
        : null
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

const refuseHeading = computed(() => {
    const reason = props.reply?.kind === 'refuse' ? props.reply.reason : '';
    switch (reason) {
        case 'out-of-scope':
            return 'I only help with building Ultra blockchain transactions.';
        case 'injection-prefix':
            return "I can't follow embedded instructions like that.";
        case 'rate-limit-minute':
        case 'rate-limit-hour':
        case 'rate-limit-day':
        case 'rate-limit-month':
        case 'budget-exceeded':
        case 'sponsor-cap':
            return "You've hit the AI usage limit.";
        case 'insufficient-uos':
            return 'Your connected account doesn’t hold enough UOS to use the AI.';
        case 'retries-exhausted':
        case 'wall-clock':
            return "The model couldn't produce a valid reply in time — try again or rephrase.";
        case 'input-too-large':
            return 'That message is too long — please shorten it.';
        case 'tool-budget':
            return 'That needed too many chain lookups — try a simpler request.';
        case 'auth-required':
            return 'Sign in with your wallet to use the AI.';
        case 'transport-error':
            return "I couldn't reach the AI backend.";
        case 'internal':
            return 'The AI backend hit an unexpected error.';
        case 'unsupported-reference':
            return "I couldn't ground that answer in the catalog.";
        case 'malformed-answer':
            return "That answer didn't validate.";
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
    }
});

function sendQuickReply() {
    const t = quickReply.value.trim();
    if (!t) return;
    emit('quick-reply', t);
    quickReply.value = '';
}
</script>
