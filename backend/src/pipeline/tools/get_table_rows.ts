// `get_table_rows` tool — wraps /v1/chain/get_table_rows with the explicit
// (contract, table) allowlist from §4.2.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 row 4. The
// TABLE_ALLOWLIST below MUST stay in sync with that table — the table-rows
// test re-reads the guidelines markdown and asserts every documented row
// appears here. Drift = CI fail. Roadmap §6 row W4.
//
// `json: true` is enforced — binary rows are useless to the LLM and would
// bypass the post-filtering layer W5 adds. `limit ≤ 20` is the §4.2
// "≤ 20 rows" cap. W4 does NOT post-filter individual row fields (rows
// are passed through verbatim) — that's W5+ territory once per-table
// schemas are defined.

import { z } from 'zod';

import { isAllowedEndpoint } from './host-allowlist.js';
import { EndpointRejectedError, UnknownTableError, type ToolCtx, type ToolSpec } from './types.js';

const NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;
// Scope may be either an EOSIO account name OR a symbol-code (e.g. `UOS`
// for the eosio.token stat table whose scope is the token's symbol code,
// not an account). Keep `code` / `table` strict against NAME_RE so the
// TABLE_ALLOWLIST join stays unambiguous.
const SCOPE_RE = /^([a-z][a-z1-5.]{0,11}[a-j1-5]?|[A-Z]{1,7})$/;
const MAX_LIMIT = 20;

// The §4.2 table — exact tuples, in the same order as the markdown. Sync
// is asserted in test/pipeline/tools/get_table_rows.test.ts.
export const TABLE_ALLOWLIST: ReadonlyArray<readonly [string, string]> = [
    ['eosio.token', 'accounts'],
    ['eosio.token', 'stat'],
    ['eosio.nft.ft', 'factory.a'],
    ['eosio.nft.ft', 'group.a'],
    ['eosio.nft.ft', 'tokenb.a'],
    ['eosio.msig', 'proposal'],
    ['eosio.msig', 'approvals2'],
] as const;

const INDEX_POSITIONS = [
    'primary',
    'secondary',
    'tertiary',
    'fourth',
    'fifth',
    'sixth',
    'seventh',
    'eighth',
    'ninth',
    'tenth',
] as const;

const InputSchema = z.object({
    code: z.string().regex(NAME_RE, 'invalid contract name'),
    table: z.string().regex(NAME_RE, 'invalid table name'),
    scope: z.string().regex(SCOPE_RE, 'invalid scope name'),
    limit: z.number().int().min(1).max(MAX_LIMIT),
    lower_bound: z.string().max(128).optional(),
    upper_bound: z.string().max(128).optional(),
    index_position: z.enum(INDEX_POSITIONS).optional(),
    key_type: z.string().max(32).optional(),
    reverse: z.boolean().optional(),
    // Explicit literal — `json: false` (binary mode) is rejected at parse time.
    json: z.literal(true).default(true),
});

function inAllowlist(code: string, table: string): boolean {
    for (const [c, t] of TABLE_ALLOWLIST) {
        if (c === code && t === table) return true;
    }
    return false;
}

export const getTableRowsSpec: ToolSpec = {
    name: 'get_table_rows',
    description: 'Read rows from a contract table on the §4.2 allowlist.',
    inputSchema: InputSchema,
    async call(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const parsed = InputSchema.parse(input);
        if (!inAllowlist(parsed.code, parsed.table)) {
            throw new UnknownTableError(parsed.code, parsed.table);
        }
        const url = new URL('/v1/chain/get_table_rows', ctx.endpoint).toString();
        if (!isAllowedEndpoint(url, ctx.allowlist)) {
            throw new EndpointRejectedError(ctx.endpoint);
        }

        // Build the request body that mirrors the chain's expected shape.
        // Optional keys are dropped (not set to undefined) to keep the
        // serialized body clean.
        const body: Record<string, unknown> = {
            code: parsed.code,
            scope: parsed.scope,
            table: parsed.table,
            limit: parsed.limit,
            json: true,
        };
        if (parsed.lower_bound !== undefined) body.lower_bound = parsed.lower_bound;
        if (parsed.upper_bound !== undefined) body.upper_bound = parsed.upper_bound;
        if (parsed.index_position !== undefined) body.index_position = parsed.index_position;
        if (parsed.key_type !== undefined) body.key_type = parsed.key_type;
        if (parsed.reverse !== undefined) body.reverse = parsed.reverse;

        const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`get_table_rows failed: HTTP ${res.status}`);
        }
        const resp = (await res.json()) as Record<string, unknown>;
        const rowsRaw = Array.isArray(resp.rows) ? (resp.rows as unknown[]) : [];
        return {
            rows: rowsRaw.slice(0, MAX_LIMIT),
            more: Boolean(resp.more),
            next_key: typeof resp.next_key === 'string' ? resp.next_key : null,
        };
    },
};
