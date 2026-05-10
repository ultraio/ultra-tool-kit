import Anthropic from '@anthropic-ai/sdk';
import {
    ProviderError,
    type ChatProvider,
    type ChatRequest,
    type ChatResponse,
    type EmbedResponse,
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

type ToolBlock = { type: 'tool_use'; name: string; input: unknown };

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

        const res = await this.client().messages.create({
            model: this.config.chatModel,
            max_tokens: req.maxTokens ?? 1024,
            system: req.system,
            messages: [{ role: 'user', content: req.user }],
            tools: [
                {
                    name: STRUCTURED_TOOL_NAME,
                    description: 'Emit the structured response payload defined by the input schema.',
                    input_schema: schema as Anthropic.Tool.InputSchema,
                },
            ],
            tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
        });

        const tool = res.content.find(
            (block): block is ToolBlock & Anthropic.ContentBlock =>
                block.type === 'tool_use' && block.name === STRUCTURED_TOOL_NAME
        );
        if (!tool) {
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

    embed(_text: string): Promise<EmbedResponse> {
        return Promise.reject(
            new ProviderError('Anthropic does not provide an embeddings API', {
                provider: 'anthropic',
            })
        );
    }

    modelTag(): string {
        return `anthropic:${this.config.chatModel}`;
    }

    vectorDim(): 768 | 1536 {
        return 1536;
    }
}
