import Anthropic from '@anthropic-ai/sdk';
import {
    ProviderError,
    type ChatProvider,
    type ChatRequest,
    type ChatResponse,
} from './provider.js';

export type AnthropicConfig = {
    apiKey: string;
    baseUrl?: string;
    chatModel: string;
};

export function anthropicConfigFromEnv(): AnthropicConfig {
    return {
        apiKey: process.env.ANTHROPIC_API_KEY ?? '',
        baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
        chatModel: process.env.ANTHROPIC_CHAT_MODEL ?? 'claude-haiku-4-5-20251001',
    };
}

const STRUCTURED_TOOL_NAME = 'emit_structured_response';

export class AnthropicProvider implements ChatProvider {
    private _client: Anthropic | null = null;

    constructor(private readonly config: AnthropicConfig = anthropicConfigFromEnv()) {}

    private client(): Anthropic {
        if (!this._client) {
            if (!this.config.apiKey) {
                throw new ProviderError('ANTHROPIC_API_KEY is not set', { provider: 'anthropic' });
            }
            this._client = new Anthropic({
                apiKey: this.config.apiKey,
                baseURL: this.config.baseUrl,
            });
        }
        return this._client;
    }

    async chat(req: ChatRequest): Promise<ChatResponse> {
        const schema = (req.toolSchema ?? {
            type: 'object',
            additionalProperties: true,
        }) as Record<string, unknown>;

        // Prompt caching on the system block (roadmap §3, "Anthropic prompt
        // caching on system prompt"). Real cache hits require the cached
        // block to exceed the model's minimum cacheable size; for short
        // system prompts the SDK still accepts the directive and treats it
        // as a no-op. W2+ will feed a system prompt large enough to benefit.
        const system: Anthropic.TextBlockParam[] = [
            {
                type: 'text',
                text: req.system,
                cache_control: { type: 'ephemeral' },
            },
        ];

        const res = await this.client().messages.create(
            {
                model: this.config.chatModel,
                max_tokens: req.maxTokens ?? 1024,
                system,
                messages: [{ role: 'user', content: req.user }],
                tools: [
                    {
                        name: STRUCTURED_TOOL_NAME,
                        description: 'Emit the structured response payload defined by the input schema.',
                        input_schema: schema as Anthropic.Tool.InputSchema,
                    },
                ],
                tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
            },
            req.signal ? { signal: req.signal } : undefined
        );

        const tool = res.content.find(
            (block) => block.type === 'tool_use' && block.name === STRUCTURED_TOOL_NAME
        );
        if (!tool || tool.type !== 'tool_use') {
            throw new ProviderError('Anthropic response did not include the structured tool_use block', {
                provider: 'anthropic',
                model: this.config.chatModel,
                stopReason: res.stop_reason ?? null,
            });
        }
        const usage = res.usage;
        return {
            json: tool.input,
            usage: {
                input: usage?.input_tokens ?? 0,
                output: usage?.output_tokens ?? 0,
                cached: usage?.cache_read_input_tokens ?? undefined,
            },
        };
    }

    modelTag(): string {
        return `anthropic:${this.config.chatModel}`;
    }
}
