// W2 acceptance — backend/src/pipeline/retrieve.ts.
// Verifies BM25 over the real on-disk catalog gives the right top-K=5
// for known queries, returns [] on empty input, and breaks ties stably.

import { describe, expect, it } from 'vitest';

import { type CatalogIndex, _resetCatalogCache, loadCatalog } from '../../src/pipeline/catalog.js';
import { type CatalogDoc, buildBm25Index, buildDoc, retrieve, tokenize } from '../../src/pipeline/retrieve.js';

// Wraps a synthetic doc set in the minimal CatalogIndex shape retrieve()
// needs (actions/byKey/contracts go unread by retrieve, so they stay empty).
function makeIndex(docs: CatalogDoc[]): CatalogIndex {
    return { actions: [], byKey: new Map(), contracts: new Set<string>(), bm25: buildBm25Index(docs) };
}

describe('retrieve — top-K=5 against the real catalog', () => {
    it('"transfer 100 UOS" puts eosio.token::transfer in the top-5', async () => {
        _resetCatalogCache();
        const index = await loadCatalog();
        const hits = retrieve('transfer 100 UOS', index);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.length).toBeLessThanOrEqual(5);
        expect(hits.some((h) => h.contract === 'eosio.token' && h.action === 'transfer')).toBe(true);
    });

    it('"propose msig" puts eosio.msig::proposex in the top-5', async () => {
        _resetCatalogCache();
        const index = await loadCatalog();
        const hits = retrieve('propose msig', index);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.length).toBeLessThanOrEqual(5);
        expect(hits.some((h) => h.contract === 'eosio.msig' && h.action === 'proposex')).toBe(true);
    });

    it('empty query returns []', async () => {
        const index = await loadCatalog();
        expect(retrieve('', index)).toEqual([]);
        expect(retrieve('   ', index)).toEqual([]);
    });

    it('catalog miss (no positive scores) returns []', async () => {
        const index = await loadCatalog();
        // A query with no overlap against any catalog doc tokens.
        expect(retrieve('zzzzzzzz qqqqqqqq', index)).toEqual([]);
    });
});

describe('retrieve — score monotonicity', () => {
    // Synthetic 3-doc corpus: doc A matches one query term, doc B matches
    // two, doc C matches none. BM25 must rank B > A > C-omitted.
    it('a doc matching more query terms scores higher', () => {
        const index = makeIndex([
            buildDoc('c.alpha', 'a', 'transfer name from to'),
            buildDoc('c.beta', 'b', 'transfer asset name from to amount memo'),
            buildDoc('c.gamma', 'c', 'unrelated tokens here'),
        ]);
        const hits = retrieve('transfer asset memo', index);
        const aScore = hits.find((h) => h.action === 'a')?.score ?? 0;
        const bScore = hits.find((h) => h.action === 'b')?.score ?? 0;
        expect(bScore).toBeGreaterThan(aScore);
        expect(hits.some((h) => h.action === 'c')).toBe(false);
    });
});

describe('retrieve — stable tie-break', () => {
    it('ties break ascending by (contract, action)', () => {
        // Two identical docs differ only in identifier. Same score; the
        // lexicographically-smaller (contract, action) must come first.
        const index = makeIndex([
            buildDoc('zeta.contract', 'b', 'identical text body shared'),
            buildDoc('alpha.contract', 'a', 'identical text body shared'),
            buildDoc('alpha.contract', 'b', 'identical text body shared'),
        ]);
        const hits = retrieve('identical text', index);
        expect(hits.map((h) => `${h.contract}::${h.action}`)).toEqual([
            'alpha.contract::a',
            'alpha.contract::b',
            'zeta.contract::b',
        ]);
    });
});

describe('tokenize — EOSIO variant suffix expansion', () => {
    it('expands trailing -x / -2 variants so "propose" matches proposex', () => {
        expect(tokenize('proposex')).toContain('propose');
        expect(tokenize('approvals2')).toContain('approvals');
    });

    it('leaves short real words alone (no spurious prefix)', () => {
        // "tax" (3), "max" (3), "exec" (4 — wrong final char) must not get
        // truncated. The minimum-length guard in tokenize protects them.
        expect(tokenize('tax')).toEqual(['tax']);
        expect(tokenize('max')).toEqual(['max']);
        expect(tokenize('exec')).toEqual(['exec']);
    });
});
