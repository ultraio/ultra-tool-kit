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
//   - validateAct(): the gate stack. Run gates 2–6 here; gate 1 (schema) is
//     the Zod parse caller does before calling in.
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
};

export type ValidateOk = { kind: 'ok'; reply: ActReply };
export type ValidateAsk = { kind: 'ask'; question: string; failedGate: number };
export type ValidateOutcome = ValidateOk | ValidateAsk;

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

    // ─── Gate 2: catalog membership ──────────────────────────────────────
    const key = `${action.contract}::${action.action}`;
    const entry = catalog.byKey.get(key);
    if (!entry) {
        return ask(2, `unknown action ${key}`);
    }
    const rules: ActionRules = entry.rules;

    // ─── Gate 3: field shape (param whitelist + regex) ───────────────────
    const paramByName = new Map<string, AbiParam>();
    for (const p of rules.params) paramByName.set(p.name, p);

    for (const [k] of Object.entries(action.data)) {
        if (!paramByName.has(k)) {
            return ask(3, `unknown field ${k} on ${key}`);
        }
    }
    // Coerce + regex-check every declared param. Missing params on the
    // reply are tolerated — `data.memo` may legitimately be absent — but
    // any present value must match the type pattern.
    const coercedData: Record<string, unknown> = {};
    for (const p of rules.params) {
        const raw = action.data[p.name];
        if (raw === undefined) continue;
        const coerced = coerceLlmShape(raw, p.type, p.name);
        coercedData[p.name] = coerced;
        const pattern = eosioTypes[p.type]?.pattern;
        if (pattern && typeof coerced === 'string') {
            if (!new RegExp(pattern).test(coerced)) {
                return ask(3, `field ${p.name} (${p.type}) failed regex: ${coerced}`);
            }
        } else if (pattern && typeof coerced !== 'string') {
            // A regex'd type whose value is still non-string means coerce
            // couldn't unwrap it. That's a shape failure.
            return ask(3, `field ${p.name} (${p.type}) not a string after coerce`);
        }
    }

    // ─── Gate 4: authorization actor + permission ────────────────────────
    const auth = action.authorization[0];
    if (!auth) return ask(4, 'missing authorization');
    if (!ctx.validatedAccounts.includes(auth.actor)) {
        return ask(4, `actor ${auth.actor} not in validatedAccounts`);
    }
    if (auth.permission !== ctx.jwtPermission) {
        return ask(4, `permission ${auth.permission} ≠ JWT permission ${ctx.jwtPermission}`);
    }
    // Sanity link to the catalog's declared auth signature: not a hard fail
    // (catalog auths can reference $-vars resolved per-action), just a log
    // breadcrumb for W4's deeper permission check.
    logCatalogAuth(rules.auths, auth);

    // ─── Gate 5: no invented identifiers ─────────────────────────────────
    // Every name-typed string value in `data` must trace to: the user's
    // current message, `context.knownAccounts`, the JWT's `account` claim,
    // or `context.selectedAccount` (the account the user has surfaced in
    // session_context — the system prompt explicitly lists session_context
    // as a permitted source per rule 2). No tool responses to consult yet
    // (W4 wires those in).
    //
    // `validatedAccounts` is deliberately NOT in this set. validatedAccounts
    // is the full wallet-attested list (often dozens of accounts across
    // testnet + mainnet); treating all of them as "mentioned" defeats gate
    // 5's purpose. Gate 4 is where validatedAccounts gates the actor.
    const knownSet = new Set<string>([...ctx.knownAccounts, ctx.jwtAccount]);
    if (ctx.selectedAccount) knownSet.add(ctx.selectedAccount);

    for (const p of rules.params) {
        if (!NAME_TYPES.has(p.type)) continue;
        const v = coercedData[p.name];
        if (typeof v !== 'string' || v.length === 0) continue;
        if (knownSet.has(v)) continue;
        if (userMessageContains(ctx.userMessage, v)) continue;
        return ask(5, `invented identifier on ${p.name}: ${v}`);
    }
    // Also check authorization.actor against the same set — although gate
    // 4 already requires it to be a validatedAccount, gate 5 makes the
    // citation chain explicit.
    if (!knownSet.has(auth.actor) && !userMessageContains(ctx.userMessage, auth.actor)) {
        return ask(5, `invented actor: ${auth.actor}`);
    }

    // ─── Gate 6: memo policy ─────────────────────────────────────────────
    // For any param of type `string` named `memo`, the value must be empty
    // OR appear verbatim in the user message. Phishing defense. Generalises
    // beyond eosio.token::transfer per the W3 prompt's "and similar" hook.
    for (const p of rules.params) {
        if (p.name !== 'memo' || p.type !== 'string') continue;
        const v = coercedData[p.name];
        if (v === undefined) continue;
        if (typeof v !== 'string') return ask(6, `memo is not a string: ${String(v)}`);
        if (v.length === 0) continue;
        if (!userMessageContains(ctx.userMessage, v)) {
            return ask(6, `memo not echoed verbatim: ${v}`);
        }
    }

    // All gates passed — emit the cleaned action back to the caller.
    const ok: ActReply = {
        kind: 'act',
        actions: [
            {
                contract: action.contract,
                action: action.action,
                data: coercedData,
                authorization: [auth],
            },
        ],
        rationale: reply.rationale,
    };
    return { kind: 'ok', reply: ok };
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
