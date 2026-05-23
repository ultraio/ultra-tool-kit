// get_balance tool — parse, cap, and input-validation tests.
//
// §4.2 row 2: `code` is pinned to eosio.token in W4. §4.2 output cap: ≤ 10
// rows. The parse semantics ("100.00000000 UOS" → {amount, symbol, contract})
// are W4-internal — the LLM never sees the raw chain string.

import { describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog } from '../../../src/pipeline/catalog.js';
import { DEFAULT_ALLOWLIST } from '../../../src/pipeline/tools/host-allowlist.js';
import { dispatch, type ToolCtx } from '../../../src/pipeline/tools/index.js';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

async function ctxWith(fetchImpl: ToolCtx['fetchImpl']): Promise<ToolCtx> {
    _resetCatalogCache();
    const catalog = await loadCatalog();
    return {
        endpoint: 'https://api.ultra.io',
        allowlist: DEFAULT_ALLOWLIST,
        catalog,
        fetchImpl,
    };
}

describe('get_balance — happy path', () => {
    it('parses chain rows into {symbol, amount, contract}', async () => {
        const ctx = await ctxWith(async () =>
            jsonResponse(['100.00000000 UOS', '50.00000000 UOS'])
        );
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'UOS', code: 'eosio.token' },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        expect(res.payload).toEqual([
            { symbol: 'UOS', amount: '100.00000000', contract: 'eosio.token' },
            { symbol: 'UOS', amount: '50.00000000', contract: 'eosio.token' },
        ]);
    });

    it('caps at 10 rows when chain returns more', async () => {
        const rows = Array.from({ length: 15 }, (_, i) => `${i + 1}.00000000 UOS`);
        const ctx = await ctxWith(async () => jsonResponse(rows));
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'UOS', code: 'eosio.token' },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        expect((res.payload as unknown[]).length).toBe(10);
    });
});

describe('get_balance — input validation', () => {
    it('rejects code other than eosio.token', async () => {
        const ctx = await ctxWith(async () => jsonResponse([]));
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'UOS', code: 'evil.token' },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });

    it('rejects bad symbol regex', async () => {
        const ctx = await ctxWith(async () => jsonResponse([]));
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'too_long_lowercase', code: 'eosio.token' },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });
});
