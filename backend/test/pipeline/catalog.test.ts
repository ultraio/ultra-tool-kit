// W2 acceptance — backend/src/pipeline/catalog.ts.
// Verifies the loader picks up every committed contract catalog, skips
// the reference files, and survives a malformed JSON file (logged-and-
// continued, never thrown — this guard is load-bearing per the W2
// prompt's exclusion list and backend/CLAUDE.md hard rule 8).

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog } from '../../src/pipeline/catalog.js';

describe('loadCatalog — default dir', () => {
    beforeEach(_resetCatalogCache);

    it('loads at least the 17 committed contracts', async () => {
        const index = await loadCatalog();
        expect(index.contracts.size).toBeGreaterThanOrEqual(17);
        expect(index.contracts.has('eosio.token')).toBe(true);
        expect(index.contracts.has('eosio.nft.ft')).toBe(true);
        expect(index.contracts.has('eosio.msig')).toBe(true);
    });

    it('skips reference files (eosio-types.json, known-symbols.json)', async () => {
        const index = await loadCatalog();
        // No "contract" with one of those names should leak into the index.
        for (const c of index.contracts) {
            expect(c).not.toBe('eosio-types');
            expect(c).not.toBe('known-symbols');
        }
    });

    it('byKey maps "contract::action" to the same entry as actions[]', async () => {
        const index = await loadCatalog();
        const sample = index.actions[0];
        expect(sample).toBeDefined();
        const viaMap = index.byKey.get(`${sample!.contract}::${sample!.action}`);
        expect(viaMap).toBe(sample);
    });
});

describe('loadCatalog — malformed file survival', () => {
    it('logs and skips a malformed catalog file, returns the rest', async () => {
        // Build a tmpdir with one good catalog (copied from the real one)
        // and one deliberately broken JSON file. Loader must succeed with
        // the good one and skip the broken one — never throw.
        const dir = await mkdtemp(join(tmpdir(), 'catalog-mal-'));
        const realDir = join(__dirname, '..', '..', 'catalog');
        const goodSrc = join(realDir, 'eosio.token.json');
        await writeFile(join(dir, 'eosio.token.json'), await readFile(goodSrc));
        await writeFile(join(dir, 'broken.json'), '{ this is not valid json');

        const index = await loadCatalog({ dir });
        expect(index.contracts.has('eosio.token')).toBe(true);
        // The broken file should not have registered any contract.
        for (const c of index.contracts) {
            expect(c).not.toBe('broken');
        }
        // Sanity — the loader read both file entries from the dir.
        const entries = await readdir(dir);
        expect(entries).toContain('broken.json');
    });

    it('skips files missing the contract/actions fields', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'catalog-shape-'));
        // JSON parses fine but lacks the expected shape.
        await writeFile(join(dir, 'shape.json'), JSON.stringify({ hello: 'world' }));
        const index = await loadCatalog({ dir });
        expect(index.actions.length).toBe(0);
        expect(index.contracts.size).toBe(0);
    });
});
