// Bearer JWT verify middleware (guidelines §3.1 + §3.2).
//
// Auth gate sequence:
//   1. DEV_AUTH_BYPASS=true AND request is loopback → inject synthetic sub
//      (guidelines §3.4). Bypass is loopback-only by design — that's the
//      one production foot-gun this wave prevents.
//   2. Bearer token present → verify against JWT_SECRET (HS256). On success
//      attach claims to `c.var.auth`.
//   3. Anything else → HTTP 401 with `{ kind: 'refuse', reason: 'auth-required' }`.
//
// HTTP 401 is the one place the AI surface returns a 4xx; once the request
// is authed, the chat routes flip to "always HTTP 200 with kind: refuse" so
// the UI renders a normal bubble (guidelines §3.3 closing).

import type { MiddlewareHandler } from 'hono';

import { verifyAuthJwt, type VerifiedClaims } from '../auth/jwt.js';
import { remoteAddressOf } from './logging.js';

export type AuthContext = {
    Variables: {
        auth: VerifiedClaims;
        authSub: string; // mirror of auth.sub for the request logger
    };
};

const REFUSE_AUTH_REQUIRED = { kind: 'refuse', reason: 'auth-required' } as const;

// Loopback addresses we treat as "this machine" for DEV_AUTH_BYPASS. IPv6
// includes the mapped form (`::ffff:127.0.0.1`) that Node emits for IPv4
// sockets when the listener is dual-stack.
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isLoopback(addr: string | undefined): boolean {
    return addr !== undefined && LOOPBACK_ADDRS.has(addr);
}

// Synthetic identity injected by DEV_AUTH_BYPASS so the rest of the stack
// (rate-limit, logging, eventually the harness) sees a stable `sub` without
// running the wallet challenge/verify in local dev.
export const DEV_BYPASS_SUB = 'k1:dev-loopback-bypass';
export const DEV_BYPASS_CLAIMS: VerifiedClaims = {
    sub: DEV_BYPASS_SUB,
    pubkey: 'DEV_BYPASS',
    account: 'dev',
    permission: 'active',
    chainId: 'dev',
    iat: 0,
    exp: 0,
};

export type JwtAuthDeps = {
    jwtSecret: string;
    devBypass?: boolean;
};

export function jwtAuth(deps: JwtAuthDeps): MiddlewareHandler<AuthContext> {
    return async (c, next) => {
        if (deps.devBypass && isLoopback(remoteAddressOf(c))) {
            c.set('auth', DEV_BYPASS_CLAIMS);
            c.set('authSub', DEV_BYPASS_SUB);
            await next();
            return;
        }

        const header = c.req.header('authorization');
        const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
        if (!token) {
            return c.json(REFUSE_AUTH_REQUIRED, 401);
        }

        const outcome = await verifyAuthJwt(token, deps.jwtSecret);
        if (outcome.kind !== 'ok') {
            return c.json(REFUSE_AUTH_REQUIRED, 401);
        }

        c.set('auth', outcome.claims);
        c.set('authSub', outcome.claims.sub);
        await next();
    };
}
