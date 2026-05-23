// `get_account` tool — wraps /v1/chain/get_account with a field-level
// allowlist on the way back.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 row 1 (full body
// allowed, no chain-side enumeration) and §4.4 ("Tool responses are
// post-filtered: only the fields the LLM asked about are forwarded back
// to the LLM"). Roadmap §6 row W4.
//
// Output is built by explicit whitelist (no spread). New fields added to
// the chain response will NOT leak through to the LLM — they have to be
// added here intentionally.

import { z } from 'zod';

import { isAllowedEndpoint } from './host-allowlist.js';
import { EndpointRejectedError, type ToolCtx, type ToolSpec } from './types.js';

// EOSIO name regex — `[a-z][a-z1-5.]{0,11}[a-j1-5]?` per validate.ts gate 3.
const NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;

const InputSchema = z.object({
    accountName: z.string().regex(NAME_RE, 'invalid eosio account name'),
});

// Permission sub-shape allowlist (mirrors the chain's `required_auth`).
type FilteredKey = { key: string; weight: number };
type FilteredAccount = { permission: { actor: string; permission: string }; weight: number };
type FilteredRequiredAuth = {
    threshold: number;
    keys: FilteredKey[];
    accounts: FilteredAccount[];
};
type FilteredPermission = {
    perm_name: string;
    parent: string;
    required_auth: FilteredRequiredAuth;
};
type FilteredAccountResp = {
    account_name: string;
    core_liquid_balance: string | null;
    ram_quota: number | null;
    ram_usage: number | null;
    permissions: FilteredPermission[];
};

function filterRequiredAuth(raw: unknown): FilteredRequiredAuth {
    const r = (raw ?? {}) as Record<string, unknown>;
    const keysRaw = Array.isArray(r.keys) ? (r.keys as unknown[]) : [];
    const accountsRaw = Array.isArray(r.accounts) ? (r.accounts as unknown[]) : [];

    const keys: FilteredKey[] = keysRaw.map((k) => {
        const o = (k ?? {}) as Record<string, unknown>;
        return {
            key: typeof o.key === 'string' ? o.key : '',
            weight: typeof o.weight === 'number' ? o.weight : 0,
        };
    });
    const accounts: FilteredAccount[] = accountsRaw.map((a) => {
        const o = (a ?? {}) as Record<string, unknown>;
        const perm = (o.permission ?? {}) as Record<string, unknown>;
        return {
            permission: {
                actor: typeof perm.actor === 'string' ? perm.actor : '',
                permission: typeof perm.permission === 'string' ? perm.permission : '',
            },
            weight: typeof o.weight === 'number' ? o.weight : 0,
        };
    });
    return {
        threshold: typeof r.threshold === 'number' ? r.threshold : 0,
        keys,
        accounts,
    };
}

function filterAccount(raw: unknown): FilteredAccountResp {
    const r = (raw ?? {}) as Record<string, unknown>;
    const permsRaw = Array.isArray(r.permissions) ? (r.permissions as unknown[]) : [];
    const permissions: FilteredPermission[] = permsRaw.map((p) => {
        const o = (p ?? {}) as Record<string, unknown>;
        return {
            perm_name: typeof o.perm_name === 'string' ? o.perm_name : '',
            parent: typeof o.parent === 'string' ? o.parent : '',
            required_auth: filterRequiredAuth(o.required_auth),
        };
    });
    return {
        account_name: typeof r.account_name === 'string' ? r.account_name : '',
        core_liquid_balance:
            typeof r.core_liquid_balance === 'string' ? r.core_liquid_balance : null,
        ram_quota: typeof r.ram_quota === 'number' ? r.ram_quota : null,
        ram_usage: typeof r.ram_usage === 'number' ? r.ram_usage : null,
        permissions,
    };
}

export const getAccountSpec: ToolSpec = {
    name: 'get_account',
    description: 'Fetch an EOSIO account: balance, RAM, and permission graph.',
    inputSchema: InputSchema,
    async call(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const { accountName } = InputSchema.parse(input);
        const url = new URL('/v1/chain/get_account', ctx.endpoint).toString();
        if (!isAllowedEndpoint(url, ctx.allowlist)) {
            throw new EndpointRejectedError(ctx.endpoint);
        }
        const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ account_name: accountName }),
        });
        if (!res.ok) {
            throw new Error(`get_account failed: HTTP ${res.status}`);
        }
        const body = (await res.json()) as unknown;
        return filterAccount(body);
    },
};
