import { sql } from 'drizzle-orm';
import {
    bigint,
    bigserial,
    boolean,
    check,
    integer,
    jsonb,
    numeric,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    vector,
} from 'drizzle-orm/pg-core';

export const contracts = pgTable('contracts', {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    account: text('account').notNull().unique(),
    displayName: text('display_name'),
    sourceRepo: text('source_repo'),
    description: text('description'),
    abiHash: text('abi_hash'),
    abiFetchedAt: timestamp('abi_fetched_at', { withTimezone: true }),
    abiChainId: text('abi_chain_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const actions = pgTable(
    'actions',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        contractId: bigint('contract_id', { mode: 'bigint' })
            .references(() => contracts.id, { onDelete: 'cascade' })
            .notNull(),
        name: text('name').notNull(),
        fields: jsonb('fields').notNull(),
        rules: jsonb('rules').notNull(),
        defaultAuth: jsonb('default_auth'),
        isAdmin: boolean('is_admin').default(false).notNull(),
        description: text('description'),
        examples: jsonb('examples'),
        sourceRef: text('source_ref'),
        unresolved: boolean('unresolved').default(false).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => [uniqueIndex('actions_contract_name_uq').on(t.contractId, t.name)]
);

export const actionChunks = pgTable(
    'action_chunks',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        actionId: bigint('action_id', { mode: 'bigint' })
            .references(() => actions.id, { onDelete: 'cascade' })
            .notNull(),
        kind: text('kind').notNull(),
        text: text('text').notNull(),
        embedding768: vector('embedding_768', { dimensions: 768 }),
        embedding1536: vector('embedding_1536', { dimensions: 1536 }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => [check('action_chunks_kind_chk', sql`${t.kind} in ('summary', 'rules', 'example')`)]
);

export const chatSessions = pgTable('chat_sessions', {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id'),
    account: text('account'),
    endpoint: text('endpoint'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
});

export const chatMessages = pgTable(
    'chat_messages',
    {
        id: bigserial('id', { mode: 'bigint' }).primaryKey(),
        sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'cascade' }),
        role: text('role').notNull(),
        content: jsonb('content'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (t) => [check('chat_messages_role_chk', sql`${t.role} in ('user', 'assistant', 'system')`)]
);

export const usageLog = pgTable('usage_log', {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sessionId: uuid('session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
    userId: uuid('user_id'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cacheRead: integer('cache_read').default(0).notNull(),
    cacheWrite: integer('cache_write').default(0).notNull(),
    costUsd: numeric('cost_usd', { precision: 12, scale: 8 }),
    requestKind: text('request_kind'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const incidents = pgTable('incidents', {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id'),
    kind: text('kind'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Contract = typeof contracts.$inferSelect;
export type NewContract = typeof contracts.$inferInsert;
export type Action = typeof actions.$inferSelect;
export type NewAction = typeof actions.$inferInsert;
export type ActionChunk = typeof actionChunks.$inferSelect;
export type NewActionChunk = typeof actionChunks.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type UsageLogRow = typeof usageLog.$inferSelect;
export type Incident = typeof incidents.$inferSelect;
