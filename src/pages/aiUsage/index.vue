<template>
    <div class="flex flex-col gap-6 text-sm" data-testid="ai-usage-page">
        <div class="flex items-center justify-between">
            <div>
                <h1 class="text-3xl font-bold">AI Usage</h1>
                <p class="text-neutral-400 mt-1">
                    Per-account spend on the AI assistant. Local mode shows token totals; projected
                    costs assume Haiku 4.5 with prompt caching after turn 1.
                </p>
            </div>
            <div class="flex gap-2">
                <button
                    class="px-3 py-1.5 rounded bg-neutral-900 border border-neutral-700 text-neutral-500 cursor-not-allowed"
                    title="Coming in Phase 2"
                    disabled
                >
                    Reset
                </button>
                <button
                    class="px-3 py-1.5 rounded bg-neutral-900 border border-neutral-700 text-neutral-500 cursor-not-allowed"
                    title="Coming in Phase 2"
                    disabled
                >
                    Export CSV
                </button>
            </div>
        </div>

        <div v-if="error" class="text-red-400 text-xs">{{ error }}</div>

        <!-- Headline cards -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3" data-testid="ai-usage-cards">
            <div class="rounded-lg bg-neutral-800 border border-neutral-700 p-4">
                <div class="text-xs text-neutral-400">Lifetime</div>
                <div class="font-mono text-lg mt-1">{{ formatTotals(lifetime) }}</div>
                <div class="text-[11px] text-neutral-500">{{ lifetime.calls }} calls</div>
            </div>
            <div class="rounded-lg bg-neutral-800 border border-neutral-700 p-4">
                <div class="text-xs text-neutral-400">Today</div>
                <div class="font-mono text-lg mt-1">{{ formatTotals(today) }}</div>
                <div class="text-[11px] text-neutral-500">{{ today.calls }} calls</div>
            </div>
            <div class="rounded-lg bg-neutral-800 border border-neutral-700 p-4">
                <div class="text-xs text-neutral-400">Last request</div>
                <div class="font-mono text-lg mt-1">{{ lastRequestLabel }}</div>
                <div class="text-[11px] text-neutral-500 truncate">{{ data?.lastRequest?.modelTag ?? '—' }}</div>
            </div>
            <div class="rounded-lg bg-neutral-800 border border-neutral-700 p-4">
                <div class="text-xs text-neutral-400">Projected (lifetime)</div>
                <div class="font-mono text-lg mt-1">{{ formatUsd(lifetime.projectedUsd) }}</div>
                <div class="text-[11px] text-neutral-500">if shipped on Haiku 4.5</div>
            </div>
        </div>

        <!-- Per-model breakdown table (Actual vs Projected) -->
        <div class="rounded-lg bg-neutral-800 border border-neutral-700 overflow-hidden">
            <div class="px-4 py-3 border-b border-neutral-700 text-neutral-300 font-semibold">Per model</div>
            <table class="w-full text-left text-xs">
                <thead class="text-neutral-500 uppercase tracking-wide text-[10px]">
                    <tr>
                        <th class="px-4 py-2 font-medium">Model</th>
                        <th class="px-4 py-2 font-medium text-right">Calls</th>
                        <th class="px-4 py-2 font-medium text-right">Input tok</th>
                        <th class="px-4 py-2 font-medium text-right">Output tok</th>
                        <th class="px-4 py-2 font-medium text-right">Actual</th>
                        <th class="px-4 py-2 font-medium text-right">Projected</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!data?.perModel?.length">
                        <td colspan="6" class="px-4 py-4 text-neutral-500 text-center">
                            No usage yet — open the chat drawer and try a request.
                        </td>
                    </tr>
                    <tr
                        v-for="m in data?.perModel ?? []"
                        :key="m.modelTag"
                        class="border-t border-neutral-700 font-mono"
                    >
                        <td class="px-4 py-2 text-neutral-200">{{ m.modelTag }}</td>
                        <td class="px-4 py-2 text-right">{{ m.calls }}</td>
                        <td class="px-4 py-2 text-right text-neutral-400">{{ m.inputTokens }}</td>
                        <td class="px-4 py-2 text-right text-neutral-400">{{ m.outputTokens }}</td>
                        <td class="px-4 py-2 text-right">{{ formatUsd(m.actualUsd) }}</td>
                        <td class="px-4 py-2 text-right text-neutral-400">{{ formatUsd(m.projectedUsd) }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Time-series chart (inline SVG, no chart lib).
             Renders calls-per-model bars by current state. The full daily-cost
             stacked time-series in §5.2 requires per-day rows from the backend
             aggregate, which the current /api/ai-usage doesn't expose; we use
             the per-model totals here as a meaningful stand-in. -->
        <div class="rounded-lg bg-neutral-800 border border-neutral-700 p-4">
            <div class="text-neutral-300 font-semibold mb-2">Cost by model</div>
            <svg
                v-if="chartBars.length"
                :viewBox="`0 0 ${chartW} ${chartH}`"
                class="w-full h-40"
                preserveAspectRatio="none"
            >
                <g v-for="(bar, i) in chartBars" :key="bar.tag">
                    <rect
                        :x="bar.x"
                        :y="chartH - bar.h - 18"
                        :width="bar.w"
                        :height="bar.h"
                        :fill="palette[i % palette.length]"
                        rx="2"
                    />
                    <text
                        :x="bar.x + bar.w / 2"
                        :y="chartH - 4"
                        text-anchor="middle"
                        font-size="9"
                        fill="#737373"
                    >
                        {{ shortTag(bar.tag) }}
                    </text>
                </g>
            </svg>
            <div v-else class="text-neutral-500 text-xs">No data to chart yet.</div>
        </div>

        <!-- Per-request log slot (deferred to M5).
             When the backend gains GET /api/ai-usage/log this section will
             render a paginated table here using the same UsagePerModel
             component vocabulary. -->
        <div class="rounded-lg bg-neutral-800 border border-neutral-700 p-4 text-neutral-500 text-xs">
            Per-request log lands in a follow-up — backend currently exposes
            aggregates only.
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useAiUsage } from '../../composables/useAiUsage';
import { formatUsd, isOllamaTag, type UsageTotals } from '../../utilities/aiClient';

const { data, error } = useAiUsage();

const EMPTY_TOTALS: UsageTotals = { calls: 0, actualUsd: 0, projectedUsd: 0 };
const lifetime = computed<UsageTotals>(() => data.value?.lifetime ?? EMPTY_TOTALS);
const today = computed<UsageTotals>(() => data.value?.today ?? EMPTY_TOTALS);

const lastRequestLabel = computed(() => {
    const lr = data.value?.lastRequest;
    if (!lr) return '—';
    if (isOllamaTag(lr.modelTag)) return `${formatUsd(0)} (proj. ${formatUsd(lr.projectedUsd)})`;
    return formatUsd(lr.actualUsd);
});

function formatTotals(t: UsageTotals): string {
    return formatUsd(t.actualUsd);
}

const chartW = 600;
const chartH = 160;

const chartBars = computed(() => {
    const models = data.value?.perModel ?? [];
    if (!models.length) return [];
    const maxCost = Math.max(0.0001, ...models.map((m) => Math.max(m.actualUsd, m.projectedUsd)));
    const slot = chartW / models.length;
    const barW = Math.min(60, slot * 0.6);
    return models.map((m, i) => {
        const value = Math.max(m.actualUsd, m.projectedUsd);
        const h = (value / maxCost) * (chartH - 30);
        const x = i * slot + (slot - barW) / 2;
        return { tag: m.modelTag, x, w: barW, h };
    });
});

const palette = ['#a855f7', '#22d3ee', '#f59e0b', '#10b981', '#ef4444', '#ec4899'];

function shortTag(tag: string): string {
    return tag.length <= 14 ? tag : tag.slice(0, 12) + '…';
}
</script>
