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

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value)?.slice(0, 200) ?? String(value);
    } catch {
        return String(value);
    }
}

const NAME_TYPES = new Set(['name', 'account_name', 'permission_name']);

// Pragmatic adapter for the LLM's most common structured-output mistakes.
// Each branch unwraps a known-bad shape into the canonical primitive that
// matches the eosio-types regex. If nothing matches, returns `value` as-is
// and the regex check will downgrade to `ask` on the next line.
function coerceLlmShape(value: unknown, type: string, fieldName: string): unknown {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const obj = value as Record<string, unknown>;

    if (NAME_TYPES.has(type)) {
        // Auth-shape leak: `{actor, permission}` placed on a name field.
        if (typeof obj.actor === 'string') return obj.actor;
        // Common EOSIO `{name: "..."}` / `{account: "..."}` envelopes.
        if (typeof obj.name === 'string') return obj.name;
        if (typeof obj.account === 'string') return obj.account;
        // Self-referential nesting: `from: {from: "acc1"}`.
        if (typeof obj[fieldName] === 'string') return obj[fieldName];
        // Angle-bracket placeholder leak: `from: {"<from>": "acc1"}`.
        const angleKey = `<${fieldName}>`;
        if (typeof obj[angleKey] === 'string') return obj[angleKey];
        // Fall through to single-key-string fallback below.
    }

    if (type === 'string') {
        // Empty object → empty string (model says "I don't have a value here").
        if (Object.keys(obj).length === 0) return '';
        // `{value: "..."}` envelope.
        if (typeof obj.value === 'string') return obj.value;
        // Fall through to single-key-string fallback below.
    }

    if (type === 'symbol') {
        // Decomposed `{precision: 8, code: "UOS"}` → "8,UOS"
        if (typeof obj.precision === 'number') {
            if (typeof obj.code === 'string') return `${obj.precision},${obj.code}`;
            if (typeof obj.symbol === 'string') return `${obj.precision},${obj.symbol}`;
        }
    }

    if (type === 'asset') {
        // Structured decomposition: `{amount: 100, precision: 8, symbol: "UOS"}`.
        if (
            typeof obj.amount === 'number' &&
            typeof obj.precision === 'number' &&
            typeof obj.symbol === 'string'
        ) {
            return `${obj.amount.toFixed(obj.precision)} ${obj.symbol}`;
        }
        // String amount + symbol.
        if (typeof obj.amount === 'string' && typeof obj.symbol === 'string') {
            return `${obj.amount} ${obj.symbol}`;
        }
        // extended_asset envelope: `{quantity: "100.0 UOS", contract: "..."}`.
        if (typeof obj.quantity === 'string') return obj.quantity;
    }

    // Last-resort: many models wrap the canonical value in a single-key envelope
    // like `{string: "..."}`, `{asset: "..."}`, `{type-name: "..."}`. If the only
    // key holds a string, unwrap it and let the regex check decide.
    const keys = Object.keys(obj);
    if (keys.length === 1) {
        const onlyKey = keys[0];
        if (onlyKey !== undefined) {
            const only = obj[onlyKey];
            if (typeof only === 'string') return only;
        }
    }

    return value;
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

    // 3b. (Removed) Admin gate. The wallet/chain enforces signing privileges; we
    // don't pre-filter admin actions here. `matched.isAdmin` and `context.isAdmin`
    // are still surfaced for analytics / future advisory rationale.

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

    // 3d. Coerce common LLM shape errors (auth-leak, structured asset, self-nest, etc.)
    // up front so subsequent checks see the canonical primitive value.
    for (const field of matched.fields) {
        const original = reply.data[field.name];
        const coerced = coerceLlmShape(original, field.type, field.name);
        if (coerced !== original) reply.data[field.name] = coerced;
    }

    // 3e. Required-field check (all fields required in Phase 1, except `string`-typed
    // fields where empty is semantically meaningful — e.g. empty memo on a transfer).
    for (const field of matched.fields) {
        const value = reply.data[field.name];
        const isMissing =
            value === undefined ||
            value === null ||
            (typeof value === 'string' && value === '' && field.type !== 'string');
        if (isMissing) {
            await logIncident(
                deps,
                'schema-fail',
                { reason: 'missing-field', field: field.name, contract: reply.contract, action: reply.action },
                userId
            );
            return askMissingField(field.name);
        }
    }

    // 3f. Format regex per field type.
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
                    valueShape: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
                    rawValue: safeJson(value),
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
