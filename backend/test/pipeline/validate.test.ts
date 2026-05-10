import { describe, expect, it, beforeEach } from 'vitest';
import { validateProposal } from '../../src/pipeline/validate.js';
import type { RetrievedAction } from '../../src/pipeline/retrieve.js';
import type { PromptContext } from '../../src/pipeline/prompt.js';
import type { Db } from '../../src/db/client.js';
import type { ActionRules } from '../../src/extractor/types.js';

type IncidentRow = { userId: string | null; kind: string; detail: Record<string, unknown> };

function makeFakeDb(): { db: Db; rows: IncidentRow[] } {
    const rows: IncidentRow[] = [];
    const fake = {
        insert(_table: unknown) {
            return {
                values(row: IncidentRow | IncidentRow[]) {
                    if (Array.isArray(row)) rows.push(...row);
                    else rows.push(row);
                    return Promise.resolve();
                },
            };
        },
    };
    // db type is large; only `insert(incidents).values()` is used by validate.ts
    return { db: fake as unknown as Db, rows };
}

const transferRules: ActionRules = {
    contract: 'eosio.token',
    action: 'transfer',
    params: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' },
    ],
    auths: [{ actor: '$from', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: ['$from', '$to'],
    source: { path: 'src/eosio.token.cpp', lines: [10, 30] },
};

const transferRetrieved: RetrievedAction = {
    actionId: 1n,
    contract: 'eosio.token',
    action: 'transfer',
    rules: transferRules,
    fields: transferRules.params,
    defaultAuth: { actor: '$from', permission: 'active' },
    isAdmin: false,
    description: 'Transfer tokens.',
    examples: null,
    bestDistance: 0.1,
};

const adminRules: ActionRules = {
    contract: 'eosio.token',
    action: 'create',
    params: [
        { name: 'issuer', type: 'name' },
        { name: 'maximum_supply', type: 'asset' },
    ],
    auths: [{ actor: 'eosio.token', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/eosio.token.cpp', lines: [40, 60] },
};

const adminRetrieved: RetrievedAction = {
    actionId: 2n,
    contract: 'eosio.token',
    action: 'create',
    rules: adminRules,
    fields: adminRules.params,
    defaultAuth: { actor: 'eosio.token', permission: 'active' },
    isAdmin: true,
    description: 'Create a new token.',
    examples: null,
    bestDistance: 0.2,
};

const baseContext: PromptContext = {
    account: 'alice',
    permission: 'active',
    endpoint: 'https://api.example',
    chainId: 'fakechain',
    isAdmin: false,
    knownAccounts: ['alice', 'bob'],
};

describe('validateProposal', () => {
    let fake: ReturnType<typeof makeFakeDb>;

    beforeEach(() => {
        fake = makeFakeDb();
    });

    it('returns a valid propose unchanged', async () => {
        const raw = {
            kind: 'propose',
            contract: 'eosio.token',
            action: 'transfer',
            data: { from: 'alice', to: 'bob', quantity: '100.0000 UOS', memo: 'gift' },
            authorization: { actor: 'alice', permission: 'active' },
            rationale: 'Sending tokens.',
        };
        const r = await validateProposal(
            { raw, retrieved: [transferRetrieved], context: baseContext, userId: null, sessionId: null },
            { db: fake.db }
        );
        expect(r.kind).toBe('propose');
        if (r.kind !== 'propose') return;
        expect(r.data).toEqual(raw.data);
        expect(r.authorization).toEqual(raw.authorization);
        expect(r.rationale).toBe('Sending tokens.');
        expect(fake.rows).toHaveLength(0);
    });

    it('downgrades to ask when a name field fails the regex', async () => {
        const raw = {
            kind: 'propose',
            contract: 'eosio.token',
            action: 'transfer',
            data: { from: 'ALICE', to: 'bob', quantity: '100.0000 UOS', memo: 'hi' },
            authorization: { actor: 'alice', permission: 'active' },
            rationale: 'Sending tokens.',
        };
        const r = await validateProposal(
            { raw, retrieved: [transferRetrieved], context: baseContext, userId: null, sessionId: null },
            { db: fake.db }
        );
        expect(r).toEqual({ kind: 'ask', question: 'What is the from?' });
        expect(fake.rows).toHaveLength(1);
        expect(fake.rows[0]?.kind).toBe('schema-fail');
        expect(fake.rows[0]?.detail.reason).toBe('regex-fail');
    });

    it('proposes admin action under non-admin context (wallet/chain is the gate)', async () => {
        const raw = {
            kind: 'propose',
            contract: 'eosio.token',
            action: 'create',
            data: { issuer: 'eosio.token', maximum_supply: '1000.00000000 UOS' },
            authorization: { actor: 'eosio.token', permission: 'active' },
            rationale: 'Create a token.',
        };
        const r = await validateProposal(
            { raw, retrieved: [adminRetrieved], context: baseContext, userId: null, sessionId: null },
            { db: fake.db }
        );
        expect(r.kind).toBe('propose');
        expect(fake.rows).toHaveLength(0);
    });

    it('downgrades to ask when a required field is missing', async () => {
        const raw = {
            kind: 'propose',
            contract: 'eosio.token',
            action: 'transfer',
            data: { to: 'bob', quantity: '100.0000 UOS', memo: 'hi' },
            authorization: { actor: 'alice', permission: 'active' },
            rationale: 'Sending tokens.',
        };
        const r = await validateProposal(
            { raw, retrieved: [transferRetrieved], context: baseContext, userId: null, sessionId: null },
            { db: fake.db }
        );
        expect(r).toEqual({ kind: 'ask', question: 'What is the from?' });
        expect(fake.rows).toHaveLength(1);
        expect(fake.rows[0]?.kind).toBe('schema-fail');
        expect(fake.rows[0]?.detail.reason).toBe('missing-field');
    });

    it('refuses on malformed shape with no further validation', async () => {
        const raw = { kind: 'banana' };
        const r = await validateProposal(
            { raw, retrieved: [transferRetrieved], context: baseContext, userId: null, sessionId: null },
            { db: fake.db }
        );
        expect(r.kind).toBe('refuse');
        expect(fake.rows).toHaveLength(1);
        expect(fake.rows[0]?.kind).toBe('schema-fail');
    });

    it('strips a URL from rationale and writes an output-blocked incident', async () => {
        const raw = {
            kind: 'propose',
            contract: 'eosio.token',
            action: 'transfer',
            data: { from: 'alice', to: 'bob', quantity: '100.0000 UOS', memo: 'hi' },
            authorization: { actor: 'alice', permission: 'active' },
            rationale: 'See https://evil.example/x for more info.',
        };
        const r = await validateProposal(
            { raw, retrieved: [transferRetrieved], context: baseContext, userId: null, sessionId: null },
            { db: fake.db }
        );
        expect(r.kind).toBe('propose');
        if (r.kind !== 'propose') return;
        expect(r.rationale).not.toContain('https://');
        expect(fake.rows.some((row) => row.kind === 'output-blocked')).toBe(true);
    });
});
