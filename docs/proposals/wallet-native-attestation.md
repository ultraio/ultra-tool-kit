# Wallet-native silent attestation — proposal for the Ultra Wallet team

> Status: **proposal**. No code lives in `@ultraos/wallet-sdk` for this yet.
> Audience: Ultra Wallet extension team, Ultra Web Wallet team, `@ultraos/wallet-sdk` maintainers.
> Authored from: `ultra-tool-kit`, which currently uses anonymous per-IP rate limiting for its AI feature (`docs/superpowers/specs/2026-05-26-ai-access-gate-design.md`) and would adopt this attestation primitive when available.

---

## 1. Problem

dApps that operate a backend (e.g., a sponsored AI chat, a paid API endpoint, a leaderboard service) need to know **which Ultra account is making a request** so they can:

1. Rate-limit per real user (not per shared IP).
2. Sponsor compute/storage on a per-user budget.
3. Audit usage by stable identity.

Today the wallet's `connect()` returns the user's accounts and pubkey to the dApp's **frontend**, but the frontend cannot prove this to the dApp's **backend** without an additional cryptographic step. The current options for that step all have meaningful problems:

| Today's option | Problem |
|---|---|
| `signMessage(account, message)` after connect | Extra popup. Breaks "connect once" UX. Some wallets (Ledger) have limited or no `signMessage` support. |
| Per-request `signTransaction` | Wallet popup on every request. Untenable for chatty backends. |
| Trust the FE's claim of account/pubkey | Trivially spoofable by anyone hitting the backend with curl. |
| Ultra SSO (OIDC) | Adds a second login flow next to wallet-connect. Excludes users on wallets not tied to an Ultra SSO account. |

A real example: `ultra-tool-kit` first tried JWT auth (challenge → wallet `signMessage` → JWT). User-facing friction was unacceptable — every chat-open requires consent. The toolkit reverted to anonymous-per-IP rate limiting as a v1 and named this proposal as the v2 upgrade.

---

## 2. Proposal

Extend the wallet's existing `connect()` flow to **silently produce a signed attestation** alongside the existing `ConnectResult` payload. No additional popup. The attestation rides the same user-consent moment that already produces `connect()` — the user clicked "Allow this dApp" once; the wallet may issue a signed identity assertion as part of fulfilling that allow.

### 2.1 Wallet API surface

`@ultraos/wallet-sdk` exposes a new optional field on `ConnectResult`:

```ts
interface ConnectResult {
    accounts: AccountInfo[];
    selectedAccount?: SelectedAccount;
    blockchainid?: string;        // legacy

    // NEW — optional. Present if the connected wallet vendor supports
    // silent attestation; absent otherwise. dApps treat absence as
    // "fall back to whatever auth this dApp uses without attestation".
    attestation?: ConnectAttestation;
}

interface ConnectAttestation {
    payload: {
        v: 1;                      // version
        pubkey: string;            // EOS... / UTR... — the signing key
        account: string;           // primary account name (the one signing)
        permission: string;        // 'active' / 'owner' / etc.
        origin: string;            // dApp origin, e.g. "http://localhost:5172"
        chainId: string;
        iat: number;               // unix seconds, issued-at
        exp: number;               // unix seconds, suggest 24h
        nonce: string;             // 32-byte random, hex-encoded
    };
    signature: string;             // SIG_K1_... over canonical hash of payload
}
```

### 2.2 What the wallet does at connect-time

When the user approves the `connect()` permission prompt:

1. Build the `payload` object with current account/pubkey/permission/chainId, requesting dApp's origin (from `window.location.origin` or the post-message source), fresh nonce, and `exp = iat + 86400`.
2. Compute the canonical hash of `payload` — JSON-stringified with sorted keys, UTF-8 encoded, SHA-256 hashed.
3. Sign the hash with the active permission's key. **No popup** — this signing is part of fulfilling the `connect()` consent the user just gave.
4. Return `{ payload, signature }` as `ConnectResult.attestation`.

### 2.3 User-consent model — why this is acceptable without an extra popup

The user's `connect()` consent today already grants the dApp:
- The ability to see all their accounts and permissions
- The ability to know the active account/pubkey
- The ability to prompt for `signTransaction` later (UI-explicit each time)

Adding "the ability to produce one signed identity assertion at connect time" is a **narrow extension** of the existing consent. It is NOT:
- An ongoing signing scope (the attestation is one-shot per connect, has an `exp`)
- A transaction (it never produces an on-chain effect)
- A delegation (it does not authorize the dApp to do anything; it only proves the user's identity to the dApp's backend)

The wallet's connect prompt UX should update to mention this: *"This dApp will be able to see your accounts and prove your identity to its backend until [exp date]."*

### 2.4 What the dApp's backend does

The dApp's backend verifies attestations as follows:

```ts
import { Signature, PublicKey, Bytes, Checksum256 } from '@wharfkit/antelope';

function verifyAttestation(
    attestation: ConnectAttestation,
    expectedOrigin: string,
    expectedChainId: string,
    now: number = Math.floor(Date.now() / 1000),
): { ok: true; account: string; pubkey: string } | { ok: false; reason: string } {
    const { payload, signature } = attestation;

    if (payload.v !== 1) return { ok: false, reason: 'bad-version' };
    if (payload.origin !== expectedOrigin) return { ok: false, reason: 'origin-mismatch' };
    if (payload.chainId !== expectedChainId) return { ok: false, reason: 'chain-mismatch' };
    if (payload.exp < now) return { ok: false, reason: 'expired' };

    // Canonical hash — JSON.stringify with sorted keys.
    const canonicalJson = JSON.stringify(payload, Object.keys(payload).sort());
    const hash = Checksum256.hash(Bytes.from(canonicalJson, 'utf8'));

    const pubkey = PublicKey.from(payload.pubkey);
    const sig = Signature.from(signature);
    if (!sig.verifyDigest(hash, pubkey)) return { ok: false, reason: 'bad-signature' };

    return { ok: true, account: payload.account, pubkey: payload.pubkey };
}
```

This uses `@wharfkit/antelope`, which the toolkit already depends on. Any Antelope-aware backend can verify with this same primitive.

### 2.5 Transport between FE and backend

The dApp's frontend forwards the attestation to its backend on each API call. Suggested shape: an `Authorization` header with a custom scheme:

```http
POST /api/ai-chat HTTP/1.1
Authorization: Attestation <base64url-of-JSON-stringified-attestation>
Content-Type: application/json

{ ... request body ... }
```

Backends that don't recognize the `Attestation` scheme can fall back to anonymous handling. Backends that do recognize it can opt into per-pubkey rate limiting, per-account audit, etc.

The attestation is reusable for its lifetime (up to `exp`). A typical SPA caches it in memory after `connect()` and discards it on disconnect or page reload (a fresh `connect()` produces a fresh attestation).

---

## 3. Vendor adoption order

Different wallet vendors will adopt at different speeds. dApps treat the attestation as **opportunistic** — present it if the wallet provides it, fall back to no-identity rate limiting (or whatever else the dApp does) if absent.

| Wallet | Notes | Expected support |
|---|---|---|
| Ultra Wallet (browser extension) | Owned by Ultra. Native EOSIO signing. Add attestation production to the connect handler. | **First** |
| Ultra Web Wallet | Owned by Ultra. Per-environment SDK instance. Same connect handler shape as the extension. | **Second** |
| `@ultraos/wallet-sdk` | The SDK surfaces the new optional field on `ConnectResult`. Once Ultra extension + web support it, the SDK release surfaces it. Released with a minor version bump (additive change). | Concurrent with Ultra Web |
| Anchor (Wharfkit) | Third-party. Wharfkit's signing model differs; Anchor team would need to adopt the attestation pattern themselves. | Long-tail. dApps fall back to anonymous for Anchor users until then. |
| Ledger | Hardware wallet, signing is per-explicit-UI-flow. Silent signing at connect is technically possible (sign-once with user pre-approval) but UX is non-trivial. | Open question for the Ledger integration team. |

---

## 4. Suggested API in `@ultraos/wallet-sdk`

For consumers of the SDK (e.g., `ultra-tool-kit/src/wallets/ultra.ts`), the existing `connect()` call returns the new field automatically when the underlying wallet supports it:

```ts
// existing code, no change needed
const result = await Ultra.connect();

// new — optional usage
if (result.attestation) {
    // Forward to backend
    backendHeaders['Authorization'] = `Attestation ${b64uEncode(JSON.stringify(result.attestation))}`;
}
// else — backend handles anonymously
```

No breaking changes. dApps that don't know about `attestation` continue to work unchanged. dApps that do can opt in.

---

## 5. Security considerations

### 5.1 Replay scoping

The `origin` field binds the attestation to a single dApp origin. A backend at `https://app-a.example.com` verifies `payload.origin === 'https://app-a.example.com'` and rejects attestations issued for `https://app-b.example.com`. This prevents cross-dApp replay.

The `nonce` field is opaque to the backend by default but allows a backend that wants stricter once-only semantics to track seen nonces in a short-lived cache (optional).

### 5.2 Expiration

`exp = iat + 86400` (24h) is suggested. dApps that want shorter sessions can require the FE to call `connect()` again sooner. dApps that want longer can accept longer-lived attestations (up to whatever the wallet's max ttl is).

### 5.3 Pubkey rotation

If the user rotates their active permission's key, existing attestations remain valid until `exp` (the signature is still cryptographically sound — the key was authorized at sign-time). dApps that need strict revocation should use shorter `exp` values.

### 5.4 Origin spoofing

The wallet must use a trustworthy source for the `origin` field — NOT a value supplied by the dApp. In the extension, this means the active tab's URL origin; in Ultra Web, this means the parent window's `postMessage` source origin (validated against an allowlist). A dApp that could supply its own `origin` could mint attestations naming any origin.

### 5.5 Cross-tab / cross-origin isolation

Standard wallet origin-isolation rules apply. Attestation is issued to the origin that initiated `connect()`. The wallet must not leak it to other origins.

---

## 6. Open questions for the wallet team

1. **Canonical serialization.** JSON-with-sorted-keys is the simplest; alternatives include CBOR / protobuf. Simplicity vs. cross-language portability. Recommendation: stick with sorted-key JSON.
2. **Signature algorithm.** EOSIO `K1` is the default. Should `R1` (hardware key) be supported? Ledger devices use a different signing model — this might affect Ledger adoption.
3. **Wallet UI text.** Connect prompt needs new copy: *"This dApp can prove your identity to its backend."* Exact wording is a UX call.
4. **TTL policy.** 24h is the suggested default. Should the wallet enforce a maximum? Allow per-dApp configuration via the connect request?
5. **Multi-account selection.** If a user has multiple accounts and switches the active account post-connect (via wallet `accountChanged` event), does the attestation become stale? Should the wallet automatically reissue and emit a new attestation in the `accountChanged` event payload?
6. **Versioning.** The `v: 1` field reserves room for future format changes. The SDK should refuse to verify unknown versions.
7. **Permission scope.** Currently the attestation names a single `permission`. Should it instead enumerate all permissions the user authorized for this dApp's connect? Simpler: single, matches the EOSIO signing model.

---

## 7. Reference implementation

A reference implementation of `verifyAttestation` lives in `ultra-tool-kit/backend/src/auth/attestation.ts` (placeholder for now — will be added when this proposal lands in the SDK). The dApp side of the integration is ~50 LOC of code.

---

## 8. Why not Ultra SSO (OIDC) instead?

Ultra already runs an OIDC identity provider at `auth.ultra.io`, and `ultra-claim` uses it successfully. Why propose wallet-native attestation as a separate primitive?

- **No second login flow.** Wallet attestation rides the connect consent. SSO adds a separate "Sign in with Ultra" affordance.
- **Works for users not tied to Ultra SSO.** Anchor users, users who only have a non-Ultra-SSO Ultra account, etc. SSO excludes them.
- **Single source of truth.** The wallet already knows the user's pubkey + active permission. SSO maintains a parallel identity system that can drift from the wallet's view.
- **No reliance on a centralized service.** Attestation is offline-verifiable from public-key cryptography alone; SSO requires the dApp to fetch JWKs from `auth.ultra.io` (which is a great service, but is one more dependency).

Both can coexist — a dApp could accept either attestation OR an Ultra SSO token. But for AI-feature-style sponsored backends in the toolkit ecosystem, wallet attestation is the better primary primitive.

---

## 9. Adoption path for `ultra-tool-kit`

When this proposal ships in `@ultraos/wallet-sdk`:

1. Bump the SDK version in `ultra-tool-kit/package.json`.
2. `src/wallets/ultra.ts` — surface `attestation` from `ConnectResult` to the toolkit's auth state.
3. `src/utilities/aiClient.ts` — attach `Authorization: Attestation <base64url>` header when an attestation is present.
4. `ultra-tool-kit/backend/src/middleware/attestation.ts` — new optional middleware. If header present, verify and attach `c.var.identity`. If absent, pass through.
5. `ultra-tool-kit/backend/src/middleware/ratelimit.ts` — when `c.var.identity` is present, rate-limit-key becomes `pubkey:${pubkey}` instead of `ip:${ip}`. Per-key tiers can be looser than per-IP (e.g., 30/day → 200/day per pubkey, since pubkey ownership is real Sybil resistance).
6. Anchor / Ledger users continue to hit the IP path — no behavior change for them.

Total work for the toolkit side: ~½ wave.

---

## 10. Status

This document captures the design. No code in any repo yet implements it. Owner: Ultra Wallet team to evaluate; `ultra-tool-kit` author tracks adoption and is ready to integrate the day the SDK ships.
