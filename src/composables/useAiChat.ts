// Reactive chat state + handoff into the toolkit's existing flows.
//
// W3 wire-up:
//   - `sendMessage(text)` POSTs to `/api/ai-chat` via aiClient.postAiChat.
//   - On `kind: 'act'` the reply's I.Action[] is emitted onto the existing
//     `updateAppActions` event bus channel — same channel every other page
//     uses to open <Transaction>. Decision 10 (root CLAUDE.md): we do NOT
//     touch wallet code or Transaction.vue; we hand off through the bus
//     and let App.vue route it through the normal modal flow.
//   - Other kinds (ask/refuse/answer) render as bubbles via MessageBubble.
//
// sessionId persists in `sessionStorage` so reopening the drawer in the same
// tab continues the session. Per scripts/ai-ci-greps.sh grep #3, the value
// is a UUID — none of {jwt, bearer, pubkey} appear in the key.

import { ref, type Ref } from 'vue';
import { emitter } from '../eventBus';
import * as I from '../interfaces';
import {
    postAiChat,
    AiClientError,
    type Reply,
    type AiChatRequest,
} from '../utilities/aiClient';

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_SESSION_MESSAGES = 30;
const SESSION_STORAGE_KEY = 'ai.chat.sessionId';

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string | Reply;
}

// Module-singleton state. Multiple ChatDrawer mounts share one conversation.
const messages = ref<ChatTurn[]>([]);
const pending = ref<boolean>(false);
const warming = ref<boolean>(false);
const lastReply = ref<Reply | null>(null);
const inlineError = ref<string | null>(null);
const sessionId = ref<string>(loadOrCreateSessionId());

function loadOrCreateSessionId(): string {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
}

export interface UseAiChatOpts {
    // Source of an in-memory JWT for the backend's Authorization header.
    // W3 has no frontend acquisition flow yet (the wallet challenge/verify
    // wiring lands in a follow-up); local dev relies on the backend's
    // DEV_AUTH_BYPASS=true.
    getJwt?: () => string | undefined;
}

export function useAiChat(authState?: Ref<I.AuthState>, opts: UseAiChatOpts = {}) {
    async function sendMessage(text: string): Promise<void> {
        inlineError.value = null;
        const trimmed = text.trim();
        if (!trimmed) return;

        if (trimmed.length > MAX_MESSAGE_CHARS) {
            inlineError.value = `Keep it concise — describe one transaction at a time (max ${MAX_MESSAGE_CHARS} chars).`;
            return;
        }
        if (messages.value.length >= MAX_SESSION_MESSAGES) {
            inlineError.value = 'This conversation is getting long — start a new one.';
            return;
        }

        messages.value.push({ role: 'user', content: trimmed });
        pending.value = true;
        warming.value = false;

        const ctx = authState?.value;
        const selectedAccount = ctx?.accountName;
        const validatedAccounts = selectedAccount ? [selectedAccount] : [];
        const req: AiChatRequest = {
            sessionId: sessionId.value,
            messages: messages.value.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : summarizeReply(m.content),
            })),
            context: {
                validatedAccounts,
                knownAccounts: [],
                selectedAccount,
                chainId: ctx?.chainId ?? '',
                endpoint: ctx?.endpoint ?? '',
            },
        };

        try {
            const reply = await postAiChat(req, {
                onWarming: () => {
                    warming.value = true;
                },
                jwt: opts.getJwt?.(),
            });
            lastReply.value = reply;
            messages.value.push({ role: 'assistant', content: reply });
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
        } catch (err) {
            const msg = err instanceof AiClientError ? err.message : "Couldn't reach the AI backend.";
            inlineError.value = msg;
            const fallback: Reply = { kind: 'refuse', reason: 'transport-error' };
            lastReply.value = fallback;
            messages.value.push({ role: 'assistant', content: fallback });
        } finally {
            pending.value = false;
            warming.value = false;
        }
    }

    function reset(): void {
        messages.value = [];
        lastReply.value = null;
        inlineError.value = null;
        const fresh = crypto.randomUUID();
        sessionId.value = fresh;
        sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    }

    return {
        messages,
        pending,
        warming,
        lastReply,
        inlineError,
        sessionId,
        sendMessage,
        reset,
    };
}

function summarizeReply(reply: Reply): string {
    switch (reply.kind) {
        case 'ask':
            return reply.question;
        case 'refuse':
            return `[refused: ${reply.reason}]`;
        case 'propose':
            return `[proposed ${reply.proposalName}]`;
        case 'act': {
            const a = reply.actions[0];
            return a ? `[composed ${a.contract}::${a.action}]` : '[composed action]';
        }
        case 'answer':
            return reply.text;
    }
}
