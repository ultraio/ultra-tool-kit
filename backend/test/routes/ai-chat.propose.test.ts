// End-to-end POST /api/ai-chat — propose path (W6).
//
// Mirrors ai-chat.test.ts: real catalog + real eosio-types + real classify/
// retrieve/validate, mocked ChatProvider. Mounts the full createApp() stack
// so JWT auth + rate-limit middleware are in the path; loopback authenticates
// via DEV_AUTH_BYPASS.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const baseCfg: AppConfig = {
    jwtSecret: 'test-secret-w6',
    allowedOrigins: ['http://localhost:5172'],
    nonceTtlMs: 5 * 60_000,
    devAuthBypass: true,
    llmProvider: 'ollama',
    allowedChainHosts: ['localhost', '127.0.0.1'],
};

// User message names every identifier a happy propose flow needs: the
// proposer (duncan, via the JWT), counterparties (duncan → bob), the
// proposalName (pay123), and the two approvers (ceo + cfo).
const HAPPY_USER_MSG =
    'propose: transfer 100 UOS from duncan to bob, require approval from ceo and cfo, proposal name pay123';

const baseRequest = {
    sessionId: 'session-w6',
    messages: [{ role: 'user' as const, content: HAPPY_USER_MSG }],
    context: {
        validatedAccounts: ['duncan', 'bob'],
        knownAccounts: ['ceo', 'cfo'],
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
            return 'mock:w6';
        },
        get calls() {
            return calls;
        },
    };
    return p as ChatProvider & { calls: number };
}

type ProposeOverrides = {
    proposalName?: string;
    from?: string;
    to?: string;
    requested?: Array<{ actor: string; permission: string }>;
};

function okProposeReply(overrides: ProposeOverrides = {}): ChatResponse {
    return {
        json: {
            kind: 'propose',
            proposalName: overrides.proposalName ?? 'pay123',
            actions: [
                {
                    contract: 'eosio.token',
                    action: 'transfer',
                    data: {
                        from: overrides.from ?? 'duncan',
                        to: overrides.to ?? 'bob',
                        quantity: '100.00000000 UOS',
                        memo: '',
                    },
                    authorization: [{ actor: 'duncan', permission: 'active' }],
                },
            ],
            requested: overrides.requested ?? [
                { actor: 'ceo', permission: 'active' },
                { actor: 'cfo', permission: 'active' },
            ],
            rationale: 'pay vendor via multisig',
        },
        usage: { input: 220, output: 95 },
    };
}

beforeEach(() => {
    _resetCatalogCache();
    _resetEosioTypesCache();
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/ai-chat — propose path (happy)', () => {
    it('returns kind:propose with proposalName + requested[] + actions[] when the user message cites everything', async () => {
        const provider = mockProvider(() => okProposeReply());
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
            reply: {
                kind: string;
                proposalName?: string;
                actions?: unknown[];
                requested?: Array<{ actor: string; permission: string }>;
            };
            usage?: { cost_usd: number; tokens_in: number; tokens_out: number };
        };
        const body = envelope.reply;
        expect(body.kind).toBe('propose');
        expect(body.proposalName).toBe('pay123');
        // Load-bearing: exactly the inner action count the provider emitted —
        // proves the propose path validates per inner action without dropping
        // or duplicating any.
        expect(body.actions).toHaveLength(1);
        expect(body.requested).toEqual([
            { actor: 'ceo', permission: 'active' },
            { actor: 'cfo', permission: 'active' },
        ]);
        // Exactly one provider call — propose path matches act's single-shot
        // pattern (no retry loop on success).
        expect(provider.calls).toBe(1);
        // W8 wrapper: usage sidecar populated.
        expect(envelope.usage).toBeDefined();
        expect(typeof envelope.usage!.cost_usd).toBe('number');
        expect(typeof envelope.usage!.tokens_in).toBe('number');
        expect(typeof envelope.usage!.tokens_out).toBe('number');
    });
});

describe('POST /api/ai-chat — propose gate 5 (invented inner-action recipient)', () => {
    it('downgrades to ask when the model emits a propose whose inner action invents `to`', async () => {
        const provider = mockProvider(() => okProposeReply({ to: 'attacker' }));
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
        const envelope = (await res.json()) as { reply: { kind: string }; usage?: unknown };
        // GENERIC_CLARIFIER surfaces — failedGate / innerIndex are logged
        // only (per §4.3 gate 1 "exposing structure leaks the contract").
        expect(envelope.reply.kind).toBe('ask');
        expect(envelope.usage).toBeDefined();
    });
});

describe('POST /api/ai-chat — propose gate 7.6 (proposer in requested)', () => {
    it('downgrades to ask when the proposer (the DEV_AUTH_BYPASS account) is also listed as an approver', async () => {
        // DEV_AUTH_BYPASS sets the JWT account to 'dev' (see
        // backend/src/middleware/auth.ts DEV_BYPASS_SUB). The proposer is
        // therefore dev@active. Test: model emits requested[] containing
        // dev@active → gate 7.6 fires. To get past gate 7.4's citation
        // check first, 'dev' must be a cited identifier; this test's
        // knownAccounts is extended with 'dev' so that source is satisfied
        // and 7.6 is the gate under test.
        const provider = mockProvider(() =>
            okProposeReply({
                requested: [
                    { actor: 'dev', permission: 'active' }, // proposer
                    { actor: 'cfo', permission: 'active' },
                ],
            })
        );
        const app = await createApp(baseCfg, { provider });

        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    ...baseRequest,
                    context: {
                        ...baseRequest.context,
                        knownAccounts: [...baseRequest.context.knownAccounts, 'dev'],
                    },
                }),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const envelope = (await res.json()) as { reply: { kind: string }; usage?: unknown };
        expect(envelope.reply.kind).toBe('ask');
        expect(envelope.usage).toBeDefined();
    });
});
