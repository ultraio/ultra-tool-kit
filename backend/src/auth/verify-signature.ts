// @wharfkit/antelope wrapper for nonce signature verification.
//
// Guidelines §3.2 explicit pointer: signatures are verified against the
// supplied pubkey using `@wharfkit/antelope`'s `PublicKey` + `Signature`
// types. `Signature.verifyMessage` hashes the message internally before
// comparing against the recovered key — same path the wallet uses on the
// signing side, so the byte-identical nonce hex string round-trips.
//
// Wrapped at this module boundary so the routes/auth.ts handler can be
// unit-tested via `vi.mock` without pulling the full antelope crypto path
// into tests (and without making real network calls — §0).

import { PublicKey, Signature } from '@wharfkit/antelope';

export function verifySignature(message: string, signature: string, pubkey: string): boolean {
    try {
        const pk = PublicKey.from(pubkey);
        const sig = Signature.from(signature);
        return sig.verifyMessage(message, pk);
    } catch {
        // Malformed key or signature → not verified. Distinguishing malformed
        // input from a cryptographic mismatch leaks signal to an attacker
        // probing the boundary; collapse both into `false`.
        return false;
    }
}
