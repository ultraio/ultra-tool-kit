// Wallet-native attestation middleware (W9). docs/00 §3.7 + RFC §2.4.
//
// Reads `Authorization: Attestation <base64url(JSON)>`. When present AND the
// attestation verifies, attaches `c.var.identity`. OPPORTUNISTIC: on absence
// OR any verification failure it logs a debug line and calls next() — it NEVER
// 401s. Downstream rate-limit + balance-gate branch on whether identity is set.
//
// Canonical hashing MUST match the wallet's signer
// (web-app libs/extension AttestationService.canonicalSerialize):
//   JSON.stringify(payload, Object.keys(payload).sort())
// The array-replacer sorts AND filters top-level keys (applied recursively as a
// key allowlist), so nested signableAccounts entries serialize as the wallet
// signed them. We hash the RAW decoded payload (the literal signed bytes), not
// the Zod-reparsed object, to reproduce the wallet's digest exactly.
//
// Verify via @wharfkit/antelope (already a dep), matching RFC §2.4:
//   Signature.from(sig).verifyDigest(Checksum256.hash(Bytes.from(json,'utf8')), PublicKey.from(pubkey))

import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { Bytes, Checksum256, PublicKey, Signature } from '@wharfkit/antelope';

import { logger } from './logging.js';

export type SignableAccount = { account: string; permissions: string[] };

export type AttestedIdentity = {
    pubkey: string;
    account: string;
    permission: string;
    signableAccounts: SignableAccount[];
};

// Hono Variables shared by the W9 middleware chain (attestation → balance-gate).
export type IdentityVariables = {
    Variables: {
        identity?: AttestedIdentity;
        totalUos?: number;
    };
};

const SignableAccountSchema = z.object({
    account: z.string().min(1),
    permissions: z.array(z.string()),
});

// Mirrors @ultraos/wallet-sdk AttestationPayload (RFC §2.1). `v` literal-gates
// the version (unknown version → schema failure → fall through).
const PayloadSchema = z.object({
    v: z.literal(1),
    pubkey: z.string().min(1),
    account: z.string().min(1),
    permission: z.string().min(1),
    origin: z.string().min(1),
    chainId: z.string().min(1),
    iat: z.number(),
    exp: z.number(),
    nonce: z.string().min(1),
    signableAccounts: z.array(SignableAccountSchema).optional(),
});

const AttestationSchema = z.object({
    payload: PayloadSchema,
    signature: z.string().min(1),
});

export const CLOCK_SKEW_SEC = 60;
const SCHEME = 'Attestation ';

export type AttestationDeps = {
    allowedOrigins: readonly string[];
    // When set, payload.chainId must equal it; when unset, the chainId equality
    // check is skipped (origin + exp + signature still bind the attestation).
    expectedChainId?: string;
    now?: () => number; // unix SECONDS; default Math.floor(Date.now()/1000)
    clockSkewSec?: number; // default CLOCK_SKEW_SEC
};

function canonicalSerialize(payload: Record<string, unknown>): string {
    return JSON.stringify(payload, Object.keys(payload).sort());
}

type VerifyResult = { ok: true; identity: AttestedIdentity } | { ok: false; reason: string };

// Pure verifier — exported for unit tests. `rawAttestation` is the object
// straight from JSON.parse so the canonical hash reproduces the signed bytes.
export function verifyAttestation(
    rawAttestation: unknown,
    opts: { allowedOrigins: readonly string[]; expectedChainId?: string; now: number; clockSkewSec: number }
): VerifyResult {
    const parsed = AttestationSchema.safeParse(rawAttestation);
    if (!parsed.success) return { ok: false, reason: 'schema' };
    const p = parsed.data.payload;
    const rawPayload = (rawAttestation as { payload: Record<string, unknown> }).payload;

    if (!opts.allowedOrigins.includes(p.origin)) return { ok: false, reason: 'origin-mismatch' };
    if (opts.expectedChainId !== undefined && p.chainId !== opts.expectedChainId) {
        return { ok: false, reason: 'chain-mismatch' };
    }
    if (p.exp <= opts.now) return { ok: false, reason: 'expired' };
    if (p.iat > opts.now + opts.clockSkewSec) return { ok: false, reason: 'future-iat' };

    let verified = false;
    try {
        const canonicalJson = canonicalSerialize(rawPayload);
        const hash = Checksum256.hash(Bytes.from(canonicalJson, 'utf8'));
        verified = Signature.from(parsed.data.signature).verifyDigest(hash, PublicKey.from(p.pubkey));
    } catch {
        return { ok: false, reason: 'bad-signature' };
    }
    if (!verified) return { ok: false, reason: 'bad-signature' };

    // RFC §5.6: source the account list from the SIGNED signableAccounts, never
    // an FE-supplied list. Absent → fall back to the primary account.
    //
    // SIGNATURE COVERAGE: the canonical serialization (sorted top-level keys as
    // an array-replacer) covers each entry's `account` (a top-level key name) but
    // NOT its `permissions` (no matching top-level key, so the replacer filters
    // it out of the hashed bytes — same on the wallet's signer). So
    // `signableAccounts[i].account` is signature-bound and trustworthy; the
    // per-entry `permissions` is NOT. The balance gate gates only on `account`.
    // Do NOT make an authorization decision on `signableAccounts[i].permissions`
    // without a coordinated wallet/RFC canonical-form bump.
    const signableAccounts: SignableAccount[] =
        p.signableAccounts && p.signableAccounts.length > 0
            ? p.signableAccounts
            : [{ account: p.account, permissions: [p.permission] }];

    return {
        ok: true,
        identity: { pubkey: p.pubkey, account: p.account, permission: p.permission, signableAccounts },
    };
}

export function attestation(deps: AttestationDeps): MiddlewareHandler<IdentityVariables> {
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    const clockSkewSec = deps.clockSkewSec ?? CLOCK_SKEW_SEC;

    return async (c, next) => {
        const header = c.req.header('authorization');
        if (!header || !header.startsWith(SCHEME)) {
            await next();
            return;
        }
        let rawAttestation: unknown;
        try {
            const json = Buffer.from(header.slice(SCHEME.length).trim(), 'base64url').toString('utf8');
            rawAttestation = JSON.parse(json);
        } catch {
            logger.debug('attestation: malformed base64url/JSON; falling through to per-IP');
            await next();
            return;
        }
        const result = verifyAttestation(rawAttestation, {
            allowedOrigins: deps.allowedOrigins,
            expectedChainId: deps.expectedChainId,
            now: now(),
            clockSkewSec,
        });
        if (!result.ok) {
            logger.debug({ reason: result.reason }, 'attestation: verification failed; falling through to per-IP');
            await next();
            return;
        }
        c.set('identity', result.identity);
        await next();
    };
}
