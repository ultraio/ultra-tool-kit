import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { loadEosioTypes, type EosioTypesFile } from '../extractor/eosio-types.js';
import type { ActionRules, AuthRef, CatalogFile } from '../extractor/types.js';
import type { ChatProvider } from '../llm/provider.js';
import type { Db } from '../db/client.js';
import { actionChunks, actions, contracts } from '../db/schema.js';
import { applyOverride, loadActionOverride } from './overrides.js';
import { renderRulesChunk, renderSummaryChunk } from './render.js';

export const ELEVATED_ACCOUNTS: readonly string[] = ['eosio', 'eosio.token', 'ultra'];

const SKIP_FILES = new Set(['eosio-types.json']);

export type IngestEnrichment = {
    description: string;
    examples: string[];
};

export type IngestOptions = {
    db: Db;
    catalogDir: string;
    contractNames?: string[];
    embedProviders: ChatProvider[]; // 1 = single-dim, 2 = dual (must have distinct vectorDim())
    chatProvider: ChatProvider;
    enrich: boolean;
    log: Logger;
};

export type IngestSummary = {
    contracts: number;
    actionsUpserted: number;
    actionsDeleted: number;
    chunksWritten: number;
};

type ChunkKind = 'summary' | 'rules' | 'example';

type PendingChunk = {
    kind: ChunkKind;
    text: string;
};

export async function listCatalogContractFiles(catalogDir: string, only?: string[]): Promise<string[]> {
    const entries = await readdir(catalogDir, { withFileTypes: true });
    const all = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json') && !SKIP_FILES.has(e.name))
        .map((e) => join(catalogDir, e.name));
    if (!only || only.length === 0) return all;
    const wanted = new Set(only);
    return all.filter((p) => wanted.has(basename(p, '.json')));
}

export function isAdminAction(contractAccount: string, defaultAuth: AuthRef | null): boolean {
    if (!defaultAuth) return false;
    const actor = defaultAuth.actor.trim();
    if (actor === '$self') return ELEVATED_ACCOUNTS.includes(contractAccount);
    const literal = actor.match(/^"([^"]+)"_n$/);
    if (literal && literal[1]) return ELEVATED_ACCOUNTS.includes(literal[1]);
    if (actor.startsWith('$')) return false;
    return ELEVATED_ACCOUNTS.includes(actor);
}

async function enrichAction(
    chat: ChatProvider,
    contract: string,
    rules: ActionRules,
    log: Logger
): Promise<IngestEnrichment> {
    const schema = {
        type: 'object',
        properties: {
            description: { type: 'string' },
            examples: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        },
        required: ['description', 'examples'],
        additionalProperties: false,
    };
    const system =
        'You annotate EOSIO contract actions for a developer-facing assistant. ' +
        'Respond with concise, factual prose. Never invent authorizations or constraints.';
    const params = rules.params.map((p) => `${p.name}: ${p.type}`).join(', ') || '(no parameters)';
    const auths = rules.auths.map((a) => `${a.actor}@${a.permission}`).join(', ') || '(none)';
    const user = [
        `Contract: ${contract}`,
        `Action: ${rules.action}`,
        `Parameters: ${params}`,
        `Authorizations: ${auths}`,
        '',
        'Return JSON with:',
        '  - description: a single-sentence plain-English summary of what this action does.',
        '  - examples: exactly 3 short natural-language ways a user might phrase a request that maps to this action.',
    ].join('\n');
    try {
        const res = await chat.chat({ system, user, toolSchema: schema, maxTokens: 400 });
        const obj = res.json as { description?: unknown; examples?: unknown };
        const description = typeof obj.description === 'string' ? obj.description.trim() : '';
        const examples = Array.isArray(obj.examples)
            ? obj.examples.filter((e): e is string => typeof e === 'string').slice(0, 3)
            : [];
        return { description, examples };
    } catch (err) {
        log.warn({ err: (err as Error).message, action: rules.action }, '[ingest] enrichment failed; continuing without prose');
        return { description: '', examples: [] };
    }
}

function buildChunks(rules: ActionRules, types: EosioTypesFile, enrichment: IngestEnrichment | null): PendingChunk[] {
    const out: PendingChunk[] = [];
    const description = enrichment?.description || null;
    const firstExample = enrichment?.examples[0] ?? null;
    out.push({ kind: 'summary', text: renderSummaryChunk(rules, description, firstExample) });
    out.push({ kind: 'rules', text: renderRulesChunk(rules, types) });
    if (enrichment) {
        for (const ex of enrichment.examples) {
            out.push({ kind: 'example', text: ex });
        }
    }
    return out;
}

type EmbeddedChunk = {
    kind: ChunkKind;
    text: string;
    vector768: number[] | null;
    vector1536: number[] | null;
};

async function embedChunks(embedProviders: ChatProvider[], chunks: PendingChunk[]): Promise<EmbeddedChunk[]> {
    const dims = embedProviders.map((p) => p.vectorDim());
    if (new Set(dims).size !== dims.length) {
        throw new Error('embedProviders must have distinct vectorDim() values');
    }
    const out: EmbeddedChunk[] = [];
    for (const c of chunks) {
        let v768: number[] | null = null;
        let v1536: number[] | null = null;
        for (const p of embedProviders) {
            const r = await p.embed(c.text);
            if (p.vectorDim() === 768) v768 = r.vector;
            else v1536 = r.vector;
        }
        out.push({ kind: c.kind, text: c.text, vector768: v768, vector1536: v1536 });
    }
    return out;
}

async function upsertContract(db: Db, file: CatalogFile): Promise<bigint> {
    const existing = await db.select({ id: contracts.id }).from(contracts).where(eq(contracts.account, file.contract));
    if (existing.length > 0) {
        await db
            .update(contracts)
            .set({
                abiHash: file.abi_hash,
                abiFetchedAt: new Date(file.abi_fetched_at),
                abiChainId: file.abi_chain_id,
                updatedAt: new Date(),
            })
            .where(eq(contracts.account, file.contract));
        return existing[0]!.id;
    }
    const inserted = await db
        .insert(contracts)
        .values({
            account: file.contract,
            abiHash: file.abi_hash,
            abiFetchedAt: new Date(file.abi_fetched_at),
            abiChainId: file.abi_chain_id,
        })
        .returning({ id: contracts.id });
    return inserted[0]!.id;
}

async function upsertAction(
    db: Db,
    contractId: bigint,
    rules: ActionRules,
    enrichment: IngestEnrichment | null,
    contractAccount: string
): Promise<bigint> {
    const defaultAuth = rules.auths[0] ?? null;
    const sourceRef = `${rules.source.path}:${rules.source.lines[0]}-${rules.source.lines[1]}`;
    const values = {
        contractId,
        name: rules.action,
        fields: rules.params,
        rules,
        defaultAuth,
        isAdmin: isAdminAction(contractAccount, defaultAuth),
        description: enrichment?.description ?? null,
        examples: enrichment ? enrichment.examples : null,
        sourceRef,
        unresolved: rules.unresolved === true,
    };
    const existing = await db
        .select({ id: actions.id })
        .from(actions)
        .where(and(eq(actions.contractId, contractId), eq(actions.name, rules.action)));
    if (existing.length > 0) {
        await db
            .update(actions)
            .set({
                fields: values.fields,
                rules: values.rules,
                defaultAuth: values.defaultAuth,
                isAdmin: values.isAdmin,
                description: values.description,
                examples: values.examples,
                sourceRef: values.sourceRef,
                unresolved: values.unresolved,
            })
            .where(eq(actions.id, existing[0]!.id));
        return existing[0]!.id;
    }
    const inserted = await db.insert(actions).values(values).returning({ id: actions.id });
    return inserted[0]!.id;
}

async function replaceChunks(db: Db, actionId: bigint, embedded: EmbeddedChunk[]): Promise<number> {
    await db.delete(actionChunks).where(eq(actionChunks.actionId, actionId));
    if (embedded.length === 0) return 0;
    const rows = embedded.map((c) => ({
        actionId,
        kind: c.kind,
        text: c.text,
        embedding768: c.vector768,
        embedding1536: c.vector1536,
    }));
    await db.insert(actionChunks).values(rows);
    return rows.length;
}

async function pruneOrphans(
    db: Db,
    contractId: bigint,
    keepNames: string[],
    log: Logger
): Promise<number> {
    if (keepNames.length === 0) return 0;
    const existing = await db.select({ id: actions.id, name: actions.name }).from(actions).where(eq(actions.contractId, contractId));
    const toDeleteIds = existing.filter((a) => !keepNames.includes(a.name)).map((a) => a.id);
    if (toDeleteIds.length === 0) return 0;
    await db.delete(actions).where(inArray(actions.id, toDeleteIds));
    log.info({ count: toDeleteIds.length, contractId: contractId.toString() }, '[ingest] pruned orphan actions');
    return toDeleteIds.length;
}

export async function ingestCatalogFile(opts: {
    db: Db;
    file: CatalogFile;
    catalogDir: string;
    embedProviders: ChatProvider[];
    chatProvider: ChatProvider;
    enrich: boolean;
    log: Logger;
    eosioTypes: EosioTypesFile;
}): Promise<{ actionsUpserted: number; actionsDeleted: number; chunksWritten: number }> {
    const { db, file, catalogDir, embedProviders, chatProvider, enrich, log, eosioTypes } = opts;
    const contractId = await upsertContract(db, file);
    log.info({ contract: file.contract, contractId: contractId.toString() }, '[ingest] contract row upserted');

    let actionsUpserted = 0;
    let chunksWritten = 0;
    const keepNames: string[] = [];

    for (const [name, rawRules] of Object.entries(file.actions)) {
        const override = await loadActionOverride(catalogDir, file.contract, name);
        const merged = applyOverride(rawRules, override);
        keepNames.push(name);

        const enrichment = enrich && merged.unresolved !== true
            ? await enrichAction(chatProvider, file.contract, merged, log)
            : null;
        const actionId = await upsertAction(db, contractId, merged, enrichment, file.contract);
        actionsUpserted++;

        const chunks = buildChunks(merged, eosioTypes, enrichment);
        const embedded = await embedChunks(embedProviders, chunks);
        chunksWritten += await replaceChunks(db, actionId, embedded);
    }

    const actionsDeleted = await pruneOrphans(db, contractId, keepNames, log);
    return { actionsUpserted, actionsDeleted, chunksWritten };
}

export async function runIngest(opts: IngestOptions): Promise<IngestSummary> {
    const files = await listCatalogContractFiles(opts.catalogDir, opts.contractNames);
    if (files.length === 0) {
        opts.log.warn({ catalogDir: opts.catalogDir }, '[ingest] no catalog files found');
        return { contracts: 0, actionsUpserted: 0, actionsDeleted: 0, chunksWritten: 0 };
    }

    const eosioTypes = await loadEosioTypes();

    let totalActionsUpserted = 0;
    let totalActionsDeleted = 0;
    let totalChunks = 0;

    for (const path of files) {
        const raw = await readFile(path, 'utf8');
        const file = JSON.parse(raw) as CatalogFile;
        opts.log.info({ contract: file.contract, file: path }, '[ingest] starting');
        const result = await ingestCatalogFile({
            db: opts.db,
            file,
            catalogDir: opts.catalogDir,
            embedProviders: opts.embedProviders,
            chatProvider: opts.chatProvider,
            enrich: opts.enrich,
            log: opts.log,
            eosioTypes,
        });
        totalActionsUpserted += result.actionsUpserted;
        totalActionsDeleted += result.actionsDeleted;
        totalChunks += result.chunksWritten;
        opts.log.info(
            {
                contract: file.contract,
                upserted: result.actionsUpserted,
                deleted: result.actionsDeleted,
                chunks: result.chunksWritten,
            },
            '[ingest] done'
        );
    }

    return {
        contracts: files.length,
        actionsUpserted: totalActionsUpserted,
        actionsDeleted: totalActionsDeleted,
        chunksWritten: totalChunks,
    };
}

