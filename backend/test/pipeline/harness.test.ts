// Harness contract tests — no real network, mock at the ChatProvider boundary.
//
// Covers the four scenarios listed in roadmap §6 row W1 acceptance:
//   1. Happy path (schema-valid output) — both providers
//   2. Schema-fail with retry → ok
//   3. Schema-fail terminal → ask
//   4. Budget exceeded (input / wall-clock / retries) → refuse, provider
//      never re-called after the cap trips
//
// The harness is provider-agnostic, so the same MockProvider exercises both
// the "anthropic shape" (provider returns parsed JSON directly) and the
// "ollama shape" (same — both providers normalise to `{ json, usage }` before
// the harness sees them). The "both providers" assertion is satisfied by
// running the same mock through two ChatProvider instances with different
// modelTags.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { call, estimateTokens, DEFAULT_BUDGET } from '../../src/pipeline/harness.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';

const ReplySchema = z.object({
    kind: z.literal('act'),
    contract: z.string(),
    action: z.string(),
});

type Reply = z.infer<typeof ReplySchema>;

function makeProvider(
    handler: (req: ChatRequest, callIndex: number) => Promise<ChatResponse> | ChatResponse,
    tag = 'anthropic:test'
): ChatProvider & { calls: number; lastReq: ChatRequest | null } {
    let calls = 0;
    let lastReq: ChatRequest | null = null;
    const provider = {
        async chat(req: ChatRequest): Promise<ChatResponse> {
            const idx = calls++;
            lastReq = req;
            return handler(req, idx);
        },
        modelTag(): string {
            return tag;
        },
        get calls() {
            return calls;
        },
        get lastReq() {
            return lastReq;
        },
    };
    return provider as ChatProvider & { calls: number; lastReq: ChatRequest | null };
}

const okReply: Reply = { kind: 'act', contract: 'eosio.token', action: 'transfer' };
const okJson: ChatResponse = {
    json: okReply,
    usage: { input: 100, output: 50 },
};

describe('harness.call', () => {
    describe('happy path', () => {
        it('returns ok with parsed value and usage for the anthropic shape', async () => {
            const provider = makeProvider(() => okJson, 'anthropic:haiku-4-5');
            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'transfer 100 UOS',
            });

            expect(result.kind).toBe('ok');
            if (result.kind !== 'ok') return;
            expect(result.value).toEqual(okReply);
            expect(result.usage).toEqual({ input: 100, output: 50 });
            expect(result.attempts).toBe(1);
            expect(provider.calls).toBe(1);
        });

        it('returns ok for the ollama shape (same mock, different modelTag)', async () => {
            const provider = makeProvider(() => okJson, 'ollama:qwen3:14b');
            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'transfer 100 UOS',
            });

            expect(result.kind).toBe('ok');
            expect(provider.calls).toBe(1);
        });

        it('forwards budget output cap to the provider as maxTokens', async () => {
            const provider = makeProvider(() => okJson);
            await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'u',
                budget: { maxOutputTokens: 256 },
            });
            expect(provider.lastReq?.maxTokens).toBe(256);
        });

        it('uses default budget when none is provided', async () => {
            const provider = makeProvider(() => okJson);
            await call({ provider, schema: ReplySchema, system: 'sys', user: 'u' });
            expect(provider.lastReq?.maxTokens).toBe(DEFAULT_BUDGET.maxOutputTokens);
        });
    });

    describe('schema gate (guidelines §4.3 gate 1)', () => {
        it('retries once with a nudge after invalid JSON, then returns ok', async () => {
            const provider = makeProvider((_req, idx) => {
                if (idx === 0) {
                    return { json: { kind: 'not-a-reply', garbage: true }, usage: { input: 10, output: 5 } };
                }
                return okJson;
            });

            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'transfer 100 UOS',
            });

            expect(result.kind).toBe('ok');
            if (result.kind !== 'ok') return;
            expect(result.attempts).toBe(2);
            expect(provider.calls).toBe(2);
            // The second call carries the nudge appended to the original user
            // message — proves the harness rebuilt the prompt, not just
            // re-sent it.
            expect(provider.lastReq?.user).toContain('Your previous reply was not valid JSON');
            expect(provider.lastReq?.user).toContain('transfer 100 UOS');
        });

        it('downgrades to ask after a second schema failure', async () => {
            const provider = makeProvider(() => ({
                json: { not: 'a reply' },
                usage: { input: 10, output: 5 },
            }));

            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'transfer 100 UOS',
            });

            expect(result.kind).toBe('ask');
            if (result.kind !== 'ask') return;
            expect(result.question).toMatch(/rephrase|detail/i);
            expect(provider.calls).toBe(2);
        });

        it('does not consume a transient retry budget on a schema failure', async () => {
            // First call: schema-bad. Second call (the nudge retry): network
            // throws. Third call (transient retry 1): ok. Two transient
            // retries should be available — schema-fail should not have
            // burned them.
            const provider = makeProvider((_req, idx) => {
                if (idx === 0) return { json: { wrong: 'shape' }, usage: { input: 10, output: 5 } };
                if (idx === 1) throw new Error('network blip');
                return okJson;
            });

            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'u',
                budget: { maxRetries: 2 },
            });

            expect(result.kind).toBe('ok');
            expect(provider.calls).toBe(3);
        });
    });

    describe('budget caps (guidelines §4.7)', () => {
        it('refuses input-too-large BEFORE calling the provider', async () => {
            const provider = makeProvider(() => okJson);
            const huge = 'x'.repeat(40_000); // ~10 K tokens, well over default 6 K cap

            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: huge,
            });

            expect(result.kind).toBe('refuse');
            if (result.kind !== 'refuse') return;
            expect(result.reason).toBe('input-too-large');
            // The cost-DoS guard MUST short-circuit before any provider call.
            expect(provider.calls).toBe(0);
        });

        it('refuses retries-exhausted after maxRetries+1 transient failures', async () => {
            const provider = makeProvider(() => {
                throw new Error('upstream 503');
            });

            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'u',
                budget: { maxRetries: 2 },
            });

            expect(result.kind).toBe('refuse');
            if (result.kind !== 'refuse') return;
            expect(result.reason).toBe('retries-exhausted');
            expect(result.detail).toContain('503');
            // 1 initial attempt + 2 retries = 3 total calls; nothing past that.
            expect(provider.calls).toBe(3);
        });

        it('refuses wall-clock on slow provider and does not re-invoke after the deadline', async () => {
            const provider = makeProvider(
                (req) =>
                    new Promise<ChatResponse>((_resolve, reject) => {
                        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                            once: true,
                        });
                    })
            );

            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'u',
                budget: { maxWallMs: 25, maxRetries: 2 },
            });

            expect(result.kind).toBe('refuse');
            if (result.kind !== 'refuse') return;
            expect(result.reason).toBe('wall-clock');
            // Even though maxRetries=2, the wall-clock cap MUST short-circuit
            // — the cost-DoS contract is that exceeding the wall budget
            // returns immediately, no further provider hits.
            expect(provider.calls).toBe(1);
        });
    });

    describe('estimateTokens', () => {
        it('returns 0 for empty, scales with length', () => {
            expect(estimateTokens('')).toBe(0);
            expect(estimateTokens('abcd')).toBe(1);
            expect(estimateTokens('abcdefghij')).toBe(3);
        });
    });

    describe('tools pass-through', () => {
        it('accepts an empty tools array without forwarding it to the provider (W1 pre-W4 shape)', async () => {
            const provider = makeProvider(() => okJson);
            const result = await call({
                provider,
                schema: ReplySchema,
                system: 'sys',
                user: 'u',
                tools: [],
            });

            expect(result.kind).toBe('ok');
            // tools is never forwarded as a `tools` field — the provider
            // interface is frozen. W4's loop is bypassed when tools is empty.
            expect((provider.lastReq as unknown as { tools?: unknown }).tools).toBeUndefined();
        });
    });
});
