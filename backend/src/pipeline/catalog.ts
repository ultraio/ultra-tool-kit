// Catalog index — boot-time loader for backend/catalog/*.json.
//
// Roadmap §3 architecture box: "BM25 over catalog/*.json, top-K=5".
// Roadmap §6 row W2 acceptance: "Pure functions, unit-tested" — the LLM
// path never reads the filesystem at request time. The index is built once
// here, then `retrieve.ts` is pure over the returned `CatalogIndex`.
//
// Hard rules respected: no LLM in the fact path (backend/CLAUDE.md hard
// rule 2), no DB (hard rule 1). One malformed catalog file must NEVER
// brick the AI feature — log + skip, never throw.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ActionRules, CatalogFile, FieldConstraint, Precondition } from '../extractor/types.js';
import { logger } from '../middleware/logging.js';
import { type Bm25Index, type CatalogDoc, buildBm25Index, buildDoc } from './retrieve.js';

// Reference data, not contract definitions — see backend/CLAUDE.md layout
// note. Skip by filename so the loader never has to introspect the schema
// to figure out what it's looking at. W5 adds the metadata JSON-Schema
// files (factory-metadata.schema.json / uniq-metadata.schema.json) which
// live in catalog/ for the parity grep (#10) but are not action catalogs.
const NON_CONTRACT_CATALOGS = new Set([
    'eosio-types.json',
    'known-symbols.json',
    'factory-metadata.schema.json',
    'uniq-metadata.schema.json',
]);

const DEFAULT_CATALOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'catalog');

export type CatalogActionEntry = {
    contract: string;
    action: string;
    rules: ActionRules;
};

export type CatalogIndex = {
    actions: CatalogActionEntry[];
    byKey: Map<string, CatalogActionEntry>; // `${contract}::${action}`
    contracts: Set<string>;
    bm25: Bm25Index;
};

export type LoadCatalogOpts = {
    dir?: string;
    force?: boolean;
};

let cached: CatalogIndex | null = null;

export async function loadCatalog(opts: LoadCatalogOpts = {}): Promise<CatalogIndex> {
    const dir = opts.dir ?? DEFAULT_CATALOG_DIR;
    const isDefault = dir === DEFAULT_CATALOG_DIR;
    if (isDefault && cached && !opts.force) return cached;

    const entries = await readdir(dir);
    const files = entries.filter((e) => e.endsWith('.json') && !NON_CONTRACT_CATALOGS.has(e)).sort();

    const actions: CatalogActionEntry[] = [];
    const byKey = new Map<string, CatalogActionEntry>();
    const contracts = new Set<string>();
    const docs: CatalogDoc[] = [];

    for (const file of files) {
        const path = join(dir, file);
        let parsed: CatalogFile;
        try {
            parsed = JSON.parse(await readFile(path, 'utf8')) as CatalogFile;
        } catch (err) {
            // Load-bearing: a single broken catalog file must never crash
            // boot. The AI feature still serves the other contracts; ops
            // sees the warn and re-runs the extractor.
            logger.warn(
                { file, err: err instanceof Error ? err.message : String(err) },
                'catalog: failed to parse, skipping'
            );
            continue;
        }
        if (!parsed.contract || !parsed.actions || typeof parsed.actions !== 'object') {
            logger.warn({ file }, 'catalog: missing contract/actions, skipping');
            continue;
        }
        contracts.add(parsed.contract);
        for (const [actionName, rules] of Object.entries(parsed.actions)) {
            const entry: CatalogActionEntry = {
                contract: parsed.contract,
                action: actionName,
                rules,
            };
            actions.push(entry);
            byKey.set(`${parsed.contract}::${actionName}`, entry);
            docs.push(buildDoc(parsed.contract, actionName, docText(parsed.contract, actionName, rules)));
        }
    }

    const index: CatalogIndex = {
        actions,
        byKey,
        contracts,
        bm25: buildBm25Index(docs),
    };
    if (isDefault) cached = index;
    return index;
}

// Document text fed to BM25 per roadmap §6 row W2: action name, summary
// (the extractor doesn't emit `summary` — `notes` is the closest free-text
// field and carries the unresolved-handler diagnostic), extracted check()
// messages, and field names. Contract name is included so a query like
// "propose msig" matches via the `msig` token even when the action is
// `proposex`.
function docText(contract: string, action: string, rules: ActionRules): string {
    const parts: string[] = [contract, action];
    if (rules.notes) parts.push(rules.notes);
    for (const p of rules.params) parts.push(p.name);
    for (const pre of rules.preconditions as Precondition[]) {
        if (pre.message) parts.push(pre.message);
    }
    for (const constraints of Object.values(rules.field_constraints) as FieldConstraint[][]) {
        for (const c of constraints) {
            if (c.message) parts.push(c.message);
        }
    }
    return parts.join(' ');
}

// Test-only escape hatch — the module-level cache otherwise leaks state
// between describe-blocks that pass custom dirs.
export function _resetCatalogCache(): void {
    cached = null;
}
