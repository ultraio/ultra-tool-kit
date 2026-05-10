<template>
    <button
        @click="goToUsage"
        @mouseenter="hover = true"
        @mouseleave="hover = false"
        class="relative flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-neutral-900 border border-neutral-700 hover:border-purple-500 text-neutral-200 text-xs font-mono"
        data-testid="ai-cost-badge"
    >
        <span class="text-base leading-none">{{ icon }}</span>
        <span>{{ label }}</span>

        <div
            v-if="hover && data"
            class="absolute right-0 top-full mt-2 w-72 z-40 p-3 rounded-md bg-neutral-900 border border-neutral-700 shadow-xl text-left text-xs text-neutral-300"
            data-testid="ai-cost-tooltip"
        >
            <div class="flex justify-between mb-1">
                <span class="text-neutral-500">Last request</span>
                <span class="font-mono">{{ lastRequestLabel }}</span>
            </div>
            <div class="flex justify-between mb-1">
                <span class="text-neutral-500">Today</span>
                <span class="font-mono">{{ formatTotals(data.today) }}</span>
            </div>
            <div class="flex justify-between mb-1">
                <span class="text-neutral-500">Lifetime</span>
                <span class="font-mono">{{ formatTotals(data.lifetime) }}</span>
            </div>
            <div v-if="isLocal" class="mt-2 pt-2 border-t border-neutral-800 text-neutral-500">
                Running on Ollama (local) — projected on Haiku 4.5:
                <span class="font-mono text-neutral-300">{{ formatUsd(data.lifetime.projectedUsd) }}</span>
                lifetime.
            </div>
            <div class="mt-2 text-[10px] text-neutral-500">Click to open the usage page.</div>
        </div>
    </button>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router/auto';
import { useAiUsage } from '../../composables/useAiUsage';
import { formatUsd, isOllamaTag, type UsageTotals } from '../../utilities/aiClient';

const router = useRouter();
const { data } = useAiUsage();
const hover = ref<boolean>(false);

const isLocal = computed(
    () => isOllamaTag(data.value?.lastRequest?.modelTag) || !!data.value?.perModel?.some((m) => isOllamaTag(m.modelTag))
);

const icon = computed(() => (isLocal.value ? '🏠' : '💰'));

const label = computed(() => {
    if (!data.value) return '—';
    if (isLocal.value) {
        const tokens = data.value.perModel.reduce((acc, m) => acc + (m.inputTokens || 0) + (m.outputTokens || 0), 0);
        return formatTokens(tokens);
    }
    return formatUsd(data.value.lifetime.actualUsd);
});

const lastRequestLabel = computed(() => {
    const lr = data.value?.lastRequest;
    if (!lr) return '—';
    if (isOllamaTag(lr.modelTag)) return `${formatUsd(0)} (proj. ${formatUsd(lr.projectedUsd)})`;
    return formatUsd(lr.actualUsd);
});

function formatTotals(t: UsageTotals): string {
    if (isLocal.value) return `${formatUsd(0)} (proj. ${formatUsd(t.projectedUsd)})`;
    return formatUsd(t.actualUsd);
}

function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K tok`;
    return `${n} tok`;
}

function goToUsage() {
    router.push('/aiUsage');
}
</script>
