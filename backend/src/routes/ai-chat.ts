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
import { summarisePriorHistory } from '../pipeline/summary.js';
import { TOOL_REGISTRY, type ToolAuditEntry, type ToolCtx } from '../pipeline/tools/index.js';
import {
    ReplySchema,
    type EosioTypes,
    validateAct,
    validateAnswer,
    validatePropose,
    type Reply,
    type ValidateContext,
} from '../pipeline/validate.js';
import type { ChatProvider } from '../llm/provider.js';
import type { AuthContext } from '../middleware/auth.js';
import { logger } from '../middleware/logging.js';
import { computeCostUsd } from '../middleware/usage-log.js';

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

// Internal-error refuse — never reaches the user from any in-flight path
// the model controlled, only from catch blocks. The reason string maps to a
// generic chip via ProposalCard.vue's refuseHeading switch.
const REFUSE_INTERNAL: Reply = { kind: 'refuse', reason: 'internal' };

// W8: response wrapper — the route returns `{ reply, usage }` instead of the
// bare Reply. The usage sidecar is OPTIONAL: when the route short-circuits
// before any provider.chat() call (bad-request, classifier-refuse/ask,
// internal-error catch), `usage` is undefined and JSON.stringify omits it.
// NOTE: the frontend's src/utilities/aiClient.ts will need a parser update to
// destructure { reply, usage } before reading `reply.kind`. That change lands
// in a separate frontend task per the W8 brief.
type UsageSidecar = { cost_usd: number; tokens_in: number; tokens_out: number };
type ResponseEnvelope = { reply: Reply; usage?: UsageSidecar };

// Build the usage sidecar from the harness's cumulative usage + the active
// model tag. Uses computeCostUsd (re-exported from usage-log.ts) so the
// cost figure on the wire matches what the JSONL row records — single price
// table, no drift between sidecar and telemetry.
function buildUsage(modelTag: string, tokensIn: number, tokensOut: number): UsageSidecar {
    return {
        cost_usd: computeCostUsd(modelTag, tokensIn, tokensOut),
        tokens_in: tokensIn,
        tokens_out: tokensOut,
    };
}

// Generic clarifier when the schema gate trips post-harness (gate 1 re-parse
// failure). Same wording the act/propose paths show. Answer-intent failures
// take this same path because A1–A3 already refuse on their own; this
// fallback only fires when Zod itself rejects the reply shape.
const SCHEMA_RECOVERY_QUESTION =
    'I could not produce a structured reply for that request. Could you rephrase or add more detail?';

export type AiChatDeps = {
    provider: ChatProvider;
    catalog: CatalogIndex;
    eosioTypes: EosioTypes;
    // W4: host allowlist threaded into every ToolCtx. Sourced from
    // AppConfig.allowedChainHosts (which folds in DEFAULT_ALLOWLIST).
    allowedChainHosts: readonly string[];
};

// W4: per-session running count of tool calls, bounded by the §4.2 per-session
// budget (6). In-process; resets on backend restart. The Map lives at module
// scope per createAiChatRouter factory call. v1 single-instance per roadmap §9;
// a cross-process LRU is W8 polish.
//
// W5: parallel sessionEchoedTokens Map — a Set<`${contract}::${symbol}`> per
// session. Cross-turn echoes accumulate so a token surfaced in turn 1's
// get_table_rows is still cited in turn 3's get_balance. Lost on restart per
// roadmap §9 single-instance v1; a future Redis-backed store inherits the
// same Map<sessionId, Set<string>> interface. Bounded by the same random-
// eviction policy.
const SESSION_TOOL_COUNT_CAP = 10_000;

// Random-eviction helper shared by sessionToolCounts and sessionEchoedTokens.
// Drops the oldest insertion when at cap and the sessionId isn't already
// tracked — keeps both Maps' bounded-growth discipline identical (a future
// real LRU swap in W8 lands here).
function setWithEviction<V>(map: Map<string, V>, sessionId: string, value: V): void {
    if (map.size >= SESSION_TOOL_COUNT_CAP && !map.has(sessionId)) {
        const firstKey = map.keys().next().value;
        if (firstKey !== undefined) map.delete(firstKey);
    }
    map.set(sessionId, value);
}

// Variables added on top of the AuthContext for the ai-chat router. `toolAudit`
// is W4 plumbing — W8's telemetry middleware reads it off `c.var`.
// `validateCoerced` is W8 plumbing — set on every happy path (act/propose/
// answer) so the usage-log middleware can stamp `validation_outcome: 'coerced'`
// when the validator silently repaired the LLM's shape (§7).
// `providerModel` + `lastUsage` are W8 plumbing — set after the harness call
// so the usage-log middleware can compute cost_usd from the SAME model tag +
// cumulative token figures the response wrapper's sidecar exposes.
type AiChatContext = AuthContext & {
    Variables: AuthContext['Variables'] & {
        toolAudit: ToolAuditEntry[];
        validateCoerced: boolean;
        providerModel: string;
        lastUsage: { input: number; output: number };
    };
};

export function createAiChatRouter(deps: AiChatDeps): Hono<AiChatContext> {
    const app = new Hono<AiChatContext>();
    const sessionToolCounts = new Map<string, number>();
    // W5: cross-turn echoed-token store. Same eviction discipline as
    // sessionToolCounts; same single-instance v1 caveat.
    const sessionEchoedTokens = new Map<string, Set<string>>();

    app.post('/', async (c) => {
        // ─── Body parse / Zod gate ───────────────────────────────────────
        let raw: unknown;
        try {
            raw = await c.req.json();
        } catch {
            // W8: short-circuit before any provider call — no usage sidecar.
            return c.json({ reply: { kind: 'refuse', reason: 'bad-request' } } as ResponseEnvelope, 200);
        }
        const parsed = RequestSchema.safeParse(raw);
        if (!parsed.success) {
            return c.json({ reply: { kind: 'refuse', reason: 'bad-request' } } as ResponseEnvelope, 200);
        }
        const body: ChatRequestBody = parsed.data;

        const auth = c.get('auth');

        // ─── Classifier short-circuits ───────────────────────────────────
        const lastTurn = body.messages[body.messages.length - 1];
        if (!lastTurn || lastTurn.role !== 'user') {
            return c.json({ reply: { kind: 'refuse', reason: 'bad-request' } } as ResponseEnvelope, 200);
        }
        const userMessage = lastTurn.content;
        const intent = classify(userMessage);

        if (intent.kind === 'refuse') {
            return c.json(
                { reply: { kind: 'refuse', reason: intent.reason ?? 'refused' } } as ResponseEnvelope,
                200
            );
        }
        if (intent.kind === 'ask') {
            return c.json(
                {
                    reply: {
                        kind: 'ask',
                        question:
                            "Could you describe the transaction in more detail — what contract, action, and parameters?",
                    },
                } as ResponseEnvelope,
                200
            );
        }

        // ─── act / propose / answer path ────────────────────────────────
        // Same retrieve + buildUserMessage + harness flow for all three
        // structured kinds. The model decides which kind to emit; the
        // per-kind validator runs the right gate stack on the structured
        // reply. Documented cross-kind downgrade per §4.3 ("the model is
        // free to downgrade when it cannot safely compose") — a model
        // classified as `answer` is still free to up-shift into act/propose
        // if the user phrased an action as a question, or downgrade to ask
        // when it can't ground. W7: validateAnswer refuses (not asks) on
        // gate failure; act/propose still downgrade to ask.
        try {
            const hits = retrieve(userMessage, deps.catalog, RETRIEVE_TOP_K);
            const entries = hits
                .map((h) => deps.catalog.byKey.get(`${h.contract}::${h.action}`))
                .filter((e): e is NonNullable<typeof e> => e !== undefined);

            // W8: when history exceeds the window, compress surplus into one
            // sentence injected before the verbatim <prior_assistant> entries.
            // Returns { summary: '' } when there's no surplus, when SUMMARY=off,
            // or when the provider call fails — the route silently continues
            // with last-N turns verbatim in all three cases. Called BEFORE the
            // harness so its usage is counted exactly once (we fold it into
            // lastUsage below).
            const priorSummaryResult = await summarisePriorHistory(body.messages, {
                provider: deps.provider,
            });
            const priorSummary = priorSummaryResult.summary;

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
                priorSummary,
            });

            // W4: tools wired into the harness. The session counter is the
            // running total of tool calls this session; the harness enforces
            // the §4.2 per-turn (3) + per-session (6) caps and returns
            // `refuse: 'tool-budget'` when either trips.
            const sessionUsed = sessionToolCounts.get(body.sessionId) ?? 0;
            // W5: pre-populate echoedTokens from the session-scoped store so
            // a token surfaced in a previous turn remains citable this turn.
            const priorEchoedTokens = sessionEchoedTokens.get(body.sessionId) ?? new Set<string>();
            const toolCtx: ToolCtx = {
                endpoint: body.context.endpoint,
                allowlist: deps.allowedChainHosts,
                catalog: deps.catalog,
                echoedTokens: priorEchoedTokens,
            };
            const tools = Object.values(TOOL_REGISTRY);

            const out = await harnessCall({
                provider: deps.provider,
                schema: ReplySchema,
                system: SYSTEM_PROMPT,
                user,
                tools,
                toolCtx,
                toolBudget: { perTurn: 3, perSession: 6, sessionUsed },
            });

            // Update the per-session counter from the audit the harness built.
            // Cap the Map at SESSION_TOOL_COUNT_CAP entries to prevent unbounded
            // growth in long-running processes (random-eviction; real LRU is
            // W8 polish).
            const audit = out.toolAudit ?? [];
            if (audit.length > 0) {
                setWithEviction(sessionToolCounts, body.sessionId, sessionUsed + audit.length);
            }
            // W5: fold in this turn's echoed tokens (union into the
            // session-scoped Set). Same cap policy as tool counts.
            if (out.echoedTokens && out.echoedTokens.size > 0) {
                const updated = new Set([...priorEchoedTokens, ...out.echoedTokens]);
                setWithEviction(sessionEchoedTokens, body.sessionId, updated);
            }
            c.set('toolAudit', audit);

            // W8: fold harness usage + summary usage into one cumulative
            // figure. The summary call is a SEPARATE provider.chat — its
            // tokens land in tokens_in/tokens_out/cost_usd via this fold;
            // it does NOT consume the §4.2 tool budget (which is keyed off
            // toolAudit, not provider usage). Set providerModel + lastUsage
            // so the usage-log middleware records a §7-shaped row and the
            // response wrapper's sidecar uses the same numbers.
            const providerModel = deps.provider.modelTag();
            const harnessUsage = out.usage; // { input, output } | undefined
            const summaryUsage = priorSummaryResult.usage; // { input, output } | undefined
            const totalIn = (harnessUsage?.input ?? 0) + (summaryUsage?.input ?? 0);
            const totalOut = (harnessUsage?.output ?? 0) + (summaryUsage?.output ?? 0);
            c.set('providerModel', providerModel);
            c.set('lastUsage', { input: totalIn, output: totalOut });
            const usageSidecar = buildUsage(providerModel, totalIn, totalOut);

            if (out.kind === 'refuse') {
                return c.json(
                    {
                        reply: { kind: 'refuse', reason: out.reason } as Reply,
                        usage: usageSidecar,
                    } as ResponseEnvelope,
                    200
                );
            }
            if (out.kind === 'ask') {
                return c.json(
                    {
                        reply: { kind: 'ask', question: out.question } as Reply,
                        usage: usageSidecar,
                    } as ResponseEnvelope,
                    200
                );
            }

            const reply: Reply = out.value;

            // The harness already Zod-parsed against ReplySchema; this branch
            // is the §4.3 gate-1 second-line re-parse the W3 prompt calls
            // out. Identity-safe: same schema, same parse result.
            const reparsed = ReplySchema.safeParse(reply);
            if (!reparsed.success) {
                logger.warn({ issues: reparsed.error.issues }, 'ai-chat: reply failed re-parse');
                return c.json(
                    {
                        reply: { kind: 'ask', question: SCHEMA_RECOVERY_QUESTION } as Reply,
                        usage: usageSidecar,
                    } as ResponseEnvelope,
                    200
                );
            }
            const validated = reparsed.data;

            // Build the shared ValidateContext once — both validateAct and
            // validatePropose consume the same shape. Gate 5's "tool response"
            // citation source (§4.3 gate 5) is the union of identifiers
            // extracted from every OK tool payload this turn.
            const ctx: ValidateContext = {
                validatedAccounts: body.context.validatedAccounts,
                knownAccounts: body.context.knownAccounts,
                selectedAccount: body.context.selectedAccount,
                jwtPermission: auth.permission,
                jwtAccount: auth.account,
                userMessage,
                toolReturnedIdentifiers: out.toolReturnedIdentifiers,
            };

            // act reply — run validateAct. The model is free to downgrade
            // propose intent → act when one inner action suffices (§4.3).
            if (validated.kind === 'act') {
                const outcome = validateAct(validated, deps.catalog, deps.eosioTypes, ctx);
                if (outcome.kind === 'ask') {
                    logger.warn(
                        { failedGate: outcome.failedGate, classifierIntent: intent.kind },
                        'ai-chat: act reply downgraded to ask'
                    );
                    return c.json(
                        {
                            reply: { kind: 'ask', question: outcome.question } as Reply,
                            usage: usageSidecar,
                        } as ResponseEnvelope,
                        200
                    );
                }
                // W8: forward the validator's coerced flag for the usage-log
                // middleware (validation_outcome: 'coerced' when true).
                c.set('validateCoerced', outcome.coerced);
                return c.json({ reply: outcome.reply, usage: usageSidecar } as ResponseEnvelope, 200);
            }

            // propose reply — run validatePropose. Gates 1–6 run per inner
            // action; one bad inner action poisons the whole proposal.
            // Gate 7 runs after all inner actions pass. failedGate +
            // innerIndex are logged but never surfaced (§4.3 gate 1 generic-
            // clarifier rule).
            if (validated.kind === 'propose') {
                if (intent.kind !== 'propose') {
                    // Classifier said act; model up-shifted to propose. That's
                    // legitimate (model saw msig intent we missed). Validate
                    // normally — the log breadcrumb helps W8 audit.
                    logger.info('ai-chat: model emitted propose under act intent');
                }
                const outcome = validatePropose(validated, deps.catalog, deps.eosioTypes, ctx);
                if (outcome.kind === 'ask') {
                    logger.warn(
                        {
                            failedGate: outcome.failedGate,
                            innerIndex: outcome.innerIndex,
                            classifierIntent: intent.kind,
                        },
                        'ai-chat: propose reply downgraded to ask'
                    );
                    return c.json(
                        {
                            reply: { kind: 'ask', question: outcome.question } as Reply,
                            usage: usageSidecar,
                        } as ResponseEnvelope,
                        200
                    );
                }
                // W8: forward the validator's coerced flag for the usage-log
                // middleware (validation_outcome: 'coerced' when true).
                c.set('validateCoerced', outcome.coerced);
                return c.json({ reply: outcome.reply, usage: usageSidecar } as ResponseEnvelope, 200);
            }

            // answer reply — run validateAnswer (W7). The classifier routes
            // knowledge questions here; the model is also free to downgrade
            // act/propose intent → answer when it would rather explain than
            // compose. Gates A1–A3 refuse on failure (no ask path — either
            // the answer grounds or we decline). failedGate breadcrumb is
            // logged via logger.warn inside validateAnswer; the user sees
            // a generic reason string only (§4.3 gate-1 generic-clarifier
            // rule generalised to W7).
            if (validated.kind === 'answer') {
                const outcome = validateAnswer(validated, deps.catalog, ctx);
                if (outcome.kind === 'refuse') {
                    logger.warn(
                        { failedGate: outcome.failedGate, classifierIntent: intent.kind },
                        'ai-chat: answer refused'
                    );
                    return c.json(
                        {
                            reply: { kind: 'refuse', reason: outcome.reason } as Reply,
                            usage: usageSidecar,
                        } as ResponseEnvelope,
                        200
                    );
                }
                // W8: forward the validator's coerced flag for the usage-log
                // middleware. Always false for answer today (no reshape
                // branches in A1–A3), but plumbed uniformly with act/propose.
                c.set('validateCoerced', outcome.coerced);
                return c.json({ reply: outcome.reply, usage: usageSidecar } as ResponseEnvelope, 200);
            }

            // Non-structured kinds (ask / refuse): the model is free to
            // downgrade when it cannot safely compose. Pass through.
            return c.json({ reply: validated, usage: usageSidecar } as ResponseEnvelope, 200);
        } catch (err) {
            // Internal errors never reach the user. Log structurally, return
            // a generic refuse. usage is undefined — we don't know whether a
            // provider call landed before the throw.
            logger.error(
                { err: err instanceof Error ? err.message : String(err), promptVersion: SYSTEM_PROMPT_VERSION },
                'ai-chat: unexpected error'
            );
            return c.json({ reply: REFUSE_INTERNAL } as ResponseEnvelope, 200);
        }
    });

    return app;
}
