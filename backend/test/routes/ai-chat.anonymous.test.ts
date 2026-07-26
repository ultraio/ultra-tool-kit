// /api/ai-chat — anonymous-callable contract (W1.5-redo).
//
// Anonymous backend: POST with no Authorization header succeeds; POST with a
// stray bearer header is ignored. Replaces the W1.5 "POST without bearer
// returns 401" assertion.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const baseCfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'ollama', // ignored — mock provider injected
    allowedChainHosts: ['localhost', '127.0.0.1'],
};

// Use a clarifier-style request: the classifier routes "what is X" as ask;
// the provider is never called. That gives a deterministic 200 + Reply
// without depending on the model's act/propose machinery.
const baseRequest = {
    sessionId: 'session-anon',
    messages: [{ role: 'user' as const, content: 'tell me more please' }],
    context: {
        validatedAccounts: ['duncan'],
        knownAccounts: [],
        selectedAccount: 'duncan',
        chainId: 'dev',
        endpoint: 'http://localhost:8888',
    },
};

function mockProvider(handler: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>): ChatProvider & {
    calls: number;
} {
    let calls = 0;
    const p = {
        async chat(req: ChatRequest): Promise<ChatResponse> {
            calls++;
            return handler(req);
        },
        modelTag(): string {
            return 'mock:anon';
        },
        get calls() {
            return calls;
        },
    };
    return p as ChatProvider & { calls: number };
}

function defaultReply(): ChatResponse {
    return {
        json: { kind: 'ask', question: 'Could you describe the transaction in more detail?' },
        usage: { input: 10, output: 5 },
    };
}

beforeEach(() => {
    _resetCatalogCache();
    _resetEosioTypesCache();
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/ai-chat — anonymous-callable (W1.5-redo)', () => {
    it('succeeds with NO Authorization header — returns 200 + Reply envelope', async () => {
        const provider = mockProvider(() => defaultReply());
        const app = await createApp(baseCfg, { provider });

        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(baseRequest),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const envelope = (await res.json()) as { reply: { kind: string } };
        expect(['ask', 'act', 'refuse', 'answer', 'propose']).toContain(envelope.reply.kind);
    });

    it('ignores a stray Authorization header — same successful response', async () => {
        const provider = mockProvider(() => defaultReply());
        const app = await createApp(baseCfg, { provider });

        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: 'Bearer some-stale-jwt-that-should-be-ignored',
                },
                body: JSON.stringify(baseRequest),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const envelope = (await res.json()) as { reply: { kind: string } };
        expect(['ask', 'act', 'refuse', 'answer', 'propose']).toContain(envelope.reply.kind);
    });

    it('non-loopback request without Authorization header also succeeds (anonymous backend)', async () => {
        const provider = mockProvider(() => defaultReply());
        // devRatelimitBypass=true but request comes from a WAN IP. There's no
        // auth gate now — the request proceeds through rate-limit normally.
        const app = await createApp(baseCfg, { provider });
        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(baseRequest),
            },
            { incoming: { socket: { remoteAddress: '203.0.113.7' } } }
        );
        // 200, not 401 — anonymous backend has no auth gate.
        expect(res.status).toBe(200);
        const envelope = (await res.json()) as { reply: { kind: string } };
        expect(envelope.reply.kind).toBeDefined();
    });
});
