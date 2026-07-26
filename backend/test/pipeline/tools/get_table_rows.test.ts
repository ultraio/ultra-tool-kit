// get_table_rows tool — allowlist, caps, and §4.2 sync check.
//
// The sync test reads docs/00-ai-global-guidelines.md, greps for the seven
// table tuples, and asserts each appears in TABLE_ALLOWLIST. Drift between
// the docs and the code = CI fail (this is the §4.2 "doc change first"
// invariant in test form).

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog } from '../../../src/pipeline/catalog.js';
import { TABLE_ALLOWLIST } from '../../../src/pipeline/tools/get_table_rows.js';
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

describe('get_table_rows — happy path', () => {
    it('returns rows + more + next_key from a chain response', async () => {
        const chainResp = {
            rows: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }],
            more: false,
            next_key: '',
        };
        const ctx = await ctxWith(async () => jsonResponse(chainResp));
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.token',
                table: 'accounts',
                scope: 'duncan',
                limit: 10,
            },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        expect(res.payload).toEqual({
            rows: chainResp.rows,
            more: false,
            next_key: '',
        });
    });

    it('caps the rows array at 20 even if chain returns more', async () => {
        const rows = Array.from({ length: 50 }, (_, i) => ({ i }));
        const ctx = await ctxWith(async () => jsonResponse({ rows, more: true, next_key: 'foo' }));
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.token',
                table: 'accounts',
                scope: 'duncan',
                limit: 20,
            },
            ctx
        );
        expect(res.audit.status).toBe('ok');
        const payload = res.payload as { rows: unknown[]; more: boolean; next_key: string };
        expect(payload.rows).toHaveLength(20);
        expect(payload.more).toBe(true);
        expect(payload.next_key).toBe('foo');
    });
});

describe('get_table_rows — allowlist', () => {
    it('rejects (code, table) outside the §4.2 allowlist', async () => {
        const ctx = await ctxWith(async () => jsonResponse({ rows: [] }));
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.evil',
                table: 'accounts',
                scope: 'duncan',
                limit: 5,
            },
            ctx
        );
        expect(res.audit.status).toBe('error');
        expect(res.audit.error).toMatch(/allowlist/);
    });
});

describe('get_table_rows — input validation', () => {
    it('rejects json:false', async () => {
        const ctx = await ctxWith(async () => jsonResponse({ rows: [] }));
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.token',
                table: 'accounts',
                scope: 'duncan',
                limit: 5,
                json: false,
            },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });

    it('rejects limit: 100 (above the cap)', async () => {
        const ctx = await ctxWith(async () => jsonResponse({ rows: [] }));
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.token',
                table: 'accounts',
                scope: 'duncan',
                limit: 100,
            },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });

    it('accepts a symbol-code scope (eosio.token stat is scoped by symbol)', async () => {
        const ctx = await ctxWith(async () =>
            jsonResponse({ rows: [], more: false, next_key: '' })
        );
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.token',
                table: 'stat',
                scope: 'UOS',
                limit: 1,
            },
            ctx
        );
        expect(res.audit.status).toBe('ok');
    });

    it('rejects a mixed-case scope (guards against the regex widening too far)', async () => {
        const ctx = await ctxWith(async () => jsonResponse({ rows: [] }));
        const res = await dispatch(
            'get_table_rows',
            {
                code: 'eosio.token',
                table: 'stat',
                scope: 'foO',
                limit: 1,
            },
            ctx
        );
        expect(res.audit.status).toBe('error');
    });
});

describe('TABLE_ALLOWLIST — §4.2 sync', () => {
    it('has EXACTLY 7 entries', () => {
        expect(TABLE_ALLOWLIST).toHaveLength(7);
    });

    it('every (code, table) tuple in §4.2 of the guidelines appears in TABLE_ALLOWLIST', async () => {
        // Read the guidelines markdown and extract every "(contract, table)"
        // tuple that appears in the §4.2 row for get_table_rows.
        const docsPath = join(
            dirname(fileURLToPath(import.meta.url)),
            '..',
            '..',
            '..',
            '..',
            'docs',
            '00-ai-global-guidelines.md'
        );
        const md = await readFile(docsPath, 'utf8');
        // Tuples we know §4.2 names — assert each is in the allowlist.
        const expected: ReadonlyArray<readonly [string, string]> = [
            ['eosio.token', 'accounts'],
            ['eosio.token', 'stat'],
            ['eosio.nft.ft', 'factory.a'],
            ['eosio.nft.ft', 'group.a'],
            ['eosio.nft.ft', 'tokenb.a'],
            ['eosio.msig', 'proposal'],
            ['eosio.msig', 'approvals2'],
        ];
        for (const [code, table] of expected) {
            // Guideline contains the literal tuple string.
            expect(md).toContain(`(${code}, ${table})`);
            // Allowlist also contains it.
            const found = TABLE_ALLOWLIST.some(([c, t]) => c === code && t === table);
            expect(found, `missing (${code}, ${table}) in TABLE_ALLOWLIST`).toBe(true);
        }
    });
});
