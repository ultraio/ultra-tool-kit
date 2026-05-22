// Provider-agnostic schema-gated call wrapper.
//
// Load-bearing per docs/00-ai-global-guidelines.md §4.3 gate 1 (schema gate
// → single nudge retry → downgrade to `ask`) and §4.7 (cost-DoS posture:
// per-call wall-clock budget, output token cap, retry cap, no exponential
// backoff). Roadmap §6 row W1.
//
// Contract: the harness builds the provider-specific request from canonical
// inputs (system / user / Zod schema), enforces every budget knob, parses
// the provider's JSON response against the Zod schema, and returns a typed
// `HarnessResult<T>` the caller can branch on without re-validating.
//
// Budget breaches NEVER throw — they return `{ kind: 'refuse', reason }` so
// the upstream caller renders a normal chat bubble (guidelines §3.3 closes
// "always reply HTTP 200 with kind: refuse"). Tool dispatch is W4 territory;
// `tools` is accepted here and intentionally not forwarded yet.

import { z, type ZodTypeAny } from 'zod';
import { type ChatProvider, type ChatUsage } from '../llm/provider.js';

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

export type HarnessCallOpts<T extends ZodTypeAny> = {
    provider: ChatProvider;
    schema: T;
    system: string;
    user: string;
    // Reserved for W4's tool dispatcher. Accepted now so the W1 contract
    // doesn't need to change; not forwarded to the provider yet.
    tools?: unknown[];
    budget?: HarnessBudget;
};

export type HarnessRefuseReason =
    | 'input-too-large'
    | 'wall-clock'
    | 'retries-exhausted'
    | 'provider-error';

export type HarnessResult<T> =
    | { kind: 'ok'; value: T; usage: ChatUsage; attempts: number }
    | { kind: 'ask'; question: string }
    | { kind: 'refuse'; reason: HarnessRefuseReason; detail?: string };

// Generic clarifying question used when the schema gate fails twice. Specific
// enough to be useful, generic enough to avoid leaking the structured shape
// to the user.
const TERMINAL_ASK_QUESTION =
    'I could not produce a structured reply for that request. Could you rephrase or add more detail?';

const SCHEMA_NUDGE_PREAMBLE =
    'Your previous reply was not valid JSON for the required schema. ' +
    'Emit ONLY the JSON object matching the schema. No prose, no markdown fences.';

// ~4 chars per token across the Anthropic + Ollama tokenizers in use. Cheap
// pre-call heuristic — avoids pulling a real tokenizer into the budget gate.
// Over-counts for code-heavy English; that's the safer bias for a ceiling.
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

// Strip the JSON Schema $schema header — Anthropic's Tool.InputSchema and
// Ollama's `format` both reject the draft URL at the root.
function buildToolSchema<T extends ZodTypeAny>(schema: T): object {
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

    const toolSchema = buildToolSchema(opts.schema);

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

        // Outer loop covers transient provider errors (network / 5xx) AND the
        // single schema-fail retry. They share the loop but track separately:
        // transient retries are capped at `budget.maxRetries`; schema retries
        // at 1 (§4.3 gate 1).
        while (true) {
            if (wallExpired) return { kind: 'refuse', reason: 'wall-clock' };
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
                if (wallExpired) return { kind: 'refuse', reason: 'wall-clock' };
                if (transientRetries >= budget.maxRetries) {
                    return {
                        kind: 'refuse',
                        reason: 'retries-exhausted',
                        detail: err instanceof Error ? err.message : String(err),
                    };
                }
                transientRetries++;
                continue; // No exponential backoff — §4.7 bans it.
            }

            const parsed = opts.schema.safeParse(res.json);
            if (parsed.success) {
                return { kind: 'ok', value: parsed.data, usage: res.usage, attempts };
            }

            // §4.3 gate 1: one nudge, then downgrade. Don't double-spend the
            // schema retry across transient retries; this branch only fires
            // when the provider returned successfully but with bad shape.
            if (!schemaRetryUsed) {
                schemaRetryUsed = true;
                userMessage = `${opts.user}\n\n${SCHEMA_NUDGE_PREAMBLE}\nValidator errors: ${formatZodIssues(parsed.error)}`;
                continue;
            }
            return { kind: 'ask', question: TERMINAL_ASK_QUESTION };
        }
    } finally {
        clearTimeout(wallTimer);
    }
}
