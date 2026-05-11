// Playwright route stubs for the AI chat flow. Intercepts the Hono backend
// (`/api/ai-action`, `/api/ai-usage`) and the chain RPC (`/v1/chain/get_abi`)
// so CI doesn't need Ollama or Postgres. Tests can override either route
// after calling these helpers — Playwright uses the most recently registered
// handler that matches.

import type { Page } from '@playwright/test';

export interface UsageOpts {
    ollama?: boolean;
    calls?: number;
}

const HOSTED_USD_PER_CALL = 0.0043;
const PROJECTED_USD_PER_CALL = 0.0042;
const TOKENS_PER_CALL = 4500;

const PROPOSE_TRANSFER = {
    kind: 'propose',
    contract: 'eosio.token',
    action: 'transfer',
    data: {
        from: 'acc1',
        to: 'acc2',
        quantity: '100.00000000 UOS',
        memo: '',
    },
    authorization: { actor: 'acc1', permission: 'active' },
    rationale: 'Standard transfer of 100 UOS from acc1 to acc2.',
};

const ASK_FROM = {
    kind: 'ask',
    question: "Who's sending? Please specify the from account.",
};

const REFUSE_OFFTOPIC = {
    kind: 'refuse',
    reason: 'off-topic',
    detail: 'I only help with building Ultra blockchain transactions.',
};

const ASK_DEFAULT = {
    kind: 'ask',
    question: 'Could you clarify what you want to do?',
};

function pickReply(text: string) {
    if (/transfer.*\bUOS\b/i.test(text)) return PROPOSE_TRANSFER;
    if (/^send\s+\d+\s+to\s+\w+/i.test(text)) return ASK_FROM;
    if (/weather|joke|calculus/i.test(text)) return REFUSE_OFFTOPIC;
    // Quick-reply follow-up like "from acc1" → resolve to a proposal so the
    // ask → answer → propose flow can run end-to-end.
    if (/^from\s+\w+/i.test(text)) return PROPOSE_TRANSFER;
    return ASK_DEFAULT;
}

function extractLastUserMessage(postData: string | null): string {
    if (!postData) return '';
    const parsed = JSON.parse(postData) as { messages?: Array<{ role?: string; content?: unknown }> };
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return '';
}

function buildUsageBody({ ollama = true, calls = 0 }: UsageOpts) {
    const modelTag = ollama ? 'ollama:qwen2.5:7b' : 'claude-haiku-4-5-20251001';
    const perCallActual = ollama ? 0 : HOSTED_USD_PER_CALL;
    const perCallProjected = ollama ? PROJECTED_USD_PER_CALL : HOSTED_USD_PER_CALL;
    const actualUsd = +(perCallActual * calls).toFixed(4);
    const projectedUsd = +(perCallProjected * calls).toFixed(4);
    return {
        lifetime: { calls, actualUsd, projectedUsd },
        today: { calls, actualUsd, projectedUsd },
        lastRequest:
            calls === 0
                ? null
                : {
                      at: new Date().toISOString(),
                      modelTag,
                      actualUsd: perCallActual,
                      projectedUsd: perCallProjected,
                  },
        perModel:
            calls === 0
                ? []
                : [
                      {
                          modelTag,
                          calls,
                          inputTokens: TOKENS_PER_CALL * calls,
                          outputTokens: TOKENS_PER_CALL * calls,
                          actualUsd,
                          projectedUsd,
                      },
                  ],
    };
}

export async function installAiStub(page: Page, opts: { usage?: UsageOpts } = {}): Promise<void> {
    const body = buildUsageBody(opts.usage ?? {});

    await page.route('**/api/ai-usage', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
        })
    );

    await page.route('**/api/ai-action', (route) => {
        const last = extractLastUserMessage(route.request().postData());
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(pickReply(last)),
        });
    });
}

export async function installChainAbiStub(page: Page): Promise<void> {
    await page.route('**/v1/chain/get_abi', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                account_name: 'eosio.token',
                abi: {
                    version: 'eosio::abi/1.1',
                    types: [],
                    structs: [
                        {
                            name: 'transfer',
                            base: '',
                            fields: [
                                { name: 'from', type: 'name' },
                                { name: 'to', type: 'name' },
                                { name: 'quantity', type: 'asset' },
                                { name: 'memo', type: 'string' },
                            ],
                        },
                    ],
                    actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
                    tables: [],
                    ricardian_clauses: [],
                    error_messages: [],
                    abi_extensions: [],
                    variants: [],
                },
            }),
        })
    );
}
