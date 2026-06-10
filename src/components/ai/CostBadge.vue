<template>
    <!--
        Operator-only sponsor-budget chip. Hidden from end users — `isDev` is
        true under `vite dev` and false in production builds (`vite build`).
        Surfaces today's spend so a developer can watch the §3.2 monthly cap
        without polling /api/ai-usage by hand.
    -->
    <div
        v-if="visible && isDev"
        class="flex items-center gap-2 px-2 py-1 rounded bg-neutral-700 text-[10px] text-neutral-300"
        data-testid="ai-cost-badge"
        :title="title"
    >
        <Icon icon="fa-coins" class="text-amber-300" />
        <span>Session: ${{ sessionCostFormatted }}</span>
        <span class="text-neutral-500">·</span>
        <!-- W10: prefer the per-identity `spent / cap` view; fall back to the
             global aggregate when no quota has been fetched yet. -->
        <span v-if="props.quota">Today: ${{ quotaSpentFormatted }} / ${{ quotaCapFormatted }}</span>
        <span v-else>Today: ${{ todayCostFormatted }}</span>
    </div>
</template>

<script setup lang="ts">
// W8: cost-display chip for the AI chat drawer.
//
// Renders TWO numbers in one chip:
//   - Session: sum of every per-turn `usage.cost_usd` observed since the
//     drawer's last reset.
//   - Today: today's aggregate spend for the active sub, fetched once on
//     drawer open via GET /api/ai-usage.
//
// The chip is hidden (v-if) until at least one of those numbers is > 0, so
// a user who never sends a message never sees "$0.0000". Errors from the
// usage endpoint are swallowed — the chip stays at its last known value.
import { computed, ref, watch, onMounted } from 'vue';
import { getAiUsage, type AiUsageSidecar, type QuotaView } from '../../utilities/aiClient';

const props = defineProps<{
    /** The most recent per-reply usage from useAiChat. null when no reply yet. */
    lastUsage: AiUsageSidecar | null;
    /** Whether the drawer is open — used to refetch today's aggregate when opened. */
    open: boolean;
    /** Bumped from the parent whenever the session is reset. */
    resetCounter?: number;
    /** W10: per-identity quota view from useAiChat. null until first fetch. */
    quota?: QuotaView | null;
}>();

const sessionCost = ref<number>(0);
const todayCost = ref<number>(0);
const visible = computed(() => sessionCost.value > 0 || todayCost.value > 0 || (props.quota?.spentTodayUsd ?? 0) > 0);
// Hide from production users — sponsor-budget telemetry is operator-only.
// Vite sets `import.meta.env.DEV` to true under `vite dev`, false in builds.
const isDev = import.meta.env.DEV;

const sessionCostFormatted = computed(() => sessionCost.value.toFixed(4));
const todayCostFormatted = computed(() => todayCost.value.toFixed(4));
const quotaSpentFormatted = computed(() => (props.quota?.spentTodayUsd ?? 0).toFixed(4));
const quotaCapFormatted = computed(() => (props.quota?.dailyCapUsd ?? 0).toFixed(2));
const title = computed(() =>
    props.quota
        ? `Session cost (this conversation): $${sessionCostFormatted.value}\nToday's spend: $${quotaSpentFormatted.value} of your $${quotaCapFormatted.value} daily cap`
        : `Session cost (this conversation): $${sessionCostFormatted.value}\nToday's spend: $${todayCostFormatted.value}`
);

// Accumulate session cost on every new usage sidecar. Also re-fetch the
// daily aggregate (G4): the cost_usd of the just-completed turn lands in
// usage.jsonl synchronously inside the middleware's try/finally, so by the
// time we get the sidecar back the JSONL aggregate is fresh. Without this,
// the "Today" value stays stale until the drawer is closed and reopened.
watch(
    () => props.lastUsage,
    (u) => {
        if (!u) return;
        sessionCost.value += u.cost_usd;
        refresh();
    }
);

// Reset session on parent's resetCounter bump.
watch(
    () => props.resetCounter,
    () => {
        sessionCost.value = 0;
    }
);

// Refetch today's aggregate when the drawer opens.
async function refresh() {
    try {
        const usage = await getAiUsage();
        todayCost.value = usage.costUsdToday;
    } catch {
        /* swallow — chip stays at last known value */
    }
}

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen) refresh();
    }
);

onMounted(() => {
    if (props.open) refresh();
});
</script>
