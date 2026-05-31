// /api/ai-chat — attested-caller integration (W9, docs/00 §3.7).
//
// Full-app via createApp with a mock provider so no LLM machinery runs. A valid
// attestation attaches identity; the balance gate sums injected UOS; the usage
// row records identity_pubkey_hash alongside client_ip_hash. The balance gate
// refuses (bare {kind,reason}) before the route's {reply,usage} envelope when
// the summed UOS is below threshold.

import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bytes, Checksum256, PrivateKey, Signature } from '@wharfkit/antelope';

import { createApp, type AppConfig } from '../../src/index.js';
import type { ChatProvider, ChatRequest, ChatResponse } from '../../src/llm/provider.js';
import { _resetCatalogCache } from '../../src/pipeline/catalog.js';
import { _resetEosioTypesCache } from '../../src/pipeline/validate.js';

const NOW = 1_700_000_000; // unix seconds

const PRIV = PrivateKey.generate('K1');
const PUB = PRIV.toPublic().toString();

type Payload = {
    v: 1;
    pubkey: string;
    account: string;
    permission: string;
    origin: string;
    chainId: string;
    iat: number;
    exp: number;
    nonce: string;
    signableAccounts?: Array<{ account: string; permissions: string[] }>;
};

function canonical(payload: Payload): string {
    return JSON.stringify(payload, Object.keys(payload).sort());
}
function sign(payload: Payload, priv: PrivateKey = PRIV): string {
    const hash = Checksum256.hash(Bytes.from(canonical(payload), 'utf8'));
    return priv.signDigest(hash).toString();
}
function makeAttestation(payload: Payload, priv: PrivateKey = PRIV) {
    return { payload, signature: sign(payload, priv) };
}
function header(att: { payload: Payload; signature: string }): string {
    return `Attestation ${Buffer.from(JSON.stringify(att)).toString('base64url')}`;
}

const cfg: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'ollama',
    allowedChainHosts: ['localhost', '127.0.0.1'],
    balanceThresholdUos: 1,
    attestationChainId: 'CHAIN_A',
};

function mockProvider(): ChatProvider {
    return {
        async chat(_req: ChatRequest): Promise<ChatResponse> {
            return {
                json: { kind: 'ask', question: 'Could you describe the transaction in more detail?' },
                usage: { input: 10, output: 5 },
            };
        },
        modelTag(): string {
            return 'anthropic:haiku-4-5';
        },
    };
}

function attestationHeader(): string {
    const att = makeAttestation({
        v: 1,
        pubkey: PUB,
        account: 'alice',
        permission: 'active',
        origin: 'http://localhost:5172',
        chainId: 'CHAIN_A',
        iat: NOW - 10,
        exp: NOW + 3600,
        nonce: 'deadbeef'.repeat(8),
        signableAccounts: [{ account: 'alice', permissions: ['active'] }],
    });
    return header(att);
}

const body = {
    sessionId: 's-att',
    messages: [{ role: 'user' as const, content: 'tell me more please' }],
    context: {
        validatedAccounts: ['alice'],
        knownAccounts: [],
        selectedAccount: 'alice',
        chainId: 'CHAIN_A',
        endpoint: 'http://localhost:8888',
    },
};

async function readRows(logPath: string): Promise<Array<Record<string, unknown>>> {
    const raw = await readFile(logPath, 'utf8');
    return raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let logPath: string;

beforeEach(() => {
    _resetCatalogCache();
    _resetEosioTypesCache();
    logPath = join(tmpdir(), `ai-chat-attested-${randomUUID()}.jsonl`);
});

afterEach(async () => {
    await rm(logPath, { force: true });
    vi.clearAllMocks();
});

describe('POST /api/ai-chat — attested caller (W9)', () => {
    it('valid attestation + sufficient balance → 200, reply present, row records identity_pubkey_hash', async () => {
        const app = await createApp(cfg, {
            provider: mockProvider(),
            usageLogPath: logPath,
            attestationNow: () => NOW,
            readUosBalance: async () => 5,
        });
        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: attestationHeader() },
                body: JSON.stringify(body),
            },
            { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
        );
        expect(res.status).toBe(200);
        const envelope = (await res.json()) as { reply: { kind: string } };
        expect(envelope.reply.kind).toBeDefined();

        const rows = await readRows(logPath);
        expect(rows.length).toBe(1);
        const row = rows[0]!;
        expect(row.identity_pubkey_hash).toBe(createHash('sha256').update(PUB).digest('hex'));
        expect(typeof row.client_ip_hash).toBe('string');
        expect((row.client_ip_hash as string).length).toBeGreaterThan(0);
    });

    it('insufficient balance → bare refuse insufficient-uos (before the reply envelope)', async () => {
        const app = await createApp(cfg, {
            provider: mockProvider(),
            usageLogPath: logPath,
            attestationNow: () => NOW,
            readUosBalance: async () => 0,
        });
        const res = await app.request(
            '/api/ai-chat',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: attestationHeader() },
                body: JSON.stringify(body),
            },
            { incoming: { socket: { remoteAddress: '127.0.0.1' } } }
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'insufficient-uos' });
    });
});
