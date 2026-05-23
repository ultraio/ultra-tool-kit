// Harness W4 tool-use loop contract tests — no real network, mock at both
// the ChatProvider boundary and the ToolSpec boundary.
//
// Covers the seven scenarios listed in the W4 task brief:
//   A. single tool call → ok
//   B. two tool calls in one turn → parallel dispatch, deterministic order
//   C. budget exceeded → refuse 'tool-budget', provider NOT re-called
//   D. unknown tool name from provider → refuse 'unknown-tool'
//   E. tool dispatch error → fenced as error → next turn → ask
//   F. total provider-call cap = 4 (3 tool-use turns + 1 forced final)
//   G. tools empty / undefined → W1 path unchanged
//
// The harness extends the caller's schema with an internal tool_use variant.
// In these tests the caller's schema covers the `act | ask` shapes the
// W3 composer emits — that's enough to exercise the full loop.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { call } from '../../src/pipeline/harness.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import type { ToolCtx, ToolSpec } from '../../src/pipeline/tools/index.js';

// Caller's reply schema (a slice of W3's union — enough to drive the loop).
const ReplySchema = z.union([
    z.object({
        kind: z.literal('act'),
        contract: z.string(),
        action: z.string(),
    }),
    z.object({
        kind: z.literal('ask'),
        question: z.string(),
    }),
]);

type Reply = z.infer<typeof ReplySchema>;

function makeProvider(
    handler: (req: ChatRequest, callIndex: number) => Promise<ChatResponse> | ChatResponse,
    tag = 'anthropic:test'
): ChatProvider & { calls: number; lastReq: ChatRequest | null; userMessages: string[] } {
    let calls = 0;
    let lastReq: ChatRequest | null = null;
    const userMessages: string[] = [];
    const provider = {
        async chat(req: ChatRequest): Promise<ChatResponse> {
            const idx = calls++;
            lastReq = req;
            userMessages.push(req.user);
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
        get userMessages() {
            return userMessages;
        },
    };
    return provider as ChatProvider & {
        calls: number;
        lastReq: ChatRequest | null;
        userMessages: string[];
    };
}

// Minimal ToolCtx — the W4 tools we mock here never touch the chain or
// the catalog so we stub the lot. The dispatcher only reaches into ctx
// via the spec's `call()`, and our specs ignore ctx entirely.
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

// Helper: build a mock ToolSpec whose `call` returns/throws on demand and
// records its start timestamp so the parallelism test can assert overlap.
function makeMockTool(
    name: ToolSpec['name'],
    handler: (input: unknown) => Promise<unknown> | unknown
): ToolSpec & { starts: number[] } {
    const starts: number[] = [];
    const spec = {
        name,
        description: `mock ${name}`,
        inputSchema: z.record(z.string(), z.unknown()),
        async call(input: unknown): Promise<unknown> {
            starts.push(performance.now());
            return handler(input);
        },
        get starts() {
            return starts;
        },
    };
    return spec as ToolSpec & { starts: number[] };
}

const ASK_REPLY: Reply = { kind: 'ask', question: 'You only hold 5 UOS' };

describe('harness.call — W4 tool-use loop', () => {
    // ─────────────────────────────────────────────────────────────────────
    // Test A — single tool call → ok
    // ─────────────────────────────────────────────────────────────────────
    it('A: single tool call dispatches, appends chain_read, then accepts a final reply', async () => {
        const balanceTool = makeMockTool('get_balance', () => [
            { amount: '5.00000000', symbol: 'UOS', contract: 'eosio.token' },
        ]);

        const provider = makeProvider((_req, idx) => {
            if (idx === 0) {
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
                    usage: { input: 10, output: 5 },
                };
            }
            return { json: ASK_REPLY, usage: { input: 20, output: 10 } };
        });

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'do I have enough UOS?',
            tools: [balanceTool],
            toolCtx: STUB_CTX,
            toolBudget: { sessionUsed: 0 },
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.value).toEqual(ASK_REPLY);
        expect(provider.calls).toBe(2);
        expect(result.toolAudit).toBeDefined();
        expect(result.toolAudit).toHaveLength(1);
        expect(result.toolAudit![0]!.name).toBe('get_balance');
        expect(result.toolAudit![0]!.status).toBe('ok');

        // Turn-2 user message must carry the fenced tool result.
        expect(provider.userMessages[1]).toContain('<chain_read tool="get_balance"');
        expect(provider.userMessages[1]).toContain('5.00000000');
        expect(provider.userMessages[1]).toContain('<prior_assistant>');
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test B — two tool calls in one turn → parallel dispatch + alpha order
    // ─────────────────────────────────────────────────────────────────────
    it('B: two tool calls dispatch in parallel and are appended in alphabetical order', async () => {
        // Stagger the tools: get_account waits 20 ms, get_balance returns
        // immediately. Parallel dispatch ⇒ both starts are close in time;
        // sequential dispatch would have the second start 20+ms after the
        // first. We assert overlap by checking starts are within 5 ms.
        const accountTool = makeMockTool('get_account', async () => {
            await new Promise((r) => setTimeout(r, 20));
            return { account_name: 'duncan' };
        });
        const balanceTool = makeMockTool('get_balance', () => [
            { amount: '5.00000000', symbol: 'UOS', contract: 'eosio.token' },
        ]);

        const provider = makeProvider((_req, idx) => {
            if (idx === 0) {
                return {
                    json: {
                        kind: 'tool_use',
                        // Intentionally B before A to confirm output sort.
                        calls: [
                            {
                                tool: 'get_balance',
                                input: { account: 'duncan', code: 'eosio.token', symbol: 'UOS' },
                            },
                            { tool: 'get_account', input: { account: 'duncan' } },
                        ],
                    },
                    usage: { input: 10, output: 5 },
                };
            }
            return {
                json: { kind: 'act', contract: 'eosio.token', action: 'transfer' },
                usage: { input: 20, output: 10 },
            };
        });

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'check my balance and my account',
            tools: [accountTool, balanceTool],
            toolCtx: STUB_CTX,
            toolBudget: { sessionUsed: 0 },
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(provider.calls).toBe(2);
        expect(result.toolAudit).toHaveLength(2);

        // Parallel: both tool starts within a tight window.
        const accountStart = accountTool.starts[0]!;
        const balanceStart = balanceTool.starts[0]!;
        expect(Math.abs(accountStart - balanceStart)).toBeLessThan(5);

        // Determinism contract: chain_read blocks sorted by tool name —
        // get_account before get_balance, regardless of request order.
        const turn2 = provider.userMessages[1]!;
        const idxAccount = turn2.indexOf('<chain_read tool="get_account"');
        const idxBalance = turn2.indexOf('<chain_read tool="get_balance"');
        expect(idxAccount).toBeGreaterThan(-1);
        expect(idxBalance).toBeGreaterThan(-1);
        expect(idxAccount).toBeLessThan(idxBalance);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test C — budget exceeded → refuse 'tool-budget'
    // ─────────────────────────────────────────────────────────────────────
    it('C: refuses tool-budget when a turn would breach perTurn, no further provider calls', async () => {
        const accountTool = makeMockTool('get_account', () => ({ account_name: 'a' }));
        const balanceTool = makeMockTool('get_balance', () => []);

        const provider = makeProvider((_req, idx) => {
            if (idx === 0) {
                return {
                    json: {
                        kind: 'tool_use',
                        calls: [
                            { tool: 'get_account', input: { account: 'a' } },
                            { tool: 'get_account', input: { account: 'b' } },
                        ],
                    },
                    usage: { input: 10, output: 5 },
                };
            }
            if (idx === 1) {
                return {
                    json: {
                        kind: 'tool_use',
                        calls: [{ tool: 'get_balance', input: { account: 'a', code: 'eosio.token', symbol: 'UOS' } }],
                    },
                    usage: { input: 10, output: 5 },
                };
            }
            // Should never be reached.
            return { json: ASK_REPLY, usage: { input: 5, output: 5 } };
        });

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'lots of tools',
            tools: [accountTool, balanceTool],
            toolCtx: STUB_CTX,
            toolBudget: { perTurn: 2, perSession: 100, sessionUsed: 0 },
        });

        expect(result.kind).toBe('refuse');
        if (result.kind !== 'refuse') return;
        expect(result.reason).toBe('tool-budget');
        expect(provider.calls).toBe(2);
        expect(result.toolAudit).toHaveLength(2);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test D — unknown tool name → refuse 'unknown-tool'
    // ─────────────────────────────────────────────────────────────────────
    it('D: refuses unknown-tool when the model names a tool not in the registry', async () => {
        const accountTool = makeMockTool('get_account', () => ({ account_name: 'a' }));

        const provider = makeProvider(() => ({
            json: {
                kind: 'tool_use',
                calls: [{ tool: 'get_evil', input: {} }],
            },
            usage: { input: 10, output: 5 },
        }));

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'try a forbidden tool',
            tools: [accountTool],
            toolCtx: STUB_CTX,
            toolBudget: { sessionUsed: 0 },
        });

        expect(result.kind).toBe('refuse');
        if (result.kind !== 'refuse') return;
        expect(result.reason).toBe('unknown-tool');
        expect(provider.calls).toBe(1);
        // No dispatch happened — audit is empty.
        expect(result.toolAudit).toHaveLength(0);
        // The mock tool was never invoked either.
        expect(accountTool.starts).toHaveLength(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test E — tool dispatch error → fenced as error → ask
    // ─────────────────────────────────────────────────────────────────────
    it('E: a tool that throws is fenced as status=error and the model gets one more turn', async () => {
        const balanceTool = makeMockTool('get_balance', () => {
            throw new Error('chain 404');
        });

        const provider = makeProvider((_req, idx) => {
            if (idx === 0) {
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
                    usage: { input: 10, output: 5 },
                };
            }
            return {
                json: { kind: 'ask', question: 'I could not verify your balance' },
                usage: { input: 20, output: 10 },
            };
        });

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'check my balance',
            tools: [balanceTool],
            toolCtx: STUB_CTX,
            toolBudget: { sessionUsed: 0 },
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.value.kind).toBe('ask');
        expect(result.toolAudit).toHaveLength(1);
        expect(result.toolAudit![0]!.status).toBe('error');
        expect(result.toolAudit![0]!.error).toContain('chain 404');
        expect(provider.calls).toBe(2);

        // The next-turn user message must mark the chain_read as status="error".
        expect(provider.userMessages[1]).toContain('status="error"');
        expect(provider.userMessages[1]).toContain('chain 404');
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test F — total provider call cap = 4 (3 tool-use + 1 forced final)
    // ─────────────────────────────────────────────────────────────────────
    it('F: caps provider calls at 4 (3 tool-use turns + one forced final structured turn)', async () => {
        const balanceTool = makeMockTool('get_balance', () => [
            { amount: '5.00000000', symbol: 'UOS', contract: 'eosio.token' },
        ]);

        const provider = makeProvider((_req, idx) => {
            // Turns 0–2: model emits tool_use. Turn 3: harness has forced
            // the final structured turn via <system_note> → model emits ask.
            if (idx < 3) {
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
                    usage: { input: 10, output: 5 },
                };
            }
            return { json: ASK_REPLY, usage: { input: 20, output: 10 } };
        });

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'keep calling tools',
            tools: [balanceTool],
            // perSession large enough not to trip; the cap that matters
            // here is MAX_TOOL_USE_TURNS, not the budget.
            toolBudget: { perTurn: 3, perSession: 100, sessionUsed: 0 },
        });

        expect(result.kind).toBe('ok');
        expect(provider.calls).toBe(4);
        // The forced-final mechanic stamps the user message with a system_note.
        expect(provider.userMessages[3]).toContain('reached the tool-call budget');
    });

    // ─────────────────────────────────────────────────────────────────────
    // Test G — tools empty → W1 path unchanged
    // ─────────────────────────────────────────────────────────────────────
    it('G: when tools is empty/undefined, the W1 path is exercised and no toolAudit is attached', async () => {
        const provider = makeProvider(() => ({
            json: { kind: 'act', contract: 'eosio.token', action: 'transfer' },
            usage: { input: 10, output: 5 },
        }));

        const result = await call({
            provider,
            schema: ReplySchema,
            system: 'sys',
            user: 'transfer',
            // tools omitted entirely.
        });

        expect(result.kind).toBe('ok');
        if (result.kind !== 'ok') return;
        expect(result.value).toEqual({ kind: 'act', contract: 'eosio.token', action: 'transfer' });
        expect(provider.calls).toBe(1);
        expect(result.toolAudit).toBeUndefined();

        // Same again with explicit empty array — also bypasses the loop.
        const provider2 = makeProvider(() => ({
            json: { kind: 'act', contract: 'eosio.token', action: 'transfer' },
            usage: { input: 10, output: 5 },
        }));
        const result2 = await call({
            provider: provider2,
            schema: ReplySchema,
            system: 'sys',
            user: 'transfer',
            tools: [],
        });
        expect(result2.kind).toBe('ok');
        if (result2.kind !== 'ok') return;
        expect(result2.toolAudit).toBeUndefined();
    });
});
