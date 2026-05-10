// Reactive chat state + handoff into the toolkit's existing flows.
// - `messages` / `pending` / `lastReply` / `warming` drive ChatDrawer + ProposalCard.
// - `applyProposal('sign')` emits `updateAppActions` (App.vue picks it up and renders <Transaction>).
// - `applyProposal('builder')` writes the proposal into module-level `aiHandoff` and routes to /builder.
// - sessionId persists in `sessionStorage` so reopening the drawer in the same tab continues the session.

import { ref, type Ref } from 'vue';
import type { Router } from 'vue-router';
import { emitter } from '../eventBus';
import * as I from '../interfaces';
import {
    postAiAction,
    AiClientError,
    type Reply,
    type ReplyPropose,
    type AiActionRequest,
} from '../utilities/aiClient';

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_SESSION_MESSAGES = 30;
const SESSION_STORAGE_KEY = 'ai.chat.sessionId';

export interface ChatTurn {
    role: 'user' | 'assistant';
    content: string | Reply;
}

export interface AiHandoff {
    contract: string;
    action: string;
    data: Record<string, unknown>;
    authorization: { actor: string; permission: string };
    rationale?: string;
}

// Module-singleton state. Multiple ChatDrawer mounts share one conversation.
const messages = ref<ChatTurn[]>([]);
const pending = ref<boolean>(false);
const warming = ref<boolean>(false);
const lastReply = ref<Reply | null>(null);
const inlineError = ref<string | null>(null);
const sessionId = ref<string>(loadOrCreateSessionId());

// Module-shared handoff slot. Builder page reads + clears this on mount.
export const aiHandoff = ref<AiHandoff | null>(null);

function newUuid(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for very old browsers / SSR shims.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function loadOrCreateSessionId(): string {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = newUuid();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
}

export function useAiChat(authState?: Ref<I.AuthState>, router?: Router) {
    async function sendMessage(text: string): Promise<void> {
        inlineError.value = null;
        const trimmed = text.trim();
        if (!trimmed) return;

        if (trimmed.length > MAX_MESSAGE_CHARS) {
            inlineError.value = `Keep it concise — describe one transaction at a time (max ${MAX_MESSAGE_CHARS} chars).`;
            return;
        }
        if (messages.value.length >= MAX_SESSION_MESSAGES) {
            inlineError.value = "This conversation is getting long — start a new one.";
            return;
        }

        messages.value.push({ role: 'user', content: trimmed });
        pending.value = true;
        warming.value = false;

        const ctx = authState?.value;
        const req: AiActionRequest = {
            sessionId: sessionId.value,
            messages: messages.value.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : summarizeReply(m.content),
            })),
            context: {
                account: ctx?.accountName ?? 'unknown',
                permission: ctx?.accountPerm ?? 'active',
                endpoint: ctx?.endpoint ?? '',
                chainId: ctx?.chainId ?? '',
                isAdmin: ctx?.isAdmin ?? false,
                knownAccounts: [],
            },
        };

        try {
            const reply = await postAiAction(req, {
                onWarming: () => {
                    warming.value = true;
                },
            });
            lastReply.value = reply;
            messages.value.push({ role: 'assistant', content: reply });
        } catch (err) {
            const msg = err instanceof AiClientError ? err.message : "Couldn't reach the AI backend.";
            inlineError.value = msg;
            const fallback: Reply = { kind: 'refuse', reason: 'transport-error', detail: msg };
            lastReply.value = fallback;
            messages.value.push({ role: 'assistant', content: fallback });
        } finally {
            pending.value = false;
            warming.value = false;
        }
    }

    function applyProposal(p: ReplyPropose, mode: 'sign' | 'builder'): void {
        if (mode === 'sign') {
            const action: I.Action = {
                contract: p.contract,
                action: p.action,
                data: p.data,
                authorization: [p.authorization],
            };
            emitter.emit('updateAppActions', [action]);
            return;
        }

        // 'builder': stash the proposal and navigate. The builder page picks
        // it up on mount via `aiHandoff`.
        aiHandoff.value = {
            contract: p.contract,
            action: p.action,
            data: p.data,
            authorization: p.authorization,
            rationale: p.rationale,
        };
        router?.push({ path: '/builder', query: { ai: 'pending' } });
    }

    function reset(): void {
        messages.value = [];
        lastReply.value = null;
        inlineError.value = null;
        const fresh = newUuid();
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
        applyProposal,
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
            return `[proposed ${reply.contract}::${reply.action}]`;
    }
}
