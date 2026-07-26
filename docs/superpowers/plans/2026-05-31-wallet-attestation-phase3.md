# Wallet-Native Attestation — Phase 3 (dApp/consumer) completion plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the toolkit's wallet-native attestation path actually work end-to-end: fix the backend canonical serialization so real wallet attestations verify, harden the masking tests with a cross-implementation golden test, and add the missing frontend on-demand `connect({ requireAttestation: true })`.

**Architecture:** A prior W9 session already landed most of Phase 3 (FE surfacing/forwarding, backend balance-gate + rate-limit re-key + verify scaffold, middleware wiring). This plan is **surgical fix + gap-close**, not greenfield. The load-bearing fix is one function. The wallet (`~/ultra/web-app`, branch `task/wallet-attestation`, SDK 0.5.0) is the byte-for-byte source of truth for canonical serialization; the toolkit's `@ultraos/wallet-sdk` is already symlinked to its local 0.5.0 build (npm only has 0.3.1).

**Tech Stack:** Backend = Hono + `@wharfkit/antelope` + vitest. Frontend = Vue 3 + `@ultraos/wallet-sdk` (local 0.5.0 symlink). No new dependencies. No `package.json` SDK bump (0.4.0/0.5.0 unpublished; local symlink is the dev arrangement).

---

## Reference: the wallet's canonical serialization (byte-for-byte target)

From `~/ultra/web-app/libs/extension/src/lib/services/attestation.service.ts`:

```ts
// Recursive: sort object keys at EVERY nesting level, keep ALL keys, preserve array order.
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            out[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}
export function canonicalSerialize(payload: AttestationPayload): string {
    return JSON.stringify(canonicalize(payload));
}
```

Signer: `KeyService.sign(buf, wif) = PrivateKey.fromString(wif).signMessage(buf).toString()` where `buf = Buffer.from(canonicalSerialize(payload), 'utf8')`. In `@wharfkit/antelope`, `signMessage(x)` ≡ `signDigest(Checksum256.hash(x))`, and `verifyDigest(Checksum256.hash(x), pub)` is the matching verify — so the backend's verify primitive is already correct; **only the serialization differs.**

The current backend bug: `JSON.stringify(payload, Object.keys(payload).sort())`. The array replacer is an **allowlist applied to every nested object**, so `signableAccounts[].permissions` (not a top-level key) is dropped → digest mismatch → all real attestations fail.

---

## Task 1: Backend — failing cross-implementation golden test (TDD anchor)

**Files:**
- Create: `backend/test/middleware/attestation.canonical.test.ts`

This test reproduces the wallet's exact recursive canonical form independently, signs with `@wharfkit/antelope`, and proves the backend verifier agrees. It MUST fail against the current (array-replacer) implementation and pass after Task 2.

- [ ] **Step 1: Write the failing test**

```ts
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
        payload.signableAccounts[1].permissions.push('owner');
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
```

- [ ] **Step 2: Run the test — confirm it FAILS against the current implementation**

Run: `npm --prefix backend test -- attestation.canonical`
Expected: FAILS. The byte-exact case fails (`canonicalSerialize` currently drops permissions → no `"permissions":["active","owner"]`), AND the verify case fails (digest mismatch → `ok:false`). Also note `canonicalSerialize` is not yet exported — the import error is itself the first failure to fix in Task 2.

---

## Task 2: Backend — fix the canonical serialization to match the wallet

**Files:**
- Modify: `backend/src/middleware/attestation.ts`

- [ ] **Step 1: Replace `canonicalSerialize` with the recursive form and export it**

Replace lines 79-81:

```ts
function canonicalSerialize(payload: Record<string, unknown>): string {
    return JSON.stringify(payload, Object.keys(payload).sort());
}
```

with:

```ts
// Recursive canonical form — sorts object keys at EVERY nesting level, keeps ALL
// keys, preserves array element order. MUST be byte-for-byte identical to the
// wallet signer (web-app libs/extension AttestationService.canonicalSerialize) so
// the digest agrees. The previous array-replacer form
// (JSON.stringify(payload, keys.sort())) was an allowlist applied to every nested
// object, which DROPPED signableAccounts[].permissions from the hashed bytes and
// broke verification of every real (permissions-bearing) attestation. Exported for
// the cross-implementation parity test.
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            out[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}

export function canonicalSerialize(payload: Record<string, unknown>): string {
    return JSON.stringify(canonicalize(payload));
}
```

- [ ] **Step 2: Update the file-header comment block (lines 8-14)**

Replace the header lines that document the old serialization:

```ts
// Canonical hashing MUST match the wallet's signer
// (web-app libs/extension AttestationService.canonicalSerialize):
//   JSON.stringify(payload, Object.keys(payload).sort())
// The array-replacer sorts AND filters top-level keys (applied recursively as a
// key allowlist), so nested signableAccounts entries serialize as the wallet
// signed them. We hash the RAW decoded payload (the literal signed bytes), not
// the Zod-reparsed object, to reproduce the wallet's digest exactly.
```

with:

```ts
// Canonical hashing MUST match the wallet's signer byte-for-byte
// (web-app libs/extension AttestationService.canonicalSerialize): a RECURSIVE
// key-sort that sorts object keys at every nesting level, keeps ALL keys, and
// preserves array order — so nested signableAccounts[].permissions are part of
// the signed bytes. We hash the RAW decoded payload (the literal signed bytes),
// not the Zod-reparsed object, to reproduce the wallet's digest exactly.
```

- [ ] **Step 3: Update the §5.6 comment block (lines 113-127)**

The old comment claims `signableAccounts[].permissions` is NOT signature-bound. With the recursive form it now IS. Replace lines 113-123's reasoning with:

```ts
    // RFC §5.6: source the account list from the SIGNED signableAccounts, never
    // an FE-supplied list. Absent → fall back to the primary account.
    //
    // SIGNATURE COVERAGE: the recursive canonical form covers each entry's
    // `account` AND `permissions` (the wallet's S1 full-structure signing). Both
    // are trustworthy. The balance gate still gates only on `account` (summing UOS
    // per account needs no permission scope); per the Phase-3 spec we treat
    // `permissions` as advisory until a downstream consumer needs to authorize on
    // it, even though it is now signature-bound.
```

Keep lines 124-132 (the `signableAccounts` fallback + the returned `identity`) exactly as-is.

- [ ] **Step 4: Run the golden test — confirm it PASSES**

Run: `npm --prefix backend test -- attestation.canonical`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Commit**

```bash
git add backend/src/middleware/attestation.ts backend/test/middleware/attestation.canonical.test.ts
git commit -m "fix(backend): canonical-serialize attestation byte-for-byte vs wallet signer

The array-replacer form dropped nested signableAccounts[].permissions from the
hashed bytes, so every real (permissions-bearing) wallet attestation failed
verification and silently fell through to anonymous. Mirror the wallet's recursive
canonicalize; add a cross-implementation golden parity test (RFC §2.4)."
```

---

## Task 3: Backend — de-mask the two self-consistent tests

The existing `attestation.verify.test.ts` and `ai-chat.attested.test.ts` sign fixtures with the same lossy `canonical()` they verify against, so they pass while masking the bug. Their fixtures carry `signableAccounts` with permissions. After Task 2 they would FAIL (lossy-signed fixture vs recursive verify) — fix their signer to the recursive form so they sign the way the real wallet does.

**Files:**
- Modify: `backend/test/middleware/attestation.verify.test.ts:37-39`
- Modify: `backend/test/routes/ai-chat.attested.test.ts:40-42`

- [ ] **Step 1: Replace `canonical()` in BOTH files**

In each file replace:

```ts
function canonical(payload: Payload): string {
    return JSON.stringify(payload, Object.keys(payload).sort());
}
```

with:

```ts
// Recursive canonical form — byte-for-byte match with the wallet signer (sorts
// keys at every nesting level, keeps signableAccounts[].permissions). The lossy
// array-replacer form previously here masked the canonical-serialization bug.
function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = canonicalize((value as Record<string, unknown>)[k]);
        }
        return out;
    }
    return value;
}
function canonical(payload: Payload): string {
    return JSON.stringify(canonicalize(payload));
}
```

- [ ] **Step 2: Update the stale header comment in `attestation.verify.test.ts` (lines 8-9)**

Replace `// Canonical hashing MUST match the middleware: sorted top-level keys. We re-sign`
with `// Canonical hashing MUST match the middleware: recursive sorted-key form. We re-sign`.

- [ ] **Step 3: Run both test files — confirm still GREEN**

Run: `npm --prefix backend test -- attestation.verify ai-chat.attested`
Expected: PASS. (Fixtures now signed recursively; backend verifies recursively → match. The bad-signature/expired/origin/chain cases still behave correctly.)

- [ ] **Step 4: Run the full backend suite**

Run: `npm --prefix backend test`
Expected: all green (balance-gate, ratelimit.attested, ratelimit.fallback, anonymous, etc.).

- [ ] **Step 5: Commit**

```bash
git add backend/test/middleware/attestation.verify.test.ts backend/test/routes/ai-chat.attested.test.ts
git commit -m "test(backend): sign attestation fixtures with the wallet's recursive canonical form

The fixtures previously signed with the same lossy serialization the middleware
verified against — self-consistent green that masked the dropped-permissions bug."
```

---

## Task 4: Frontend — forward `requireAttestation` + on-demand acquisition

**Files:**
- Modify: `src/wallets/ultra.ts` (the `connect` fn lines 67-71; add `ensureAttestation` near `getAttestation` line 236)

- [ ] **Step 1: Extend `connect()` to forward `requireAttestation`**

Replace lines 67-71:

```ts
export async function connect(onlyIfTrusted = false): Promise<UltraResponse<ConnectResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.connect({ onlyIfTrusted });
}
```

with:

```ts
export async function connect(
    onlyIfTrusted = false,
    opts: { requireAttestation?: boolean } = {}
): Promise<UltraResponse<ConnectResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    // W9: requireAttestation (SDK 0.5.0) asks the wallet to issue a connect-time
    // attestation. Older wallets ignore the flag; existing callers pass nothing
    // and behave exactly as before (RFC §4 — strictly additive).
    return wallet.connect({ onlyIfTrusted, requireAttestation: opts.requireAttestation });
}
```

- [ ] **Step 2: Add `ensureAttestation()` after `getAttestation()` (after line 238)**

Also add `setAttestation` to the import at line 12 (it already imports `setAttestation`), and ensure `ConnectAttestation` is imported (already is, line 10).

```ts
/**
 * W9: ensure a fresh connect-time attestation is cached for the AI feature
 * (RFC §2.1 / §5.2).
 *
 * No-op when a cached attestation is still valid (not past `exp`, minus a small
 * skew). When absent OR expired, and the Ultra extension is available, calls
 * `connect({ requireAttestation: true })` — the wallet prompts once for
 * attestation consent via the existing connect dialog (no separate signature
 * popup), then issues silently on subsequent connects — and surfaces the result
 * into the shared store via `setAttestation`. Touches ONLY the attestation ref
 * (not accounts/selection, so a local multi-signer override is preserved).
 *
 * Fail-soft: any failure leaves the attestation unset so the AI request falls
 * back to the anonymous per-IP path (RFC §3 — opportunistic). Returns the cached
 * attestation if one is now present, else undefined.
 */
function attestationExpired(att: ConnectAttestation | undefined): boolean {
    if (!att) return true;
    const skewSec = 60;
    return att.payload.exp <= Math.floor(Date.now() / 1000) + skewSec;
}

export async function ensureAttestation(): Promise<ConnectAttestation | undefined> {
    const { attestation } = useWalletAccounts();
    if (!attestationExpired(attestation.value)) return attestation.value;
    if (!isAvailable()) return undefined;
    try {
        const res = await connect(false, { requireAttestation: true });
        if (res?.status === 'success' && res.data?.attestation) {
            setAttestation(res.data.attestation);
        }
    } catch {
        // Opportunistic — stay on the anonymous path on any failure.
    }
    return useWalletAccounts().attestation.value;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run build` (vue-tsc + vite build)
Expected: passes — `requireAttestation` and `attestation` resolve from the local 0.5.0 SDK symlink.

---

## Task 5: Frontend — trigger on-demand acquisition when the AI drawer opens

**Files:**
- Modify: `src/components/ai/ChatDrawer.vue` (script block, lines 129-196)

- [ ] **Step 1: Import the wallet module**

Add to the imports after line 132:

```ts
import { ensureAttestation } from '../../wallets/ultra';
```

- [ ] **Step 2: Acquire on open (after the auto-scroll watch, line 195)**

```ts
// W9: when the drawer opens for a logged-in Ultra-extension session and no
// attestation is cached yet, acquire one on demand so the FIRST chat request is
// already attested (per-pubkey rate-limit + balance gate). Opportunistic and
// fail-soft — ultra-web/anchor/ledger sessions skip this and use the per-IP path;
// ultra-web's connect-time attestation, if any, already arrives via populate.
watch(
    () => props.open,
    (open) => {
        if (open && loggedIn.value && props.state.type === 'ultra') {
            void ensureAttestation();
        }
    },
    { immediate: true }
);
```

- [ ] **Step 3: Typecheck + lint format**

Run: `npm run build`
Expected: passes.

- [ ] **Step 4: Commit**

```bash
git add src/wallets/ultra.ts src/components/ai/ChatDrawer.vue
git commit -m "feat(fe): on-demand connect({ requireAttestation }) when AI drawer opens

Forwards the SDK 0.5.0 requireAttestation flag and acquires a connect-time
attestation on first AI-drawer open for Ultra-extension sessions when none is
cached. Opportunistic + fail-soft: falls back to the anonymous per-IP path."
```

---

## Task 6: Verify end-to-end + simplify

- [ ] **Step 1: Full backend suite**

Run: `npm --prefix backend test`
Expected: all green, including the new `attestation.canonical` parity test.

- [ ] **Step 2: Backend typecheck**

Run: `npm --prefix backend run typecheck`
Expected: clean.

- [ ] **Step 3: Frontend build/typecheck**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Playwright AI smoke (best-effort)**

Run: `npx playwright test tests/ai-chat-smoke.spec.ts`
Expected: green, or unchanged from baseline if it requires a live wallet. Report the result honestly; do not claim a pass that didn't run.

- [ ] **Step 5: Code-simplifier pass over the diff** (per memory `feedback_simplify_after_features` + backend CLAUDE.md §7.1)

Dispatch the `code-simplifier` subagent over the changed files only:
`backend/src/middleware/attestation.ts`, `src/wallets/ultra.ts`, `src/components/ai/ChatDrawer.vue`.
Exclusions per backend CLAUDE.md §7.1: leave the test files, validation gates, and docs out of scope. Re-run `npm --prefix backend test` + `npm run build` after; revert any file the pass breaks.

---

## Out of scope / deliberately NOT changed

- **No `package.json` SDK bump.** npm has only `@ultraos/wallet-sdk@0.3.1`; 0.4.0/0.5.0 are unpublished. The local symlink (`node_modules/@ultraos/wallet-sdk` → `~/ultra/web-app/dist/libs/wallet-sdk`) is the dev arrangement. Bump the manifest only once the SDK publishes (RFC §9 step 1).
- **`balance-gate.ts`, `ratelimit.ts`, `logging.ts`, `index.ts`** — already correct; no changes.
- **`aiClient.ts`, `wallet-accounts.ts`, `useAiChat.ts`** — attestation surfacing/forwarding already done; no changes.
- **No new FE unit-test runner.** The toolkit FE has only Playwright e2e; verify FE via typecheck + smoke, not a new vitest harness.

## Acceptance mapping

- *backend rejects bad-signature / expired / origin-mismatch / wrong-chain* → `attestation.verify.test.ts` cases 3,4,4b,6,7 (now signing recursively).
- *canonical serialization matches the wallet incl. signableAccounts[].permissions* → `attestation.canonical.test.ts` (byte-exact + verify + tamper + lossy-reject).
- *balance gate sums across verified signableAccounts and refuses below threshold* → `balance-gate.test.ts` + `ai-chat.attested.test.ts` (insufficient-uos), now reachable because verification succeeds.
- *anonymous requests still work via the IP path* → `ratelimit.fallback.test.ts` + `ai-chat.anonymous.test.ts` + attestation.verify cases 8,11,12.
- *AI unlocks for a funded account after on-demand connect* → FE `ensureAttestation` (Task 4) + drawer trigger (Task 5); smoke in Task 6.
