// W8 regression baseline — the determinism contract from
// `docs/00-ai-global-guidelines.md` §6: "same catalog + same user message
// + same session context + same provider:model → same (contract, action)
// pair. Rationale prose may vary."
//
// What this test does:
//   1. Reads every fixture under test/fixtures/baseline/ (operator-seeded,
//      NEVER re-seeded by this test — §6 closing rule).
//   2. For each fixture, builds a deterministic mock ChatProvider whose
//      .chat() returns a hardcoded JSON object keyed by fixture name. The
//      hardcoded responses are crafted to satisfy validate.ts's gate stack
//      (gates 1–6 for act, gates 1–7 for propose, gates A1–A3 for answer).
//   3. POSTs the fixture's `request` to /api/ai-chat via the in-process
//      Hono app (LOOPBACK env so DEV_RATELIMIT_BYPASS short-circuits the
//      per-IP rate limit; mirrors the existing route tests). Anonymous
//      backend per docs/00 §3.1 — no Authorization header needed.
//   4. Asserts ONLY the (contract, action) pair (plus proposalName +
//      requested.length for propose, plus "contains" substring for
//      answer). NEVER asserts rationale prose — that's the §6 carve-out.
//
// Drift detector: when a planner/classifier change accidentally reroutes
// a known intent (e.g. token::transfer → some other contract), CI fails.
// Adding a new fixture requires only dropping a file in the baseline
// directory — the test iterates via readdir.
//
// Defensive about the response wrapper: a downstream task may wrap the
// reply as `{ reply, usage }`. If the body has a `reply` field, unwrap it
// before the assertions.

import { describe, it, expect, beforeEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, type AppConfig } from '../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../src/llm/provider.js';
import { _resetCatalogCache } from '../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../src/pipeline/validate.js';

const LOOPBACK_ENV = { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as const;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'fixtures', 'baseline');

const baseCfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'ollama', // ignored — we inject a mock provider per fixture
    allowedChainHosts: ['localhost', '127.0.0.1'],
};

// Fixture file shape. expectedReply is the §6 (contract, action)-only
// assertion target — never the full reply. The mock response the test
// constructs lives in MOCK_RESPONSES below, keyed by fixture name.
type FixtureAct = {
    name: string;
    request: unknown;
    expectedReply: {
        kind: 'act';
        actions: Array<{ contract: string; action: string }>;
    };
};
type FixturePropose = {
    name: string;
    request: unknown;
    expectedReply: {
        kind: 'propose';
        proposalName: string;
        actions: Array<{ contract: string; action: string }>;
        requestedCount: number;
    };
};
type FixtureAnswer = {
    name: string;
    request: unknown;
    expectedReply: {
        kind: 'answer';
        contains: string;
    };
};
type Fixture = FixtureAct | FixturePropose | FixtureAnswer;

// ──────────────────────────────────────────────────────────────────────────
// Hardcoded mock provider responses keyed by fixture name. Each response is
// what the model SHOULD have emitted for that fixture's user message; the
// shape must pass the relevant validate.ts gate stack (gate 5 in particular
// requires every name-typed identifier to trace to the user message,
// knownAccounts, or selectedAccount — anonymous backend per docs/00 §3.1).
// ──────────────────────────────────────────────────────────────────────────

const MOCK_RESPONSES: Record<string, ChatResponse> = {
    'token-transfer-happy': {
        json: {
            kind: 'act',
            rationale: 'compose UOS transfer from duncan to bob',
            actions: [
                {
                    contract: 'eosio.token',
                    action: 'transfer',
                    data: {
                        from: 'duncan',
                        to: 'bob',
                        // 8-decimal precision per known-symbols.json — UOS
                        // core token. Mirrors ai-chat.test.ts happy path.
                        quantity: '100.00000000 UOS',
                        memo: '',
                    },
                    authorization: [{ actor: 'duncan', permission: 'active' }],
                },
            ],
        },
        usage: { input: 200, output: 80 },
    },

    'nft-ft-create-happy': {
        // create.b is the v1 successor to `create` (catalog row
        // `eosio.nft.ft::create.b`). Its top-level param is a struct
        // (`create: create_wrap_v1`) whose inner shape is NOT validated
        // by gate 3 — the extractor doesn't expand struct inner fields,
        // so checkFieldShape falls through. Top-level `create` field is
        // therefore an opaque struct blob; only the actor + permission
        // need to be cited. duncan@active is sourced from
        // validatedAccounts + selectedAccount.
        json: {
            kind: 'act',
            rationale: 'create an NFT factory v1 for duncan',
            actions: [
                {
                    contract: 'eosio.nft.ft',
                    action: 'create.b',
                    data: {
                        create: {
                            asset_manager: 'duncan',
                            asset_creator: 'duncan',
                            max_mintable_tokens: 1000,
                        },
                    },
                    authorization: [{ actor: 'duncan', permission: 'active' }],
                },
            ],
        },
        usage: { input: 260, output: 80 },
    },

    'nft-ft-transfer-happy': {
        // transfer's top-level param is `transfer: transfer_wrap` (struct).
        // Gate 5 doesn't drill into struct fields, so {from,to,token_ids}
        // are not separately gated. token id 42 is cited by the user
        // message via `userMessageContains` if it ever surfaces at a gated
        // level. Mirrors ai-chat.nft-ft-transfer.test.ts shape.
        json: {
            kind: 'act',
            rationale: 'transfer NFT token 42 from duncan to bob',
            actions: [
                {
                    contract: 'eosio.nft.ft',
                    action: 'transfer',
                    data: {
                        transfer: {
                            from: 'duncan',
                            to: 'bob',
                            token_ids: [42],
                            memo: '',
                        },
                    },
                    authorization: [{ actor: 'duncan', permission: 'active' }],
                },
            ],
        },
        usage: { input: 260, output: 80 },
    },

    'msig-propose-happy': {
        // Inner action is eosio.token::transfer (gates 1–6 on inner);
        // proposalName + approvers are gated by gate 7. The user message
        // names "txproposal1", "ceo", and "cfo" explicitly so gate 7.4
        // (every requested actor must be cited) passes.
        json: {
            kind: 'propose',
            proposalName: 'txproposal1',
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
                },
            ],
            requested: [
                { actor: 'ceo', permission: 'active' },
                { actor: 'cfo', permission: 'active' },
            ],
            rationale: 'pay vendor via multisig',
        },
        usage: { input: 220, output: 95 },
    },

    'answer-grounded-happy': {
        // Gate A2: every contract::action pair in the text must be in
        // catalog.byKey. eosio.nft.ft::transfer is real (see
        // backend/catalog/eosio.nft.ft.json action `transfer`). The
        // verbatim string is asserted by the test.
        json: {
            kind: 'answer',
            text:
                'The eosio.nft.ft::transfer action moves a uniq from the owner to another account.' +
                ' It requires authorization from the current owner.',
        },
        usage: { input: 200, output: 80 },
    },
};

// Mock provider factory — looks up the response by fixture name. Each
// fixture's request carries the same content as the lookup key (the user
// message in the fixture maps 1:1 to a fixture name, so the test never
// asks the real model anything).
function fixtureProvider(fixtureName: string): ChatProvider {
    const response = MOCK_RESPONSES[fixtureName];
    if (!response) {
        throw new Error(`baseline test: no mock response wired for fixture ${fixtureName}`);
    }
    return {
        async chat(_req: ChatRequest): Promise<ChatResponse> {
            return response;
        },
        modelTag(): string {
            return 'mock:w8-baseline';
        },
    };
}

beforeEach(() => {
    _resetCatalogCache();
    _resetEosioTypesCache();
});

// Defensive unwrap — a downstream task may wrap the reply as
// `{ reply, usage }`. Today the route returns the Reply object directly,
// but the brief calls out that the wrapper may land later; this helper
// keeps the test stable across the change.
function unwrapBody(body: unknown): Record<string, unknown> {
    if (
        body !== null &&
        typeof body === 'object' &&
        'reply' in body &&
        typeof (body as { reply: unknown }).reply === 'object' &&
        (body as { reply: unknown }).reply !== null
    ) {
        return (body as { reply: Record<string, unknown> }).reply;
    }
    return body as Record<string, unknown>;
}

// Iterate fixtures via readdir so adding a new fixture later only needs
// the file — no test code change. This is the §6 "operator-seeded only"
// shape: the test reads what's there, never writes.
async function loadFixtures(): Promise<Fixture[]> {
    const entries = await readdir(FIXTURE_DIR);
    const jsonFiles = entries.filter((name) => name.endsWith('.json')).sort();
    const out: Fixture[] = [];
    for (const fileName of jsonFiles) {
        const raw = await readFile(join(FIXTURE_DIR, fileName), 'utf8');
        out.push(JSON.parse(raw) as Fixture);
    }
    return out;
}

const fixtures = await loadFixtures();

describe('POST /api/ai-chat — W8 regression baseline (determinism §6)', () => {
    for (const fixture of fixtures) {
        it(`${fixture.name}: stable (contract, action) pair`, async () => {
            const provider = fixtureProvider(fixture.name);
            const app = await createApp(baseCfg, { provider });

            const res = await app.request(
                '/api/ai-chat',
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(fixture.request),
                },
                LOOPBACK_ENV
            );

            expect(res.status).toBe(200);
            const raw = await res.json();
            const body = unwrapBody(raw);

            // §6: assert ONLY the (contract, action) pair (+ proposalName +
            // requested count for propose, + verbatim contains for answer).
            // NEVER assert rationale prose.
            if (fixture.expectedReply.kind === 'act') {
                expect(body.kind).toBe('act');
                const actions = body.actions as Array<{ contract: string; action: string }>;
                const got = actions[0];
                const want = fixture.expectedReply.actions[0];
                expect(got).toBeDefined();
                expect(want).toBeDefined();
                expect(got!.contract).toBe(want!.contract);
                expect(got!.action).toBe(want!.action);
            } else if (fixture.expectedReply.kind === 'propose') {
                expect(body.kind).toBe('propose');
                expect(body.proposalName).toBe(fixture.expectedReply.proposalName);
                const actions = body.actions as Array<{ contract: string; action: string }>;
                const got = actions[0];
                const want = fixture.expectedReply.actions[0];
                expect(got).toBeDefined();
                expect(want).toBeDefined();
                expect(got!.contract).toBe(want!.contract);
                expect(got!.action).toBe(want!.action);
                const requested = body.requested as unknown[];
                expect(requested).toHaveLength(fixture.expectedReply.requestedCount);
            } else {
                expect(body.kind).toBe('answer');
                const text = body.text as string;
                expect(text.length).toBeGreaterThan(0);
                expect(text).toContain(fixture.expectedReply.contains);
            }
        });
    }
});
