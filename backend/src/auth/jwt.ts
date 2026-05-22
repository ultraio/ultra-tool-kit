// JWT issuance + verification per guidelines §3.2.
//
// HS256 only (symmetric secret loaded from JWT_SECRET); 24h max lifetime.
// Claim set is verbatim from §3.2 — adding or dropping a claim is a doc
// change first. `sub = k1:<sha256(pubkey)>` is computed by the caller
// (routes/auth.ts); this module signs and verifies the token only.

import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

export type AuthClaims = {
    sub: string;
    pubkey: string;
    account: string;
    permission: string;
    chainId: string;
};

export type VerifiedClaims = AuthClaims & { iat: number; exp: number };

export type JwtVerifyOutcome =
    | { kind: 'ok'; claims: VerifiedClaims }
    | { kind: 'bad' }
    | { kind: 'expired' };

// 24h ceiling per §3.2 ("iat, exp ... 24h max"). Kept as a constant so the
// roadmap-quoted limit is grep-able.
export const JWT_MAX_LIFETIME_SECONDS = 24 * 60 * 60;

export function subFromPubkey(pubkey: string): string {
    const hash = createHash('sha256').update(pubkey).digest('hex');
    return `k1:${hash}`;
}

function keyOf(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
}

export async function signAuthJwt(
    claims: AuthClaims,
    secret: string,
    now = Math.floor(Date.now() / 1000)
): Promise<{ jwt: string; expiresAt: number }> {
    const exp = now + JWT_MAX_LIFETIME_SECONDS;
    const jwt = await new SignJWT({
        pubkey: claims.pubkey,
        account: claims.account,
        permission: claims.permission,
        chainId: claims.chainId,
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(claims.sub)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(keyOf(secret));
    return { jwt, expiresAt: exp };
}

export async function verifyAuthJwt(token: string, secret: string): Promise<JwtVerifyOutcome> {
    try {
        const { payload } = await jwtVerify(token, keyOf(secret), { algorithms: ['HS256'] });
        const { sub, pubkey, account, permission, chainId, iat, exp } = payload as Record<string, unknown>;
        if (
            typeof sub !== 'string' ||
            typeof pubkey !== 'string' ||
            typeof account !== 'string' ||
            typeof permission !== 'string' ||
            typeof chainId !== 'string' ||
            typeof iat !== 'number' ||
            typeof exp !== 'number'
        ) {
            return { kind: 'bad' };
        }
        return {
            kind: 'ok',
            claims: { sub, pubkey, account, permission, chainId, iat, exp },
        };
    } catch (err) {
        if (err instanceof joseErrors.JWTExpired) return { kind: 'expired' };
        return { kind: 'bad' };
    }
}
