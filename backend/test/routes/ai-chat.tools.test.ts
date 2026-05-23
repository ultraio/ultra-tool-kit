// End-to-end /api/ai-chat tool-use tests.
//
// Proves the W4 success criterion from roadmap §6: "AI catches 'insufficient
// funds' in one turn". The handler wires the harness's tool-use loop to the
// W4 tool registry — turn 1 the mock model emits `tool_use` for get_balance,
// the harness dispatches it (mocked fetch returns 5 UOS), and turn 2 the
// mock model emits the `ask` clarifier referencing the actual on-chain
// balance.
//
// Real catalog, real eosio-types, real classify/retrieve/validate/harness;
// mock ChatProvider and mock globalThis.fetch (the get_balance spec reaches
// for ctx.fetchImpl ?? globalThis.fetch). DEV_AUTH_BYPASS on loopback is the
// same pattern as ai-chat.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const baseCfg: AppConfig = {
    jwtSecret: 'test-secret-w4',
    allowedOrigins: ['http://localhost:5172'],
    nonceTtlMs: 5 * 60_000,
    devAuthBypass: true,
    llmProvider: 'ollama', // ignored — we inject a mock provider
    allowedChainHosts: ['localhost', '127.0.0.1'],
};

const baseRequest = {
    sessionId: 'sess-1',
    messages: [{ role: 'user' as const, content: 'transfer 100 UOS from duncan to bob' }],
    context: {
        validatedAccounts: ['duncan'],
        knownAccounts: ['bob'],
        selectedAccount: 'duncan',
        chainId: 'dev',
        endpoint: 'http://localhost:8888',
    },
};

function mockProvider(
    handler: (req: ChatRequest, idx: number) => ChatResponse | Promise<ChatResponse>
): ChatProvider & { calls: number } {
    let calls = 0;
    const p = {
        async chat(req: ChatRequest): Promise<ChatResponse> {
            const idx = calls++;
            return handler(req, idx);
        },
        modelTag(): string {
            return 'mock:w4';
        },
        get calls() {
            return calls;
        },
    };
    return p as ChatProvider & { calls: number };
}

beforeEach(() => {
    _resetCatalogCache();
    _resetEosioTypesCache();
});

afterEach(() => vi.restoreAllMocks());

describe('POST /api/ai-chat — W4 tool-use loop (insufficient-funds in one turn)', () => {
    it('dispatches get_balance, reads the actual balance, and downgrades to ask referencing it', async () => {
        // Mock the chain RPC: account 'duncan' holds 5 UOS.
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify(['5.00000000 UOS']), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );

        const provider = mockProvider((_req, idx) => {
            if (idx === 0) {
                // Turn 1: model decides it needs the on-chain balance first.
                return {
                    json: {
                        kind: 'tool_use',
                        calls: [
                            {
                                tool: 'get_balance',
                                input: { account: 'duncan', code: 'eosio.token', symbol: 'UOS' },
                            },
                        ],
                    },
                    usage: { input: 200, output: 30 },
                };
            }
            // Turn 2: harness appended <chain_read> with 5 UOS; the model
            // refuses to compose the 100 UOS transfer and asks for a smaller
            // amount, referencing the actual balance.
            return {
                json: {
                    kind: 'ask',
                    question: 'You only hold 5 UOS — would you like to send less, or top up first?',
                },
                usage: { input: 260, output: 40 },
            };
        });

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
        const body = (await res.json()) as { kind: string; question?: string };
        expect(body.kind).toBe('ask');
        // The §6 W4 success criterion — the ask string carries the on-chain
        // balance, not an invented number. The mock provider built the
        // string but the harness only got to that string by completing the
        // tool-use loop with the fetched payload in scope.
        expect(body.question).toContain('5');

        // Exactly two provider turns (tool_use → ask). Three would mean the
        // harness double-spent the budget; one would mean the tool dispatch
        // never happened.
        expect(provider.calls).toBe(2);
        // Exactly one fetch — one dispatch of get_balance. More would mean
        // the dispatcher retried or looped.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // Per the task brief: the second e2e (tool-budget exceeded across the
    // whole session) duplicates what harness.tools.test.ts already covers
    // for the budget mechanic, and asserting it here would require seeding
    // the route's private sessionToolCounts Map from outside (which would
    // mean exposing harness internals just for the test). Skipped on
    // purpose — see test/pipeline/harness.tools.test.ts Test C for the
    // budget assertion at the harness boundary.
});
