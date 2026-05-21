// LLM output coercion + cleanup helpers.
// Source of truth for the W3 validation gates: docs/00-ai-global-guidelines.md §4.3.
//
// W0 carries only the type-agnostic repairs from the demo branch — every
// per-field coercion branch is preserved verbatim because the small-model
// output shapes they target are unchanged. The full validateProposal pipeline
// (catalog membership, authorization-actor checks, citation gate) is rebuilt
// in W3 against the new prompt + retrieve shapes.

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
// and the regex check (rebuilt in W3) downgrades to `ask`.
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
