// pgvector top-K retrieval — see docs/01-architecture.md §3.2 step 5.

import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { getDb, type Db } from '../db/client.js';
import { getProvider } from '../llm/router.js';
import type { ChatProvider } from '../llm/provider.js';
import type { ActionRules, AuthRef } from '../extractor/types.js';

export type RetrieveDeps = {
    db?: Db;
    provider?: ChatProvider;
    log?: Logger;
};

export type RetrievedAction = {
    actionId: bigint;
    contract: string;
    action: string;
    rules: ActionRules;
    fields: Array<{ name: string; type: string }>;
    defaultAuth: AuthRef | null;
    isAdmin: boolean;
    description: string | null;
    examples: string[] | null;
    bestDistance: number;
};

type RetrieveRow = {
    id: string | bigint;
    account: string;
    name: string;
    fields: unknown;
    rules: unknown;
    default_auth: unknown;
    is_admin: boolean;
    description: string | null;
    examples: unknown;
    distance: number | string;
};

function toBigInt(v: string | bigint): bigint {
    return typeof v === 'bigint' ? v : BigInt(v);
}

function toFields(v: unknown): Array<{ name: string; type: string }> {
    if (!Array.isArray(v)) return [];
    return v.filter(
        (x): x is { name: string; type: string } =>
            typeof x === 'object' && x !== null && typeof (x as { name?: unknown }).name === 'string' && typeof (x as { type?: unknown }).type === 'string'
    );
}

function toAuthRef(v: unknown): AuthRef | null {
    if (!v || typeof v !== 'object') return null;
    const obj = v as { actor?: unknown; permission?: unknown };
    if (typeof obj.actor !== 'string' || typeof obj.permission !== 'string') return null;
    return { actor: obj.actor, permission: obj.permission };
}

function toExamples(v: unknown): string[] | null {
    if (!Array.isArray(v)) return null;
    return v.filter((x): x is string => typeof x === 'string');
}

function toVectorLiteral(v: number[]): string {
    return `[${v.join(',')}]`;
}

// Over-fetch raw chunks then dedupe by action_id (one action can have multiple
// chunks — rules + summary), so we keep enough headroom to still return TOP_K
// distinct actions after collapsing duplicates.
const RAW_FETCH_LIMIT = 12;
const TOP_K = 6;

export async function retrieveActions(
    query: string,
    ctx: { isAdmin: boolean },
    deps?: RetrieveDeps
): Promise<RetrievedAction[]> {
    const db = deps?.db ?? getDb();
    const provider = deps?.provider ?? getProvider('embed');

    let queryVector: number[];
    try {
        const res = await provider.embed(query);
        queryVector = res.vector;
    } catch (err) {
        // Provider error — caller decides whether to refuse.
        deps?.log?.warn(
            { err: err instanceof Error ? err.message : String(err) },
            '[retrieve] embedding failed; returning empty result'
        );
        return [];
    }

    const column = provider.vectorDim() === 768 ? 'embedding_768' : 'embedding_1536';
    const vecLiteral = toVectorLiteral(queryVector);
    const colExpr = sql.raw(`ch.${column}`);
    const adminFilter = ctx.isAdmin ? sql`` : sql`and a.is_admin = false`;

    const rows = (await db.execute(sql`
        select distinct on (a.id)
          a.id as id,
          c.account as account,
          a.name as name,
          a.fields as fields,
          a.rules as rules,
          a.default_auth as default_auth,
          a.is_admin as is_admin,
          a.description as description,
          a.examples as examples,
          ${colExpr} <=> ${vecLiteral}::vector as distance
        from action_chunks ch
        join actions a on a.id = ch.action_id
        join contracts c on c.id = a.contract_id
        where a.unresolved = false
          ${adminFilter}
          and ${colExpr} is not null
        order by a.id, distance
        limit ${sql.raw(String(RAW_FETCH_LIMIT))}
    `)) as unknown as RetrieveRow[];

    const hydrated: RetrievedAction[] = rows.map((r) => ({
        actionId: toBigInt(r.id),
        contract: r.account,
        action: r.name,
        rules: r.rules as ActionRules,
        fields: toFields(r.fields),
        defaultAuth: toAuthRef(r.default_auth),
        isAdmin: r.is_admin,
        description: r.description,
        examples: toExamples(r.examples),
        bestDistance: typeof r.distance === 'string' ? Number(r.distance) : r.distance,
    }));

    hydrated.sort((a, b) => a.bestDistance - b.bestDistance);
    return hydrated.slice(0, TOP_K);
}
