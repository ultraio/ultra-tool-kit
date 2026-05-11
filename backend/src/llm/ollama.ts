import { Ollama } from 'ollama';
import {
    ProviderError,
    type ChatProvider,
    type ChatRequest,
    type ChatResponse,
    type EmbedResponse,
} from './provider.js';

export type OllamaConfig = {
    baseUrl: string;
    chatModel: string;
    embedModel: string;
    keepAlive: string;
};

export function ollamaConfigFromEnv(): OllamaConfig {
    return {
        baseUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
        chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen3:14b',
        embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
        // Per-request override of Ollama's default 5-min unload; keeps the model
        // resident across chat + classifier turns so the user never pays
        // first-load latency mid-conversation.
        keepAlive: process.env.OLLAMA_KEEP_ALIVE ?? '30m',
    };
}

const EMBED_DIM_BY_MODEL: Record<string, 768 | 1536> = {
    'nomic-embed-text': 768,
};

export class OllamaProvider implements ChatProvider {
    private readonly client: Ollama;

    constructor(private readonly config: OllamaConfig = ollamaConfigFromEnv()) {
        this.client = new Ollama({ host: this.config.baseUrl });
    }

    async chat(req: ChatRequest): Promise<ChatResponse> {
        const format = req.toolSchema ?? 'json';
        const res = await this.client.chat({
            model: this.config.chatModel,
            format,
            messages: [
                { role: 'system', content: req.system },
                { role: 'user', content: req.user },
            ],
            options: req.maxTokens ? { num_predict: req.maxTokens } : undefined,
            keep_alive: this.config.keepAlive,
            stream: false,
        });
        const content = res.message?.content ?? '';
        let json: unknown;
        try {
            json = JSON.parse(content);
        } catch (err) {
            throw new ProviderError('Ollama returned non-JSON content', {
                provider: 'ollama',
                model: this.config.chatModel,
                content,
                cause: err instanceof Error ? err.message : String(err),
            });
        }
        return {
            json,
            usage: {
                input: res.prompt_eval_count ?? 0,
                output: res.eval_count ?? 0,
            },
        };
    }

    async embed(text: string): Promise<EmbedResponse> {
        const res = await this.client.embeddings({
            model: this.config.embedModel,
            prompt: text,
            keep_alive: this.config.keepAlive,
        });
        return {
            vector: res.embedding,
            usage: { input: text.length },
        };
    }

    modelTag(): string {
        return `ollama:${this.config.chatModel}`;
    }

    vectorDim(): 768 | 1536 {
        const dim = EMBED_DIM_BY_MODEL[this.config.embedModel];
        if (!dim) {
            throw new ProviderError(`Unknown vector dimension for Ollama embed model "${this.config.embedModel}"`, {
                provider: 'ollama',
                model: this.config.embedModel,
            });
        }
        return dim;
    }
}
