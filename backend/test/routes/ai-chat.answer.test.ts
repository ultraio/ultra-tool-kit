// End-to-end POST /api/ai-chat — answer path (W7).
//
// Mirrors ai-chat.test.ts / ai-chat.propose.test.ts: real catalog + real
// eosio-types + real classify/retrieve/validateAnswer, mocked ChatProvider.
// Mounts the full createApp() stack so the rate-limit middleware is in
// the path; loopback bypasses the per-IP buckets via DEV_RATELIMIT_BYPASS.
// Anonymous backend per docs/00 §3.1 — no Authorization header needed.
//
// Cases per W7 prompt:
//   1. Happy: provider returns a grounded answer mentioning a real
//      (contract, action) pair → 200, kind: 'answer'.
//   2. Invented reference: provider returns an answer naming a (contract,
//      action) pair not in the catalog → 200, kind: 'refuse', reason
//      'unsupported-reference'. The provider IS called (validateAnswer
//      decides post-harness).
//   3. Smuggled JSON action: provider returns an answer with a covert
//      {contract, action, data} JSON literal → 200, kind: 'refuse',
//      reason 'unsupported-reference' (or 'malformed-answer' — whichever
//      gate the validator emits).
//   4. Classifier short-circuit: user asks "what is bitcoin?" → 200,
//      kind: 'refuse', reason 'out-of-scope', provider.calls === 0. The
//      provider-not-called assertion is load-bearing per the W7 simplifier
//      exclusion list — the classifier is the cost + safety win of W2.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const baseCfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'ollama', // ignored — we inject a mock provider
    allowedChainHosts: ['localhost', '127.0.0.1'],
};

// User asks about an action that genuinely exists in the catalog.
// (eosio.nft.ft, transfer) is the cleanest happy-path target — it's in
// the catalog and the BM25 retriever will surface it as a top hit.
const HAPPY_USER_MSG = 'what does eosio.nft.ft::transfer do?';

const baseRequest = {
    sessionId: 'session-w7',
    messages: [{ role: 'user' as const, content: HAPPY_USER_MSG }],
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
            return 'mock:w7';
        },
        get calls() {
            return calls;
        },
    };
    return p as ChatProvider & { calls: number };
}

function answerReply(text: string): ChatResponse {
    return {
        json: { kind: 'answer', text },
        usage: { input: 200, output: 80 },
    };
}

beforeEach(() => {
    _resetCatalogCache();
    _resetEosioTypesCache();
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/ai-chat — answer path (happy)', () => {
    it('returns kind:answer with grounded text when the model cites a real catalog pair', async () => {
        const provider = mockProvider(() =>
            answerReply(
                'The eosio.nft.ft::transfer action moves a uniq from the owner to another account. It requires authorization from the current owner.'
            )
        );
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
        const envelope = (await res.json()) as {
            reply: { kind: string; text?: string };
            usage?: { cost_usd: number; tokens_in: number; tokens_out: number };
        };
        const body = envelope.reply;
        expect(body.kind).toBe('answer');
        expect(body.text).toContain('eosio.nft.ft::transfer');
        // Provider IS called for the happy path (no classifier short-circuit).
        expect(provider.calls).toBe(1);
        // W8 wrapper: usage sidecar populated.
        expect(envelope.usage).toBeDefined();
        expect(typeof envelope.usage!.cost_usd).toBe('number');
        expect(typeof envelope.usage!.tokens_in).toBe('number');
        expect(typeof envelope.usage!.tokens_out).toBe('number');
    });
});

describe('POST /api/ai-chat — gate A2 (invented reference)', () => {
    it('refuses with unsupported-reference when the answer cites a (contract, action) pair not in the catalog', async () => {
        // eosio.fakecontract::transfer — contract not in catalog, not in
        // toolReturnedIdentifiers. Gate A2 refuses.
        const provider = mockProvider(() =>
            answerReply('The eosio.fakecontract::transfer action does something important.')
        );
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
        const envelope = (await res.json()) as {
            reply: { kind: string; reason?: string };
            usage?: unknown;
        };
        expect(envelope.reply.kind).toBe('refuse');
        expect(envelope.reply.reason).toBe('unsupported-reference');
        // Provider IS called — the model produced the bad reply, the
        // validator caught it post-harness.
        expect(provider.calls).toBe(1);
        // Harness ran → usage sidecar present.
        expect(envelope.usage).toBeDefined();
    });
});

describe('POST /api/ai-chat — gate A3 (smuggled JSON action)', () => {
    it('refuses when the answer text embeds a JSON object with contract+action+data keys', async () => {
        const provider = mockProvider(() =>
            answerReply(
                'Here is an example: {"contract": "eosio.token", "action": "transfer", "data": {"from": "alice"}}'
            )
        );
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
        const envelope = (await res.json()) as {
            reply: { kind: string; reason?: string };
            usage?: unknown;
        };
        expect(envelope.reply.kind).toBe('refuse');
        // A3 emits 'unsupported-reference' per the validator; the route
        // surfaces that string. The W7 prompt accepts either A3 reason
        // ('unsupported-reference' OR 'malformed-answer'), so assert
        // membership of the W7-defined set.
        expect(['unsupported-reference', 'malformed-answer']).toContain(envelope.reply.reason);
        expect(provider.calls).toBe(1);
        expect(envelope.usage).toBeDefined();
    });
});

describe('POST /api/ai-chat — classifier short-circuit (W7 cost + safety)', () => {
    it("refuses 'what is bitcoin?' WITHOUT calling the provider", async () => {
        const provider = mockProvider(() => answerReply('grounded answer text here'));
        const app = await createApp(baseCfg, { provider });

        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...baseRequest,
                    messages: [{ role: 'user' as const, content: 'what is bitcoin?' }],
                }),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const envelope = (await res.json()) as {
            reply: { kind: string; reason?: string };
            usage?: unknown;
        };
        expect(envelope.reply.kind).toBe('refuse');
        expect(envelope.reply.reason).toBe('out-of-scope');
        // Load-bearing per the W7 simplifier exclusion list — the
        // classifier short-circuit is the cost win of W2 + the safety
        // boundary that keeps non-Ultra topics out of the provider.
        expect(provider.calls).toBe(0);
        // No provider call → usage sidecar omitted.
        expect(envelope.usage).toBeUndefined();
    });
});
