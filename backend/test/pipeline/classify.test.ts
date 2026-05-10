import { describe, expect, it } from 'vitest';
import { classifyIntent, type IntentLabel } from '../../src/pipeline/classify.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';

class StubClassifier implements ChatProvider {
    public lastRequest: ChatRequest | null = null;
    constructor(private readonly payload: unknown) {}
    async chat(req: ChatRequest): Promise<ChatResponse> {
        this.lastRequest = req;
        return { json: this.payload, usage: { input: 50, output: 1 } };
    }
    embed(): Promise<never> {
        return Promise.reject(new Error('embed not used'));
    }
    modelTag(): string {
        return 'stub:classifier';
    }
    vectorDim(): 1536 {
        return 1536;
    }
}

const conversation = [
    { role: 'user' as const, content: 'How do I send 100 UOS?' },
    { role: 'assistant' as const, content: 'Sure — to whom?' },
    { role: 'user' as const, content: 'to acc2' },
];

describe('classifyIntent', () => {
    for (const label of ['ON_TOPIC', 'OFF_TOPIC', 'AMBIGUOUS'] as IntentLabel[]) {
        it(`returns ${label} when provider responds with that label`, async () => {
            const stub = new StubClassifier({ label });
            const r = await classifyIntent(conversation, { provider: stub });
            expect(r.label).toBe(label);
            expect(r.modelTag).toBe('stub:classifier');
            expect(r.usage).toEqual({ input: 50, output: 1 });
            expect(stub.lastRequest?.maxTokens).toBe(4);
            // Last 3 turns should appear in the user content
            expect(stub.lastRequest?.user).toContain('to acc2');
        });
    }

    it('defaults to AMBIGUOUS when the provider returns malformed JSON', async () => {
        const stub = new StubClassifier({ banana: 'cake' });
        const r = await classifyIntent(conversation, { provider: stub });
        expect(r.label).toBe('AMBIGUOUS');
    });

    it('defaults to AMBIGUOUS when label is unknown enum value', async () => {
        const stub = new StubClassifier({ label: 'MAYBE' });
        const r = await classifyIntent(conversation, { provider: stub });
        expect(r.label).toBe('AMBIGUOUS');
    });
});
