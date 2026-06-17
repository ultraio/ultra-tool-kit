<template>
    <Teleport to="body">
        <transition name="drawer-fade">
            <div
                v-if="props.open"
                class="fixed inset-0 z-50 flex justify-end"
                @click.self="emit('close')"
                data-testid="ai-chat-drawer"
            >
                <!-- Backdrop -->
                <div class="absolute inset-0 bg-black/40" />

                <!-- Panel. Width toggles between the side panel and full screen. -->
                <aside
                    class="relative h-full bg-neutral-900 border-l border-neutral-700 flex flex-col text-neutral-200 shadow-2xl"
                    :class="fullscreen ? 'w-full' : 'w-full md:w-96'"
                >
                    <header
                        class="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800"
                    >
                        <div class="flex items-center gap-2 font-semibold">
                            <Icon icon="fa-comments" class="text-purple-400" />
                            <span>AI Assistant</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <button
                                class="p-1.5 text-neutral-400 hover:text-neutral-100"
                                title="Backend settings"
                                @click="showSettings = !showSettings"
                                data-testid="ai-chat-settings"
                            >
                                <Icon icon="fa-gear" />
                            </button>
                            <button
                                class="hidden md:inline-flex p-1.5 text-neutral-400 hover:text-neutral-100"
                                :title="fullscreen ? 'Exit full screen' : 'Full screen'"
                                @click="toggleFullscreen"
                                data-testid="ai-chat-fullscreen"
                            >
                                <Icon :icon="fullscreen ? 'fa-compress' : 'fa-expand'" />
                            </button>
                            <button
                                class="p-1.5 text-neutral-400 hover:text-neutral-100"
                                title="Reset session"
                                @click="handleReset"
                            >
                                <Icon icon="fa-rotate-left" />
                            </button>
                            <button
                                class="p-1.5 text-neutral-400 hover:text-neutral-100"
                                title="Close"
                                @click="emit('close')"
                                data-testid="ai-chat-close"
                            >
                                <Icon icon="fa-xmark" />
                            </button>
                        </div>
                    </header>

                    <!-- Backend URL settings -->
                    <div
                        v-if="showSettings"
                        class="px-4 py-3 border-b border-neutral-700 bg-neutral-800/60 text-sm"
                        data-testid="ai-chat-settings-panel"
                    >
                        <label class="block text-xs text-neutral-400 mb-1">AI backend URL</label>
                        <div class="flex gap-2">
                            <input
                                v-model="backendUrlDraft"
                                placeholder="http://localhost:8787"
                                class="flex-grow rounded bg-neutral-950 text-neutral-200 px-3 py-1"
                            />
                            <button
                                class="px-3 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-50"
                                :disabled="checkingBackend"
                                @click="saveBackendUrl"
                            >
                                <Icon :icon="checkingBackend ? 'fa-spinner' : 'fa-check'" :spin="checkingBackend" />
                            </button>
                        </div>
                        <div class="mt-1 flex items-center justify-between text-xs">
                            <span class="text-neutral-500">Active: {{ activeBackendUrl }}</span>
                            <button class="text-neutral-400 hover:text-neutral-200 underline" @click="resetBackendUrl">
                                Reset to default
                            </button>
                        </div>
                        <p v-if="backendMsg" class="mt-1 text-xs" :class="backendOk ? 'text-emerald-400' : 'text-red-400'">
                            {{ backendMsg }}
                        </p>
                    </div>

                    <!-- Thinking / warming hint -->
                    <div
                        v-if="warming"
                        class="px-4 py-2 text-xs text-amber-300 bg-amber-900/20 border-b border-amber-800/40"
                        data-testid="ai-warming"
                    >
                        <span class="inline-block animate-pulse">●</span>
                        The model is thinking — a local model can take up to a minute on the first or a complex turn.
                        Hang tight, your message will still go through.
                    </div>

                    <!-- Messages. Inner column is width-capped + centered in full screen. -->
                    <div ref="scrollEl" class="flex-grow overflow-y-auto p-3">
                        <div class="flex flex-col gap-3 w-full" :class="fullscreen ? 'max-w-3xl mx-auto' : ''">
                            <div v-if="messages.length === 0" class="text-xs text-neutral-500 text-center mt-8">
                                Describe a transaction in plain English — e.g.
                                <span class="text-neutral-300">"transfer 100 UOS from acc1 to acc2"</span>.
                            </div>
                            <MessageBubble
                                v-for="(m, i) in messages"
                                :key="i"
                                :role="m.role"
                                :content="m.content"
                                :state="props.state"
                                @quick-reply="onQuickReply"
                                @reset="handleReset"
                            />
                            <div v-if="pending" class="text-xs text-neutral-500 italic">Thinking…</div>
                        </div>
                    </div>

                    <!-- Footer. Inner content is width-capped + centered in full screen. -->
                    <footer class="border-t border-neutral-700 p-3 bg-neutral-800">
                        <div :class="fullscreen ? 'max-w-3xl mx-auto w-full' : ''">
                            <!-- Unauthenticated CTA (guidelines §3.1) -->
                            <div
                                v-if="!loggedIn"
                                class="flex flex-col items-center gap-2 py-2 text-center"
                                data-testid="ai-chat-signin-cta"
                            >
                                <div class="text-xs text-neutral-400">Sign in with your wallet to use AI.</div>
                                <button
                                    class="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-sm"
                                    @click="onSignInClick"
                                    data-testid="ai-chat-signin"
                                >
                                    Sign in
                                </button>
                                <div class="text-[10px] text-neutral-500">
                                    Sign in and stake UOS to raise your daily AI budget.
                                </div>
                            </div>

                            <!-- Logged in but below the unlock threshold (W9 balance gate) -->
                            <div
                                v-else-if="quota?.locked"
                                class="flex flex-col items-center gap-1 py-2 text-center"
                                data-testid="ai-chat-locked"
                            >
                                <Icon icon="fa-lock" class="text-amber-300" />
                                <div class="text-xs text-neutral-300">
                                    AI needs ≥ {{ formatUos(quota.thresholdUos) }} UOS to unlock.
                                </div>
                                <div class="text-[10px] text-neutral-500">
                                    Your account holds {{ formatUos(quota.heldUos) }} UOS.
                                </div>
                            </div>

                            <!-- Logged in + unlocked (or quota not yet known) -->
                            <template v-else>
                                <div v-if="inlineError" class="mb-2 text-xs text-red-400" data-testid="ai-inline-error">
                                    {{ inlineError }}
                                </div>
                                <div class="flex gap-2 items-end">
                                    <textarea
                                        v-model="draft"
                                        rows="2"
                                        placeholder="Describe the transaction…"
                                        class="flex-grow resize-none bg-neutral-950 rounded border border-neutral-700 px-2 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-purple-500"
                                        @keydown="onKeydown"
                                        data-testid="ai-chat-input"
                                    />
                                    <button
                                        class="px-3 py-2 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 text-white"
                                        :disabled="pending || !draft.trim()"
                                        @click="onSend"
                                        data-testid="ai-chat-send"
                                    >
                                        <Icon icon="fa-paper-plane" />
                                    </button>
                                </div>
                                <!-- Compact usage row under the input (Claude-style): daily
                                 budget on the left (tap to expand), char count on the right. -->
                                <div class="flex items-center justify-between gap-2 text-[10px] text-neutral-500 mt-1">
                                    <button
                                        v-if="quota"
                                        type="button"
                                        class="flex items-center gap-1 rounded hover:text-neutral-300"
                                        :aria-expanded="showQuotaDetails"
                                        @click="showQuotaDetails = !showQuotaDetails"
                                        data-testid="ai-quota-budget"
                                    >
                                        <Icon icon="fa-coins" class="text-amber-300/80" />
                                        <span
                                            >${{ formatUsd4(quota.spentTodayUsd) }} / ${{
                                                formatUsd2(quota.dailyCapUsd)
                                            }}</span
                                        >
                                        <Icon
                                            :icon="showQuotaDetails ? 'fa-chevron-down' : 'fa-chevron-up'"
                                            class="text-[8px] text-neutral-600"
                                        />
                                    </button>
                                    <span v-else />
                                    <span class="whitespace-nowrap">{{ remaining }}/{{ MAX_MESSAGE_CHARS }}</span>
                                </div>
                                <!-- Expanded detail: stake-to-raise hint + send shortcut. -->
                                <div
                                    v-if="quota && showQuotaDetails"
                                    class="mt-1 pt-1 border-t border-neutral-700/60 text-[10px] leading-relaxed text-neutral-500"
                                    data-testid="ai-quota-details"
                                >
                                    <div>{{ raiseHint }}</div>
                                    <div class="text-neutral-600">Cmd/Ctrl+Enter to send</div>
                                </div>
                            </template>
                        </div>
                    </footer>
                </aside>
            </div>
        </transition>
    </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import * as I from '../../interfaces';
import { useAiChat, MAX_MESSAGE_CHARS } from '../../composables/useAiChat';
import MessageBubble from './MessageBubble.vue';
import { ensureAttestation } from '../../wallets/ultra';
import { getBaseUrl, getStoredBaseUrl, setBaseUrl, clearBaseUrl, pingBackend } from '../../utilities/aiClient';

const props = defineProps<{ open: boolean; state: I.AuthState }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'show-login'): void }>();

const stateRef = computed(() => props.state);
// The "Sign in with wallet" CTA is pure UI gating per docs/00 §3.1 — it
// ensures the AI has `validatedAccounts` from the wallet before the user
// can chat (the AI needs them to compose anything). The backend is
// anonymous (no JWT, no auth gate) and rate-limits on client IP — the
// CTA does not affect backend access.
const { messages, pending, warming, inlineError, sendMessage, reset, quota, refreshQuota } = useAiChat(stateRef);

const loggedIn = computed(() => !!props.state.accountName);

function handleReset() {
    reset();
}

const draft = ref<string>('');
const scrollEl = ref<HTMLElement | null>(null);
const remaining = computed(() => draft.value.length);
// Collapsed by default; the compact usage row expands to the stake hint.
const showQuotaDetails = ref(false);

// Full-screen toggle (desktop only — the drawer is already full width on mobile).
// Preference persists across opens within the browser.
const FULLSCREEN_KEY = 'aiChatFullscreen';
const fullscreen = ref<boolean>(localStorage.getItem(FULLSCREEN_KEY) === 'true');
function toggleFullscreen() {
    fullscreen.value = !fullscreen.value;
    localStorage.setItem(FULLSCREEN_KEY, String(fullscreen.value));
}

const showSettings = ref<boolean>(false);
const activeBackendUrl = ref<string>(getBaseUrl());
const backendUrlDraft = ref<string>(getStoredBaseUrl() ?? '');
const checkingBackend = ref<boolean>(false);
const backendMsg = ref<string>('');
const backendOk = ref<boolean>(false);

async function saveBackendUrl() {
    const url = backendUrlDraft.value.trim();
    if (!url) {
        clearBaseUrl();
        activeBackendUrl.value = getBaseUrl();
        backendOk.value = true;
        backendMsg.value = 'Reset to default.';
        return;
    }
    checkingBackend.value = true;
    backendMsg.value = '';
    const reachable = await pingBackend(url);
    checkingBackend.value = false;
    backendOk.value = reachable;
    setBaseUrl(url);
    activeBackendUrl.value = getBaseUrl();
    backendMsg.value = reachable
        ? 'Saved — backend reachable.'
        : 'Saved, but that URL was not reachable (check the URL / CORS origin).';
}

function resetBackendUrl() {
    clearBaseUrl();
    backendUrlDraft.value = '';
    activeBackendUrl.value = getBaseUrl();
    backendOk.value = true;
    backendMsg.value = 'Reset to default.';
}

// Display helpers for the quota/unlock footer.
function formatUos(v: number): string {
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function formatUsd4(v: number): string {
    return Number(v).toFixed(4);
}
function formatUsd2(v: number): string {
    return Number(v).toFixed(2);
}
// Text-only "stake to raise" hint — never composes a stake transaction
// (eosio.system is not in the catalog; see spec §7).
const raiseHint = computed(() => {
    const n = quota.value?.nextTier.stakeUosForMax;
    const max = quota.value?.nextTier.maxDailyUsd ?? 0;
    return n == null
        ? 'Stake UOS to raise your daily budget.'
        : `Stake ~${n.toLocaleString()} UOS for the $${max.toFixed(2)}/day max.`;
});

async function onSend() {
    const text = draft.value;
    if (!text.trim() || pending.value) return;
    draft.value = '';
    await sendMessage(text);
}

function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onSend();
    }
}

function onQuickReply(text: string) {
    draft.value = text;
    onSend();
}

// Close the drawer before surfacing the login modal — the drawer's z-50
// + full-screen backdrop would otherwise intercept clicks on the modal
// (Modal.vue is z-10). After sign-in the user reopens the drawer
// manually; the textarea will be active because `loggedIn` flipped true.
function onSignInClick() {
    emit('show-login');
    emit('close');
}

// Auto-scroll on new messages.
watch(
    () => messages.value.length,
    async () => {
        await nextTick();
        if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
    }
);

// W9: when the drawer opens for a logged-in Ultra-extension session and no
// attestation is cached yet, acquire one on demand so the FIRST chat request is
// already attested (per-pubkey rate-limit + balance gate). Opportunistic and
// fail-soft — ultra-web/anchor/ledger sessions skip this and use the per-IP path;
// ultra-web's connect-time attestation, if any, already arrives via populate.
watch(
    () => props.open,
    (open) => {
        if (open && loggedIn.value && props.state.type === 'ultra') {
            void ensureAttestation();
        }
        // W10: refresh the quota view on every open so the badge shows the
        // current `spent / cap` even before the first turn. Best-effort.
        if (open) void refreshQuota();
    },
    { immediate: true }
);
</script>

<style scoped>
.drawer-fade-enter-active,
.drawer-fade-leave-active {
    transition: opacity 150ms ease;
}
.drawer-fade-enter-from,
.drawer-fade-leave-to {
    opacity: 0;
}
</style>
