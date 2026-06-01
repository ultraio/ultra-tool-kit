import { Ollama } from 'ollama';
import {
    ProviderError,
    type ChatProvider,
    type ChatRequest,
    type ChatResponse,
} from './provider.js';

export type OllamaConfig = {
    baseUrl: string;
    chatModel: string;
    keepAlive: string;
    think: boolean;
};

export function ollamaConfigFromEnv(): OllamaConfig {
    return {
        // Accept either OLLAMA_BASE_URL (documented in .env.example) or the
        // legacy OLLAMA_URL; both default to local Ollama.
        baseUrl: process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434',
        chatModel: process.env.OLLAMA_CHAT_MODEL ?? 'qwen3:14b',
        // Per-request override of Ollama's default 5-min unload; keeps the model
        // resident across chat + classifier turns so the user never pays
        // first-load latency mid-conversation.
        keepAlive: process.env.OLLAMA_KEEP_ALIVE ?? '30m',
        // Reasoning ("thinking") models (qwen3, deepseek-r1, …) spend the
        // harness's 15s budget on hidden reasoning under forced-JSON output for
        // zero benefit here — the reply is schema-constrained JSON, not prose,
        // and a warm qwen3:14b drops from ~12s to ~2s with thinking off. Default
        // OFF; set OLLAMA_THINK=true to re-enable. Non-thinking models ignore it.
        think: process.env.OLLAMA_THINK === 'true',
    };
}

export class OllamaProvider implements ChatProvider {
    private readonly client: Ollama;

    constructor(private readonly config: OllamaConfig = ollamaConfigFromEnv()) {
        this.client = new Ollama({ host: this.config.baseUrl });
    }

    async chat(req: ChatRequest): Promise<ChatResponse> {
        const format = req.toolSchema ?? 'json';
        // Translate the harness's AbortSignal into Ollama's per-call abort.
        // The SDK's `abort()` is best-effort and throws if no call is in
        // flight — swallow it so we don't mask the underlying provider error.
        const abortHandler = req.signal
            ? () => {
                  try {
                      this.client.abort();
                  } catch {
                      /* no-op */
                  }
              }
            : null;
        if (abortHandler) req.signal!.addEventListener('abort', abortHandler, { once: true });
        try {
            const res = await this.client.chat({
                model: this.config.chatModel,
                format,
                think: this.config.think,
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
        } finally {
            if (abortHandler) req.signal!.removeEventListener('abort', abortHandler);
        }
    }

    modelTag(): string {
        return `ollama:${this.config.chatModel}`;
    }
}
