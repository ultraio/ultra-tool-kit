// Challenge/verify route contract tests (guidelines §3.2).
//
// Signature verification mocked at the verify-signature.ts boundary per the
// W1.5 prompt — never make real crypto calls in tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { jwtVerify } from 'jose';

import { createAuthRouter } from '../../src/routes/auth.js';
import { NonceStore } from '../../src/auth/nonce-store.js';
import { subFromPubkey } from '../../src/auth/jwt.js';

const readJson = async <T>(res: Response): Promise<T> => (await res.json()) as T;

vi.mock('../../src/auth/verify-signature.js', () => ({
    verifySignature: vi.fn(),
}));

import { verifySignature } from '../../src/auth/verify-signature.js';

const JWT_SECRET = 'test-secret-w1.5';
const PUBKEY = 'PUB_K1_5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';

function makeApp(ttlMs = 5 * 60_000) {
    const nonceStore = new NonceStore(ttlMs);
    const router = createAuthRouter({ nonceStore, jwtSecret: JWT_SECRET });
    const app = new Hono();
    app.route('/api/auth', router);
    return { app, nonceStore };
}

const validBody = (nonce: string) => ({
    nonce,
    signature: 'SIG_K1_xxxxxxxxxxxxxxxxxx',
    pubkey: PUBKEY,
    account: 'duncan',
    permission: 'active',
    chainId: 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097',
});

beforeEach(() => {
    vi.mocked(verifySignature).mockReset();
    vi.mocked(verifySignature).mockReturnValue(true);
});

afterEach(() => vi.clearAllMocks());

describe('POST /api/auth/challenge', () => {
    it('returns a fresh nonce and an ISO expiry', async () => {
        const { app } = makeApp();
        const res = await app.request('/api/auth/challenge', { method: 'POST' });
        expect(res.status).toBe(200);
        const body = await readJson<{ nonce: string; expiresAt: string }>(res);
        expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('issues a unique nonce per call', async () => {
        const { app } = makeApp();
        const a = await readJson<{ nonce: string }>(
            await app.request('/api/auth/challenge', { method: 'POST' })
        );
        const b = await readJson<{ nonce: string }>(
            await app.request('/api/auth/challenge', { method: 'POST' })
        );
        expect(a.nonce).not.toBe(b.nonce);
    });
});

describe('POST /api/auth/verify', () => {
    it('issues a JWT with §3.2 claim set verbatim on success', async () => {
        const { app } = makeApp();
        const { nonce } = await readJson<{ nonce: string }>(
            await app.request('/api/auth/challenge', { method: 'POST' })
        );

        const res = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody(nonce)),
        });
        expect(res.status).toBe(200);
        const body = await readJson<{ jwt: string; expiresAt: string }>(res);
        expect(body.jwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
        expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

        const { payload } = await jwtVerify(body.jwt, new TextEncoder().encode(JWT_SECRET), {
            algorithms: ['HS256'],
        });
        expect(payload.sub).toBe(subFromPubkey(PUBKEY));
        expect(payload.pubkey).toBe(PUBKEY);
        expect(payload.account).toBe('duncan');
        expect(payload.permission).toBe('active');
        expect(payload.chainId).toBe(validBody(nonce).chainId);
        expect(typeof payload.iat).toBe('number');
        expect(typeof payload.exp).toBe('number');
        // 24h max lifetime per §3.2.
        expect((payload.exp as number) - (payload.iat as number)).toBe(24 * 60 * 60);
    });

    it('rejects an unknown nonce with bad-nonce', async () => {
        const { app } = makeApp();
        const res = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody('deadbeef'.repeat(8))),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'bad-nonce' });
        expect(verifySignature).not.toHaveBeenCalled();
    });

    it('rejects an expired nonce', async () => {
        const { app } = makeApp(1); // 1ms TTL → expires immediately
        const { nonce } = await readJson<{ nonce: string }>(
            await app.request('/api/auth/challenge', { method: 'POST' })
        );
        await new Promise((r) => setTimeout(r, 5));
        const res = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody(nonce)),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'bad-nonce' });
    });

    it('rejects nonce reuse (second verify of the same nonce)', async () => {
        const { app } = makeApp();
        const { nonce } = await readJson<{ nonce: string }>(
            await app.request('/api/auth/challenge', { method: 'POST' })
        );

        const first = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody(nonce)),
        });
        expect(first.status).toBe(200);

        const second = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody(nonce)),
        });
        expect(second.status).toBe(400);
        expect(await second.json()).toEqual({ kind: 'refuse', reason: 'bad-nonce' });
    });

    it('rejects a bad signature with bad-signature (nonce already consumed)', async () => {
        vi.mocked(verifySignature).mockReturnValue(false);
        const { app, nonceStore } = makeApp();
        const { nonce } = await readJson<{ nonce: string }>(
            await app.request('/api/auth/challenge', { method: 'POST' })
        );

        const res = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(validBody(nonce)),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'bad-signature' });
        expect(verifySignature).toHaveBeenCalledWith(
            nonce,
            'SIG_K1_xxxxxxxxxxxxxxxxxx',
            PUBKEY
        );
        // Reuse rejection: even a bad-signature attempt consumes the nonce.
        expect(nonceStore._size()).toBe(0);
    });

    it('rejects a malformed body with bad-request', async () => {
        const { app } = makeApp();
        const res = await app.request('/api/auth/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nonce: 'abc' }), // missing required fields
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'bad-request' });
    });
});
