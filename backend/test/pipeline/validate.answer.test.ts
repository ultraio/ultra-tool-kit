// W7 — validateAnswer tests.
//
// Mirrors validate.test.ts / validate.propose.test.ts: real catalog
// (loadCatalog), one describe per gate. Per the W7 prompt's simplifier
// exclusion list, each gate (A1, A2, A3) stays its own named branch and
// each test pins a single failure / success mode.
//
// Coverage:
//   - A1 happy: short, real text → ok.
//   - A1 fail: empty after cleanText (text is only URLs / markdown images).
//   - A1 fail: text length > ANSWER_MAX_CHARS.
//   - A2 happy: text references a real (eosio.nft.ft, transfer) pair → ok.
//   - A2 fail: invented (contract, action) pair → refuse 'unsupported-reference'.
//   - A2 fail: invented contract (not in catalog AND not in
//     toolReturnedIdentifiers) → refuse.
//   - A2 pass via toolReturnedIdentifiers: contract not in catalog but
//     surfaced by a get_abi this turn → ok.
//   - A3 fail: text contains a JSON object literal with contract+action+data
//     keys → refuse.
//   - A3 pass: prose mentions the words "transfer" and "data" but no
//     literal contract/action/data JSON object → ok.

import { beforeAll, describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog, type CatalogIndex } from '../../src/pipeline/catalog.js';
import {
    type AnswerReply,
    type ValidateContext,
    validateAnswer,
} from '../../src/pipeline/validate.js';

let catalog: CatalogIndex;

beforeAll(async () => {
    _resetCatalogCache();
    catalog = await loadCatalog();
});

const baseCtx: ValidateContext = {
    validatedAccounts: ['duncan'],
    knownAccounts: [],
    selectedAccount: 'duncan',
    userMessage: 'what does eosio.nft.ft::transfer do?',
};

function ans(text: string): AnswerReply {
    return { kind: 'answer', text };
}

describe('validateAnswer — gate A1 (text shape)', () => {
    it('passes a short, real, grounded answer', () => {
        const reply = ans(
            'The eosio.nft.ft::transfer action moves a uniq from one account to another. It requires authorization from the owner.'
        );
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('ok');
    });

    it('refuses when cleanText scrubs the entire body to empty', () => {
        // Text is only a markdown image + URL — cleanText drops both → empty.
        const reply = ans('![pic](https://x.com/img.png) https://example.com');
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('refuse');
        if (out.kind === 'refuse') {
            expect(out.failedGate).toBe('A1');
            expect(out.reason).toBe('malformed-answer');
        }
    });

    it('refuses when text exceeds the 2000-char cap', () => {
        // 2001 chars of prose. No URL/image scrubbing — pure text bypasses
        // the cleanText-empty path and trips the length cap instead.
        const reply = ans('a'.repeat(2001));
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('refuse');
        if (out.kind === 'refuse') {
            expect(out.failedGate).toBe('A1');
            expect(out.reason).toBe('malformed-answer');
        }
    });
});

describe('validateAnswer — gate A2 (contract::action grounding)', () => {
    it('passes when every (contract, action) pair exists in the catalog', () => {
        const reply = ans(
            'eosio.token::transfer moves a fungible token. eosio.nft.ft::transfer moves a uniq. Both require auth from the owner.'
        );
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('ok');
    });

    it('refuses when the (contract, action) pair is not in the catalog', () => {
        // eosio.token exists; magicaction does not.
        const reply = ans('The eosio.token::magicaction action does something cool.');
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('refuse');
        if (out.kind === 'refuse') {
            expect(out.failedGate).toBe('A2');
            expect(out.reason).toBe('unsupported-reference');
        }
    });

    it('refuses when the contract itself is invented (not catalog, not tool-returned)', () => {
        const reply = ans('fake.contract::transfer is a totally legitimate action.');
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('refuse');
        if (out.kind === 'refuse') {
            expect(out.failedGate).toBe('A2');
            expect(out.reason).toBe('unsupported-reference');
        }
    });

    it('passes a non-cataloged contract when its name appears in toolReturnedIdentifiers', () => {
        // Simulates the model calling get_abi on a non-cataloged contract
        // this turn; the route handler adds the contract name to
        // toolReturnedIdentifiers via extractIdentifiers. The validator
        // then accepts pairs whose contract appears in that Set.
        const ctxWithTool: ValidateContext = {
            ...baseCtx,
            toolReturnedIdentifiers: new Set(['someoldcntr']),
        };
        const reply = ans('The someoldcntr::burn action destroys a token. It requires owner auth.');
        const out = validateAnswer(reply, catalog, ctxWithTool);
        expect(out.kind).toBe('ok');
    });
});

describe('validateAnswer — gate A3 (no smuggled JSON action)', () => {
    it('refuses when the text contains a JSON object with contract+action+data keys', () => {
        // Verbatim JSON shaped like a Reply action. The validator must
        // reject regardless of the surrounding prose — a phishing/UI-
        // confusion defense (§4.4).
        const reply = ans(
            'Here is an example: {"contract": "eosio.token", "action": "transfer", "data": {"from": "alice"}}'
        );
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('refuse');
        if (out.kind === 'refuse') {
            expect(out.failedGate).toBe('A3');
            expect(out.reason).toBe('unsupported-reference');
        }
    });

    it('refuses when the JSON object uses a different key ordering', () => {
        // The regex permutes — any permutation of the three keys within a
        // 200-char window of an opening brace must be rejected.
        const reply = ans(
            'Here: {"data": {"x": 1}, "action": "transfer", "contract": "eosio.token"}'
        );
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('refuse');
        if (out.kind === 'refuse') {
            expect(out.failedGate).toBe('A3');
        }
    });

    it('passes when the text uses words "data" and "transfer" but no JSON action literal', () => {
        // Legitimate prose explaining the data shape — uses the words but
        // never packs all three of {contract, action, data} into a JSON
        // object together. The tight 3-key regex preserves this case.
        const reply = ans(
            "The eosio.token::transfer action's data field includes from, to, quantity, and memo."
        );
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('ok');
    });
});

// W8 — telemetry-only `coerced: boolean` on the OK outcome. Answer never
// reshapes anything today (gates A1–A3 don't have coerce branches), so this
// is always `false`. Plumbed for uniformity with act/propose.
describe('validateAnswer — W8 coerced telemetry flag', () => {
    it('coerced === false on every OK answer path', () => {
        const reply = ans(
            'The eosio.nft.ft::transfer action moves a uniq from one account to another.'
        );
        const out = validateAnswer(reply, catalog, baseCtx);
        expect(out.kind).toBe('ok');
        if (out.kind === 'ok') {
            expect(out.coerced).toBe(false);
        }
    });
});
