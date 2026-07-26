// Sliding-window history compression (roadmap §3 + wave W8).
//
// The chat route keeps the last HISTORY_WINDOW prior turns verbatim. Anything
// older than that would otherwise be dropped. This module compresses the
// surplus older turns into ONE sentence via a cheap, separate provider call;
// the route handler injects the result as a <prior_summary> fenced block in
// the next turn's user message (the fence is enumerated in prompts.ts's
// SYSTEM_PROMPT rule 4 and escapeFence regex).
//
// This is a planner-side call — NOT a tool. The closed 5-tool registry under
// pipeline/tools/ stays at 5; the §4.2 per-turn / per-session tool budgets are
// untouched. The summary's tokens land in tokens_in/tokens_out via the usage
// log (caller adds the returned `usage` to `c.var.lastUsage`).
//
// Failure mode is silent: any error returns { summary: '' } so the main turn
// never blocks on summary infrastructure problems.

import type { ChatProvider } from '../llm/provider.js';
import { escapeFence, type PromptHistoryTurn } from './prompts.js';

// Mirrors the constant in routes/ai-chat.ts. Kept in sync by convention —
// changing one without the other would break the slicing math the route
// relies on.
export const HISTORY_WINDOW = 6;

export type SummariseDeps = {
    provider: ChatProvider;
    // Default true; pass `enabled: false` (or set SUMMARY=off in env) to
    // short-circuit before any provider call.
    enabled?: boolean;
};

export type SummariseResult = {
    summary: string;
    usage?: { input: number; output: number };
};

// Static system prompt for the summariser. Stays static per guidelines §4.1
// rule 2 — never concatenate untrusted text into the system message.
const SUMMARY_SYSTEM_PROMPT =
    'You compress chat history into one sentence. Output only the JSON object the schema requires.';

// The verbatim phrase from the W8 brief. Stays as a single string so a future
// edit can't drift its wording across the codebase.
const SUMMARY_USER_PREAMBLE =
    'Summarize the prior conversation into one sentence. Keep account names, asset symbols, and intent verbs verbatim.';

// JSON-schema-gated output. The Anthropic provider wires this through a forced
// tool_use block; the Ollama provider passes it as the `format` parameter
// (provider.ts contract). Either way we read back `result.json.summary`.
const SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string' },
    },
    required: ['summary'],
} as const;

// TODO: ChatRequest in src/llm/provider.ts does not currently expose a
// `temperature` field. The Anthropic SDK call uses its default temperature.
// W8 brief calls for temperature: 0 for determinism — acceptable for v1
// since each call has a tight 200-token cap and a single-sentence schema.
// Add temperature to ChatRequest in a follow-up when other call sites need it.

function renderTurn(turn: PromptHistoryTurn): string {
    // Surplus content is itself prior user/assistant text — fence inside the
    // user message so the model treats it as DATA per rule 4. We use the same
    // fence names the rest of the pipeline uses so escapeFence already knows
    // to strip stray closing tags.
    const tag = turn.role === 'user' ? 'user_input' : 'prior_assistant';
    return `<${tag}>\n${escapeFence(turn.content)}\n</${tag}>`;
}

export async function summarisePriorHistory(
    messages: PromptHistoryTurn[],
    deps: SummariseDeps
): Promise<SummariseResult> {
    // Env short-circuit: SUMMARY=off disables the feature entirely without
    // touching deps. Lets ops kill it without a deploy.
    if (process.env.SUMMARY === 'off') {
        return { summary: '' };
    }
    if (deps.enabled === false) {
        return { summary: '' };
    }

    // Conservative threshold: messages.length includes the current turn, so
    // we only summarise when there are MORE than HISTORY_WINDOW prior turns
    // (i.e. surplus is non-empty after stripping the last HISTORY_WINDOW
    // turns the route already keeps verbatim).
    if (messages.length <= HISTORY_WINDOW + 1) {
        return { summary: '' };
    }

    // The surplus is the older head — every message EXCEPT the last
    // HISTORY_WINDOW. The route slices `messages.slice(-HISTORY_WINDOW - 1, -1)`
    // for verbatim history, so this surplus is strictly older than what the
    // main LLM call sees.
    const surplus = messages.slice(0, messages.length - HISTORY_WINDOW);

    const userParts: string[] = [SUMMARY_USER_PREAMBLE, '', 'Conversation:'];
    for (const turn of surplus) {
        userParts.push(renderTurn(turn));
    }
    const user = userParts.join('\n');

    try {
        const result = await deps.provider.chat({
            system: SUMMARY_SYSTEM_PROMPT,
            user,
            toolSchema: SUMMARY_SCHEMA,
            maxTokens: 200,
        });

        const json = result.json as { summary?: unknown } | null | undefined;
        const summary = typeof json?.summary === 'string' ? json.summary.trim() : '';
        if (!summary) {
            return { summary: '' };
        }

        return {
            summary,
            usage: { input: result.usage.input, output: result.usage.output },
        };
    } catch {
        // Never block the main turn on a summary failure. Silent fall-through
        // — the route still proceeds with the last HISTORY_WINDOW turns
        // verbatim, just without the <prior_summary> head.
        return { summary: '' };
    }
}
