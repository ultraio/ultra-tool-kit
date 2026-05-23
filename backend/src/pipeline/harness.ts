// Provider-agnostic schema-gated call wrapper.
//
// Load-bearing per docs/00-ai-global-guidelines.md §4.3 gate 1 (schema gate
// → single nudge retry → downgrade to `ask`) and §4.7 (cost-DoS posture:
// per-call wall-clock budget, output token cap, retry cap, no exponential
// backoff). Roadmap §6 row W1.
//
// W4 extension: multi-turn tool-use loop. When `opts.tools` is non-empty
// the harness extends the Zod schema with an internal `tool_use` variant
// (the provider interface in src/llm/provider.ts is FROZEN — we don't add
// a tools field there). When the model picks the `tool_use` branch the
// harness dispatches the requested tools in parallel through the W4
// dispatcher, appends `<chain_read>` fenced blocks to the user message,
// and loops. After MAX_TOOL_USE_TURNS cycles the harness forces a final
// structured turn so total provider calls per `call()` are capped at 4.
//
// Contract: the harness builds the provider-specific request from canonical
// inputs (system / user / Zod schema), enforces every budget knob, parses
// the provider's JSON response against the Zod schema, and returns a typed
// `HarnessResult<T>` the caller can branch on without re-validating.
//
// Budget breaches NEVER throw — they return `{ kind: 'refuse', reason }` so
// the upstream caller renders a normal chat bubble (guidelines §3.3 closes
// "always reply HTTP 200 with kind: refuse").

import { z, type ZodTypeAny } from 'zod';
import { type ChatProvider, type ChatUsage } from '../llm/provider.js';
import { escapeFence } from './prompts.js';
import {
    BudgetError,
    enforceBudget,
    type ToolAuditEntry,
    type ToolCtx,
    type ToolName,
    type ToolSpec,
} from './tools/index.js';
import { extractIdentifiers } from './validate.js';

export type HarnessBudget = {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxWallMs?: number;
    maxRetries?: number;
};

// Defaults follow guidelines §4.7: 15 s wall-clock, retry cap of 2, output
// cap small enough to keep Haiku 4.5 per-turn cost ≤ $0.0008 (roadmap §3
// "Per-turn target: ≤ 1.5 K input + ≤ 400 output"). The 6 K input cap is a
// generous ceiling — real W3+ prompts will run well under that.
export const DEFAULT_BUDGET: Required<HarnessBudget> = {
    maxInputTokens: 6000,
    maxOutputTokens: 1024,
    maxWallMs: 15_000,
    maxRetries: 2,
};

// Per-turn / per-session tool budgets. Defaults match §4.2 ("max 3 tool
// calls per LLM turn, max 6 across a session"). `sessionUsed` is the
// running count from the caller — the route handler keeps the per-session
// counter; the harness only enforces against it.
export type ToolBudget = {
    perTurn?: number;
    perSession?: number;
    sessionUsed: number;
};

export type HarnessCallOpts<T extends ZodTypeAny> = {
    provider: ChatProvider;
    schema: T;
    system: string;
    user: string;
    // W4 tool-use loop. When `tools` is non-empty, the harness builds an
    // extended schema with an internal `tool_use` variant; intercepts and
    // dispatches when the model picks it.
    tools?: readonly ToolSpec[];
    toolCtx?: ToolCtx; // required when tools is non-empty
    toolBudget?: ToolBudget; // required when tools is non-empty
    budget?: HarnessBudget;
};

export type HarnessRefuseReason =
    | 'input-too-large'
    | 'wall-clock'
    | 'retries-exhausted'
    | 'provider-error'
    | 'tool-budget' // W4 — per-turn or per-session budget exceeded
    | 'unknown-tool'; // W4 — model named a tool not in registry

export type HarnessResult<T> =
    | {
          kind: 'ok';
          value: T;
          usage: ChatUsage;
          attempts: number;
          toolAudit?: ToolAuditEntry[];
          // W4: union of EOSIO-name-shaped identifiers across every OK tool
          // response this turn. Route handler feeds this to validate.ts gate 5
          // as the "tool response" citation source (§4.3 gate 5, §4.1 rule 2).
          toolReturnedIdentifiers?: Set<string>;
      }
    | { kind: 'ask'; question: string; toolAudit?: ToolAuditEntry[]; toolReturnedIdentifiers?: Set<string> }
    | {
          kind: 'refuse';
          reason: HarnessRefuseReason;
          detail?: string;
          toolAudit?: ToolAuditEntry[];
          toolReturnedIdentifiers?: Set<string>;
      };

// Generic clarifying question used when the schema gate fails twice. Specific
// enough to be useful, generic enough to avoid leaking the structured shape
// to the user.
const TERMINAL_ASK_QUESTION =
    'I could not produce a structured reply for that request. Could you rephrase or add more detail?';

const SCHEMA_NUDGE_PREAMBLE =
    'Your previous reply was not valid JSON for the required schema. ' +
    'Emit ONLY the JSON object matching the schema. No prose, no markdown fences.';

// Hard ceiling on tool-use cycles. After this many turns the harness rewrites
// the user message with a <system_note> forcing the model to emit a final
// structured reply. Combined with `MAX_TOOL_USE_TURNS + 1` final turn this
// caps provider calls per `call()` at exactly 4 (1 initial + 3 follow-ups),
// matching the per-turn budget cap of 3.
const MAX_TOOL_USE_TURNS = 3;

const FORCE_FINAL_NOTE =
    'You have reached the tool-call budget for this turn. Emit a final structured reply now.';

// ~4 chars per token across the Anthropic + Ollama tokenizers in use. Cheap
// pre-call heuristic — avoids pulling a real tokenizer into the budget gate.
// Over-counts for code-heavy English; that's the safer bias for a ceiling.
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// Strip the JSON Schema $schema header — Anthropic's Tool.InputSchema and
// Ollama's `format` both reject the draft URL at the root.
function buildToolSchema(schema: ZodTypeAny): object {
    const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
    return rest;
}

function formatZodIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
            return `${path}: ${issue.message}`;
        })
        .join('; ');
}

// Internal-only schema. The model picks this kind when it wants chain data.
// The harness never returns this kind to the caller — it intercepts and loops.
// `input` is opaque here; the dispatcher's per-tool Zod is the real validator.
const ToolUseRequestSchema = z.object({
    kind: z.literal('tool_use'),
    calls: z
        .array(
            z.object({
                tool: z.string().min(1),
                input: z.record(z.string(), z.unknown()),
            })
        )
        .min(1)
        .max(3),
});

type ToolUseRequest = z.infer<typeof ToolUseRequestSchema>;

// schema is a discriminated union on `kind`. We attach ToolUseRequestSchema
// as one more variant. Using z.union is simpler than re-building the
// discriminated union (which requires matching the discriminator) and the
// downstream `kind` check still narrows correctly.
function extendSchemaWithToolUse<T extends ZodTypeAny>(schema: T): ZodTypeAny {
    return z.union([schema, ToolUseRequestSchema]);
}

function isKnownToolName(name: string, registry: readonly ToolSpec[]): name is ToolName {
    return registry.some((s) => s.name === name);
}

export async function call<T extends ZodTypeAny>(
    opts: HarnessCallOpts<T>
): Promise<HarnessResult<z.infer<T>>> {
    const budget: Required<HarnessBudget> = { ...DEFAULT_BUDGET, ...(opts.budget ?? {}) };

    // §4.7 gate 1: input budget. Refuse BEFORE calling the provider — this is
    // the cost-DoS guard, so we must never spend a token on oversized input.
    const inputEstimate = estimateTokens(opts.system) + estimateTokens(opts.user);
    if (inputEstimate > budget.maxInputTokens) {
        return {
            kind: 'refuse',
            reason: 'input-too-large',
            detail: `estimated ${inputEstimate} tokens > cap ${budget.maxInputTokens}`,
        };
    }

    const toolsEnabled = !!opts.tools && opts.tools.length > 0;
    const finalSchema = toolsEnabled ? extendSchemaWithToolUse(opts.schema) : opts.schema;
    const toolSchema = buildToolSchema(finalSchema);

    // §4.7 gate 2: wall-clock. AbortController aborts the in-flight provider
    // call; a flag mirrors the state so post-await branches can distinguish
    // timeout from other provider errors.
    const abort = new AbortController();
    let wallExpired = false;
    const wallTimer = setTimeout(() => {
        wallExpired = true;
        abort.abort('wall-clock');
    }, budget.maxWallMs);

    try {
        let schemaRetryUsed = false;
        let transientRetries = 0;
        let userMessage = opts.user;
        let attempts = 0;
        let toolUseTurns = 0;
        const toolAudit: ToolAuditEntry[] = [];
        // W4: union of identifiers seen in every OK tool payload this turn.
        // Returned on the result so the route handler can pass it to gate 5.
        const collectedIdentifiers = new Set<string>();
        // Empty Set is normalized to undefined so the route handler's `?:`
        // chain stays clean.
        const identifiersOut = (): Set<string> | undefined =>
            collectedIdentifiers.size > 0 ? collectedIdentifiers : undefined;
        const auditOut = (): ToolAuditEntry[] | undefined => (toolsEnabled ? toolAudit : undefined);
        const wallClockRefuse = (): HarnessResult<z.infer<T>> => ({
            kind: 'refuse',
            reason: 'wall-clock',
            toolAudit: auditOut(),
            toolReturnedIdentifiers: identifiersOut(),
        });

        // Outer loop covers transient provider errors (network / 5xx), the
        // single schema-fail retry, AND the W4 tool-use loop. They share the
        // loop but track separately:
        //   - transient retries capped at `budget.maxRetries`
        //   - schema retries capped at 1 (§4.3 gate 1)
        //   - tool-use turns capped at MAX_TOOL_USE_TURNS (§4.2 / §4.7)
        while (true) {
            if (wallExpired) return wallClockRefuse();
            attempts++;

            let res;
            try {
                res = await opts.provider.chat({
                    system: opts.system,
                    user: userMessage,
                    toolSchema,
                    maxTokens: budget.maxOutputTokens,
                    signal: abort.signal,
                });
            } catch (err) {
                if (wallExpired) return wallClockRefuse();
                if (transientRetries >= budget.maxRetries) {
                    return {
                        kind: 'refuse',
                        reason: 'retries-exhausted',
                        detail: err instanceof Error ? err.message : String(err),
                        toolAudit: auditOut(),
                        toolReturnedIdentifiers: identifiersOut(),
                    };
                }
                transientRetries++;
                continue; // No exponential backoff — §4.7 bans it.
            }

            const parsed = finalSchema.safeParse(res.json);
            if (!parsed.success) {
                // §4.3 gate 1: one nudge, then downgrade. Don't double-spend
                // the schema retry across transient retries; this branch only
                // fires when the provider returned successfully but with bad
                // shape. Applies equally to tool-use turns: if the model
                // emits neither the caller's reply nor a valid tool_use
                // request, that's a single-nudge case.
                if (!schemaRetryUsed) {
                    schemaRetryUsed = true;
                    userMessage = `${userMessage}\n\n${SCHEMA_NUDGE_PREAMBLE}\nValidator errors: ${formatZodIssues(parsed.error)}`;
                    continue;
                }
                return {
                    kind: 'ask',
                    question: TERMINAL_ASK_QUESTION,
                    toolAudit: auditOut(),
                    toolReturnedIdentifiers: identifiersOut(),
                };
            }

            // W4: intercept tool_use kind. Only meaningful when tools are
            // wired in — otherwise the schema can't produce this variant.
            if (toolsEnabled && (parsed.data as { kind?: string }).kind === 'tool_use') {
                // Hard stop: if the model ignored the forced-final
                // <system_note> and emitted tool_use again, we don't
                // dispatch — that's a budget breach.
                if (toolUseTurns >= MAX_TOOL_USE_TURNS) {
                    return {
                        kind: 'refuse',
                        reason: 'tool-budget',
                        toolAudit,
                        toolReturnedIdentifiers: identifiersOut(),
                    };
                }
                const toolUse = parsed.data as ToolUseRequest;

                // Per-turn budget: enforce against the PEAK count this batch
                // would push us to. `enforceBudget` checks `usedThisTurn >=
                // perTurn` so we pass the count of the LAST call this turn
                // (zero-indexed) — i.e. usedSoFar + batchSize - 1.
                const perTurn = opts.toolBudget?.perTurn ?? 3;
                const perSession = opts.toolBudget?.perSession ?? 6;
                const sessionUsed = opts.toolBudget?.sessionUsed ?? 0;
                const usedThisTurn = toolAudit.length;
                try {
                    enforceBudget(
                        usedThisTurn + toolUse.calls.length - 1,
                        sessionUsed + toolAudit.length + toolUse.calls.length - 1,
                        perTurn,
                        perSession
                    );
                } catch (err) {
                    if (err instanceof BudgetError) {
                        return {
                            kind: 'refuse',
                            reason: 'tool-budget',
                            toolAudit,
                            toolReturnedIdentifiers: identifiersOut(),
                        };
                    }
                    throw err;
                }

                // Validate every tool name BEFORE dispatching — one bad name
                // rejects the whole turn (§4.2 "Tool dispatcher rejects
                // unknown tool names — no dynamic dispatch").
                const enabledTools = opts.tools!;
                for (const c of toolUse.calls) {
                    if (!isKnownToolName(c.tool, enabledTools)) {
                        return {
                            kind: 'refuse',
                            reason: 'unknown-tool',
                            toolAudit,
                            toolReturnedIdentifiers: identifiersOut(),
                        };
                    }
                }

                // Dispatch in parallel through the caller-provided tool
                // registry. We don't use tools/index.ts `dispatch()` here
                // because the harness's enabled-tool set is `opts.tools` —
                // a subset (or mock) of the global registry. The dispatcher
                // pattern (wrap spec errors in a status: 'error' audit) is
                // duplicated here intentionally so the loop owns its own
                // boundary. Each result keeps its request-index so we can
                // sort deterministically afterwards.
                const results = await Promise.all(
                    toolUse.calls.map(async (c, idx) => {
                        const spec = enabledTools.find((s) => s.name === c.tool)!;
                        const start = performance.now();
                        try {
                            const payload = await spec.call(c.input, opts.toolCtx!);
                            const audit: ToolAuditEntry = {
                                name: spec.name,
                                input: c.input,
                                status: 'ok',
                                durMs: performance.now() - start,
                            };
                            return { idx, name: c.tool, payload, audit };
                        } catch (err) {
                            // Spec errors fence as status: 'error' — never
                            // throw out of dispatch. Stack + response body
                            // never logged (backend/CLAUDE.md hard rule 4).
                            const message = err instanceof Error ? err.message : String(err);
                            const audit: ToolAuditEntry = {
                                name: spec.name,
                                input: c.input,
                                status: 'error',
                                durMs: performance.now() - start,
                                error: message.split('\n')[0] ?? message,
                            };
                            return { idx, name: c.tool, payload: null, audit };
                        }
                    })
                );

                // Audit reflects ACTUAL call order (the parallel Promise.all
                // order, indexed by request position). Determinism for the
                // model-facing conversation comes from the next-turn sort.
                for (const r of results) {
                    toolAudit.push(r.audit);
                    if (r.audit.status === 'ok') {
                        for (const id of extractIdentifiers(r.payload)) {
                            collectedIdentifiers.add(id);
                        }
                    }
                }

                // Sort for the user-role conversation append. §6 determinism
                // contract: "tool results are sorted deterministically by
                // tool name before being concatenated into the next turn".
                const sorted = [...results].sort((a, b) => {
                    if (a.name !== b.name) return a.name.localeCompare(b.name);
                    return a.idx - b.idx;
                });

                // Schema retry is per the FINAL turn — reset between tool-use
                // cycles so a bad final turn still gets one nudge.
                schemaRetryUsed = false;

                const priorAssistantPart = `<prior_assistant>\n${escapeFence(JSON.stringify(toolUse))}\n</prior_assistant>`;
                const chainReadParts = sorted.map((r) => {
                    const payload =
                        r.audit.status === 'ok'
                            ? JSON.stringify(r.payload)
                            : JSON.stringify({ error: r.audit.error ?? 'tool error' });
                    const inputJson = escapeFence(JSON.stringify(toolUse.calls[r.idx]!.input));
                    const statusAttr = r.audit.status === 'error' ? ' status="error"' : '';
                    return `<chain_read tool="${r.name}" input="${inputJson}"${statusAttr}>\n${escapeFence(payload)}\n</chain_read>`;
                });
                userMessage = `${userMessage}\n\n${priorAssistantPart}\n\n${chainReadParts.join('\n\n')}`;
                toolUseTurns++;

                // After MAX_TOOL_USE_TURNS dispatches the harness has used
                // its budget. Stamp the NEXT-turn user message with a
                // <system_note> so the model knows it must emit a final
                // structured reply. Combined with MAX_TOOL_USE_TURNS this
                // caps total provider calls at MAX_TOOL_USE_TURNS + 1 = 4.
                if (toolUseTurns >= MAX_TOOL_USE_TURNS) {
                    userMessage = `${userMessage}\n\n<system_note>${FORCE_FINAL_NOTE}</system_note>`;
                }
                continue;
            }

            // Non-tool_use parse succeeded. When tools are enabled the
            // `finalSchema` is a union of the caller's schema + tool_use,
            // so we must re-narrow to the caller's schema before returning.
            // (When tools are disabled, finalSchema IS the caller's schema
            // and this re-narrow is effectively a no-op pass-through.)
            const callerParsed = toolsEnabled ? opts.schema.safeParse(parsed.data) : { success: true as const, data: parsed.data };
            if (!callerParsed.success) {
                // Shouldn't happen unless the model emits something that
                // matches tool_use shape after we forced the final turn.
                // Fall through to the schema-retry path.
                if (!schemaRetryUsed) {
                    schemaRetryUsed = true;
                    userMessage = `${userMessage}\n\n${SCHEMA_NUDGE_PREAMBLE}\nValidator errors: ${formatZodIssues(callerParsed.error)}`;
                    continue;
                }
                return {
                    kind: 'ask',
                    question: TERMINAL_ASK_QUESTION,
                    toolAudit: auditOut(),
                    toolReturnedIdentifiers: identifiersOut(),
                };
            }
            return {
                kind: 'ok',
                value: callerParsed.data as z.infer<T>,
                usage: res.usage,
                attempts,
                toolAudit: auditOut(),
                toolReturnedIdentifiers: identifiersOut(),
            };
        }
    } finally {
        clearTimeout(wallTimer);
    }
}
