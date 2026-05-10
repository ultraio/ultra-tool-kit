// Layer-5 deterministic validation of LLM proposals.
// Source of truth: docs/03-guardrails.md §2 Layer 5 + docs/01-architecture.md §6.

import type { Logger } from 'pino';
import type { Db } from '../db/client.js';
import { incidents } from '../db/schema.js';
import { loadEosioTypes, type EosioTypesFile } from '../extractor/eosio-types.js';
import { proposalSchema, type PromptContext } from './prompt.js';
import type { RetrievedAction } from './retrieve.js';

export type ValidatedReply =
    | { kind: 'ask'; question: string }
    | {
          kind: 'propose';
          contract: string;
          action: string;
          data: Record<string, unknown>;
          authorization: { actor: string; permission: string };
          rationale: string;
      }
    | { kind: 'refuse'; reason: string };

export type ValidationDeps = {
    db?: Db;
    log?: Logger;
};

type IncidentKind = 'schema-fail' | 'admin-blocked' | 'output-blocked';

const REGEX_TYPES = new Set([
    'name',
    'account_name',
    'permission_name',
    'asset',
    'symbol',
    'symbol_code',
    'checksum256',
    'bytes',
]);

const URL_RE = /https?:\/\/\S+/gi;
const CODE_FENCE_RE = /```/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const JAILBREAK_RE = /(here'?s how to bypass|ignore previous instructions)/gi;

function cleanText(input: string): { cleaned: string; stripped: boolean } {
    let out = input;
    out = out.replace(MD_IMAGE_RE, '');
    out = out.replace(URL_RE, '');
    out = out.replace(CODE_FENCE_RE, '');
    out = out.replace(JAILBREAK_RE, '');
    const stripped = out !== input;
    return { cleaned: out.trim(), stripped };
}

async function logIncident(
    deps: ValidationDeps | undefined,
    kind: IncidentKind,
    detail: Record<string, unknown>,
    userId: string | null
): Promise<void> {
    const db = deps?.db;
    if (!db) return;
    // Incidents are best-effort observability — never let a failed audit-log
    // write break the user's chat reply.
    try {
        await db.insert(incidents).values({
            userId,
            kind,
            detail,
        });
    } catch (err) {
        deps?.log?.warn({ err: (err as Error).message, kind }, '[validate] failed to record incident');
    }
}

function findMatchingAction(retrieved: RetrievedAction[], contract: string, action: string): RetrievedAction | null {
    return retrieved.find((r) => r.contract === contract && r.action === action) ?? null;
}

function refuse(reason: string): ValidatedReply {
    return { kind: 'refuse', reason };
}

function askMissingField(fieldName: string): ValidatedReply {
    return { kind: 'ask', question: `What is the ${fieldName}?` };
}

function regexForType(types: EosioTypesFile, typeName: string): RegExp | null {
    const base = typeName.replace(/\?$|\[\]$/, '');
    if (!REGEX_TYPES.has(base)) return null;
    const rules = types[base];
    if (!rules?.pattern) return null;
    try {
        return new RegExp(rules.pattern);
    } catch {
        return null;
    }
}

export async function validateProposal(
    args: {
        raw: unknown;
        retrieved: RetrievedAction[];
        context: PromptContext;
        userId: string | null;
        sessionId: string | null;
    },
    deps?: ValidationDeps
): Promise<ValidatedReply> {
    const { raw, retrieved, context, userId } = args;

    // 1. Schema parse.
    const parsed = proposalSchema.safeParse(raw);
    if (!parsed.success) {
        await logIncident(deps, 'schema-fail', { reason: 'zod-parse', issues: parsed.error.issues }, userId);
        return refuse('I could not build a confident proposal — please rephrase.');
    }

    const reply = parsed.data;

    if (reply.kind === 'ask') {
        const { cleaned, stripped } = cleanText(reply.question);
        if (stripped) await logIncident(deps, 'output-blocked', { field: 'question' }, userId);
        return { kind: 'ask', question: cleaned };
    }

    if (reply.kind === 'refuse') {
        const { cleaned, stripped } = cleanText(reply.reason);
        if (stripped) await logIncident(deps, 'output-blocked', { field: 'reason' }, userId);
        return { kind: 'refuse', reason: cleaned };
    }

    // 3a. Catalog membership.
    const matched = findMatchingAction(retrieved, reply.contract, reply.action);
    if (!matched) {
        await logIncident(
            deps,
            'schema-fail',
            {
                reason: 'catalog-membership',
                contract: reply.contract,
                action: reply.action,
                retrievedKeys: retrieved.map((r) => `${r.contract}::${r.action}`),
            },
            userId
        );
        return refuse('I could not build a confident proposal — please rephrase.');
    }

    // 3b. Admin gate.
    if (matched.isAdmin && !context.isAdmin) {
        await logIncident(
            deps,
            'admin-blocked',
            { contract: reply.contract, action: reply.action },
            userId
        );
        return refuse('That action requires elevated permissions on this account.');
    }

    // 3c. Field-key whitelist.
    const knownFields = new Set(matched.fields.map((f) => f.name));
    const dataKeys = Object.keys(reply.data);
    const unknownKeys = dataKeys.filter((k) => !knownFields.has(k));
    if (unknownKeys.length > 0) {
        await logIncident(
            deps,
            'schema-fail',
            { reason: 'unknown-data-keys', unknownKeys, contract: reply.contract, action: reply.action },
            userId
        );
        return refuse('I could not build a confident proposal — please rephrase.');
    }

    // 3d. Required-field check (all fields required in Phase 1).
    for (const field of matched.fields) {
        const value = reply.data[field.name];
        if (value === undefined || value === null || (typeof value === 'string' && value === '')) {
            await logIncident(
                deps,
                'schema-fail',
                { reason: 'missing-field', field: field.name, contract: reply.contract, action: reply.action },
                userId
            );
            return askMissingField(field.name);
        }
    }

    // 3e. Format regex per field type.
    const types = await loadEosioTypes();
    for (const field of matched.fields) {
        const re = regexForType(types, field.type);
        if (!re) continue;
        const value = reply.data[field.name];
        const asString = typeof value === 'string' ? value : String(value);
        if (!re.test(asString)) {
            await logIncident(
                deps,
                'schema-fail',
                {
                    reason: 'regex-fail',
                    field: field.name,
                    type: field.type,
                    value: asString,
                    contract: reply.contract,
                    action: reply.action,
                },
                userId
            );
            return askMissingField(field.name);
        }
    }

    // 3f. Rationale clean-up.
    const { cleaned: cleanedRationale, stripped } = cleanText(reply.rationale);
    if (stripped) await logIncident(deps, 'output-blocked', { field: 'rationale' }, userId);

    return {
        kind: 'propose',
        contract: reply.contract,
        action: reply.action,
        data: reply.data,
        authorization: reply.authorization,
        rationale: cleanedRationale,
    };
}
