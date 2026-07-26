// W5 — End-to-end /api/ai-chat tests for eosio.nft.ft::transfer.
//
// Real catalog + real validate; mocked ChatProvider + mocked fetch.
// Demonstrates the numeric-id harvester (token_id from tool response) and
// the struct-param fall-through (transfer_wrap is not gate-checked beyond
// top-level shape).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const baseCfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
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
            return 'mock:w5-transfer';
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

describe('POST /api/ai-chat — W5 eosio.nft.ft::transfer happy path', () => {
    it('composes transfer after a get_table_rows lookup against tokenb.a', async () => {
        // Mocked chain RPC: tokenb.a row showing duncan owns token 42 from
        // factory 7. The route's extractIdentifiers harvests numeric *_id
        // values (token_id, factory_id) into toolReturnedIdentifiers so
        // gate 5 can cite them.
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    rows: [{ owner: 'duncan', token_id: 42, factory_id: 7 }],
                    more: false,
                    next_key: null,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
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
                                    table: 'tokenb.a',
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
                    rationale: 'transfer card 42 to alice',
                    actions: [
                        {
                            contract: 'eosio.nft.ft',
                            action: 'transfer',
                            data: {
                                transfer: {
                                    from: 'duncan',
                                    to: 'alice',
                                    token_ids: [42],
                                    memo: '',
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
                    sessionId: 'sess-w5-transfer',
                    messages: [
                        { role: 'user' as const, content: 'transfer my card #42 to alice' },
                    ],
                    context: {
                        validatedAccounts: ['duncan'],
                        knownAccounts: ['alice'],
                        selectedAccount: 'duncan',
                        chainId: 'dev',
                        endpoint: 'http://localhost:8888',
                    },
                }),
            },
            LOOPBACK_ENV
        );

        expect(res.status).toBe(200);
        const envelope = (await res.json()) as { reply: { kind: string }; usage?: unknown };
        expect(envelope.reply.kind).toBe('act');
        expect(envelope.usage).toBeDefined();
        expect(provider.calls).toBe(2);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});
