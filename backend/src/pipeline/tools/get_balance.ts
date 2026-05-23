// `get_balance` tool — wraps /v1/chain/get_currency_balance with the
// (contract, symbol) pinned to `eosio.token` per the §4.2 row.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 row 2
// ("eosio.token + (contract, symbol) echoed from a previous turn") and the
// "≤ 10 rows" output cap. W4 first cut keeps `code` literally `eosio.token`
// — broadening to other token contracts is W5+ territory and must come with
// a docs PR per §4.2 ("New tool / new allowlist row → doc change first").

import { z } from 'zod';

import { isAllowedEndpoint } from './host-allowlist.js';
import { EndpointRejectedError, type ToolCtx, type ToolSpec } from './types.js';

const NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;
const SYMBOL_RE = /^[A-Z]{1,7}$/;

const InputSchema = z.object({
    account: z.string().regex(NAME_RE, 'invalid eosio account name'),
    symbol: z.string().regex(SYMBOL_RE, 'invalid symbol_code (1–7 uppercase letters)'),
    code: z.literal('eosio.token'),
});

const MAX_ROWS = 10;

export type BalanceRow = {
    symbol: string;
    amount: string;
    contract: 'eosio.token';
};

// Chain returns ["100.00000000 UOS", ...]. We split on whitespace, drop
// rows that don't match the canonical "<amount> <symbol>" shape — a
// malformed row is dropped silently rather than poisoning the whole array,
// because a bad row from chain is observable elsewhere (it'll fail the
// reply's regex gate) and we'd rather give the LLM partial truth than
// nothing.
function parseRow(row: string): BalanceRow | null {
    const parts = row.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const [amount, symbol] = parts;
    if (!amount || !symbol) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(amount)) return null;
    if (!SYMBOL_RE.test(symbol)) return null;
    return { symbol, amount, contract: 'eosio.token' };
}

export const getBalanceSpec: ToolSpec = {
    name: 'get_balance',
    description: 'Read eosio.token balances for an account, scoped to one symbol.',
    inputSchema: InputSchema,
    async call(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const { account, symbol, code } = InputSchema.parse(input);
        const url = new URL('/v1/chain/get_currency_balance', ctx.endpoint).toString();
        if (!isAllowedEndpoint(url, ctx.allowlist)) {
            throw new EndpointRejectedError(ctx.endpoint);
        }
        const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code, account, symbol }),
        });
        if (!res.ok) {
            throw new Error(`get_balance failed: HTTP ${res.status}`);
        }
        const body = (await res.json()) as unknown;
        const rows = Array.isArray(body) ? (body as unknown[]) : [];
        const capped = rows.slice(0, MAX_ROWS);
        const out: BalanceRow[] = [];
        for (const r of capped) {
            if (typeof r !== 'string') continue;
            const parsed = parseRow(r);
            if (parsed) out.push(parsed);
        }
        return out;
    },
};
