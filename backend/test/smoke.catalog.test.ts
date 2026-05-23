// W0 smoke test: every contract catalog in backend/catalog/ has actions
// with real semantics. No LLM, no network, no DB — just JSON shape checks.
//
// Why glob instead of a hardcoded list:
//   The catalog now holds every contract under ~/ultra/eosio.contracts that
//   the extractor could successfully process (per roadmap §1: "Other contracts
//   work via fallback to ABI-only mode" — we extract whatever we can ahead of
//   time so the LLM has grounding data even for non-primary contracts). The
//   list of contracts will grow as new ones get deployed. Globbing keeps the
//   test in sync with whatever's actually in the catalog dir.
//
// Excluded from the glob:
//   - eosio-types.json  — canonical EOSIO type + regex catalog (not a contract)
//   - known-symbols.json — token-symbol reference (not a contract)
//   - *-metadata.schema.json — JSON-Schema mirrors of the frontend metadata
//     validators (W5; live in catalog/ for the parity grep #10).
//
// Assertion deviation from a strict "first action has auths + field_constraints":
//   eosio.msig validates whole transactions, not individual fields — its
//   check() calls land in `preconditions` (cross-field/state), never in
//   `field_constraints`. The assertion below requires at least one action
//   with non-empty `auths` AND at least one action with non-empty
//   `field_constraints` OR `preconditions`, which confirms the extractor
//   produced real semantic output on the axis the contract actually uses.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog');
const NON_CONTRACT_CATALOGS = new Set([
    'eosio-types.json',
    'known-symbols.json',
    'factory-metadata.schema.json',
    'uniq-metadata.schema.json',
]);

type ActionRow = {
    contract: string;
    action: string;
    params: { name: string; type: string }[];
    auths: unknown[];
    preconditions: unknown[];
    field_constraints: Record<string, unknown>;
};

type CatalogFile = {
    contract: string;
    actions: Record<string, ActionRow>;
};

async function listContractCatalogs(): Promise<string[]> {
    const entries = await readdir(CATALOG_DIR);
    return entries.filter((e) => e.endsWith('.json') && !NON_CONTRACT_CATALOGS.has(e)).sort();
}

async function loadCatalog(file: string): Promise<CatalogFile> {
    return JSON.parse(await readFile(join(CATALOG_DIR, file), 'utf8')) as CatalogFile;
}

describe('catalog smoke', () => {
    it('catalog dir has at least the three primary contracts', async () => {
        const files = await listContractCatalogs();
        expect(files).toContain('eosio.token.json');
        expect(files).toContain('eosio.nft.ft.json');
        expect(files).toContain('eosio.msig.json');
    });

    // One sub-test per catalog file — failures point at the specific contract.
    it('every contract catalog has actions with real semantics', async () => {
        const files = await listContractCatalogs();
        expect(files.length).toBeGreaterThan(0);

        for (const file of files) {
            const cat = await loadCatalog(file);
            const expectedContract = file.replace(/\.json$/, '');
            expect(cat.contract, `${file}: contract field`).toBe(expectedContract);

            const actions = Object.values(cat.actions);
            expect(actions.length, `${file}: action count`).toBeGreaterThan(0);

            const withAuths = actions.filter((a) => a.auths.length > 0);
            expect(withAuths.length, `${file}: actions with non-empty auths`).toBeGreaterThan(0);

            const withSemantics = actions.filter(
                (a) => Object.keys(a.field_constraints).length > 0 || a.preconditions.length > 0
            );
            expect(withSemantics.length, `${file}: actions with field_constraints or preconditions`).toBeGreaterThan(0);
        }
    });
});
