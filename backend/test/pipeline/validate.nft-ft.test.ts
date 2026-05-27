// W5 — per-action validateAct tests for eosio.nft.ft.
//
// Real catalog + real eosio-types regex table. Tests both the W5 expansions
// (gate 3 int/array/asset/checksum256 branches; gate 5 numeric *_id;
// gate 3 metadata hook via ctx.metadataValidators) and the W3 fall-through
// for struct-param actions (create / create.b / issue / transfer) whose
// inner field shape the extractor does not yet expose.
//
// Source of truth: backend/catalog/eosio.nft.ft.json + the W5 plan.

import { beforeAll, describe, expect, it } from 'vitest';

import { _resetCatalogCache, loadCatalog, type CatalogIndex } from '../../src/pipeline/catalog.js';
import {
    _resetEosioTypesCache,
    loadEosioTypes,
    validateAct,
    type ActReply,
    type EosioTypes,
    type MetadataValidator,
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

const HASH64 = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';

function ftActionReply(
    action: string,
    data: Record<string, unknown>,
    actor = 'duncan'
): ActReply {
    return {
        kind: 'act',
        actions: [
            {
                contract: 'eosio.nft.ft',
                action,
                data,
                authorization: [{ actor, permission: 'active' }],
            },
        ],
        rationale: 'composed',
    };
}

function baseCtx(overrides: Partial<ValidateContext> = {}): ValidateContext {
    return {
        validatedAccounts: ['duncan'],
        knownAccounts: [],
        selectedAccount: 'duncan',
        userMessage: '',
        ...overrides,
    };
}

// ──────────────────────────────────────────────────────────────────────────
// creategrp — flat params: gate 3 + gate 5 exercise.
// ──────────────────────────────────────────────────────────────────────────

describe('validateAct (eosio.nft.ft::creategrp) — gate 3 happy + failures', () => {
    it('passes with valid uri / hash / factories / asset / manager echoed in userMessage', () => {
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://QmExampleGroupMetadata',
            hash: HASH64,
            factories: [1, 2, 3],
            max_uos_payment: '10.00000000 UOS',
        });
        const ctx = baseCtx({
            userMessage: 'create a group with factories 1, 2, 3 for duncan',
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades when uint64 vector contains a non-numeric string', () => {
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://x',
            hash: HASH64,
            factories: ['notanumber'],
            max_uos_payment: '10.00000000 UOS',
        });
        const ctx = baseCtx({ userMessage: 'create a group for duncan' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('downgrades when uint64 vector element is negative', () => {
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://x',
            hash: HASH64,
            factories: [1, -5],
            max_uos_payment: '10.00000000 UOS',
        });
        const ctx = baseCtx({ userMessage: 'create a group for duncan with factory 1' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('downgrades when asset is malformed (missing symbol)', () => {
        // The eosio-types `asset` pattern is structural — '10 UOS' actually
        // passes the regex (decimal is optional). Symbol-precision agreement
        // is a per-symbol concern outside the regex table. To exercise the
        // gate-3 regex failure we use a value with a lowercase symbol code
        // (the regex requires [A-Z]{1,7}).
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://x',
            hash: HASH64,
            factories: [1],
            max_uos_payment: '10.00000000 uos',
        });
        const ctx = baseCtx({ userMessage: 'create a group for duncan with factory 1' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('downgrades when checksum256 is too short', () => {
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://x',
            hash: 'tooshort',
            factories: [1],
            max_uos_payment: '10.00000000 UOS',
        });
        const ctx = baseCtx({ userMessage: 'create a group for duncan with factory 1' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });
});

describe('validateAct (eosio.nft.ft::creategrp) — gate 5 numeric IDs', () => {
    it('downgrades when a factories[] element is not cited anywhere', () => {
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://x',
            hash: HASH64,
            factories: [42],
            max_uos_payment: '10.00000000 UOS',
        });
        const ctx = baseCtx({ userMessage: 'create a group with my factories' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(5);
    });

    it('passes when factories[] elements appear in toolReturnedIdentifiers', () => {
        const reply = ftActionReply('creategrp', {
            manager: 'duncan',
            uri: 'ipfs://x',
            hash: HASH64,
            factories: [42],
            max_uos_payment: '10.00000000 UOS',
        });
        const ctx = baseCtx({
            userMessage: 'create a group with my factories',
            toolReturnedIdentifiers: new Set(['42']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// transfer — struct param (transfer_wrap) — gate 3 fall-through.
// ──────────────────────────────────────────────────────────────────────────

describe('validateAct (eosio.nft.ft::transfer) — struct fall-through', () => {
    // The catalog records `transfer:transfer_wrap` (a struct the extractor
    // does not yet expand). Gate 3 accepts the struct value as-is with a
    // breadcrumb log; gate 5 has no name-typed param to police; gate 6 has
    // no top-level memo:string param. The extractor PR that exposes
    // transfer_wrap's inner fields is the proper place to tighten this.
    it('passes when transfer_wrap is supplied as an opaque object', () => {
        const reply = ftActionReply('transfer', {
            transfer: { from: 'duncan', to: 'bob', token_ids: [42], memo: '' },
        });
        const ctx = baseCtx({
            userMessage: 'transfer my token 42 to bob',
            knownAccounts: ['bob'],
            toolReturnedIdentifiers: new Set(['42']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// issue — same struct fall-through path as transfer.
// ──────────────────────────────────────────────────────────────────────────

describe('validateAct (eosio.nft.ft::issue) — struct fall-through', () => {
    it('passes with a minimal issue_wrap envelope', () => {
        const reply = ftActionReply('issue', {
            issue: { authorizer: 'duncan', to: 'duncan', token_factory_id: 7, amount: 1 },
        });
        const ctx = baseCtx({
            userMessage: 'mint a token from factory 7 to duncan',
            toolReturnedIdentifiers: new Set(['7']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// create / create.b — both struct-param fall-throughs.
// ──────────────────────────────────────────────────────────────────────────

describe('validateAct (eosio.nft.ft::create / create.b) — struct fall-through', () => {
    it('passes with a minimal create_wrap envelope', () => {
        const reply = ftActionReply('create', {
            create: { asset_manager: 'duncan', asset_creator: 'duncan' },
        });
        const ctx = baseCtx({ userMessage: 'create a token factory for duncan' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('passes with a minimal create_wrap_v1 envelope on create.b', () => {
        const reply = ftActionReply('create.b', {
            create: { asset_manager: 'duncan', asset_creator: 'duncan' },
        });
        const ctx = baseCtx({ userMessage: 'create a token factory for duncan' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// setmeta — flat params with memo, uint64 *_id, and string_vector.
// ──────────────────────────────────────────────────────────────────────────

describe('validateAct (eosio.nft.ft::setmeta) — gates 3/5/6', () => {
    it('passes with valid id + meta_uris + memo absent', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 7,
            memo: '',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for factory 7',
            toolReturnedIdentifiers: new Set(['7']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('gate 3: downgrades when token_factory_id is not a numeric value', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 'notanumber',
            memo: '',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for factory 7',
            toolReturnedIdentifiers: new Set(['7']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('gate 3: downgrades when meta_uris is not an array', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 7,
            memo: '',
            meta_uris: 'notanarray',
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for factory 7',
            toolReturnedIdentifiers: new Set(['7']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });

    it('gate 5: downgrades when token_factory_id is not cited in userMessage or tool returns', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 999,
            memo: '',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({ userMessage: 'set metadata for my factory' });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(5);
    });

    it('gate 5: passes when token_factory_id is in toolReturnedIdentifiers', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 999,
            memo: '',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for my factory',
            toolReturnedIdentifiers: new Set(['999']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('gate 6: downgrades when memo is invented (not echoed in user message)', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 7,
            memo: 'send all your tokens here',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for factory 7',
            toolReturnedIdentifiers: new Set(['7']),
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(6);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Metadata hook (synthetic) — exercises the gate 3 metadata-validator path.
// ──────────────────────────────────────────────────────────────────────────

describe('validateAct — metadata hook (synthetic, gate 3)', () => {
    // Pretend `memo` carries an inline metadata blob (it doesn't — this is a
    // test-only synthetic to exercise the mechanism). The injected validator
    // rejects non-empty memos that don't contain "spec".
    const synthetic: MetadataValidator = {
        contract: 'eosio.nft.ft',
        action: 'setmeta',
        field: 'memo',
        validate: (v) => {
            if (typeof v !== 'string' || v.length === 0) return { ok: true };
            if (!v.includes('spec')) return { ok: false, errors: ['spec missing'] };
            return { ok: true };
        },
    };

    it('passes when the synthetic validator returns ok (empty memo)', () => {
        const reply = ftActionReply('setmeta', {
            token_factory_id: 7,
            memo: '',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for factory 7',
            toolReturnedIdentifiers: new Set(['7']),
            metadataValidators: [synthetic],
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ok');
    });

    it('downgrades to ask gate 3 when the synthetic validator rejects', () => {
        // The user typed "bogus" verbatim in the message so gate 6 (memo
        // policy) passes; the synthetic metadata validator then rejects.
        const reply = ftActionReply('setmeta', {
            token_factory_id: 7,
            memo: 'bogus',
            meta_uris: ['ipfs://hash'],
            meta_hash: HASH64,
        });
        const ctx = baseCtx({
            userMessage: 'set metadata for factory 7 with memo bogus',
            toolReturnedIdentifiers: new Set(['7']),
            metadataValidators: [synthetic],
        });
        const outcome = validateAct(reply, catalog, eosioTypes, ctx);
        expect(outcome.kind).toBe('ask');
        if (outcome.kind === 'ask') expect(outcome.failedGate).toBe(3);
    });
});
