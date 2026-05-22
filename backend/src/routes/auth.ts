// Wallet-pubkey challenge/verify routes (guidelines §3.2).
//
//   POST /api/auth/challenge → { nonce: <hex32>, expiresAt: <iso> }
//   POST /api/auth/verify    ← { nonce, signature, pubkey, account, permission, chainId }
//                            → { jwt, expiresAt: <iso> }
//
// One-shot nonces (NonceStore.consume deletes on lookup — see nonce-store.ts).
// Signatures verified via @wharfkit/antelope at the verify-signature.ts
// boundary so tests can mock without touching real crypto. JWT claims emitted
// verbatim per §3.2; `sub = k1:<sha256(pubkey)>` per §3.2.

import { Hono } from 'hono';
import { z } from 'zod';

import { NonceStore } from '../auth/nonce-store.js';
import { signAuthJwt, subFromPubkey } from '../auth/jwt.js';
import { verifySignature } from '../auth/verify-signature.js';

export type AuthRouterDeps = {
    nonceStore: NonceStore;
    jwtSecret: string;
};

// Zod gates on both endpoints. Bodies that don't parse → 400 with refuse
// envelope. We keep the schema permissive on string content (length only)
// because the signature/pubkey verifier collapses malformed input into a
// generic "bad signature" — see verify-signature.ts for rationale.
const VerifyBody = z.object({
    nonce: z.string().min(1),
    signature: z.string().min(1),
    pubkey: z.string().min(1),
    account: z.string().min(1).max(13),
    permission: z.string().min(1).max(13),
    chainId: z.string().min(1),
});

const REFUSE_BAD_REQUEST = { kind: 'refuse', reason: 'bad-request' } as const;
const REFUSE_BAD_NONCE = { kind: 'refuse', reason: 'bad-nonce' } as const;
const REFUSE_BAD_SIGNATURE = { kind: 'refuse', reason: 'bad-signature' } as const;

export function createAuthRouter(deps: AuthRouterDeps): Hono {
    const app = new Hono();

    app.post('/challenge', (c) => {
        const { nonce, expiresAt } = deps.nonceStore.issue();
        return c.json({ nonce, expiresAt: new Date(expiresAt).toISOString() });
    });

    app.post('/verify', async (c) => {
        let raw: unknown;
        try {
            raw = await c.req.json();
        } catch {
            return c.json(REFUSE_BAD_REQUEST, 400);
        }

        const parsed = VerifyBody.safeParse(raw);
        if (!parsed.success) return c.json(REFUSE_BAD_REQUEST, 400);
        const body = parsed.data;

        // One-shot nonce. `consume` returns false if unknown OR expired —
        // both branches collapse to a single refuse to avoid leaking
        // timing/state signal. Reuse rejection is automatic: the second
        // consume call after a successful first returns false because the
        // first call already deleted the entry.
        if (!deps.nonceStore.consume(body.nonce)) {
            return c.json(REFUSE_BAD_NONCE, 400);
        }

        if (!verifySignature(body.nonce, body.signature, body.pubkey)) {
            return c.json(REFUSE_BAD_SIGNATURE, 400);
        }

        const claims = {
            sub: subFromPubkey(body.pubkey),
            pubkey: body.pubkey,
            account: body.account,
            permission: body.permission,
            chainId: body.chainId,
        };
        const { jwt, expiresAt } = await signAuthJwt(claims, deps.jwtSecret);
        return c.json({ jwt, expiresAt: new Date(expiresAt * 1000).toISOString() });
    });

    return app;
}
