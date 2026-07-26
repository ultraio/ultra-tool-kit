// `get_abi` tool — wraps /v1/chain/get_abi with an in-process 1h cache and
// a 64 KB size cap.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 row 3 ("any
// contract; cached 1h ... full abi"). The size cap is the §4.7 cost-DoS
// guard — a 5 MB ABI in a prompt is a budget hole.
//
// Cache key = `${endpoint}::${accountName}`. Truncated marker is cached
// too — the LLM should not re-fetch a too-large ABI repeatedly within the
// hour just because the previous response was a truncation marker.

import { z } from 'zod';

import { isAllowedEndpoint } from './host-allowlist.js';
import { EndpointRejectedError, type ToolCtx, type ToolSpec } from './types.js';

const NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;
const InputSchema = z.object({
    accountName: z.string().regex(NAME_RE, 'invalid eosio account name'),
});

const MAX_ABI_BYTES = 65536;
const TTL_MS = 60 * 60 * 1000;

type CacheEntry = { ts: number; body: unknown; truncated: boolean };

const cache = new Map<string, CacheEntry>();

export function _resetAbiCache(): void {
    cache.clear();
}

type AbiResult =
    | { abi: unknown; truncated: false }
    | { abi: null; truncated: true; reason: string };

function pack(entry: CacheEntry): AbiResult {
    if (entry.truncated) {
        return { abi: null, truncated: true, reason: 'abi too large' };
    }
    return { abi: entry.body, truncated: false };
}

export const getAbiSpec: ToolSpec = {
    name: 'get_abi',
    description: "Fetch a contract's ABI from chain; cached 1h, capped at 64 KB.",
    inputSchema: InputSchema,
    async call(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const { accountName } = InputSchema.parse(input);
        const cacheKey = `${ctx.endpoint}::${accountName}`;
        const now = Date.now();
        const hit = cache.get(cacheKey);
        if (hit && now - hit.ts < TTL_MS) {
            return pack(hit);
        }
        if (hit) cache.delete(cacheKey);

        const url = new URL('/v1/chain/get_abi', ctx.endpoint).toString();
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
            throw new Error(`get_abi failed: HTTP ${res.status}`);
        }
        const body = (await res.json()) as unknown;

        // Byte length on the JSON encoding (not character count) — the LLM
        // pays for tokens off the rendered JSON, not the in-memory object.
        const truncated = Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_ABI_BYTES;
        const entry: CacheEntry = { ts: now, body, truncated };
        cache.set(cacheKey, entry);
        return pack(entry);
    },
};
