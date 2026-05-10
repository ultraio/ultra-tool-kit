import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { actionChunks, actions, contracts } from '../../src/db/schema.js';
import * as schema from '../../src/db/schema.js';
import { retrieveActions } from '../../src/pipeline/retrieve.js';
import type { ChatProvider } from '../../src/llm/provider.js';
import type { ActionRules } from '../../src/extractor/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '..', '..', 'drizzle');

const DIM = 768;

function unitVector(idx: number): number[] {
    const v = new Array<number>(DIM).fill(0);
    v[idx] = 1;
    return v;
}

class FixedEmbedProvider implements ChatProvider {
    constructor(private readonly vector: number[]) {}
    chat(): Promise<never> {
        return Promise.reject(new Error('chat not used'));
    }
    async embed(): Promise<{ vector: number[]; usage: { input: number } }> {
        return { vector: this.vector, usage: { input: 0 } };
    }
    modelTag(): string {
        return 'stub:embed-768';
    }
    vectorDim(): 768 {
        return 768;
    }
}

const transferRules: ActionRules = {
    contract: 'test.tok',
    action: 'transfer',
    params: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
    ],
    auths: [{ actor: '$from', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/test.tok.cpp', lines: [10, 30] },
};

const issueRules: ActionRules = {
    contract: 'test.tok',
    action: 'issue',
    params: [
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
    ],
    auths: [{ actor: '$issuer', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/test.tok.cpp', lines: [40, 60] },
};

const adminRules: ActionRules = {
    contract: 'test.tok',
    action: 'create',
    params: [{ name: 'issuer', type: 'name' }],
    auths: [{ actor: 'eosio.token', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/test.tok.cpp', lines: [70, 90] },
};

describe('retrieveActions (against pgvector pg17)', () => {
    let container: StartedPostgreSqlContainer;
    let sql: Sql;
    let db: PostgresJsDatabase<typeof schema>;

    beforeAll(async () => {
        container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
            .withDatabase('retrieve_test')
            .withUsername('postgres')
            .withPassword('postgres')
            .start();
        sql = postgres(container.getConnectionUri(), { prepare: false });
        db = drizzle(sql, { schema });
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

        const [contract] = await db
            .insert(contracts)
            .values({ account: 'test.tok' })
            .returning({ id: contracts.id });
        const contractId = contract!.id;

        const transferAction = await db
            .insert(actions)
            .values({
                contractId,
                name: 'transfer',
                fields: transferRules.params,
                rules: transferRules,
                defaultAuth: transferRules.auths[0],
                isAdmin: false,
                unresolved: false,
            })
            .returning({ id: actions.id });
        const issueAction = await db
            .insert(actions)
            .values({
                contractId,
                name: 'issue',
                fields: issueRules.params,
                rules: issueRules,
                defaultAuth: issueRules.auths[0],
                isAdmin: false,
                unresolved: false,
            })
            .returning({ id: actions.id });
        const adminAction = await db
            .insert(actions)
            .values({
                contractId,
                name: 'create',
                fields: adminRules.params,
                rules: adminRules,
                defaultAuth: adminRules.auths[0],
                isAdmin: true,
                unresolved: false,
            })
            .returning({ id: actions.id });

        await db.insert(actionChunks).values([
            {
                actionId: transferAction[0]!.id,
                kind: 'rules',
                text: 'transfer rules',
                embedding768: unitVector(0),
                embedding1536: null,
            },
            {
                actionId: transferAction[0]!.id,
                kind: 'summary',
                text: 'transfer summary',
                embedding768: unitVector(0),
                embedding1536: null,
            },
            {
                actionId: issueAction[0]!.id,
                kind: 'rules',
                text: 'issue rules',
                embedding768: unitVector(1),
                embedding1536: null,
            },
            {
                actionId: adminAction[0]!.id,
                kind: 'rules',
                text: 'create rules',
                embedding768: unitVector(2),
                embedding1536: null,
            },
        ]);
    }, 120_000);

    afterAll(async () => {
        await sql.end({ timeout: 5 });
        await container.stop();
    });

    it('ranks transfer top-1 when query vector aligns with transfer chunks', async () => {
        const provider = new FixedEmbedProvider(unitVector(0));
        const results = await retrieveActions('send tokens', { isAdmin: false }, { db, provider });
        expect(results.length).toBeGreaterThanOrEqual(1);
        expect(results[0]?.contract).toBe('test.tok');
        expect(results[0]?.action).toBe('transfer');
        expect(results[0]!.bestDistance).toBeLessThan(results[1]!.bestDistance);
    }, 60_000);

    it('returns admin actions regardless of isAdmin (wallet/chain is the gate)', async () => {
        const provider = new FixedEmbedProvider(unitVector(2));
        const nonAdmin = await retrieveActions('create token', { isAdmin: false }, { db, provider });
        const asAdmin = await retrieveActions('create token', { isAdmin: true }, { db, provider });
        expect(nonAdmin.find((r) => r.action === 'create')).toBeDefined();
        expect(asAdmin.find((r) => r.action === 'create')).toBeDefined();
    }, 60_000);
});
