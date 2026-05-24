// Gate-by-gate validator tests (guidelines §4.3 gates 1–6).
//
// One describe per gate. Each has a positive case (passes through unchanged)
// and at least one negative case (downgrades to ask). The invented-identifier
// case is the centerpiece — gate 5 is what prevents the AI from authorizing
// transfers to attacker-controlled accounts.
//
// Catalog is the real committed eosio.token.json — loaded once per file
// via the shared loadCatalog cache. eosio-types regex table likewise.

import { beforeAll, describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog, type CatalogIndex } from '../../src/pipeline/catalog.js';
import {
    _resetEosioTypesCache,
    loadEosioTypes,
    validateAct,
    type ActReply,
    type EosioTypes,
    type ValidateContext,
} from '../../src/pipeline/validate.js';

let catalog: CatalogIndex;
let eosioTypes: EosioTypes;

beforeAll(async () => {
    _resetCatalogCache();
    _resetEosioTypesCache();
    catalog = await loadCatalog();
    eosioTypes = await loadEosioTypes();
});

const baseCtx: ValidateContext = {
    validatedAccounts: ['duncan', 'bob'],
    knownAccounts: [],
    selectedAccount: 'duncan',
    jwtPermission: 'active',
    jwtAccount: 'duncan',
    userMessage: 'transfer 100 UOS from duncan to bob',
};

function transferReply(overrides: Partial<ActReply['actions'][0]> = {}, rationale = 'composed'): ActReply {
    return {
        kind: 'act',
        actions: [
            {
                contract: 'eosio.token',
                action: 'transfer',
                data: {
                    from: 'duncan',
                    to: 'bob',
                    quantity: '100.00000000 UOS',
                    memo: '',
                },
                authorization: [{ actor: 'duncan', permission: 'active' }],
                ...overrides,
            },
        ],
        rationale,
    };
}

describe('validateAct — gate 2 (catalog membership)', () => {
    it('passes when (contract, action) exists in the catalog', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades when the action is unknown', () => {
        const reply = transferReply({ action: 'no_such_action' });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(2);
    });

    it('downgrades when the contract is unknown', () => {
        const reply = transferReply({ contract: 'no.such.contract' });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(2);
    });
});

describe('validateAct — gate 3 (field shape)', () => {
    it('passes when every data key is in the param whitelist and types match', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades when data carries an unknown field', () => {
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'bob',
                quantity: '100.00000000 UOS',
                memo: '',
                attacker_field: 'x',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('downgrades when an asset value fails the regex (lowercase symbol)', () => {
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'bob',
                quantity: '100.00000000 uos', // symbol must be [A-Z]{1,7}
                memo: '',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('downgrades when a name value fails the regex (uppercase)', () => {
        const ctx = { ...baseCtx, validatedAccounts: ['duncan', 'BOB_INVALID'] };
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'BOB_INVALID',
                quantity: '100.00000000 UOS',
                memo: '',
            },
            authorization: [{ actor: 'duncan', permission: 'active' }],
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('coerces structured asset shapes back to canonical string before regex', () => {
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'bob',
                // coerceLlmShape unwraps {amount, precision, symbol} → "100.00000000 UOS"
                quantity: { amount: 100, precision: 8, symbol: 'UOS' } as unknown as string,
                memo: '',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') {
            expect(outcome.reply.actions[0]!.data.quantity).toBe('100.00000000 UOS');
        }
    });
});

describe('validateAct — gate 4 (authorization actor + permission)', () => {
    it('passes when actor is in validatedAccounts and permission matches the JWT', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades when actor is not in validatedAccounts', () => {
        const reply = transferReply({
            authorization: [{ actor: 'mallory', permission: 'active' }],
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(4);
    });

    it('downgrades when permission disagrees with the JWT claim', () => {
        const reply = transferReply({
            authorization: [{ actor: 'duncan', permission: 'owner' }],
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(4);
    });
});

describe('validateAct — gate 5 (no invented identifiers)', () => {
    it('passes when every name appears in the user message', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
    });

    it('passes when a name appears in knownAccounts even if not in the user message', () => {
        const ctx = {
            ...baseCtx,
            userMessage: 'send 100 UOS to my bookmarked recipient',
            validatedAccounts: ['duncan', 'savedfriend'],
            knownAccounts: ['savedfriend'],
        };
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'savedfriend',
                quantity: '100.00000000 UOS',
                memo: '',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades when "to" is an account that is in NEITHER the user message NOR knownAccounts (the attacker case)', () => {
        // Centerpiece of the gate stack. The model has been induced to
        // propose a transfer to an account the user never mentioned.
        const ctx = {
            ...baseCtx,
            userMessage: 'transfer 100 UOS from duncan to bob',
            validatedAccounts: ['duncan', 'attacker'],
            knownAccounts: [],
        };
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'attacker',
                quantity: '100.00000000 UOS',
                memo: '',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(5);
    });

    it('downgrades when "from" is invented (gate 5 covers the same vector both directions)', () => {
        const ctx = {
            ...baseCtx,
            userMessage: 'transfer 100 UOS to bob',
            validatedAccounts: ['duncan', 'attacker'],
        };
        const reply = transferReply({
            data: {
                from: 'attacker',
                to: 'bob',
                quantity: '100.00000000 UOS',
                memo: '',
            },
            authorization: [{ actor: 'attacker', permission: 'active' }],
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(5);
    });

    it('passes when "to" came from a tool response (W4 toolReturnedIdentifiers source)', () => {
        // The user asked "send 100 UOS to my bookmarked recipient". A
        // preceding get_account tool call returned bob's account body; the
        // route handler extracted "bob" into toolReturnedIdentifiers.
        // bob is NOT in the user message and NOT in knownAccounts — but
        // gate 5 now accepts it as a tool-cited identifier.
        const ctx: ValidateContext = {
            ...baseCtx,
            userMessage: 'send 100 UOS to my saved friend',
            validatedAccounts: ['duncan', 'bob'],
            knownAccounts: [],
            toolReturnedIdentifiers: new Set(['alice', 'bob']),
        };
        const outcome = validateAct(transferReply(), catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('still downgrades when the identifier is absent from ALL sources including tool returns', () => {
        const ctx: ValidateContext = {
            ...baseCtx,
            userMessage: 'transfer 100 UOS from duncan',
            validatedAccounts: ['duncan', 'attacker'],
            knownAccounts: [],
            toolReturnedIdentifiers: new Set(['alice', 'bob']),
        };
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'attacker',
                quantity: '100.00000000 UOS',
                memo: '',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(5);
    });

    it('omitting toolReturnedIdentifiers preserves W3 behaviour (the existing happy path still passes)', () => {
        // baseCtx has no toolReturnedIdentifiers field — the validator must
        // treat that the same as W3 (no extra source, no extra invention).
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
    });
});

describe('validateAct — gate 6 (memo policy)', () => {
    it('passes when memo is empty', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
    });

    it('passes when memo is a verbatim substring of the user message', () => {
        const ctx = { ...baseCtx, userMessage: 'transfer 100 UOS from duncan to bob, memo: gift' };
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'bob',
                quantity: '100.00000000 UOS',
                memo: 'gift',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades when the LLM authors a memo not in the user message', () => {
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'bob',
                quantity: '100.00000000 UOS',
                memo: 'Hi bob! Have a great day',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(6);
    });

    it('memo policy is unaffected by toolReturnedIdentifiers — memos must still come from the user', () => {
        // The W4 tool-returned identifiers source extends gate 5 ONLY. Gate
        // 6 is the phishing defense and stays user-text-only: even if "bob"
        // is in the tool response, "pay to bob" is not a memo the user
        // authored.
        const ctx: ValidateContext = {
            ...baseCtx,
            userMessage: 'transfer 100 UOS from duncan to bob',
            toolReturnedIdentifiers: new Set(['bob']),
        };
        const reply = transferReply({
            data: {
                from: 'duncan',
                to: 'bob',
                quantity: '100.00000000 UOS',
                memo: 'pay to bob',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(6);
    });
});

describe('validateAct — happy path output shape', () => {
    it('returns a structurally-clean act reply with coerced fields', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
        if (outcome.kind !== 'ok') return;
        const action = outcome.reply.actions[0]!;
        expect(action.contract).toBe('eosio.token');
        expect(action.action).toBe('transfer');
        expect(action.authorization).toEqual([{ actor: 'duncan', permission: 'active' }]);
        expect(action.data).toEqual({
            from: 'duncan',
            to: 'bob',
            quantity: '100.00000000 UOS',
            memo: '',
        });
    });
});

// W8 — telemetry-only `coerced: boolean` on the OK outcome. Observability
// for the per-turn usage-log middleware; no gate decision reads this field.
describe('validateAct — W8 coerced telemetry flag', () => {
    it('coerced === false when no field-shape branch reshapes the input', () => {
        const outcome = validateAct(transferReply(), catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') {
            expect(outcome.coerced).toBe(false);
        }
    });

    it('coerced === true when coerceLlmShape unwraps an auth-shape leak on a name field', () => {
        // `from: {actor: "duncan"}` is the auth-shape-leak branch in
        // coerceLlmShape — a real reshape (`coerced !== value`).
        const reply = transferReply({
            data: {
                from: { actor: 'duncan' } as unknown as string,
                to: 'bob',
                quantity: '100.00000000 UOS',
                memo: '',
            },
        });
        const outcome = validateAct(reply, catalog, eosioTypes, baseCtx);
        expect(outcome.kind).toBe('ok');
        if (outcome.kind === 'ok') {
            expect(outcome.coerced).toBe(true);
            // Sanity: the actual value is still the canonical string.
            expect(outcome.reply.actions[0]!.data.from).toBe('duncan');
        }
    });
});
