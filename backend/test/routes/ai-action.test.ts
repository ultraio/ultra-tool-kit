import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
    actionChunks,
    actions,
    chatMessages,
    chatSessions,
    contracts,
    incidents,
    usageLog,
} from '../../src/db/schema.js';
import * as schema from '../../src/db/schema.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import type { ActionRules } from '../../src/extractor/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '..', '..', 'drizzle');

const DIM = 768;

function unitVector(idx: number): number[] {
    const v = new Array<number>(DIM).fill(0);
    v[idx] = 1;
    return v;
}

const TRANSFER_VECTOR = unitVector(0);
const ADMIN_VECTOR = unitVector(2);
const FALLBACK_VECTOR = unitVector(0);

// ----- Stubs -----------------------------------------------------------------

class EmbedStub implements ChatProvider {
    constructor(public vector: number[] = FALLBACK_VECTOR) {}
    chat(): Promise<ChatResponse> {
        return Promise.reject(new Error('embed stub: chat not implemented'));
    }
    async embed(): Promise<{ vector: number[]; usage: { input: number } }> {
        return { vector: this.vector, usage: { input: 1 } };
    }
    modelTag(): string {
        return 'stub:embed-768';
    }
    vectorDim(): 768 {
        return 768;
    }
}

class ConfigurableChatStub implements ChatProvider {
    public next: ChatResponse = { json: { kind: 'refuse', reason: 'unset' }, usage: { input: 0, output: 0 } };
    public queue: ChatResponse[] = [];
    public callCount = 0;
    constructor(public readonly tag: string) {}
    async chat(_req: ChatRequest): Promise<ChatResponse> {
        this.callCount += 1;
        const queued = this.queue.shift();
        return queued ?? this.next;
    }
    embed(): Promise<{ vector: number[]; usage: { input: number } }> {
        return Promise.reject(new Error(`${this.tag}: embed not implemented`));
    }
    modelTag(): string {
        return this.tag;
    }
    vectorDim(): 768 {
        return 768;
    }
}

const embedStub = new EmbedStub();
const classifierStub = new ConfigurableChatStub('stub:classifier');
const chatStub = new ConfigurableChatStub('stub:chat');

vi.mock('../../src/llm/router.js', () => {
    return {
        getProvider(role: 'chat' | 'embed' | 'classifier'): ChatProvider {
            if (role === 'embed') return embedStub;
            if (role === 'classifier') return classifierStub;
            return chatStub;
        },
        getRouter() {
            return { chat: chatStub, embed: embedStub, classifier: classifierStub };
        },
        resetRouterCache() {
            /* no-op for the mock */
        },
    };
});

// ----- Action seeds ----------------------------------------------------------

const transferRules: ActionRules = {
    contract: 'eosio.token',
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
    recipients: [],
    source: { path: 'src/eosio.token.cpp', lines: [10, 30] },
};

const adminRules: ActionRules = {
    contract: 'eosio.token',
    action: 'create',
    params: [{ name: 'issuer', type: 'name' }],
    auths: [{ actor: 'eosio.token', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/eosio.token.cpp', lines: [70, 90] },
};

// ----- Helpers ---------------------------------------------------------------

function makeBody(overrides?: { messages?: Array<{ role: 'user' | 'assistant'; content: string }>; isAdmin?: boolean; sessionId?: string }) {
    return {
        sessionId: overrides?.sessionId ?? randomUUID(),
        messages: overrides?.messages ?? [{ role: 'user' as const, content: 'transfer 100 UOS from acc1 to acc2' }],
        context: {
            account: 'acc1',
            permission: 'active',
            endpoint: 'https://example.com',
            chainId: 'fakechain',
            isAdmin: overrides?.isAdmin ?? false,
            knownAccounts: ['acc1', 'acc2'],
        },
    };
}

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

// ----- Suite -----------------------------------------------------------------

describe('POST /api/ai-action (integration)', () => {
    let container: StartedPostgreSqlContainer;
    let pgSql: Sql;
    let db: PostgresJsDatabase<typeof schema>;
    let app: Awaited<ReturnType<typeof loadApp>>;

    async function loadApp() {
        // Import after env + mocks are configured.
        const mod = await import('../../src/app.js');
        return mod.createApp();
    }

    async function truncateAll() {
        await db.execute(sql`truncate table chat_messages, usage_log, incidents, chat_sessions restart identity cascade`);
    }

    beforeAll(async () => {
        container = await new PostgreSqlContainer('pgvector/pgvector:pg17')
            .withDatabase('ai_action_test')
            .withUsername('postgres')
            .withPassword('postgres')
            .start();
        process.env.DATABASE_URL = container.getConnectionUri();
        process.env.LOG_LEVEL = 'silent';
        // Generous limits so most tests don't trip rate limiting.
        process.env.RATE_PER_MINUTE = '100';
        process.env.RATE_PER_HOUR = '1000';
        process.env.RATE_TURNS_PER_DAY = '1000';
        process.env.RATE_DAILY_COST_USD = '100';
        process.env.ALLOWED_ORIGINS = 'http://localhost:5172';

        pgSql = postgres(container.getConnectionUri(), { prepare: false });
        db = drizzle(pgSql, { schema });
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

        // Seed contract + actions
        const [contract] = await db
            .insert(contracts)
            .values({ account: 'eosio.token' })
            .returning({ id: contracts.id });
        const contractId = contract!.id;

        const transferIns = await db
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
        const adminIns = await db
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
                actionId: transferIns[0]!.id,
                kind: 'rules',
                text: 'transfer rules',
                embedding768: TRANSFER_VECTOR,
                embedding1536: null,
            },
            {
                actionId: transferIns[0]!.id,
                kind: 'summary',
                text: 'transfer summary',
                embedding768: TRANSFER_VECTOR,
                embedding1536: null,
            },
            {
                actionId: adminIns[0]!.id,
                kind: 'rules',
                text: 'create rules',
                embedding768: ADMIN_VECTOR,
                embedding1536: null,
            },
        ]);

        app = await loadApp();
    }, 180_000);

    afterAll(async () => {
        await pgSql.end({ timeout: 5 });
        await container.stop();
    });

    beforeEach(async () => {
        await truncateAll();
        const { __resetRateLimitState } = await import('../../src/middleware/ratelimit.js');
        __resetRateLimitState();
        // Reset stubs.
        embedStub.vector = TRANSFER_VECTOR;
        classifierStub.next = {
            json: { label: 'ON_TOPIC' },
            usage: { input: 10, output: 1 },
        };
        classifierStub.callCount = 0;
        chatStub.next = { json: { kind: 'refuse', reason: 'unset' }, usage: { input: 0, output: 0 } };
        chatStub.queue = [];
        chatStub.callCount = 0;
    });

    async function postBody(body: unknown): Promise<{ status: number; body: any }> {
        const res = await app.request('/api/ai-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let parsed: unknown = null;
        try {
            parsed = JSON.parse(text);
        } catch {
            parsed = text;
        }
        return { status: res.status, body: parsed };
    }

    it('happy path: returns a propose and writes user/assistant + classify/chat usage rows', async () => {
        embedStub.vector = TRANSFER_VECTOR;
        chatStub.next = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'transfer',
                data: { from: 'acc1', to: 'acc2', quantity: '100.00000000 UOS', memo: 'thanks' },
                authorization: { actor: 'acc1', permission: 'active' },
                rationale: 'User asked to send tokens.',
            },
            usage: { input: 50, output: 30 },
        };

        const sessionId = randomUUID();
        const { status, body } = await postBody(makeBody({ sessionId }));
        expect(status).toBe(200);
        expect(body.kind).toBe('propose');
        expect(body.contract).toBe('eosio.token');
        expect(body.action).toBe('transfer');
        expect(body.data.from).toBe('acc1');
        expect(body.data.to).toBe('acc2');

        const msgs = await db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.sessionId, sessionId));
        expect(msgs.length).toBe(2);
        const roles = msgs.map((m) => m.role).sort();
        expect(roles).toEqual(['assistant', 'user']);

        const usage = await db.select().from(usageLog).where(eq(usageLog.userId, TEST_USER_ID));
        expect(usage.length).toBe(2);
        const kinds = usage.map((u) => u.requestKind).sort();
        expect(kinds).toEqual(['chat', 'classify']);

        expect(chatStub.callCount).toBe(1);
    }, 60_000);

    it('off-topic short-circuit: no chat call, no retrieval, off-topic incident', async () => {
        classifierStub.next = { json: { label: 'OFF_TOPIC' }, usage: { input: 8, output: 1 } };

        const { status, body } = await postBody(
            makeBody({ messages: [{ role: 'user', content: 'tell me a joke' }] })
        );
        expect(status).toBe(200);
        expect(body.kind).toBe('refuse');
        expect(body.reason).toBe('off-topic');

        expect(chatStub.callCount).toBe(0);

        const usage = await db.select().from(usageLog);
        expect(usage.length).toBe(1);
        expect(usage[0]!.requestKind).toBe('classify');

        const inc = await db.select().from(incidents).where(eq(incidents.kind, 'off-topic'));
        expect(inc.length).toBe(1);
    }, 60_000);

    it('missing-field downgrade: validate.ts returns kind=ask + schema-fail incident', async () => {
        chatStub.next = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'transfer',
                // 'from' missing entirely
                data: { to: 'acc2', quantity: '100.00000000 UOS', memo: '', from: '' },
                authorization: { actor: 'acc1', permission: 'active' },
                rationale: 'incomplete',
            },
            usage: { input: 50, output: 30 },
        };

        const { status, body } = await postBody(makeBody());
        expect(status).toBe(200);
        expect(body.kind).toBe('ask');
        expect(body.question).toMatch(/from/);

        const inc = await db.select().from(incidents).where(eq(incidents.kind, 'schema-fail'));
        expect(inc.length).toBeGreaterThanOrEqual(1);
    }, 60_000);

    it('retry: recovers a propose when the first pass had a non-coercible shape error', async () => {
        // Small local models (qwen2.5:7b/14b) occasionally emit objects in
        // primitive slots — e.g. quantity = {actor, permission} from an attention
        // failure. The validator can't coerce that, so it downgrades to `ask`;
        // we retry once with a stricter system coda and accept the second pass
        // if it's clean.
        const bad = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'transfer',
                data: {
                    from: 'acc1',
                    to: 'acc2',
                    quantity: { actor: 'acc1', permission: 'active' },
                    memo: '',
                },
                authorization: { actor: 'acc1', permission: 'active' },
                rationale: 'first pass',
            },
            usage: { input: 50, output: 30 },
        };
        const good = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'transfer',
                data: { from: 'acc1', to: 'acc2', quantity: '100.00000000 UOS', memo: '' },
                authorization: { actor: 'acc1', permission: 'active' },
                rationale: 'second pass',
            },
            usage: { input: 60, output: 30 },
        };
        chatStub.queue = [bad, good];

        const { status, body } = await postBody(makeBody());
        expect(status).toBe(200);
        expect(body.kind).toBe('propose');
        expect(body.data.quantity).toBe('100.00000000 UOS');
        expect(chatStub.callCount).toBe(2);

        // Both chat passes get cost-logged.
        const usage = await db.select().from(usageLog).where(eq(usageLog.userId, TEST_USER_ID));
        const chatRows = usage.filter((u) => u.requestKind === 'chat');
        expect(chatRows.length).toBe(2);
    }, 60_000);

    it('retry: does not fire when first pass already returns a clean propose', async () => {
        chatStub.next = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'transfer',
                data: { from: 'acc1', to: 'acc2', quantity: '100.00000000 UOS', memo: '' },
                authorization: { actor: 'acc1', permission: 'active' },
                rationale: 'clean first pass',
            },
            usage: { input: 50, output: 30 },
        };

        const { status, body } = await postBody(makeBody());
        expect(status).toBe(200);
        expect(body.kind).toBe('propose');
        expect(chatStub.callCount).toBe(1);
    }, 60_000);

    it('admin-action: any user (admin or not) can get a propose; the wallet/chain is the gate', async () => {
        // The backend no longer pre-filters by is_admin. The wallet (no key)
        // and the chain (rejects unauthorized sigs) enforce signing privileges,
        // so this layer just translates intent → JSON and lets the user decide.
        embedStub.vector = ADMIN_VECTOR;
        chatStub.next = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'create',
                data: { issuer: 'acc1' },
                authorization: { actor: 'eosio.token', permission: 'active' },
                rationale: 'admin op',
            },
            usage: { input: 30, output: 20 },
        };
        for (const isAdmin of [false, true]) {
            const { status, body } = await postBody(
                makeBody({ messages: [{ role: 'user', content: 'create a new token' }], isAdmin })
            );
            expect(status).toBe(200);
            expect(body.kind).toBe('propose');
            expect(body.action).toBe('create');
        }
    }, 60_000);

    it('rate-limit refusal: 7th request in a row returns refuse with HTTP 200 and no chat call', async () => {
        const prior = process.env.RATE_PER_MINUTE;
        process.env.RATE_PER_MINUTE = '6';
        const { __resetRateLimitState } = await import('../../src/middleware/ratelimit.js');
        __resetRateLimitState();

        try {
            chatStub.next = {
                json: {
                    kind: 'propose',
                    contract: 'eosio.token',
                    action: 'transfer',
                    data: { from: 'acc1', to: 'acc2', quantity: '100.00000000 UOS', memo: 'thanks' },
                    authorization: { actor: 'acc1', permission: 'active' },
                    rationale: 'ok',
                },
                usage: { input: 50, output: 30 },
            };

            const before = chatStub.callCount;
            for (let i = 0; i < 6; i += 1) {
                const r = await postBody(makeBody({ sessionId: randomUUID() }));
                expect(r.status).toBe(200);
            }
            const callsAfterSix = chatStub.callCount;
            expect(callsAfterSix - before).toBe(6);

            const seventh = await postBody(makeBody({ sessionId: randomUUID() }));
            expect(seventh.status).toBe(200);
            expect(seventh.body.kind).toBe('refuse');
            expect(seventh.body.reason).toBe('rate-limit');
            expect(chatStub.callCount).toBe(callsAfterSix);

            const inc = await db.select().from(incidents).where(eq(incidents.kind, 'rate-limit'));
            expect(inc.length).toBeGreaterThanOrEqual(1);
        } finally {
            if (prior === undefined) delete process.env.RATE_PER_MINUTE;
            else process.env.RATE_PER_MINUTE = prior;
            __resetRateLimitState();
        }
    }, 60_000);

    it('invalid request body returns 400 refuse', async () => {
        const res = await app.request('/api/ai-action', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ junk: true }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { kind: string; reason: string };
        expect(body.kind).toBe('refuse');
        expect(body.reason).toBe('invalid-request');
    }, 30_000);

    it('seeds chat_sessions row on first request', async () => {
        chatStub.next = {
            json: {
                kind: 'propose',
                contract: 'eosio.token',
                action: 'transfer',
                data: { from: 'acc1', to: 'acc2', quantity: '100.00000000 UOS', memo: 'thanks' },
                authorization: { actor: 'acc1', permission: 'active' },
                rationale: 'ok',
            },
            usage: { input: 50, output: 30 },
        };
        const sessionId = randomUUID();
        await postBody(makeBody({ sessionId }));
        const sess = await db
            .select()
            .from(chatSessions)
            .where(eq(chatSessions.id, sessionId));
        expect(sess.length).toBe(1);
        expect(sess[0]!.account).toBe('acc1');
    }, 60_000);
});
