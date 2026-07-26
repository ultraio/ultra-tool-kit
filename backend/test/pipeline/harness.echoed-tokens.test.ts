// W5 — three-turn dance verifying echoedTokens threading.
//
// Turn 1: provider emits tool_use for get_table_rows (eosio.nft.ft / factory.a).
//         Mocked spec returns a row with {symbol:'CARD', contract:'eosio.nft.ft'}.
//         The harness's extractEchoedTokens harvests `eosio.nft.ft::CARD`.
// Turn 2: provider emits tool_use for get_balance with the echoed symbol.
//         The harness's per-dispatch ctx union must surface the harvested
//         token, so the stub spec's call() sees it in ctx.echoedTokens.
// Turn 3: provider emits a final ask.
//
// Assertions: turn-2 dispatch succeeds (no unknown-tool / no error audit);
// result.echoedTokens is the Set containing 'eosio.nft.ft::CARD'.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { call } from '../../src/pipeline/harness.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import type { ToolCtx, ToolSpec } from '../../src/pipeline/tools/index.js';

const ReplySchema = z.union([
    z.object({ kind: z.literal('act'), contract: z.string(), action: z.string() }),
    z.object({ kind: z.literal('ask'), question: z.string() }),
]);

const STUB_CTX: ToolCtx = {
    endpoint: 'https://example.invalid',
    allowlist: ['example.invalid'],
    catalog: {
        actions: [],
        byKey: new Map(),
        contracts: new Set(),
        bm25: { docs: [], idf: new Map(), avgDl: 0 },
    } as unknown as ToolCtx['catalog'],
};

function makeProvider(handler: (req: ChatRequest, idx: number) => ChatResponse | Promise<ChatResponse>): ChatProvider & { calls: number } {
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

describe('harness — W5 echoed-tokens threading', () => {
    it('threads tokens harvested by turn 1 into the turn-2 dispatch ctx', async () => {
        // Turn-1 spec: returns a row whose object node has BOTH `contract`
        // and `symbol` — the heuristic the harvester recognises.
        const tableRowsSpec: ToolSpec = {
            name: 'get_table_rows',
            description: 'mock get_table_rows',
            inputSchema: z.record(z.string(), z.unknown()),
            async call(): Promise<unknown> {
                return {
                    rows: [{ symbol: 'CARD', contract: 'eosio.nft.ft', asset_manager: 'duncan' }],
                    more: false,
                    next_key: null,
                };
            },
        };

        // Turn-2 spec: records the ctx it was called with so the test can
        // assert echoedTokens was threaded through.
        let dispatchedCtx: ToolCtx | null = null;
        const balanceSpec: ToolSpec = {
            name: 'get_balance',
            description: 'mock get_balance',
            inputSchema: z.record(z.string(), z.unknown()),
            async call(_input: unknown, ctx: ToolCtx): Promise<unknown> {
                dispatchedCtx = ctx;
                // Return an empty balance row list — we're only checking
                // that the call succeeded with the right ctx.
                return [];
            },
        };

        const provider = makeProvider((_req, idx) => {
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
                    usage: { input: 10, output: 5 },
                };
            }
            if (idx === 1) {
                return {
                    json: {
                        kind: 'tool_use',
                        calls: [
                            {
                                tool: 'get_balance',
                                input: { account: 'duncan', code: 'eosio.nft.ft', symbol: 'CARD' },
                            },
                        ],
                    },
                    usage: { input: 10, output: 5 },
                };
            }
            return {
                json: { kind: 'ask', question: 'You hold 0 CARD.' },
                usage: { input: 20, output: 10 },
            };
        });

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'check my CARD balance from factory 1',
            tools: [tableRowsSpec, balanceSpec],
            toolCtx: STUB_CTX,
            toolBudget: { perTurn: 3, perSession: 100, sessionUsed: 0 },
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;

        // Three provider turns: tool_use → tool_use → final ask.
        expect(provider.calls).toBe(3);

        // The turn-2 dispatch surfaced the harvested token in ctx.
        expect(dispatchedCtx).not.toBeNull();
        expect(dispatchedCtx!.echoedTokens).toBeDefined();
        expect(dispatchedCtx!.echoedTokens!.has('eosio.nft.ft::CARD')).toBe(true);

        // The harness's returned echoedTokens carries the same entry.
        expect(result.echoedTokens).toBeDefined();
        expect(result.echoedTokens!.has('eosio.nft.ft::CARD')).toBe(true);

        // Both audit entries are status:'ok' — neither dispatch failed.
        expect(result.toolAudit).toHaveLength(2);
        for (const a of result.toolAudit!) {
            expect(a.status).toBe('ok');
        }
    });
});
