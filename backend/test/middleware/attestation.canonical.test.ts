// Cross-implementation golden test for wallet-native attestation (W9, RFC §2.4).
//
// The wallet signs `canonicalSerialize(payload)` where canonicalSerialize is a
// RECURSIVE key-sort (web-app libs/extension AttestationService) that KEEPS
// nested signableAccounts[].permissions. This test independently reproduces that
// canonical form, signs a permissions-bearing payload with @wharfkit/antelope the
// way the wallet does (PrivateKey.signMessage), and asserts the backend verifier
// agrees byte-for-byte. It guards against a regression to the lossy array-replacer
// form (JSON.stringify(payload, keys.sort())), which silently drops nested
// permissions and breaks verification for every real attestation.

import { describe, expect, it } from 'vitest';
import { Bytes, PrivateKey, PublicKey } from '@wharfkit/antelope';

import { canonicalSerialize, verifyAttestation } from '../../src/middleware/attestation.js';

// Fixed EOSIO dev key so the canonical bytes are deterministic and writable inline.
const WIF = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PRIV = PrivateKey.fromString(WIF);
const PUB = PRIV.toPublic().toString(); // EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV
const NOW = 1_700_000_000;

// Independent re-implementation of the wallet's recursive canonicalize — NOT
// imported from the middleware, so a bug in either side is caught by divergence.
function walletCanonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(walletCanonicalize);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = walletCanonicalize((value as Record<string, unknown>)[k]);
        }
        return out;
    }
    return value;
}
function walletSerialize(payload: Record<string, unknown>): string {
    return JSON.stringify(walletCanonicalize(payload));
}
// The wallet's exact signer call: KeyService.sign = PrivateKey.signMessage(buf).toString().
function walletSign(payload: Record<string, unknown>): string {
    return PRIV.signMessage(Bytes.from(walletSerialize(payload), 'utf8')).toString();
}

function payloadWithPermissions() {
    return {
        v: 1 as const,
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
            { account: 'alice.x', permissions: ['active', 'owner'] },
        ],
    };
}

const VERIFY_OPTS = {
    allowedOrigins: ['http://localhost:5172'] as const,
    expectedChainId: 'CHAIN_A',
    now: NOW,
    clockSkewSec: 60,
};

describe('attestation canonical serialization — wallet parity', () => {
    it('backend canonicalSerialize keeps nested signableAccounts[].permissions (byte-exact)', () => {
        const p = payloadWithPermissions();
        const expected =
            `{"account":"alice","chainId":"CHAIN_A","exp":${NOW + 3600},"iat":${NOW - 10},` +
            `"nonce":"${'deadbeef'.repeat(8)}","origin":"http://localhost:5172","permission":"active",` +
            `"pubkey":"${PUB}",` +
            `"signableAccounts":[{"account":"alice","permissions":["active"]},` +
            `{"account":"alice.x","permissions":["active","owner"]}],"v":1}`;
        expect(canonicalSerialize(p)).toBe(expected);
        // The lossy array-replacer form would drop permissions — guard against regression.
        expect(canonicalSerialize(p)).toContain('"permissions":["active","owner"]');
        expect(canonicalSerialize(p)).not.toBe(JSON.stringify(p, Object.keys(p).sort()));
    });

    it('verifies a wallet-signed attestation that carries signableAccounts permissions', () => {
        const payload = payloadWithPermissions();
        const att = { payload, signature: walletSign(payload) };
        const res = verifyAttestation(att, VERIFY_OPTS);
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.identity.pubkey).toBe(PUB);
            expect(res.identity.signableAccounts).toEqual(payload.signableAccounts);
        }
    });

    it('rejects tampering with signableAccounts[].permissions (S1 full-structure signing)', () => {
        const payload = payloadWithPermissions();
        const signature = walletSign(payload);
        // Escalate permissions after signing — must break verification.
        // Non-null assertion: payloadWithPermissions() always has two entries
        // (noUncheckedIndexedAccess widens the index access to `| undefined`).
        payload.signableAccounts[1]!.permissions.push('owner');
        const res = verifyAttestation({ payload, signature }, VERIFY_OPTS);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('bad-signature');
    });

    it('rejects a lossy-serialized signature (cannot silently regress to array-replacer)', () => {
        const payload = payloadWithPermissions();
        // Sign the lossy form (permissions dropped) — backend now expects recursive bytes.
        const lossy = JSON.stringify(payload, Object.keys(payload).sort());
        const signature = PRIV.signMessage(Bytes.from(lossy, 'utf8')).toString();
        const res = verifyAttestation({ payload, signature }, VERIFY_OPTS);
        expect(res.ok).toBe(false);
    });
});
