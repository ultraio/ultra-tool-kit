// Layer-3 intent classifier — see docs/03-guardrails.md §2 Layer 3.

import { getProvider } from '../llm/router.js';
import type { ChatProvider, ChatUsage } from '../llm/provider.js';

export type IntentLabel = 'ON_TOPIC' | 'OFF_TOPIC' | 'AMBIGUOUS';

const SYSTEM_PROMPT = [
    `Classify whether the user's latest message is asking for help building an`,
    `Ultra blockchain transaction (e.g. transfer tokens, mint NFT, propose`,
    `multisig, manage factories, query account permissions).`,
    ``,
    `Reply with ONLY one of:`,
    `  ON_TOPIC`,
    `  OFF_TOPIC`,
    `  AMBIGUOUS`,
].join('\n');

const OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        label: { type: 'string', enum: ['ON_TOPIC', 'OFF_TOPIC', 'AMBIGUOUS'] },
    },
    required: ['label'],
    additionalProperties: false,
} as const;

function isIntentLabel(v: unknown): v is IntentLabel {
    return v === 'ON_TOPIC' || v === 'OFF_TOPIC' || v === 'AMBIGUOUS';
}

function renderConversation(messages: Array<{ role: 'user' | 'assistant'; content: string }>): string {
    return messages
        .slice(-3)
        .map((m) => `${m.role}: ${m.content}`)
        .join('\n');
}

export async function classifyIntent(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    deps?: { provider?: ChatProvider }
): Promise<{ label: IntentLabel; usage: ChatUsage; modelTag: string }> {
    const provider = deps?.provider ?? getProvider('classifier');
    const userContent = ['Conversation:', renderConversation(messages)].join('\n');

    // 16 tokens fits `{"label":"OFF_TOPIC"}` plus slack on Ollama, which counts the JSON
    // envelope. Hosted tool_use ignores the cap for short structured outputs, so this
    // doesn't change cost on Anthropic / OpenAI.
    let res;
    try {
        res = await provider.chat({
            system: SYSTEM_PROMPT,
            user: userContent,
            toolSchema: OUTPUT_SCHEMA,
            maxTokens: 16,
        });
    } catch {
        return { label: 'AMBIGUOUS', usage: { input: 0, output: 0 }, modelTag: provider.modelTag() };
    }

    const candidate = (res.json as { label?: unknown } | null | undefined)?.label;
    const label: IntentLabel = isIntentLabel(candidate) ? candidate : 'AMBIGUOUS';

    return { label, usage: res.usage, modelTag: provider.modelTag() };
}
