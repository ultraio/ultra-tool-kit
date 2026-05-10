import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { actionChunks, actions, contracts } from '../../src/db/schema.js';
import * as schema from '../../src/db/schema.js';
import { runIngest } from '../../src/ingest/index.js';
import type { ChatProvider } from '../../src/llm/provider.js';
import type { CatalogFile } from '../../src/extractor/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '..', '..', 'drizzle');

class StubEmbedProvider implements ChatProvider {
    constructor(private readonly dim: 768 | 1536) {}
    chat(): Promise<never> {
        return Promise.reject(new Error('chat not used in ingest test'));
    }
    async embed(): Promise<{ vector: number[]; usage: { input: number } }> {
        return { vector: Array(this.dim).fill(0.1), usage: { input: 0 } };
    }
    modelTag(): string {
        return `stub:embed-${this.dim}`;
    }
    vectorDim(): 768 | 1536 {
        return this.dim;
    }
}

class StubChatProvider implements ChatProvider {
    chat(): Promise<never> {
        return Promise.reject(new Error('chat not used in ingest test (enrich=false)'));
    }
    embed(): Promise<never> {
        return Promise.reject(new Error('embed not used on chat stub'));
    }
    modelTag(): string {
        return 'stub:chat';
    }
    vectorDim(): 1536 {
        return 1536;
    }
}

function makeCatalog(actionsObj: CatalogFile['actions']): CatalogFile {
    return {
        contract: 'test.tok',
        abi_hash: 'deadbeef',
        abi_chain_id: 'fakechain',
        abi_fetched_at: '2026-05-10T00:00:00.000Z',
        source_path: '/tmp/test',
        actions: actionsObj,
    };
}

const transferAction = {
    contract: 'test.tok',
    action: 'transfer',
    params: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' },
    ],
    auths: [{ actor: '$from', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: ['$from', '$to'],
    source: { path: 'src/test.tok.cpp', lines: [10, 30] as [number, number] },
};

const issueAction = {
    contract: 'test.tok',
    action: 'issue',
    params: [
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' },
    ],
    auths: [{ actor: '$issuer', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/test.tok.cpp', lines: [40, 60] as [number, number] },
};

describe('Stage B ingest (against pgvector pg17)', () => {
    let container: StartedPostgreSqlContainer;
    let sql: Sql;
    let db: PostgresJsDatabase<typeof schema>;
    let catalogDir: string;

    beforeAll(async () => {
        container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
            .withDatabase('ingest_test')
            .withUsername('postgres')
            .withPassword('postgres')
            .start();
        sql = postgres(container.getConnectionUri(), { prepare: false });
        db = drizzle(sql, { schema });
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        catalogDir = await mkdtemp(join(tmpdir(), 'ingest-test-'));
    }, 120_000);

    afterAll(async () => {
        await sql.end({ timeout: 5 });
        await container.stop();
        if (catalogDir) await rm(catalogDir, { recursive: true, force: true });
    });

    it('writes contracts, actions, and chunks for a single-action catalog', async () => {
        const file = makeCatalog({ transfer: transferAction, issue: issueAction });
        const path = join(catalogDir, 'test.tok.json');
        await writeFile(path, JSON.stringify(file), 'utf8');

        const summary = await runIngest({
            db,
            catalogDir,
            embedProviders: [new StubEmbedProvider(768)],
            chatProvider: new StubChatProvider(),
            enrich: false,
            log: pino({ level: 'silent' }),
        });

        expect(summary.contracts).toBe(1);
        expect(summary.actionsUpserted).toBe(2);
        expect(summary.actionsDeleted).toBe(0);
        expect(summary.chunksWritten).toBe(4); // 2 chunks per action × 2 actions

        const contractRows = await db.select().from(contracts).where(eq(contracts.account, 'test.tok'));
        expect(contractRows).toHaveLength(1);

        const actionRows = await db.select().from(actions);
        expect(actionRows).toHaveLength(2);
        expect(actionRows.map((a) => a.name).sort()).toEqual(['issue', 'transfer']);
        for (const a of actionRows) {
            expect(a.unresolved).toBe(false);
            expect(a.defaultAuth).not.toBeNull();
        }

        const chunkRows = await db.select().from(actionChunks);
        expect(chunkRows).toHaveLength(4);
        for (const c of chunkRows) {
            expect(c.embedding768).not.toBeNull();
            expect(c.embedding1536).toBeNull();
        }
    }, 60_000);

    it('orphan-cleans actions removed from the catalog (chunks cascade)', async () => {
        const file = makeCatalog({ transfer: transferAction });
        const path = join(catalogDir, 'test.tok.json');
        await writeFile(path, JSON.stringify(file), 'utf8');

        const summary = await runIngest({
            db,
            catalogDir,
            embedProviders: [new StubEmbedProvider(768)],
            chatProvider: new StubChatProvider(),
            enrich: false,
            log: pino({ level: 'silent' }),
        });

        expect(summary.actionsUpserted).toBe(1);
        expect(summary.actionsDeleted).toBe(1);

        const actionRows = await db.select().from(actions);
        expect(actionRows.map((a) => a.name)).toEqual(['transfer']);

        const chunkRows = await db.select().from(actionChunks);
        expect(chunkRows.length).toBe(2); // only transfer's chunks remain
    }, 60_000);
});
