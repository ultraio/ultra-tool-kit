// Output validator — the §4.3 citation gate.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.3 (the SIX gates) plus
// §4.4 ("the AI never lists accounts the user did not mention" — gate 5
// mirrors that). Roadmap §6 row W3 acceptance. backend/CLAUDE.md hard
// rules 3 + 8.
//
// What's in this file:
//   - Reply Zod union covering all five reply kinds.
//   - cleanText + coerceLlmShape (W0 carry-over). Every branch fixes a real
//     observed small-model output drift and is load-bearing per the W3
//     simplifier exclusion list.
//   - loadEosioTypes(): boot-time read of catalog/eosio-types.json into the
//     regex table the field-shape gate consults.
//   - validateInnerAction(): gates 2–6 on a single action — used by both
//     validateAct (W3) and validatePropose (W6, called once per inner action).
//   - validateAct(): delegates to validateInnerAction for an act reply.
//   - validatePropose() (W6): runs validateInnerAction on every inner action
//     (one bad inner action poisons the whole proposal), then runs the new
//     gate 7 propose-level checks (proposalName regex + citation, requested[]
//     regex + citation, proposer not in requested, no duplicate approvers).
//
// Gate failure semantics: NEVER bubble up a half-validated reply. Each
// failure returns `{ kind: 'ask', question: <generic clarifier> }`. The
// caller hands that back to the chat UI unchanged.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { CatalogIndex } from './catalog.js';
import type { AbiParam, ActionRules, AuthRef } from '../extractor/types.js';
import { logger } from '../middleware/logging.js';

// ─────────────────────────────────────────────────────────────────────────
// Metadata validator hook (W5).
//
// Mechanism for catching invented inline-metadata blobs at gate 3. Entry
// shape: a (contract, action, field) triple plus a validator. When gate 3
// finds a present `data[field]` for a matching (contract, action), it runs
// `validate(value)`; on `{ ok: false }` the gate downgrades to ask.
//
// PRODUCTION TABLE IS EMPTY (and stays that way until the extractor exposes
// the inner shape of struct params like `create_wrap` / `issue_wrap`).
// No real eosio.nft.ft action carries an inline metadata-JSON blob at its
// top-level `data` map today — every metadata lives off-chain at the URIs in
// `meta_uris` / `uri` / `factory_uri` / `hash`. The mechanism is wired in so
// that the moment a future action lands with an on-chain metadata field, the
// gate is already in place to catch invented values. See roadmap §6 row W5
// and guidelines §4.3 gate 3.
//
// Tests inject synthetic entries via ValidateContext.metadataValidators
// (preferred — mirrors the existing toolReturnedIdentifiers? pattern). Never
// add a synthetic entry here that doesn't correspond to a real catalog
// (contract, action, field) tuple.
// ─────────────────────────────────────────────────────────────────────────

export type MetadataValidator = {
    contract: string;
    action: string;
    field: string;
    validate: (value: unknown) => { ok: true } | { ok: false; errors: string[] };
};

export const METADATA_VALIDATORS: ReadonlyArray<MetadataValidator> = [];

// ─────────────────────────────────────────────────────────────────────────
// Reply union — the five contract kinds. Locked per docs §3 trust boundary
// box and §4.3. Adding/removing/renaming a kind is a docs change first.
// ─────────────────────────────────────────────────────────────────────────

const AuthorizationSchema = z.object({
    actor: z.string().min(1),
    permission: z.string().min(1),
});

export const ActionSchema = z.object({
    contract: z.string().min(1),
    action: z.string().min(1),
    data: z.record(z.string(), z.unknown()),
    authorization: z.array(AuthorizationSchema).min(1),
});

const ActReplySchema = z.object({
    kind: z.literal('act'),
    actions: z.array(ActionSchema).min(1).max(1),
    rationale: z.string(),
});

const ProposeReplySchema = z.object({
    kind: z.literal('propose'),
    proposalName: z.string().min(1),
    actions: z.array(ActionSchema).min(1),
    requested: z.array(AuthorizationSchema).min(1),
    rationale: z.string(),
});

const AskReplySchema = z.object({
    kind: z.literal('ask'),
    question: z.string().min(1),
});

const RefuseReplySchema = z.object({
    kind: z.literal('refuse'),
    reason: z.string().min(1),
});

const AnswerReplySchema = z.object({
    kind: z.literal('answer'),
    text: z.string().min(1),
});

export const ReplySchema = z.discriminatedUnion('kind', [
    ActReplySchema,
    ProposeReplySchema,
    AskReplySchema,
    RefuseReplySchema,
    AnswerReplySchema,
]);

export type Reply = z.infer<typeof ReplySchema>;
export type ActReply = z.infer<typeof ActReplySchema>;
export type ProposeReply = z.infer<typeof ProposeReplySchema>;
export type AskReply = z.infer<typeof AskReplySchema>;
export type RefuseReply = z.infer<typeof RefuseReplySchema>;
export type AnswerReply = z.infer<typeof AnswerReplySchema>;
export type ReplyAction = z.infer<typeof ActionSchema>;

// ─────────────────────────────────────────────────────────────────────────
// W0 carry-overs (cleanText + coerceLlmShape). Verbatim from the demo; every
// branch is load-bearing per the W3 simplifier exclusion list.
// ─────────────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/\S+/gi;
const CODE_FENCE_RE = /```/g;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const JAILBREAK_RE = /(here'?s how to bypass|ignore previous instructions)/gi;

export function cleanText(input: string): { cleaned: string; stripped: boolean } {
    let out = input;
    out = out.replace(MD_IMAGE_RE, '');
    out = out.replace(URL_RE, '');
    out = out.replace(CODE_FENCE_RE, '');
    out = out.replace(JAILBREAK_RE, '');
    const stripped = out !== input;
    return { cleaned: out.trim(), stripped };
}

const NAME_TYPES = new Set(['name', 'account_name', 'permission_name']);

// Pragmatic adapter for the LLM's most common structured-output mistakes.
// Each branch unwraps a known-bad shape into the canonical primitive that
// matches the eosio-types regex. If nothing matches, returns `value` as-is
// and the regex check downgrades to `ask`.
export function coerceLlmShape(value: unknown, type: string, fieldName: string): unknown {
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
        // Symbol may surface as `symbol` (common) or `symbol_code` (qwen variant).
        const sym =
            typeof obj.symbol === 'string'
                ? obj.symbol
                : typeof obj.symbol_code === 'string'
                  ? obj.symbol_code
                  : null;
        // Structured decomposition: `{amount: 100, precision: 8, symbol|symbol_code: "UOS"}`.
        if (typeof obj.amount === 'number' && typeof obj.precision === 'number' && sym !== null) {
            return `${obj.amount.toFixed(obj.precision)} ${sym}`;
        }
        // String amount + symbol.
        if (typeof obj.amount === 'string' && sym !== null) {
            return `${obj.amount} ${sym}`;
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

// ─────────────────────────────────────────────────────────────────────────
// eosio-types regex table loader. Boot-time read; cached. Hard rule per
// backend/CLAUDE.md: "Catalog JSON is generated, not hand-edited." This
// module never writes back.
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TYPES_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'catalog',
    'eosio-types.json'
);

export type EosioTypeEntry = {
    pattern?: string;
};

export type EosioTypes = Record<string, EosioTypeEntry>;

let cachedTypes: EosioTypes | null = null;

export async function loadEosioTypes(path = DEFAULT_TYPES_PATH): Promise<EosioTypes> {
    if (path === DEFAULT_TYPES_PATH && cachedTypes) return cachedTypes;
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const out: EosioTypes = {};
    for (const [name, entry] of Object.entries(raw)) {
        if (entry && typeof entry === 'object') {
            const pattern = (entry as Record<string, unknown>).pattern;
            out[name] = { pattern: typeof pattern === 'string' ? pattern : undefined };
        }
    }
    if (path === DEFAULT_TYPES_PATH) cachedTypes = out;
    return out;
}

export function _resetEosioTypesCache(): void {
    cachedTypes = null;
}

// ─────────────────────────────────────────────────────────────────────────
// validateAct — gates 2–6.
//
// Gate 1 (schema) is the harness's Zod parse + the route handler's re-parse
// against ReplySchema; if either fails the caller short-circuits to ask
// before this function is invoked.
// ─────────────────────────────────────────────────────────────────────────

export type ValidateContext = {
    validatedAccounts: string[];
    knownAccounts: string[];
    selectedAccount?: string;
    // JWT claim's permission — the only permission the active key holds at
    // the active account this wave. W4 will replace with a real get_account
    // lookup.
    jwtPermission: string;
    // The user's most recent message (the turn the LLM was responding to).
    // Source for gate 5's invention check + gate 6's memo policy.
    userMessage: string;
    // JWT claim's account name — gate 5 treats this as a known identifier
    // even when it isn't echoed in the user message (the user signed in as
    // it, so it isn't "invented" if the LLM proposes it).
    jwtAccount: string;
    // W4: identifiers that appeared in <chain_read> responses THIS turn.
    // Gate 5 treats these as cited (rule 2's "tool response"). Optional —
    // callers that don't pass it (W3 routes, isolated tests) get the W3
    // behaviour unchanged. Populated by the route handler via
    // extractIdentifiers() over each tool response payload. W5: the same
    // Set may also carry numeric *_id values harvested by extractIdentifiers
    // from object pairs like {token_id: 42} — see extractIdentifiers below.
    toolReturnedIdentifiers?: Set<string>;
    // W5: optional override / test-only injection of the metadata-validator
    // table. Falls back to the empty module-level `METADATA_VALIDATORS` in
    // production. When set, completely replaces the default table.
    metadataValidators?: ReadonlyArray<MetadataValidator>;
};

export type ValidateOk = { kind: 'ok'; reply: ActReply };
// `innerIndex` is set only by validatePropose (W6) when an inner action
// failed gates 1–6 OR when gate 7 is propose-level (innerIndex omitted).
// Existing validateAct callers ignore it.
export type ValidateAsk = { kind: 'ask'; question: string; failedGate: number; innerIndex?: number };
export type ValidateOutcome = ValidateOk | ValidateAsk;

// W6 sibling outcome for propose flows. Mirrors ValidateOutcome with a
// ProposeReply payload on success — keeps the caller's narrow happy.
export type ValidateProposeOk = { kind: 'ok'; reply: ProposeReply };
export type ValidateProposeOutcome = ValidateProposeOk | ValidateAsk;

// Generic clarifier surfaced to the user when any gate trips. Generic by
// design — exposing which gate failed leaks the structured contract and
// gives an attacker a probe.
const GENERIC_CLARIFIER =
    "I couldn't safely compose that action. Could you spell out the contract, action, and parameters more explicitly?";

function ask(failedGate: number, why: string): ValidateAsk {
    logger.warn({ failedGate, why }, 'validate: downgraded to ask');
    return { kind: 'ask', question: GENERIC_CLARIFIER, failedGate };
}

// String value or whitespace-collapsed substring check. EOSIO names are
// already lowercase + length-bounded; substring is the right operator
// because users write "transfer 100 UOS from alice to bob" not "transfer
// from='alice' to='bob'".
function userMessageContains(userMessage: string, value: string): boolean {
    return userMessage.includes(value);
}

// ─────────────────────────────────────────────────────────────────────────
// W5: field-shape helper. Drives gate 3 across the full eosio-types regex
// table plus a per-type branch for ints, bools, arrays, extended_asset,
// optionals, and structs. Replaces the W3 "non-string fall-through" with an
// explicit per-shape check.
//
// Returns:
//   { ok: true, coerced }    — value passed the shape check; `coerced` is
//                              the canonical form (number for ints, boolean
//                              for bools, the original string for regex
//                              types, etc.). Caller MUST use `coerced`
//                              when echoing the value into the validated
//                              reply (so downstream consumers see a
//                              normalised value).
//   { ok: false, reason }    — value failed. Caller downgrades to ask gate 3.
//
// Unknown / struct types fall through to ok with a debug breadcrumb so the
// existing W3 behaviour (struct param accepted as-is) is preserved. When the
// extractor lands a struct-shape feature, the lookup goes here.
// ─────────────────────────────────────────────────────────────────────────

const UINT_TYPE_RE = /^u?int(8|16|32|64)$/;
const VECTOR_BRACKET_RE = /^(.+?)\[\]$/;
const VECTOR_SUFFIX_RE = /^(.+?)_vector$/;
const VECTOR_ANGLE_RE = /^vector<(.+)>$/;
// Some catalogs surface `uint64_t_vector` (a typedef artifact). Treat as vector.
const VECTOR_T_SUFFIX_RE = /^(.+?)_t_vector$/;

type FieldShapeResult = { ok: true; coerced: unknown } | { ok: false; reason: string };

// Range bounds for the (u?)int(8|16|32|64) family. Returns null for invalid
// type strings (caller treats as unknown / struct).
function intBounds(type: string): { signed: boolean; bits: 8 | 16 | 32 | 64 } | null {
    const m = UINT_TYPE_RE.exec(type);
    if (!m) return null;
    const signed = !type.startsWith('u');
    const bits = Number(m[1]) as 8 | 16 | 32 | 64;
    return { signed, bits };
}

// Validate a numeric value against signed/unsigned X-bit bounds. Accepts
// JS number OR a numeric string (the latter preserves uint64 precision —
// JS numbers lose precision above 2^53).
function checkIntInRange(value: unknown, signed: boolean, bits: 8 | 16 | 32 | 64): FieldShapeResult {
    let asBig: bigint;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
            return { ok: false, reason: 'not an integer' };
        }
        asBig = BigInt(value);
    } else if (typeof value === 'string') {
        // Strict numeric string (allow leading minus for signed).
        if (!/^-?\d+$/.test(value)) {
            return { ok: false, reason: 'not a numeric string' };
        }
        try {
            asBig = BigInt(value);
        } catch {
            return { ok: false, reason: 'BigInt parse failed' };
        }
    } else {
        return { ok: false, reason: `int value not number/string: ${typeof value}` };
    }
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    if (asBig < min || asBig > max) {
        return { ok: false, reason: `out of range for ${signed ? '' : 'u'}int${bits}` };
    }
    // Canonicalise: keep as string for 64-bit to preserve precision; else number.
    const coerced: unknown = bits === 64 ? asBig.toString() : Number(asBig);
    return { ok: true, coerced };
}

function checkBool(value: unknown): FieldShapeResult {
    if (typeof value === 'boolean') return { ok: true, coerced: value };
    if (value === 0 || value === 1) return { ok: true, coerced: value === 1 };
    if (value === 'true') return { ok: true, coerced: true };
    if (value === 'false') return { ok: true, coerced: false };
    return { ok: false, reason: 'invalid bool' };
}

// Unwrap a one-level optional type marker (suffix '?'). Returns the inner
// type and an explicit flag.
function unwrapOptional(type: string): { isOpt: boolean; inner: string } {
    if (type.endsWith('?')) return { isOpt: true, inner: type.slice(0, -1) };
    return { isOpt: false, inner: type };
}

// Unwrap a vector type marker. Returns the inner element type or null if
// the type isn't a vector.
function vectorElementType(type: string): string | null {
    const m1 = VECTOR_BRACKET_RE.exec(type);
    if (m1 && m1[1]) return m1[1];
    const m2 = VECTOR_T_SUFFIX_RE.exec(type);
    if (m2 && m2[1]) return m2[1];
    const m3 = VECTOR_SUFFIX_RE.exec(type);
    if (m3 && m3[1]) return m3[1];
    const m4 = VECTOR_ANGLE_RE.exec(type);
    if (m4 && m4[1]) return m4[1];
    return null;
}

// Recursive field shape check. `paramName` is the top-level param name (for
// breadcrumbs); `path` accumulates a JSON-ish path for nested errors.
function checkFieldShape(
    value: unknown,
    type: string,
    eosioTypes: EosioTypes,
    paramName: string,
    path = ''
): FieldShapeResult {
    // ─── Optional unwrap ────────────────────────────────────────────────
    const { isOpt, inner: typeAfterOpt } = unwrapOptional(type);
    if (isOpt && (value === null || value === undefined || value === '')) {
        return { ok: true, coerced: value };
    }

    // ─── Vector unwrap ──────────────────────────────────────────────────
    const elem = vectorElementType(typeAfterOpt);
    if (elem !== null) {
        if (!Array.isArray(value)) {
            return { ok: false, reason: `${paramName}${path}: expected array for ${typeAfterOpt}` };
        }
        const coercedArr: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
            const sub = checkFieldShape(value[i], elem, eosioTypes, paramName, `${path}[${i}]`);
            if (!sub.ok) return sub;
            coercedArr.push(sub.coerced);
        }
        return { ok: true, coerced: coercedArr };
    }

    // ─── Integer family ─────────────────────────────────────────────────
    const ib = intBounds(typeAfterOpt);
    if (ib) {
        const r = checkIntInRange(value, ib.signed, ib.bits);
        if (!r.ok) return { ok: false, reason: `${paramName}${path} (${typeAfterOpt}): ${r.reason}` };
        return r;
    }

    // ─── bool ───────────────────────────────────────────────────────────
    if (typeAfterOpt === 'bool') {
        const r = checkBool(value);
        if (!r.ok) return { ok: false, reason: `${paramName}${path} (bool): ${r.reason}` };
        return r;
    }

    // ─── extended_asset ────────────────────────────────────────────────
    if (typeAfterOpt === 'extended_asset') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return { ok: false, reason: `${paramName}${path}: extended_asset must be object` };
        }
        const obj = value as Record<string, unknown>;
        const qRes = checkFieldShape(obj.quantity, 'asset', eosioTypes, paramName, `${path}.quantity`);
        if (!qRes.ok) return qRes;
        const cRes = checkFieldShape(obj.contract, 'name', eosioTypes, paramName, `${path}.contract`);
        if (!cRes.ok) return cRes;
        return { ok: true, coerced: { quantity: qRes.coerced, contract: cRes.coerced } };
    }

    // ─── Regex-bearing types from eosio-types.json ──────────────────────
    const pattern = eosioTypes[typeAfterOpt]?.pattern;
    if (pattern) {
        // Apply coerceLlmShape first (the legacy gate-3 path does this).
        const coerced = coerceLlmShape(value, typeAfterOpt, paramName);
        if (typeof coerced !== 'string') {
            return { ok: false, reason: `${paramName}${path} (${typeAfterOpt}): not a string after coerce` };
        }
        if (!new RegExp(pattern).test(coerced)) {
            return { ok: false, reason: `${paramName}${path} (${typeAfterOpt}) failed regex: ${coerced}` };
        }
        return { ok: true, coerced };
    }

    // ─── Catch-all: unknown type (likely a struct). Preserve W3 fall-
    // through but log a breadcrumb naming the type so the W6 msig audit
    // can see what the extractor needs to expand next.
    logger.debug(
        { unknownType: typeAfterOpt, paramName, path },
        'gate 3: unknown nested type — falling through (extractor PR needed for struct shape)'
    );
    return { ok: true, coerced: value };
}

// Integer-id type predicate — used by gate 5's W5 numeric branch.
function isUintIdType(type: string): boolean {
    return UINT_TYPE_RE.test(unwrapOptional(type).inner);
}

// ─────────────────────────────────────────────────────────────────────────
// validateInnerAction — gates 2–6 on a single Action.
//
// Used by both validateAct (W3, called once with the lone act action) and
// validatePropose (W6, called once per inner action; first failure
// short-circuits the whole proposal).
//
// Returns the coerced action on success so the caller can emit a normalised
// reply (uint64 → string, asset coerced from {amount, precision, symbol},
// etc.). Returns `{ kind: 'ask', failedGate, why }` on failure; the caller
// surfaces GENERIC_CLARIFIER and logs `why` via the `ask()` helper.
//
// Each gate stays its own named branch per the W6 simplifier exclusion list.
// ─────────────────────────────────────────────────────────────────────────

type InnerActionOk = { kind: 'ok'; coerced: ReplyAction };
type InnerActionAsk = { kind: 'ask'; failedGate: number; why: string };
type InnerActionOutcome = InnerActionOk | InnerActionAsk;

function validateInnerAction(
    action: ReplyAction,
    catalog: CatalogIndex,
    eosioTypes: EosioTypes,
    ctx: ValidateContext
): InnerActionOutcome {
    // ─── Gate 2: catalog membership ──────────────────────────────────────
    const key = `${action.contract}::${action.action}`;
    const entry = catalog.byKey.get(key);
    if (!entry) {
        return { kind: 'ask', failedGate: 2, why: `unknown action ${key}` };
    }
    const rules: ActionRules = entry.rules;

    // ─── Gate 3: field shape (param whitelist + type-driven check) ───────
    // W5: gate now branches per declared type (int / bool / array / asset /
    // extended_asset / name-regex / struct fall-through), not just "regex
    // string". checkFieldShape handles all the cases; unknown types log a
    // breadcrumb and accept the value (preserving W3 behaviour for struct
    // params the extractor hasn't expanded yet).
    const paramByName = new Map<string, AbiParam>();
    for (const p of rules.params) paramByName.set(p.name, p);

    for (const [k] of Object.entries(action.data)) {
        if (!paramByName.has(k)) {
            return { kind: 'ask', failedGate: 3, why: `unknown field ${k} on ${key}` };
        }
    }
    const coercedData: Record<string, unknown> = {};
    for (const p of rules.params) {
        const raw = action.data[p.name];
        if (raw === undefined) continue;
        const res = checkFieldShape(raw, p.type, eosioTypes, p.name);
        if (!res.ok) {
            return { kind: 'ask', failedGate: 3, why: res.reason };
        }
        coercedData[p.name] = res.coerced;
    }

    // ─── Gate 3 — metadata hook (W5) ─────────────────────────────────────
    // Empty in production (no real eosio.nft.ft action has an inline
    // metadata-JSON field; metadata lives at the URIs in meta_uris / uri /
    // factory_uri). Tests inject via ctx.metadataValidators. When a future
    // contract DOES land an action with an inline metadata blob, the entry
    // goes in METADATA_VALIDATORS and gate 3 catches invented values here.
    const activeMetaValidators = ctx.metadataValidators ?? METADATA_VALIDATORS;
    for (const mv of activeMetaValidators) {
        if (mv.contract !== action.contract || mv.action !== action.action) continue;
        const v = coercedData[mv.field];
        if (v === undefined) continue;
        const r = mv.validate(v);
        if (!r.ok) {
            return { kind: 'ask', failedGate: 3, why: `metadata invalid on ${mv.field}: ${r.errors.join('; ')}` };
        }
    }

    // ─── Gate 4: authorization actor + permission ────────────────────────
    const auth = action.authorization[0];
    if (!auth) return { kind: 'ask', failedGate: 4, why: 'missing authorization' };
    if (!ctx.validatedAccounts.includes(auth.actor)) {
        return { kind: 'ask', failedGate: 4, why: `actor ${auth.actor} not in validatedAccounts` };
    }
    if (auth.permission !== ctx.jwtPermission) {
        return {
            kind: 'ask',
            failedGate: 4,
            why: `permission ${auth.permission} ≠ JWT permission ${ctx.jwtPermission}`,
        };
    }
    // Sanity link to the catalog's declared auth signature: not a hard fail
    // (catalog auths can reference $-vars resolved per-action), just a log
    // breadcrumb for W4's deeper permission check.
    logCatalogAuth(rules.auths, auth);

    // ─── Gate 5: no invented identifiers ─────────────────────────────────
    // Every name-typed string value in `data` must trace to: the user's
    // current message, `context.knownAccounts`, the JWT's `account` claim,
    // `context.selectedAccount` (the account the user has surfaced in
    // session_context — the system prompt explicitly lists session_context
    // as a permitted source per rule 2), or `context.toolReturnedIdentifiers`
    // (W4: identifiers that appeared in a <chain_read> tool response this
    // turn — rule 2's "tool response" source).
    //
    // `validatedAccounts` is deliberately NOT in this set. validatedAccounts
    // is the full wallet-attested list (often dozens of accounts across
    // testnet + mainnet); treating all of them as "mentioned" defeats gate
    // 5's purpose. Gate 4 is where validatedAccounts gates the actor.
    const knownSet = new Set<string>([...ctx.knownAccounts, ctx.jwtAccount]);
    if (ctx.selectedAccount) knownSet.add(ctx.selectedAccount);
    if (ctx.toolReturnedIdentifiers) {
        for (const id of ctx.toolReturnedIdentifiers) knownSet.add(id);
    }

    for (const p of rules.params) {
        if (!NAME_TYPES.has(p.type)) continue;
        const v = coercedData[p.name];
        if (typeof v !== 'string' || v.length === 0) continue;
        if (knownSet.has(v)) continue;
        if (userMessageContains(ctx.userMessage, v)) continue;
        return { kind: 'ask', failedGate: 5, why: `invented identifier on ${p.name}: ${v}` };
    }
    // W5: numeric *_id params (uint8/16/32/64 family, with or without `?`
    // optional). Citation source is the user message (substring) OR the
    // toolReturnedIdentifiers set (exact match on string form). knownAccounts
    // is also consulted for completeness (a user-curated bookmark list could
    // contain numeric IDs in some future extension). Skips arrays — array-
    // valued *_id params (e.g. `factories: uint64[]` on creategrp) are
    // checked element-by-element.
    for (const p of rules.params) {
        if (!isUintIdType(p.type) || !p.name.endsWith('_id')) continue;
        const v = coercedData[p.name];
        if (v === undefined || v === null) continue;
        const numStr = String(v);
        if (numStr.length === 0) continue;
        if (ctx.toolReturnedIdentifiers?.has(numStr)) continue;
        if (knownSet.has(numStr)) continue;
        if (userMessageContains(ctx.userMessage, numStr)) continue;
        return { kind: 'ask', failedGate: 5, why: `invented numeric id on ${p.name}: ${numStr}` };
    }
    // W5: array-of-uint64 params (also commonly *_ids — e.g. `factories` on
    // creategrp). Each element must be cited like a scalar id. We piggyback
    // on the same uint-id rule; the heuristic for "this is an id array" is
    // simply "type matched a vector whose element is a uint family". Param
    // names like `factories` / `token_ids` don't always end in `_id`, so the
    // gate runs on EVERY array-of-uint param. Scalar non-`_id` uints are
    // intentionally not checked here (e.g. `quantity: uint32` on authminter
    // can legitimately be `1` without the user writing the word "1").
    for (const p of rules.params) {
        const inner = vectorElementType(unwrapOptional(p.type).inner);
        if (inner === null) continue;
        if (!UINT_TYPE_RE.test(inner)) continue;
        const v = coercedData[p.name];
        if (!Array.isArray(v)) continue;
        for (const elem of v) {
            if (elem === undefined || elem === null) continue;
            const numStr = String(elem);
            if (numStr.length === 0) continue;
            if (ctx.toolReturnedIdentifiers?.has(numStr)) continue;
            if (knownSet.has(numStr)) continue;
            if (userMessageContains(ctx.userMessage, numStr)) continue;
            return { kind: 'ask', failedGate: 5, why: `invented numeric id in ${p.name}: ${numStr}` };
        }
    }
    // Also check authorization.actor against the same set — although gate
    // 4 already requires it to be a validatedAccount, gate 5 makes the
    // citation chain explicit.
    if (!knownSet.has(auth.actor) && !userMessageContains(ctx.userMessage, auth.actor)) {
        return { kind: 'ask', failedGate: 5, why: `invented actor: ${auth.actor}` };
    }

    // ─── Gate 6: memo policy ─────────────────────────────────────────────
    // For any param of type `string` named `memo`, the value must be empty
    // OR appear verbatim in the user message. Phishing defense. Generalises
    // beyond eosio.token::transfer per the W3 prompt's "and similar" hook.
    for (const p of rules.params) {
        if (p.name !== 'memo' || p.type !== 'string') continue;
        const v = coercedData[p.name];
        if (v === undefined) continue;
        if (typeof v !== 'string') return { kind: 'ask', failedGate: 6, why: `memo is not a string: ${String(v)}` };
        if (v.length === 0) continue;
        if (!userMessageContains(ctx.userMessage, v)) {
            return { kind: 'ask', failedGate: 6, why: `memo not echoed verbatim: ${v}` };
        }
    }

    return {
        kind: 'ok',
        coerced: {
            contract: action.contract,
            action: action.action,
            data: coercedData,
            authorization: [auth],
        },
    };
}

export function validateAct(
    reply: ActReply,
    catalog: CatalogIndex,
    eosioTypes: EosioTypes,
    ctx: ValidateContext
): ValidateOutcome {
    // act has exactly one action this wave (W6 expands the propose path to
    // many; act itself stays single per the docs §3 architecture box).
    const action = reply.actions[0];
    if (!action) return ask(1, 'empty actions array');

    const inner = validateInnerAction(action, catalog, eosioTypes, ctx);
    if (inner.kind === 'ask') {
        return ask(inner.failedGate, inner.why);
    }

    return {
        kind: 'ok',
        reply: {
            kind: 'act',
            actions: [inner.coerced],
            rationale: reply.rationale,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// validatePropose — W6. Runs validateInnerAction per inner action (one bad
// inner action poisons the whole proposal) then gate 7 propose-level checks.
//
// Gate 7 sub-checks each stay their own named branch per the W6 simplifier
// exclusion list:
//   7.1 proposalName regex (matches eosio name pattern)
//   7.2 proposalName cited (user msg substring OR knownAccounts OR
//       toolReturnedIdentifiers; validatedAccounts NOT a source — the user
//       must explicitly name the proposal)
//   7.3 requested[] non-empty (defensive; Zod already enforces min(1))
//   7.4 every requested[i].actor regex + cited (validatedAccounts IS
//       allowed here — the user explicitly named approvers, unlike inner
//       actors)
//   7.5 every requested[i].permission regex
//   7.6 proposer (ctx.jwtAccount+ctx.jwtPermission) NOT in requested[]
//   7.7 no duplicate approvers (case-sensitive actor::permission)
// ─────────────────────────────────────────────────────────────────────────

function askPropose(failedGate: number, why: string, innerIndex?: number): ValidateAsk {
    logger.warn({ failedGate, why, innerIndex }, 'validate: downgraded propose to ask');
    const ask: ValidateAsk = { kind: 'ask', question: GENERIC_CLARIFIER, failedGate };
    if (innerIndex !== undefined) ask.innerIndex = innerIndex;
    return ask;
}

export function validatePropose(
    reply: ProposeReply,
    catalog: CatalogIndex,
    eosioTypes: EosioTypes,
    ctx: ValidateContext
): ValidateProposeOutcome {
    // Defensive — Zod's min(1) should have caught this already.
    if (reply.actions.length === 0) return askPropose(1, 'empty actions array');

    // ─── Gates 1–6 per inner action ─────────────────────────────────────
    // One bad inner action poisons the whole proposal. Short-circuit on the
    // first failure; the innerIndex breadcrumb is logged but never surfaced
    // to the user (gate-1 "generic clarifier" rule from §4.3).
    const coercedActions: ReplyAction[] = [];
    for (let i = 0; i < reply.actions.length; i++) {
        const action = reply.actions[i];
        if (!action) return askPropose(1, `actions[${i}] is missing`, i);
        const inner = validateInnerAction(action, catalog, eosioTypes, ctx);
        if (inner.kind === 'ask') {
            return askPropose(inner.failedGate, `inner[${i}] ${inner.why}`, i);
        }
        coercedActions.push(inner.coerced);
    }

    // ─── Gate 7 — propose-level checks ──────────────────────────────────
    const namePattern = eosioTypes.name?.pattern;
    if (!namePattern) {
        // catalog/eosio-types.json is missing the `name` regex — extractor
        // health check, not user-facing. Treat as gate 7 failure so the
        // chat downgrades safely.
        return askPropose(7, 'eosio-types.json missing name pattern');
    }
    const nameRe = new RegExp(namePattern);

    // 7.1 proposalName regex
    if (!nameRe.test(reply.proposalName)) {
        return askPropose(7, `proposalName failed name regex: ${reply.proposalName}`);
    }

    // 7.2 proposalName cited. Citation sources mirror gate 5 (knownAccounts
    // + toolReturnedIdentifiers + user message) but EXCLUDE validatedAccounts
    // — the user must explicitly name the proposal; an inventory lookup is
    // not a source. The model never invents a proposalName.
    const proposalNameKnown = new Set<string>(ctx.knownAccounts);
    if (ctx.toolReturnedIdentifiers) {
        for (const id of ctx.toolReturnedIdentifiers) proposalNameKnown.add(id);
    }
    if (!proposalNameKnown.has(reply.proposalName) && !userMessageContains(ctx.userMessage, reply.proposalName)) {
        return askPropose(7, `proposalName not cited: ${reply.proposalName}`);
    }

    // 7.3 requested[] non-empty
    if (reply.requested.length === 0) {
        return askPropose(7, 'requested[] is empty');
    }

    // 7.4 every requested[i].actor regex + cited. validatedAccounts IS a
    // source here — the user explicitly named approvers, unlike inner-action
    // actors (gate 5). 7.5 every requested[i].permission regex.
    const approverActorKnown = new Set<string>([
        ...ctx.knownAccounts,
        ...ctx.validatedAccounts,
        ctx.jwtAccount,
    ]);
    if (ctx.selectedAccount) approverActorKnown.add(ctx.selectedAccount);
    if (ctx.toolReturnedIdentifiers) {
        for (const id of ctx.toolReturnedIdentifiers) approverActorKnown.add(id);
    }

    for (const req of reply.requested) {
        if (!nameRe.test(req.actor)) {
            return askPropose(7, `requested actor failed name regex: ${req.actor}`);
        }
        if (!approverActorKnown.has(req.actor) && !userMessageContains(ctx.userMessage, req.actor)) {
            return askPropose(7, `requested actor not cited: ${req.actor}`);
        }
        if (!nameRe.test(req.permission)) {
            return askPropose(7, `requested permission failed name regex: ${req.permission}`);
        }
    }

    // 7.6 proposer NOT in requested[]
    for (const req of reply.requested) {
        if (req.actor === ctx.jwtAccount && req.permission === ctx.jwtPermission) {
            return askPropose(7, `proposer ${ctx.jwtAccount}@${ctx.jwtPermission} cannot be in requested`);
        }
    }

    // 7.7 no duplicate approvers (case-sensitive actor::permission)
    const seen = new Set<string>();
    for (const req of reply.requested) {
        const key = `${req.actor}::${req.permission}`;
        if (seen.has(key)) {
            return askPropose(7, `duplicate approver: ${key}`);
        }
        seen.add(key);
    }

    // All gates passed — emit the cleaned proposal.
    return {
        kind: 'ok',
        reply: {
            kind: 'propose',
            proposalName: reply.proposalName,
            actions: coercedActions,
            requested: reply.requested,
            rationale: reply.rationale,
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────
// W4 + W5: extractIdentifiers — walk a JSON-shaped tool response and return
// every string value (or object key) that matches the EOSIO name regex,
// PLUS every numeric value sitting under a `*_id` key (W5). The route
// handler calls this on each tool response and feeds the union into
// ValidateContext.toolReturnedIdentifiers. Used by gate 5 as the "tool
// response" source per §4.1 rule 2 + §4.3 gate 5.
//
// W5 numeric-id addition: when walking an object's `[key, value]` pairs, if
// `key` ends in `_id` AND `value` is a number / numeric string, add
// `String(value)` to the Set. The Set holds names AND numeric strings; gate
// 5's W5 uint-id branch consults exact-match against this Set. The Set's
// existing name-citation semantics are unchanged.
//
// Caveats:
//   - Walks objects and arrays. Skips null/undefined/Dates.
//   - Stops at maxDepth (default 5) instead of throwing — defensive against
//     deeply nested ABIs.
//   - Caps output at 100 identifiers — defensive against a tool returning a
//     huge table page (e.g. 1000 accounts). The harness already caps rows at
//     20 per tool, so 100 is plenty of headroom.
//   - Object KEYS are also matched — permission names appear as keys
//     (`active`, `owner`) in /v1/chain/get_account responses, not values.
//   - Numeric-id harvest happens at the [key, value] level; nested arrays
//     like `factories: [1,2,3]` (key `factories`, value an array) are not
//     captured by name (the key doesn't end in `_id`). Catch them via the
//     inner walk's numeric pickups would over-collect; instead a future
//     extension could whitelist array-bearing keys like `token_ids`.
// ─────────────────────────────────────────────────────────────────────────

const EOSIO_NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;
const EXTRACT_IDENTIFIERS_CAP = 100;
const ID_KEY_SUFFIX = '_id';
const NUMERIC_STRING_RE = /^-?\d+$/;

export function extractIdentifiers(payload: unknown, maxDepth = 5): Set<string> {
    const out = new Set<string>();
    walk(payload, 0, maxDepth, out);
    return out;
}

// Add a numeric *_id value (number or numeric string) under a key ending
// in `_id`. Helper kept out-of-line so the walker stays readable.
function addNumericId(key: string, value: unknown, out: Set<string>): void {
    if (!key.endsWith(ID_KEY_SUFFIX)) return;
    if (out.size >= EXTRACT_IDENTIFIERS_CAP) return;
    if (typeof value === 'number') {
        if (Number.isFinite(value) && Number.isInteger(value)) {
            out.add(String(value));
        }
        return;
    }
    if (typeof value === 'string' && NUMERIC_STRING_RE.test(value)) {
        out.add(value);
    }
}

function walk(node: unknown, depth: number, maxDepth: number, out: Set<string>): void {
    if (out.size >= EXTRACT_IDENTIFIERS_CAP) return;
    if (node === null || node === undefined) return;
    if (depth > maxDepth) return;
    if (node instanceof Date) return;
    const t = typeof node;
    if (t === 'number' || t === 'boolean') return;
    if (t === 'string') {
        if (EOSIO_NAME_RE.test(node as string)) out.add(node as string);
        return;
    }
    if (Array.isArray(node)) {
        for (const item of node) {
            if (out.size >= EXTRACT_IDENTIFIERS_CAP) return;
            walk(item, depth + 1, maxDepth, out);
        }
        return;
    }
    if (t === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (out.size >= EXTRACT_IDENTIFIERS_CAP) return;
            if (EOSIO_NAME_RE.test(k)) out.add(k);
            // W5: numeric-id harvest.
            addNumericId(k, v, out);
            if (out.size >= EXTRACT_IDENTIFIERS_CAP) return;
            walk(v, depth + 1, maxDepth, out);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────
// W5: extractEchoedTokens — sibling of extractIdentifiers. Walks a tool
// payload looking for object nodes that reveal a (contract, symbol) pair,
// and emits a Set of `${contract}::${symbol}` strings.
//
// Heuristics (only emits when BOTH contract and symbol are visible at the
// SAME object node — over-aggressive aggregation across siblings would
// falsely cite tokens the chain never linked):
//   1. node has `contract` (matching NAME_RE) AND `symbol` (matching
//      SYMBOL_RE) string fields → emit `${contract}::${symbol}`.
//   2. node has a `quantity` asset-string ("<amount> <SYMBOL>") AND a
//      `contract` field → emit `${contract}::<SYMBOL>`.
//   3. node has a `sym` field shaped "<precision>,<CODE>" AND a `contract`
//      field → emit `${contract}::<CODE>`. (Common in extended_symbol.)
//
// Cap at 50 entries; depth limit 5. Empty Set is normalized at the call
// site, not here.
// ─────────────────────────────────────────────────────────────────────────

export const _EXTRACT_ECHOED_TOKENS_CAP = 50;
const SYMBOL_CODE_RE = /^[A-Z]{1,7}$/;
const ASSET_STRING_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)? ([A-Z]{1,7})$/;
const SYM_STRING_RE = /^([0-9]|1[0-8]),([A-Z]{1,7})$/;

export function extractEchoedTokens(payload: unknown, maxDepth = 5): Set<string> {
    const out = new Set<string>();
    walkForTokens(payload, 0, maxDepth, out);
    return out;
}

function emitToken(out: Set<string>, contract: string, code: string): void {
    if (out.size >= _EXTRACT_ECHOED_TOKENS_CAP) return;
    out.add(`${contract}::${code}`);
}

function tryEmitTokensFromObject(obj: Record<string, unknown>, out: Set<string>): void {
    const contract = obj.contract;
    if (typeof contract !== 'string' || !EOSIO_NAME_RE.test(contract)) return;
    // Shape 1: explicit symbol field.
    const sym = obj.symbol;
    if (typeof sym === 'string' && SYMBOL_CODE_RE.test(sym)) {
        emitToken(out, contract, sym);
    }
    // Shape 2: asset-string quantity.
    const qty = obj.quantity;
    if (typeof qty === 'string') {
        const m = ASSET_STRING_RE.exec(qty);
        if (m && m[3]) emitToken(out, contract, m[3]);
    }
    // Shape 3: extended_symbol-shaped sym.
    const symField = obj.sym;
    if (typeof symField === 'string') {
        const m = SYM_STRING_RE.exec(symField);
        if (m && m[2]) emitToken(out, contract, m[2]);
    }
}

function walkForTokens(node: unknown, depth: number, maxDepth: number, out: Set<string>): void {
    if (out.size >= _EXTRACT_ECHOED_TOKENS_CAP) return;
    if (node === null || node === undefined) return;
    if (depth > maxDepth) return;
    if (node instanceof Date) return;
    const t = typeof node;
    if (t === 'number' || t === 'boolean' || t === 'string') return;
    if (Array.isArray(node)) {
        for (const item of node) {
            if (out.size >= _EXTRACT_ECHOED_TOKENS_CAP) return;
            walkForTokens(item, depth + 1, maxDepth, out);
        }
        return;
    }
    if (t === 'object') {
        tryEmitTokensFromObject(node as Record<string, unknown>, out);
        for (const v of Object.values(node as Record<string, unknown>)) {
            if (out.size >= _EXTRACT_ECHOED_TOKENS_CAP) return;
            walkForTokens(v, depth + 1, maxDepth, out);
        }
    }
}

// Catalog auths can include `$placeholder` actors (`$from`, `$proposer`) that
// resolve from the action's own params. This wave we just log the mismatch
// rather than fail — W4's get_account lookup is what gives us a real check.
function logCatalogAuth(catalogAuths: AuthRef[], proposed: { actor: string; permission: string }): void {
    if (catalogAuths.length === 0) return;
    const matches = catalogAuths.some(
        (a) => (a.actor.startsWith('$') || a.actor === proposed.actor) && a.permission === proposed.permission
    );
    if (!matches) {
        logger.debug(
            { catalogAuths, proposed },
            'validate: proposed auth not in catalog signature (W4 will harden)'
        );
    }
}
