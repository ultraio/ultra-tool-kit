// W5 — End-to-end /api/ai-chat tests for eosio.nft.ft action composition.
//
// Real catalog + real validate; mocked ChatProvider + mocked fetch.
// Covers:
//   1. happy path: turn 1 get_table_rows → turn 2 act for create.b
//   2. gate-5 invented-actor downgrade after the same tool turn

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const baseCfg: AppConfig = {
    jwtSecret: 'test-secret-w5',
    allowedOrigins: ['http://localhost:5172'],
    nonceTtlMs: 5 * 60_000,
    devAuthBypass: true,
    llmProvider: 'ollama',
    allowedChainHosts: ['localhost', '127.0.0.1'],
};

function mockProvider(handler: (req: ChatRequest, idx: number) => ChatResponse | Promise<ChatResponse>): ChatProvider & { calls: number } {
    let calls = 0;
    const p = {
        async chat(req: ChatRequest): Promise<ChatResponse> {
            const idx = calls++;
            return handler(req, idx);
        },
        modelTag(): string {
            return 'mock:w5';
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

describe('POST /api/ai-chat — W5 eosio.nft.ft::create.b happy path', () => {
    it('composes create.b after a single get_table_rows tool turn', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ rows: [], more: false, next_key: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );

        const provider = mockProvider((_req, idx) => {
            if (idx === 0) {
                // Turn 1: inspect existing factories.
                return {
                    json: {
                        kind: 'tool_use',
                        calls: [
                            {
                                tool: 'get_table_rows',
                                input: {
                                    code: 'eosio.nft.ft',
                                    table: 'factory.a',
                                    scope: 'duncan',
                                    limit: 1,
                                },
                            },
                        ],
                    },
                    usage: { input: 200, output: 30 },
                };
            }
            // Turn 2: composed act. create.b carries an opaque struct (the
            // extractor doesn't expose create_wrap_v1's inner fields).
            return {
                json: {
                    kind: 'act',
                    rationale: 'create a new card factory for duncan',
                    actions: [
                        {
                            contract: 'eosio.nft.ft',
                            action: 'create.b',
                            data: {
                                create: {
                                    asset_manager: 'duncan',
                                    asset_creator: 'duncan',
                                    max_mintable_tokens: 1000,
                                },
                            },
                            authorization: [{ actor: 'duncan', permission: 'active' }],
                        },
                    ],
                },
                usage: { input: 260, output: 80 },
            };
        });

        const app = await createApp(baseCfg, { provider });
        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    sessionId: 'sess-w5-1',
                    messages: [
                        {
                            role: 'user' as const,
                            content: 'create a card factory for my account, max 1000',
                        },
                    ],
                    context: {
                        validatedAccounts: ['duncan'],
                        knownAccounts: [],
                        selectedAccount: 'duncan',
                        chainId: 'dev',
                        endpoint: 'http://localhost:8888',
                    },
                }),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { kind: string };
        expect(body.kind).toBe('act');
        expect(provider.calls).toBe(2);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('POST /api/ai-chat — W5 gate 5 invented-actor downgrade', () => {
    it('downgrades to ask when the LLM proposes create.b with an invented authorization actor', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ rows: [], more: false, next_key: null }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );

        const provider = mockProvider((_req, idx) => {
            if (idx === 0) {
                return {
                    json: {
                        kind: 'tool_use',
                        calls: [
                            {
                                tool: 'get_table_rows',
                                input: {
                                    code: 'eosio.nft.ft',
                                    table: 'factory.a',
                                    scope: 'duncan',
                                    limit: 1,
                                },
                            },
                        ],
                    },
                    usage: { input: 200, output: 30 },
                };
            }
            return {
                json: {
                    kind: 'act',
                    rationale: 'create a card factory',
                    actions: [
                        {
                            contract: 'eosio.nft.ft',
                            action: 'create.b',
                            data: {
                                create: {
                                    asset_manager: 'mallory',
                                    asset_creator: 'mallory',
                                },
                            },
                            // Invented actor — never mentioned in user
                            // message, not in validatedAccounts.
                            authorization: [{ actor: 'mallory', permission: 'active' }],
                        },
                    ],
                },
                usage: { input: 260, output: 80 },
            };
        });

        const app = await createApp(baseCfg, { provider });
        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    sessionId: 'sess-w5-2',
                    messages: [{ role: 'user' as const, content: 'create a card factory' }],
                    context: {
                        validatedAccounts: ['duncan'],
                        knownAccounts: [],
                        selectedAccount: 'duncan',
                        chainId: 'dev',
                        endpoint: 'http://localhost:8888',
                    },
                }),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { kind: string };
        expect(body.kind).toBe('ask');
    });
});
