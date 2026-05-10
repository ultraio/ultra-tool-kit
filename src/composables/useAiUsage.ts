// Usage polling shared across consumers (CostBadge + /aiUsage page).
// One timer is kept alive while at least one consumer is active. The first
// consumer triggers an immediate fetch; subsequent ones reuse the running state.

import { ref, onMounted, onUnmounted } from 'vue';
import { getAiUsage, AiClientError, type UsageResponse } from '../utilities/aiClient';

const POLL_INTERVAL_MS = 10_000;

const data = ref<UsageResponse | null>(null);
const loading = ref<boolean>(false);
const error = ref<string | null>(null);

let activeCount = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: AbortController | null = null;

async function fetchOnce(): Promise<void> {
    if (inflight) inflight.abort();
    const controller = new AbortController();
    inflight = controller;
    loading.value = true;
    try {
        data.value = await getAiUsage({ signal: controller.signal });
        error.value = null;
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        error.value = err instanceof AiClientError ? err.message : "Couldn't reach the AI backend.";
    } finally {
        if (inflight === controller) inflight = null;
        loading.value = false;
    }
}

function activate(): void {
    activeCount += 1;
    if (activeCount === 1) {
        fetchOnce();
        timer = setInterval(fetchOnce, POLL_INTERVAL_MS);
    }
}

function deactivate(): void {
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount === 0) {
        if (timer) clearInterval(timer);
        timer = null;
        if (inflight) inflight.abort();
        inflight = null;
    }
}

export function useAiUsage(options: { autoStart?: boolean } = {}) {
    const autoStart = options.autoStart !== false;
    if (autoStart) {
        onMounted(activate);
        onUnmounted(deactivate);
    }
    return {
        data,
        loading,
        error,
        refresh: fetchOnce,
        activate,
        deactivate,
    };
}
