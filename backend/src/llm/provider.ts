export type Provider = 'anthropic' | 'openai' | 'ollama';

export type ChatRequest = {
    system: string;
    user: string;
    toolSchema?: object;
    maxTokens?: number;
};

export type ChatUsage = {
    input: number;
    output: number;
    cached?: number;
};

export type EmbedUsage = {
    input: number;
};

export type ChatResponse = {
    json: unknown;
    usage: ChatUsage;
};

export type EmbedResponse = {
    vector: number[];
    usage: EmbedUsage;
};

export interface ChatProvider {
    chat(req: ChatRequest): Promise<ChatResponse>;
    embed(text: string): Promise<EmbedResponse>;
    modelTag(): string;
    vectorDim(): 768 | 1536;
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
