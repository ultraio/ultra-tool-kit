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

                <!-- Panel -->
                <aside
                    class="relative h-full w-full md:w-96 bg-neutral-900 border-l border-neutral-700 flex flex-col text-neutral-200 shadow-2xl"
                >
                    <header
                        class="flex items-center justify-between px-4 py-3 border-b border-neutral-700 bg-neutral-800"
                    >
                        <div class="flex items-center gap-2 font-semibold">
                            <Icon icon="fa-comments" class="text-purple-400" />
                            <span>AI Assistant</span>
                        </div>
                        <div class="flex items-center gap-2">
                            <CostBadge
                                :last-usage="lastUsage"
                                :open="props.open"
                                :reset-counter="resetCounter"
                            />
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

                    <!-- Warming hint -->
                    <div
                        v-if="warming"
                        class="px-4 py-2 text-xs text-amber-300 bg-amber-900/20 border-b border-amber-800/40"
                        data-testid="ai-warming"
                    >
                        Still working — local models can take a few seconds per turn.
                    </div>

                    <!-- Messages -->
                    <div ref="scrollEl" class="flex-grow overflow-y-auto p-3 flex flex-col gap-3">
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

                    <!-- Footer -->
                    <footer class="border-t border-neutral-700 p-3 bg-neutral-800">
                        <!-- Unauthenticated CTA (guidelines §3.1) -->
                        <div
                            v-if="!loggedIn"
                            class="flex flex-col items-center gap-2 py-2 text-center"
                            data-testid="ai-chat-signin-cta"
                        >
                            <div class="text-xs text-neutral-400">
                                Sign in with your wallet to use AI.
                            </div>
                            <button
                                class="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-sm"
                                @click="onSignInClick"
                                data-testid="ai-chat-signin"
                            >
                                Sign in
                            </button>
                        </div>
                        <template v-else>
                            <div
                                v-if="inlineError"
                                class="mb-2 text-xs text-red-400"
                                data-testid="ai-inline-error"
                            >
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
                            <div class="text-[10px] text-neutral-500 mt-1">Cmd/Ctrl+Enter to send · {{ remaining }}/{{ MAX_MESSAGE_CHARS }}</div>
                        </template>
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
import CostBadge from './CostBadge.vue';
import MessageBubble from './MessageBubble.vue';

const props = defineProps<{ open: boolean; state: I.AuthState }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'show-login'): void }>();

const stateRef = computed(() => props.state);
// The "Sign in with wallet" CTA is pure UI gating per docs/00 §3.1 — it
// ensures the AI has `validatedAccounts` from the wallet before the user
// can chat (the AI needs them to compose anything). The backend is
// anonymous (no JWT, no auth gate) and rate-limits on client IP — the
// CTA does not affect backend access.
const { messages, pending, warming, inlineError, sendMessage, reset, lastUsage } = useAiChat(stateRef);

const loggedIn = computed(() => !!props.state.accountName);

// W8: bumped on every reset so CostBadge zeros out its session running total.
const resetCounter = ref(0);
function handleReset() {
    reset();
    resetCounter.value += 1;
}

const draft = ref<string>('');
const scrollEl = ref<HTMLElement | null>(null);
const remaining = computed(() => draft.value.length);

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
