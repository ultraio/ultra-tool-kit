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
// tab continues the session.

import { ref, type Ref } from 'vue';
import { emitter } from '../eventBus';
import * as I from '../interfaces';
import { useWalletAccounts } from '../wallets/wallet-accounts';
import {
    postAiChat,
    fetchQuota,
    AiClientError,
    type Reply,
    type AiChatRequest,
    type QuotaView,
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
// W10: the caller's stake-tiered quota view from GET /api/ai-quota. null until
// the first successful fetch; kept at its last known value on fetch failure.
const quota = ref<QuotaView | null>(null);
const inlineError = ref<string | null>(null);
const sessionId = ref<string>(loadOrCreateSessionId());

function loadOrCreateSessionId(): string {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
}

export function useAiChat(authState?: Ref<I.AuthState>) {
    // W10: best-effort quota refresh — on failure keep the previous value,
    // never throw into the UI. Forwards the same attestation as the chat POST
    // so the backend reports the per-account (stake-tiered) view when it can.
    async function refreshQuota(): Promise<void> {
        try {
            const { attestation } = useWalletAccounts();
            quota.value = await fetchQuota(sessionId.value, authState?.value?.endpoint ?? '', {
                attestation: attestation.value,
            });
        } catch {
            /* swallow — badge stays at last known value */
        }
    }

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
        // G2/G3: pull the full wallet-attested account list. validatedAccounts
        // (backend gate 4 — actor must be in this set) gets the full list so
        // cross-account propose flows work. knownAccounts (gate 5's citation
        // source — "no invented identifiers") gets the same list so the user
        // doesn't have to type every account name verbatim in every turn.
        // Capped at 50 per the backend's Zod limit; deduped via Set in case
        // the wallet returns the same name twice.
        const { validatedAccounts: walletValidated, attestation } = useWalletAccounts();
        const walletAccountNames = [...new Set(walletValidated.value.map((a) => a.accountName))];
        const fallback = selectedAccount ? [selectedAccount] : [];
        const accountList = (walletAccountNames.length > 0 ? walletAccountNames : fallback).slice(0, 50);
        const req: AiChatRequest = {
            sessionId: sessionId.value,
            messages: messages.value.map((m) => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content : summarizeReply(m.content),
            })),
            context: {
                validatedAccounts: accountList,
                knownAccounts: accountList,
                selectedAccount,
                chainId: ctx?.chainId ?? '',
                endpoint: ctx?.endpoint ?? '',
            },
        };

        try {
            const response = await postAiChat(req, {
                onWarming: () => {
                    warming.value = true;
                },
                attestation: attestation.value,
            });
            const reply = response.reply;
            lastReply.value = reply;
            // W10: the turn's spend is recorded server-side by now — refresh
            // the quota view so the footer tracks `spent / cap` per turn.
            void refreshQuota();
            messages.value.push({ role: 'assistant', content: reply });
            if (reply.kind === 'propose') {
                // Ultra ext/web build + sign the proposal in-card (ProposalCard
                // drives useProposalSigner → eosio.msig::proposex). Anchor/Ledger
                // keep the <Transaction> modal flow, so emit to the bus for them.
                const walletType = ctx?.type;
                if (walletType !== 'ultra' && walletType !== 'ultra-web') {
                    emitter.emit('updateAppActions', reply.actions);
                }
            } else if (reply.kind === 'act') {
                // Ultra ext/web sign one-click from the chat card (no modal) —
                // ProposalCard drives Ultra.signTransaction directly. Anchor /
                // Ledger keep the modal flow, so emit to the bus for them and
                // App.vue opens <Transaction> as before.
                const walletType = ctx?.type;
                if (walletType !== 'ultra' && walletType !== 'ultra-web') {
                    emitter.emit('updateAppActions', reply.actions);
                }
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
        quota,
        inlineError,
        sessionId,
        sendMessage,
        refreshQuota,
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
