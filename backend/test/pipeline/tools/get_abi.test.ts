// get_abi tool — cache, TTL, and 64 KB size cap.
//
// §4.2 row 3 ("cached 1h"). §4.7 cost-DoS guard ("Output token cap enforced
// in the harness"). The cap also protects against an oversized ABI eating
// the per-turn input budget downstream.

import { beforeEach, describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog } from '../../../src/pipeline/catalog.js';
import { _resetAbiCache } from '../../../src/pipeline/tools/get_abi.js';
import { DEFAULT_ALLOWLIST } from '../../../src/pipeline/tools/host-allowlist.js';
import { dispatch, type ToolCtx } from '../../../src/pipeline/tools/index.js';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function ctxWith(
    fetchImpl: ToolCtx['fetchImpl'],
    endpoint = 'https://api.ultra.io'
): Promise<ToolCtx> {
    _resetCatalogCache();
    const catalog = await loadCatalog();
    return {
        endpoint,
        allowlist: DEFAULT_ALLOWLIST,
        catalog,
        fetchImpl,
    };
}

beforeEach(() => {
    _resetAbiCache();
});

describe('get_abi — size handling', () => {
    it('passes through a small ABI with truncated:false', async () => {
        const smallAbi = { abi: { version: 'eosio::abi/1.2', actions: [] } };
        const ctx = await ctxWith(async () => jsonResponse(smallAbi));
        const res = await dispatch('get_abi', { accountName: 'eosio.token' }, ctx);
        expect(res.audit.status).toBe('ok');
        expect(res.payload).toEqual({ abi: smallAbi, truncated: false });
    });

    it('returns truncated:true when the ABI exceeds 64 KB', async () => {
        // Build a 100 KB ABI by stuffing a string field.
        const huge = 'x'.repeat(100_000);
        const oversizedAbi = { abi: { version: 'eosio::abi/1.2', filler: huge } };
        const ctx = await ctxWith(async () => jsonResponse(oversizedAbi));
        const res = await dispatch('get_abi', { accountName: 'eosio.token' }, ctx);
        expect(res.audit.status).toBe('ok');
        const payload = res.payload as Record<string, unknown>;
        expect(payload.abi).toBeNull();
        expect(payload.truncated).toBe(true);
        expect(payload.reason).toBeTruthy();
    });
});

describe('get_abi — cache', () => {
    it('hits cache on the second call with the same (endpoint, accountName)', async () => {
        let calls = 0;
        const ctx = await ctxWith(async () => {
            calls++;
            return jsonResponse({ abi: { version: 'eosio::abi/1.2' } });
        });
        await dispatch('get_abi', { accountName: 'eosio.token' }, ctx);
        await dispatch('get_abi', { accountName: 'eosio.token' }, ctx);
        expect(calls).toBe(1);
    });

    it('does not share cache across endpoints', async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls++;
            return jsonResponse({ abi: { version: 'eosio::abi/1.2' } });
        };
        const ctxA = await ctxWith(fetchImpl, 'https://api.ultra.io');
        const ctxB = await ctxWith(fetchImpl, 'https://test.ultra.io');
        await dispatch('get_abi', { accountName: 'eosio.token' }, ctxA);
        await dispatch('get_abi', { accountName: 'eosio.token' }, ctxB);
        expect(calls).toBe(2);
    });
});
