// Wallet-native attestation middleware verification tests (W9, docs/00 §3.7).
//
// The middleware is OPPORTUNISTIC: any failure (bad signature, expired, wrong
// origin/chain, malformed, schema, unknown version, absent header) clears
// identity and falls through — it NEVER 401s. These tests assert identity is
// attached on the happy path and null on every failure path, status always 200.
//
// Canonical hashing MUST match the middleware: sorted top-level keys. We re-sign
// any payload we mutate so the only signature-failure case is case 3.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Bytes, Checksum256, PrivateKey, Signature } from '@wharfkit/antelope';

import { attestation, type IdentityVariables } from '../../src/middleware/attestation.js';

const PRIV = PrivateKey.generate('K1');
const PUB = PRIV.toPublic().toString();
// A second key whose pubkey differs from PUB — used for the bad-signature case.
const PRIV2 = PrivateKey.generate('K1');

const NOW = 1_700_000_000;

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

function basePayload(overrides: Partial<Payload> = {}): Payload {
    return {
        v: 1,
        pubkey: PUB,
        account: 'alice',
        permission: 'active',
        origin: 'http://localhost:5172',
        chainId: 'CHAIN_A',
        iat: NOW - 10,
        exp: NOW + 3600,
        nonce: 'deadbeef'.repeat(8),
        signableAccounts: [
            { account: 'alice', permissions: ['active'] },
            { account: 'alice.x', permissions: ['active'] },
        ],
        ...overrides,
    };
}

function makeApp() {
    const app = new Hono<IdentityVariables>();
    app.use(
        '/p',
        attestation({ allowedOrigins: ['http://localhost:5172'], expectedChainId: 'CHAIN_A', now: () => NOW })
    );
    app.get('/p', (c) => c.json({ identity: c.get('identity') ?? null }));
    return app;
}

async function probe(headers: Record<string, string> = {}) {
    const app = makeApp();
    const res = await app.request('/p', { headers });
    const body = (await res.json()) as { identity: IdentityVariables['Variables']['identity'] | null };
    return { res, identity: body.identity };
}

describe('attestation middleware — verification', () => {
    it('1. happy path → identity attached', async () => {
        const att = makeAttestation(basePayload());
        const { res, identity } = await probe({ authorization: header(att) });
        expect(res.status).toBe(200);
        expect(identity).not.toBeNull();
        expect(identity!.pubkey).toBe(PUB);
        expect(identity!.account).toBe('alice');
        expect(identity!.permission).toBe('active');
        expect(identity!.signableAccounts).toHaveLength(2);
    });

    it('2. happy path without signableAccounts → defaults to primary account', async () => {
        const p = basePayload();
        delete p.signableAccounts;
        const att = makeAttestation(p);
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).not.toBeNull();
        expect(identity!.signableAccounts).toEqual([{ account: 'alice', permissions: ['active'] }]);
    });

    it('3. bad signature → identity null', async () => {
        // Sign with a different key whose pubkey differs from payload.pubkey.
        const p = basePayload();
        const att = { payload: p, signature: sign(p, PRIV2) };
        const { res, identity } = await probe({ authorization: header(att) });
        expect(res.status).toBe(200);
        expect(identity).toBeNull();
    });

    it('4. expired (exp = NOW-1) → null', async () => {
        const att = makeAttestation(basePayload({ exp: NOW - 1 }));
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).toBeNull();
    });

    it('4b. boundary: exp == NOW → null (check is exp <= now, not exp < now)', async () => {
        const att = makeAttestation(basePayload({ exp: NOW }));
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).toBeNull();
    });

    it('5. future iat beyond skew → null; borderline within skew → verifies', async () => {
        const future = makeAttestation(basePayload({ iat: NOW + 120 }));
        const { identity: futureIdentity } = await probe({ authorization: header(future) });
        expect(futureIdentity).toBeNull();

        const borderline = makeAttestation(basePayload({ iat: NOW + 30 }));
        const { identity: borderIdentity } = await probe({ authorization: header(borderline) });
        expect(borderIdentity).not.toBeNull();
    });

    it('6. wrong origin → null', async () => {
        const att = makeAttestation(basePayload({ origin: 'http://evil.example' }));
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).toBeNull();
    });

    it('7. wrong chainId (expectedChainId CHAIN_A) → null', async () => {
        const att = makeAttestation(basePayload({ chainId: 'CHAIN_B' }));
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).toBeNull();
    });

    it('8. malformed base64url/JSON → null, status 200, no throw', async () => {
        const { res, identity } = await probe({ authorization: 'Attestation !!!not-base64!!!' });
        expect(res.status).toBe(200);
        expect(identity).toBeNull();
    });

    it('9. missing required field (no pubkey) → null', async () => {
        const p = basePayload();
        delete (p as unknown as Record<string, unknown>).pubkey;
        const att = makeAttestation(p as unknown as Payload);
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).toBeNull();
    });

    it('10. unknown version (v: 2) → null', async () => {
        const p = basePayload({ v: 2 as unknown as 1 });
        const att = makeAttestation(p);
        const { identity } = await probe({ authorization: header(att) });
        expect(identity).toBeNull();
    });

    it('11. no Authorization header → identity null, status 200', async () => {
        const { res, identity } = await probe();
        expect(res.status).toBe(200);
        expect(identity).toBeNull();
    });

    it('12. stray non-Attestation header → identity null, status 200', async () => {
        const { res, identity } = await probe({ authorization: 'Bearer xyz' });
        expect(res.status).toBe(200);
        expect(identity).toBeNull();
    });
});
