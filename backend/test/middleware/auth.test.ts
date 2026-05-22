// jwtAuth middleware contract tests (guidelines §3.1 + §3.4).
//
// Loopback handling: we pass a synthetic `env: { incoming: { socket: ... } }`
// straight into `app.request(url, init, env)` — that's the same shape
// @hono/node-server populates at runtime, and the only piece of context the
// middleware reads to make the loopback decision. No real sockets in tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';

import { type AuthContext, jwtAuth, DEV_BYPASS_SUB } from '../../src/middleware/auth.js';

const readJson = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const JWT_SECRET = 'test-secret-w1.5-mw';
const SECRET_KEY = new TextEncoder().encode(JWT_SECRET);

async function makeJwt(opts: { exp?: number } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
        pubkey: 'PUB_K1_test',
        account: 'duncan',
        permission: 'active',
        chainId: 'cid-1',
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('k1:abc')
        .setIssuedAt(now)
        .setExpirationTime(opts.exp ?? now + 60)
        .sign(SECRET_KEY);
}

function makeApp(devBypass: boolean) {
    const app = new Hono<AuthContext>();
    app.use('/protected', jwtAuth({ jwtSecret: JWT_SECRET, devBypass }));
    app.get('/protected', (c) => c.json({ ok: true, sub: c.get('auth').sub }));
    return app;
}

const loopbackEnv = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const ipv6LoopbackEnv = { incoming: { socket: { remoteAddress: '::1' } } };
const wanEnv = { incoming: { socket: { remoteAddress: '203.0.113.5' } } };

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.useRealTimers());

describe('jwtAuth middleware', () => {
    it('returns HTTP 401 + auth-required when no Bearer header', async () => {
        const app = makeApp(false);
        const res = await app.request('/protected', {}, loopbackEnv);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'auth-required' });
    });

    it('returns HTTP 401 on a malformed JWT', async () => {
        const app = makeApp(false);
        const res = await app.request(
            '/protected',
            { headers: { authorization: 'Bearer not-a-jwt' } },
            loopbackEnv
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'auth-required' });
    });

    it('returns HTTP 401 on an expired JWT', async () => {
        const now = Math.floor(Date.now() / 1000);
        const expired = await makeJwt({ exp: now - 60 });
        const app = makeApp(false);
        const res = await app.request(
            '/protected',
            { headers: { authorization: `Bearer ${expired}` } },
            loopbackEnv
        );
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'auth-required' });
    });

    it('attaches claims and proceeds on a valid JWT', async () => {
        const jwt = await makeJwt();
        const app = makeApp(false);
        const res = await app.request(
            '/protected',
            { headers: { authorization: `Bearer ${jwt}` } },
            loopbackEnv
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, sub: 'k1:abc' });
    });

    it('DEV_AUTH_BYPASS=true short-circuits for loopback (127.0.0.1)', async () => {
        const app = makeApp(true);
        const res = await app.request('/protected', {}, loopbackEnv);
        expect(res.status).toBe(200);
        const body = await readJson<{ sub: string }>(res);
        expect(body.sub).toBe(DEV_BYPASS_SUB);
    });

    it('DEV_AUTH_BYPASS=true short-circuits for loopback (::1)', async () => {
        const app = makeApp(true);
        const res = await app.request('/protected', {}, ipv6LoopbackEnv);
        expect(res.status).toBe(200);
        expect((await readJson<{ sub: string }>(res)).sub).toBe(DEV_BYPASS_SUB);
    });

    it('DEV_AUTH_BYPASS=true does NOT short-circuit for non-loopback', async () => {
        const app = makeApp(true);
        const res = await app.request('/protected', {}, wanEnv);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ kind: 'refuse', reason: 'auth-required' });
    });

    it('DEV_AUTH_BYPASS=true still requires a JWT on non-loopback even if one would have worked', async () => {
        const jwt = await makeJwt();
        const app = makeApp(true);
        const res = await app.request(
            '/protected',
            { headers: { authorization: `Bearer ${jwt}` } },
            wanEnv
        );
        // Non-loopback + JWT → JWT path; bypass irrelevant.
        expect(res.status).toBe(200);
        expect((await readJson<{ sub: string }>(res)).sub).toBe('k1:abc');
    });
});
