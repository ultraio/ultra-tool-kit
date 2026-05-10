import OpenAI from 'openai';
import {
    ProviderError,
    type ChatProvider,
    type ChatRequest,
    type ChatResponse,
    type EmbedResponse,
} from './provider.js';

export type OpenAIConfig = {
    apiKey: string;
    embedModel: string;
    chatModel: string;
};

export function openAIConfigFromEnv(): OpenAIConfig {
    return {
        apiKey: process.env.OPENAI_API_KEY ?? '',
        embedModel: process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small',
        chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
    };
}

export class OpenAIProvider implements ChatProvider {
    private _client: OpenAI | null = null;

    constructor(private readonly config: OpenAIConfig = openAIConfigFromEnv()) {}

    private client(): OpenAI {
        if (!this._client) {
            if (!this.config.apiKey) {
                throw new ProviderError('OPENAI_API_KEY is not set', { provider: 'openai' });
            }
            this._client = new OpenAI({ apiKey: this.config.apiKey });
        }
        return this._client;
    }

    chat(_req: ChatRequest): Promise<ChatResponse> {
        return Promise.reject(
            new ProviderError('chat not implemented in M2; use anthropic or ollama', {
                provider: 'openai',
            })
        );
    }

    async embed(text: string): Promise<EmbedResponse> {
        const res = await this.client().embeddings.create({
            model: this.config.embedModel,
            input: text,
        });
        const first = res.data[0];
        if (!first) {
            throw new ProviderError('OpenAI embeddings returned no data', {
                provider: 'openai',
                model: this.config.embedModel,
            });
        }
        return {
            vector: first.embedding,
            usage: { input: res.usage?.prompt_tokens ?? text.length },
        };
    }

    modelTag(): string {
        return `openai:${this.config.chatModel}`;
    }

    vectorDim(): 768 | 1536 {
        return 1536;
    }
}
