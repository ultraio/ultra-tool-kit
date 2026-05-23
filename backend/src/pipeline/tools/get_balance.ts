// `get_balance` tool — wraps /v1/chain/get_currency_balance.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 row 2 ("eosio.token +
// (contract, symbol) echoed from a previous turn") and the "≤ 10 rows" output
// cap. W5 broadens `code` to also accept `eosio.nft.ft` but ONLY when the
// (code, symbol) pair already surfaced in this turn's echoedTokens set — i.e.
// the LLM has actually SEEN that token via get_table_rows (factory.a /
// tokenb.a) or via known-symbols. Any other `code`, or an `eosio.nft.ft` code
// with a symbol not yet echoed, throws EchoedTokenRequiredError which the
// dispatcher folds into the standard audit status:'error'. Anti-DoS posture:
// the LLM can't enumerate balances across arbitrary tokens / contracts
// because every (code, symbol) it tries must be cited from earlier in the
// turn. eosio.token is the always-allowed baseline because UOS is the
// platform token and the §4.2 baseline already permits it.

import { z } from 'zod';

import { isAllowedEndpoint } from './host-allowlist.js';
import {
    EchoedTokenRequiredError,
    EndpointRejectedError,
    type ToolCtx,
    type ToolSpec,
} from './types.js';

const NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;
const SYMBOL_RE = /^[A-Z]{1,7}$/;

const InputSchema = z.object({
    account: z.string().regex(NAME_RE, 'invalid eosio account name'),
    symbol: z.string().regex(SYMBOL_RE, 'invalid symbol_code (1–7 uppercase letters)'),
    // W5: `code` is the issuing contract. Always-allowed: 'eosio.token'.
    // 'eosio.nft.ft' is allowed only when the (code, symbol) pair appears in
    // ctx.echoedTokens. Any other name regex-valid string is rejected at
    // call() time with EchoedTokenRequiredError (the dispatcher renders that
    // as an audit error so the LLM sees a refusal it can react to).
    code: z.string().regex(NAME_RE, 'invalid contract name'),
});

const MAX_ROWS = 10;

// W5: `contract` is generic — it reflects whatever `code` was queried.
// (eosio.token still produces 'eosio.token' contract values; eosio.nft.ft
// now produces 'eosio.nft.ft'.) Downstream identifier extraction treats
// these as data — there's no field whitelist on shape.
export type BalanceRow = {
    symbol: string;
    amount: string;
    contract: string;
};

// Chain returns ["100.00000000 UOS", ...]. We split on whitespace, drop
// rows that don't match the canonical "<amount> <symbol>" shape — a
// malformed row is dropped silently rather than poisoning the whole array,
// because a bad row from chain is observable elsewhere (it'll fail the
// reply's regex gate) and we'd rather give the LLM partial truth than
// nothing.
function parseRow(row: string, contract: string): BalanceRow | null {
    const parts = row.trim().split(/\s+/);
    if (parts.length !== 2) return null;
    const [amount, symbol] = parts;
    if (!amount || !symbol) return null;
    if (!/^[0-9]+(\.[0-9]+)?$/.test(amount)) return null;
    if (!SYMBOL_RE.test(symbol)) return null;
    return { symbol, amount, contract };
}

// Pre-flight check: which (code, symbol) pairs are allowed without prior
// echo. eosio.token has always been the unconditional baseline per §4.2; any
// other code requires a prior tool/citation entry in echoedTokens.
function isUnconditionallyAllowed(code: string): boolean {
    return code === 'eosio.token';
}

export const getBalanceSpec: ToolSpec = {
    name: 'get_balance',
    description:
        'Read token balances for an account, scoped to one (code, symbol) pair. ' +
        'eosio.token is always allowed; other codes (e.g. eosio.nft.ft) require the symbol to have been surfaced in a prior tool response this turn.',
    inputSchema: InputSchema,
    async call(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const { account, symbol, code } = InputSchema.parse(input);

        // W5 gate — non-baseline contracts must trace to an echoed token.
        // Anti-DoS + anti-invention: stops the LLM from probing balances
        // for invented symbols across arbitrary contracts.
        if (!isUnconditionallyAllowed(code)) {
            const key = `${code}::${symbol}`;
            if (!ctx.echoedTokens?.has(key)) {
                throw new EchoedTokenRequiredError(code, symbol);
            }
        }

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
            const parsed = parseRow(r, code);
            if (parsed) out.push(parsed);
        }
        return out;
    },
};
