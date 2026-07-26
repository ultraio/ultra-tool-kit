// get_action_schema tool — local catalog read.
//
// §4.2 row 5: known contracts only, one entry. The `null` return is the
// LLM's signal to fall back to get_abi for an uncatalogued contract
// (§4.3 gate 2 second clause).

import { describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog } from '../../../src/pipeline/catalog.js';
import { DEFAULT_ALLOWLIST } from '../../../src/pipeline/tools/host-allowlist.js';
import { dispatch, type ToolCtx } from '../../../src/pipeline/tools/index.js';

async function makeCtx(): Promise<ToolCtx> {
    _resetCatalogCache();
    const catalog = await loadCatalog();
    return {
        endpoint: 'https://api.ultra.io',
        allowlist: DEFAULT_ALLOWLIST,
        catalog,
        fetchImpl: async () => {
            throw new Error('get_action_schema must not fetch');
        },
    };
}

describe('get_action_schema — known action', () => {
    it('returns the rules object for a catalogued (contract, action)', async () => {
        const ctx = await makeCtx();
        const res = await dispatch(
            'get_action_schema',
            { contract: 'eosio.token', action: 'transfer' },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        const payload = res.payload as Record<string, unknown>;
        expect(payload.contract).toBe('eosio.token');
        expect(payload.action).toBe('transfer');
        expect(Array.isArray(payload.params)).toBe(true);
    });
});

describe('get_action_schema — unknown action', () => {
    it('returns null for an uncatalogued (contract, action)', async () => {
        const ctx = await makeCtx();
        const res = await dispatch(
            'get_action_schema',
            { contract: 'no.such.thing', action: 'transfer' },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        expect(res.payload).toBeNull();
    });
});

describe('get_action_schema — bad name regex', () => {
    it("surfaces a Zod failure as audit.status = 'error'", async () => {
        const ctx = await makeCtx();
        const res = await dispatch(
            'get_action_schema',
            { contract: 'INVALID_UPPER', action: 'transfer' },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });
});
