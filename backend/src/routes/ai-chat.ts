// POST /api/ai-chat — the wave-W3 entry point.
//
// Flow per docs/00-ai-global-guidelines.md §2 (trust boundary diagram):
//   1. Zod parse the request body (gate before any LLM touch).
//   2. JWT claims are already attached by jwtAuth middleware (W1.5).
//   3. Classifier short-circuits refuse / ask / answer / propose.
//   4. For act: retrieve top-5 catalog hits, build the fenced user message,
//      call the harness, run the §4.3 gate stack, return the validated
//      action (or downgrade to ask).
//
// Always HTTP 200 once the request is authed — failures become
// `{ kind: 'refuse', reason: '...' }`. Guidelines §3.3 closing.
// Internal errors are pino-logged and never re-raised to the response.

import { Hono } from 'hono';
import { z } from 'zod';

import { classify } from '../pipeline/classify.js';
import type { CatalogIndex } from '../pipeline/catalog.js';
import { retrieve } from '../pipeline/retrieve.js';
import { call as harnessCall } from '../pipeline/harness.js';
import { buildUserMessage, SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } from '../pipeline/prompts.js';
import {
    ReplySchema,
    type EosioTypes,
    validateAct,
    type Reply,
    type ValidateContext,
} from '../pipeline/validate.js';
import type { ChatProvider } from '../llm/provider.js';
import type { AuthContext } from '../middleware/auth.js';
import { logger } from '../middleware/logging.js';

// ─────────────────────────────────────────────────────────────────────────
// Request schema. Conservative limits — these are not security gates (the
// classifier + validator are), but they let us refuse pathological inputs
// (e.g. 1 MB messages) before the harness's input-token cap fires.
// ─────────────────────────────────────────────────────────────────────────

const MessageSchema = z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4000),
});

const ContextSchema = z.object({
    validatedAccounts: z.array(z.string()).max(50).default([]),
    knownAccounts: z.array(z.string()).max(50).default([]),
    selectedAccount: z.string().optional(),
    chainId: z.string().default(''),
    endpoint: z.string().default(''),
});

const RequestSchema = z.object({
    sessionId: z.string().min(1).max(128),
    messages: z.array(MessageSchema).min(1).max(30),
    context: ContextSchema,
});

type ChatRequestBody = z.infer<typeof RequestSchema>;

// Per W3 prompt: history is the last-N turns. N=6 matches roadmap §3
// "sliding window summary" and keeps the per-turn input budget under cap.
const HISTORY_WINDOW = 6;
const RETRIEVE_TOP_K = 5;

// The user-facing string when the classifier flags a topic this wave
// doesn't yet support. W6 will swap msig's; the body of the route stays
// the same.
const STUB_PROPOSE_QUESTION =
    "Multisig proposals aren't supported yet — could you rephrase as a single direct action you'd like to compose?";
const STUB_ANSWER_QUESTION =
    'Knowledge answers are coming in a later release. Could you describe the action you want to compose instead?';
const REFUSE_INTERNAL: Reply = { kind: 'refuse', reason: 'internal' };

export type AiChatDeps = {
    provider: ChatProvider;
    catalog: CatalogIndex;
    eosioTypes: EosioTypes;
};

export function createAiChatRouter(deps: AiChatDeps): Hono<AuthContext> {
    const app = new Hono<AuthContext>();

    app.post('/', async (c) => {
        // ─── Body parse / Zod gate ───────────────────────────────────────
        let raw: unknown;
        try {
            raw = await c.req.json();
        } catch {
            return c.json({ kind: 'refuse', reason: 'bad-request' } as Reply, 200);
        }
        const parsed = RequestSchema.safeParse(raw);
        if (!parsed.success) {
            return c.json({ kind: 'refuse', reason: 'bad-request' } as Reply, 200);
        }
        const body: ChatRequestBody = parsed.data;

        const auth = c.get('auth');

        // ─── Classifier short-circuits ───────────────────────────────────
        const lastTurn = body.messages[body.messages.length - 1];
        if (!lastTurn || lastTurn.role !== 'user') {
            return c.json({ kind: 'refuse', reason: 'bad-request' } as Reply, 200);
        }
        const userMessage = lastTurn.content;
        const intent = classify(userMessage);

        if (intent.kind === 'refuse') {
            return c.json({ kind: 'refuse', reason: intent.reason ?? 'refused' } as Reply, 200);
        }
        if (intent.kind === 'ask') {
            return c.json(
                {
                    kind: 'ask',
                    question:
                        "Could you describe the transaction in more detail — what contract, action, and parameters?",
                } as Reply,
                200
            );
        }
        if (intent.kind === 'propose') {
            return c.json({ kind: 'ask', question: STUB_PROPOSE_QUESTION } as Reply, 200);
        }
        if (intent.kind === 'answer') {
            return c.json({ kind: 'ask', question: STUB_ANSWER_QUESTION } as Reply, 200);
        }

        // ─── act path ────────────────────────────────────────────────────
        try {
            const hits = retrieve(userMessage, deps.catalog, RETRIEVE_TOP_K);
            const entries = hits
                .map((h) => deps.catalog.byKey.get(`${h.contract}::${h.action}`))
                .filter((e): e is NonNullable<typeof e> => e !== undefined);

            const history = body.messages.slice(-HISTORY_WINDOW - 1, -1);
            const user = buildUserMessage({
                history,
                turn: userMessage,
                catalogEntries: entries,
                context: {
                    selectedAccount: body.context.selectedAccount,
                    permission: auth.permission,
                    chainId: body.context.chainId || auth.chainId,
                    endpoint: body.context.endpoint,
                    validatedAccounts: body.context.validatedAccounts,
                    knownAccounts: body.context.knownAccounts,
                },
            });

            const out = await harnessCall({
                provider: deps.provider,
                schema: ReplySchema,
                system: SYSTEM_PROMPT,
                user,
            });

            if (out.kind === 'refuse') {
                return c.json({ kind: 'refuse', reason: out.reason } as Reply, 200);
            }
            if (out.kind === 'ask') {
                return c.json({ kind: 'ask', question: out.question } as Reply, 200);
            }

            const reply: Reply = out.value;

            // The harness already Zod-parsed against ReplySchema; this branch
            // is the §4.3 gate-1 second-line re-parse the W3 prompt calls
            // out. Identity-safe: same schema, same parse result.
            const reparsed = ReplySchema.safeParse(reply);
            if (!reparsed.success) {
                logger.warn({ issues: reparsed.error.issues }, 'ai-chat: reply failed re-parse');
                return c.json({ kind: 'ask', question: STUB_ANSWER_QUESTION } as Reply, 200);
            }
            const validated = reparsed.data;

            // The LLM is not supposed to emit propose in W3 (system prompt
            // says so), but if it does we downgrade rather than bubble up an
            // unvalidated multi-action structure.
            if (validated.kind === 'propose') {
                logger.warn('ai-chat: model emitted propose; downgrading (W6 territory)');
                return c.json({ kind: 'ask', question: STUB_PROPOSE_QUESTION } as Reply, 200);
            }
            // Non-act kinds (ask / refuse / answer): the model is free to
            // downgrade when it cannot safely compose. Pass through.
            if (validated.kind !== 'act') {
                return c.json(validated, 200);
            }

            // act — run the gate stack.
            const ctx: ValidateContext = {
                validatedAccounts: body.context.validatedAccounts,
                knownAccounts: body.context.knownAccounts,
                selectedAccount: body.context.selectedAccount,
                jwtPermission: auth.permission,
                jwtAccount: auth.account,
                userMessage,
            };
            const outcome = validateAct(validated, deps.catalog, deps.eosioTypes, ctx);
            if (outcome.kind === 'ask') {
                return c.json({ kind: 'ask', question: outcome.question } as Reply, 200);
            }
            return c.json(outcome.reply, 200);
        } catch (err) {
            // Internal errors never reach the user. Log structurally, return
            // a generic refuse.
            logger.error(
                { err: err instanceof Error ? err.message : String(err), promptVersion: SYSTEM_PROMPT_VERSION },
                'ai-chat: unexpected error'
            );
            return c.json(REFUSE_INTERNAL, 200);
        }
    });

    return app;
}
