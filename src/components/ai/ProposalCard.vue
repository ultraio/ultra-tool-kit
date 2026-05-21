<template>
    <!-- propose -->
    <div v-if="props.proposal" class="flex flex-col gap-2 text-xs">
        <div class="flex items-center gap-2 font-mono text-purple-300">
            <Icon icon="fa-bolt-lightning" class="text-purple-400" />
            <span>{{ props.proposal.contract }}<span class="text-neutral-500">::</span>{{ props.proposal.action }}</span>
        </div>

        <div
            v-if="props.proposal.rationale"
            class="text-neutral-400 italic"
        >
            {{ props.proposal.rationale }}
        </div>

        <div class="bg-neutral-950 rounded border border-neutral-800 overflow-hidden">
            <table class="w-full text-left">
                <thead class="text-neutral-500 text-[10px] uppercase tracking-wide">
                    <tr>
                        <th class="px-2 py-1 font-medium">Field</th>
                        <th class="px-2 py-1 font-medium">Value</th>
                        <th class="px-2 py-1 font-medium">Type</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in fieldRows" :key="row.name" class="border-t border-neutral-800">
                        <td class="px-2 py-1 font-mono text-neutral-300 align-top">{{ row.name }}</td>
                        <td class="px-2 py-1 font-mono text-neutral-200 align-top break-all">{{ row.value }}</td>
                        <td class="px-2 py-1 font-mono text-neutral-500 align-top">{{ row.type }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="flex items-center gap-2">
            <span class="text-neutral-500">Authorization</span>
            <span
                class="font-mono px-2 py-0.5 rounded bg-neutral-950 border border-neutral-800 text-neutral-200"
            >
                {{ props.proposal.authorization.actor }}@{{ props.proposal.authorization.permission }}
            </span>
        </div>

        <div class="flex flex-wrap gap-2 pt-1">
            <button
                class="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200"
                @click="emit('apply', 'builder')"
                data-testid="ai-open-in-builder"
            >
                Open in Builder
            </button>
            <button
                class="px-3 py-1 rounded bg-purple-600 hover:bg-purple-500 text-white"
                @click="emit('apply', 'sign')"
                data-testid="ai-sign-now"
            >
                Sign now
            </button>
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
        <div v-if="props.reply.detail" class="italic">{{ props.reply.detail }}</div>
        <div v-if="props.reply.reason === 'rate-limit'" class="pt-1">
            <button
                class="px-3 py-1 rounded bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-neutral-200"
                @click="emit('reset')"
            >
                <Icon icon="fa-rotate-left" class="mr-1" />
                Reset session
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import * as I from '../../interfaces';
import { BlockchainService } from '../../utilities/blockchain';
import type { Reply, ReplyPropose } from '../../utilities/aiClient';

const props = defineProps<{
    proposal?: ReplyPropose;
    reply?: Reply;
    state?: I.AuthState;
}>();

const emit = defineEmits<{
    (e: 'apply', mode: 'sign' | 'builder'): void;
    (e: 'reset'): void;
    (e: 'quick-reply', text: string): void;
}>();

const fieldTypes = ref<Record<string, string>>({});
const quickReply = ref<string>('');

async function loadFieldTypes() {
    if (!props.proposal) return;
    const { contract, action } = props.proposal;
    try {
        const wrapped = await BlockchainService.getAbi(contract, true);
        const abi = wrapped?.ABI;
        if (!abi) return;
        const actionDef = abi.actions?.find((a: any) => a.name === action);
        const structName = actionDef?.type ?? action;
        const struct = abi.structs?.find((s: any) => s.name === structName);
        const map: Record<string, string> = {};
        for (const f of struct?.fields ?? []) {
            map[f.name] = f.type;
        }
        fieldTypes.value = map;
    } catch {
        // ABI lookup is best-effort; the proposal is still usable without type hints.
    }
}

watch(
    () => props.proposal?.contract + ':' + props.proposal?.action,
    () => {
        if (props.proposal) loadFieldTypes();
    },
    { immediate: true }
);

const fieldRows = computed(() => {
    const data = props.proposal?.data ?? {};
    return Object.keys(data).map((name) => ({
        name,
        value: stringify(data[name]),
        type: fieldTypes.value[name] ?? '—',
    }));
});

function stringify(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

const refuseHeading = computed(() => {
    const reason = props.reply?.kind === 'refuse' ? props.reply.reason : '';
    switch (reason) {
        case 'off-topic':
            return 'I only help with building Ultra blockchain transactions.';
        case 'rate-limit':
            return "You've hit the daily AI budget.";
        case 'no-matches':
            return "I couldn't find a matching action in the catalog.";
        case 'transport-error':
            return "I couldn't reach the AI backend.";
        case 'provider-error':
            return 'The model is unavailable right now.';
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
