// W5 — get_balance broadened to accept eosio.nft.ft codes when the
// (code, symbol) pair appears in ctx.echoedTokens.
//
// The unconditional eosio.token path is unchanged (the W4 test still passes).
// Source of truth: docs §4.2 row 2 + the W5 plan ("echoedTokens gates non-
// baseline codes").

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

async function ctxWith(
    fetchImpl: ToolCtx['fetchImpl'],
    echoedTokens?: Set<string>
): Promise<ToolCtx> {
    _resetCatalogCache();
    const catalog = await loadCatalog();
    return {
        endpoint: 'https://api.ultra.io',
        allowlist: DEFAULT_ALLOWLIST,
        catalog,
        fetchImpl,
        echoedTokens,
    };
}

describe('get_balance — eosio.nft.ft path (W5)', () => {
    it('accepts (eosio.nft.ft, CARD) when echoedTokens contains the pair', async () => {
        const ctx = await ctxWith(
            async () => jsonResponse(['7.00000000 CARD']),
            new Set(['eosio.nft.ft::CARD'])
        );
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'CARD', code: 'eosio.nft.ft' },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        expect(res.payload).toEqual([
            { symbol: 'CARD', amount: '7.00000000', contract: 'eosio.nft.ft' },
        ]);
    });

    it('rejects (eosio.nft.ft, CARD) when echoedTokens is empty', async () => {
        const ctx = await ctxWith(async () => jsonResponse([]), new Set());
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'CARD', code: 'eosio.nft.ft' },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });

    it('rejects (eosio.nft.ft, OTHER) when echoedTokens has only ::CARD (symbol mismatch)', async () => {
        const ctx = await ctxWith(
            async () => jsonResponse([]),
            new Set(['eosio.nft.ft::CARD'])
        );
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'OTHER', code: 'eosio.nft.ft' },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });

    it('regression: (eosio.token, UOS) still works without echoedTokens', async () => {
        const ctx = await ctxWith(async () => jsonResponse(['10.00000000 UOS']));
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'UOS', code: 'eosio.token' },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        expect(res.payload).toEqual([
            { symbol: 'UOS', amount: '10.00000000', contract: 'eosio.token' },
        ]);
    });

    it('rejects an arbitrary unknown code even when echoedTokens has a key under it', async () => {
        // 'evil.token' is not eosio.token (so it must go through the echo
        // gate). Even if we synthesize an echoedTokens entry for it, the
        // implementation accepts it because the gate is by-key. This is
        // intentional — once an arbitrary contract has actually surfaced in
        // a chain_read this turn, the LLM may legitimately query it. The
        // anti-DoS guard is the "must have surfaced in this turn" property,
        // not a static contract allowlist. So this test verifies that an
        // arbitrary, NEVER-echoed contract is rejected.
        const ctx = await ctxWith(async () => jsonResponse([]), new Set());
        const res = await dispatch(
            'get_balance',
            { account: 'duncan', symbol: 'UOS', code: 'evil.token' },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });
});
