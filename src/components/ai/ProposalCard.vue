<template>
    <!-- act — composed action summary. The <Transaction> modal opens
         automatically when the bubble lands (useAiChat emits the action via
         the bus); this card is the user-visible breadcrumb. -->
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

    <!-- propose (W6) — multisig proposal summary. The inner actions land in
         the <Transaction> modal via the bus; the user clicks "Create Proposal"
         inside the modal and copies the proposalName + requested approvers
         from this card into the modal's fields (Transaction.vue is frozen per
         decision 10 — no programmatic pre-fill). -->
    <div v-else-if="props.reply?.kind === 'propose'" class="flex flex-col gap-2 text-xs">
        <div class="flex items-center gap-2 font-mono text-purple-300">
            <Icon icon="fa-file-contract" class="text-purple-400" />
            <span>multisig proposal · <span class="text-purple-200">{{ props.reply.proposalName }}</span></span>
        </div>
        <div v-if="props.reply.rationale" class="text-neutral-400 italic">
            {{ props.reply.rationale }}
        </div>
        <div class="flex flex-col gap-1">
            <div class="text-neutral-500">Inner actions ({{ props.reply.actions.length }}):</div>
            <div
                v-for="(a, i) in props.reply.actions"
                :key="i"
                class="font-mono text-neutral-300 pl-3"
            >
                {{ i + 1 }}. {{ a.contract }}<span class="text-neutral-500">::</span>{{ a.action }}
            </div>
        </div>
        <div class="flex flex-col gap-1">
            <div class="text-neutral-500">Requested approvers:</div>
            <div
                v-for="(r, i) in props.reply.requested"
                :key="i"
                class="font-mono text-neutral-300 pl-3"
            >
                {{ r.actor }}<span class="text-neutral-500">@</span>{{ r.permission }}
            </div>
        </div>
        <div class="text-neutral-500">
            Open the transaction modal, toggle "Create Proposal", and enter the proposal name + approvers above.
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
            <button
                class="px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white"
                @click="sendQuickReply"
            >
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
import { computed, ref } from 'vue';
import type { Reply } from '../../utilities/aiClient';

const props = defineProps<{
    reply?: Reply;
}>();

const emit = defineEmits<{
    (e: 'reset'): void;
    (e: 'quick-reply', text: string): void;
}>();

const quickReply = ref<string>('');

const firstAction = computed(() => {
    if (props.reply?.kind !== 'act') return null;
    return props.reply.actions[0] ?? null;
});

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
        case 'budget-exceeded':
        case 'sponsor-cap':
            return "You've hit the AI usage limit.";
        case 'auth-required':
            return 'Sign in with your wallet to use the AI.';
        case 'transport-error':
            return "I couldn't reach the AI backend.";
        case 'internal':
            return 'The AI backend hit an unexpected error.';
        default:
            return "I couldn't build a confident proposal.";
    }
});

function sendQuickReply() {
    const t = quickReply.value.trim();
    if (!t) return;
    emit('quick-reply', t);
    quickReply.value = '';
}
</script>
