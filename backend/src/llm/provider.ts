// Provider abstraction for the AI harness.
//
// Two providers only — `anthropic` (Haiku 4.5) and `ollama` (local
// Haiku-equivalent, qwen3:14b default) — per roadmap §4 decision 3 and
// backend/CLAUDE.md hard rule 5.
//
// JSON-schema-gated outputs are the contract: every chat call returns the
// provider's best attempt at a JSON value matching `toolSchema`. The harness
// runs Zod against that value; the provider does not validate.

export type Provider = 'anthropic' | 'ollama';

export type ChatRequest = {
    system: string;
    user: string;
    // JSON Schema describing the response shape the provider should emit. The
    // Anthropic provider wires this through a forced `tool_use` block; the
    // Ollama provider passes it as the `format` parameter.
    toolSchema?: object;
    // Hard ceiling on output tokens. Required upstream by the harness so
    // every call carries a §4.7 cost-DoS budget; providers default to a
    // conservative value if the harness ever forgets to pass it.
    maxTokens?: number;
    // Wall-clock abort signal supplied by the harness (§4.7). Providers must
    // propagate to the underlying SDK.
    signal?: AbortSignal;
};

export type ChatUsage = {
    input: number;
    output: number;
    cached?: number;
};

export type ChatResponse = {
    json: unknown;
    usage: ChatUsage;
};

export interface ChatProvider {
    chat(req: ChatRequest): Promise<ChatResponse>;
    modelTag(): string;
}

export class ProviderError extends Error {
    constructor(
        message: string,
        public readonly context: Record<string, unknown> = {}
    ) {
        super(message);
        this.name = 'ProviderError';
    }
}
