# AI access gate — anonymous backend, per-IP rate limit, monthly cost cap

> Date: 2026-05-26
> Branch: `feature/ai-enhancement`
> Wave: redo of W1.5 (the JWT/per-pubkey approach was reverted to `f5bbcaa`)
> Status: design locked, ready for implementation
> Replaces: the W1.5 design previously in `docs/00-ai-global-guidelines.md §3`

---

## 1. Why the redo

The first attempt at W1.5 built per-pubkey JWT auth — wallet signs a nonce, backend verifies, 24h JWT, rate limits keyed on `sub = hash(pubkey)`. That whole branch was hard-reset back to `f5bbcaa`. The reasons:

- **Extra wallet popup at chat-open.** Signing a nonce after wallet-connect is a second consent step the user has to take. Breaks the "connect once, then use the toolkit" mental model.
- **Dual signing modes.** Ultra Wallet supports `signMessage`; Ledger and Anchor either lack it or expose it differently. Plumbing two paths doubles the surface area for marginal benefit.
- **Complexity vs. payoff.** JWT/nonce machinery (nonce store, JWT signer/verifier, challenge route, verify route, dev-bypass synthetic claims) is meaningful code for a defense that's only as strong as the wallet's signing UX.

This redo throws all of that out. v1 is **anonymous-per-IP**, with monthly cost cap as the binding defense.

---

## 2. Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| D1 | **v1 is fully anonymous on the backend.** `/api/ai-chat` accepts any POST. No JWT, no signature, no identity claim required or trusted. | Lowest friction for v1 ("easy to try out"). Smallest surface area. Net-deletes ~300 LOC. |
| D2 | **Rate-limit key = client IP.** Token-bucket structure unchanged from W1.5; lookup key swaps from `sub` to client IP. | IP is the only stable signal we have without identity. |
| D3 | **Cost cap is monthly, not daily.** Global ceiling = $50/month (raise to $100 if real usage shows legitimate users hitting it). | Sponsor's actual budget is monthly, not daily. Daily cap was leftover from W1.5's per-pubkey-day-USD shape. |
| D4 | **FE drawer "Sign in with wallet" CTA stays.** It gates the UI behind `connect()` because the AI needs `validatedAccounts` from the wallet to compose anything. | Purely UX — backend doesn't enforce. Wallet-connect is functionally required for the AI to do useful work, just not for backend access. |
| D5 | **Future v2 = wallet-native silent connect-time attestation (Path 1).** Documented in §6 + `docs/proposals/wallet-native-attestation.md`. | Closes T2/T3/T4 properly. Requires Ultra Wallet team coordination — doesn't block v1. |
| D6 | **Ultra SSO / OIDC (ultra-claim's pattern) is NOT the future plan.** Captured here so future readers don't re-propose it. | Path 1 (wallet attestation) is preferred because it works with the wallet primitive already in user flow, doesn't require a separate SSO login next to wallet-connect, and doesn't exclude Ledger/Anchor users from Ultra-IdP. |

---

## 3. Threat model (honest)

What the v1 gate stops, and what it doesn't.

| Threat | v1 outcome |
|---|---|
| T1 — Single-IP drive-by (curl loop on one machine) | **Blocked** by per-IP rate limit. Burns one IP in minutes, hits `rate-limit-day`. Cost to sponsor: < $0.05. |
| T2 — Distributed abuse (botnet, proxy pool, Tor) | **Bounded** by global monthly cap. ~200 distinct IPs needed to drain $50 over a month. Attacker can DoS the feature for the rest of the month; cannot drain beyond cap. |
| T3 — Cost-DoS of the AI feature | Same as T2 — global cap binds. Failure mode is "AI dies until 1st of next month". Operator gets a clear signal. |
| T4 — Account spoofing (attacker submits `validatedAccounts: ["someone-else"]`) | **Absorbed** by the wallet refusing to sign anything the attacker's keys can't authorize. Per `docs/00 §4.5`: the wallet is the signing gate, not the AI. Citation gate (`docs/00 §4.3 gate 5`) prevents the AI from emitting identifiers not in the user's message or tool results. |

**What v1 does NOT defend:**
- Distributed abuse beyond the $50/month cap. Determined attacker can DoS the AI for an entire month at $50 cost.
- Hosted-deploy IP spoofing via `X-Forwarded-For`. v1 binds loopback only — deferred until hosted-deploy work lands.
- CGNAT shared-IP false positives. Heavy carrier-NAT pools could brush the per-day cap (30/day). Refuse message names the cap explicitly.

The proper closure for T2/T3 is **Path 1 — wallet-native attestation** (see §6 + the proposal doc).

---

## 4. Backend code delta

### Delete entirely

- `backend/src/routes/auth.ts` — challenge/verify routes
- `backend/src/auth/nonce-store.ts`
- `backend/src/auth/verify-signature.ts`
- `backend/src/auth/jwt.ts`
- `backend/src/middleware/auth.ts` — JWT-verify middleware
- All tests under `backend/test/auth/` and `backend/test/middleware/auth.test.ts`

### Modify

**`backend/src/middleware/ratelimit.ts`**
- Re-key bucket store from `sub` to client IP. Bucket struct (`minute`, `hour`, `day`) unchanged.
- Add `month` field to `SubBuckets` (rename to `IpBuckets`).
- Read monthly aggregate via `readMonthlyAggregate` (renamed from `readDailyAggregate`).
- New tier constants:
  ```ts
  export const RATE_LIMITS = {
      perMinute: 10,           // burst control (per IP)
      perHour: 60,             // sustained control (per IP)
      perDay: 30,              // smooths IP usage across day (per IP)
      perMonthPerIP: 300,      // single-IP monthly footprint
      globalMonthUsd: 50,      // THE cost ceiling
  } as const;
  ```
- Refuse reasons collapse to: `rate-limit-minute | rate-limit-hour | rate-limit-day | rate-limit-month | sponsor-cap`.
- Loopback bypass: if `deps.devBypass && isLoopback(clientIpOf(c))` → `next()` immediately (skip all tiers).

**`backend/src/ratelimit/usage-aggregate.ts`**
- Rename `readDailyAggregate` → `readMonthlyAggregate`.
- Predicate becomes: rows where `ts` is in the current calendar month (UTC). Use `Date.UTC(year, month, 1)` boundary.
- Same JSONL file (`logs/usage.jsonl`), same row schema — just a different sum predicate.
- Return shape: `{ costUsdGlobal: number; tokensIn?: number; tokensOut?: number }`. Token fields can be dropped — they're no longer gated on.

**`backend/src/middleware/logging.ts`**
- Promote `remoteAddressOf(c)` to a named export `clientIpOf(c)`. Used by both logging and ratelimit.
- Document at the function: returns the connection-level remote address. For hosted deploys behind a trusted proxy, this MUST be replaced with a trusted-proxy header read (e.g., `CF-Connecting-IP`). v1 is loopback-only so the connection-level address is always trustworthy.

**`backend/src/index.ts`**
- Drop `app.use('*', jwtAuth({...}))`.
- Drop `app.route('/api/auth', createAuthRouter({...}))`.
- Drop `nonceStore` and `jwtSecret` from `AppConfig`.
- Ratelimit middleware now mounts directly on `/api/ai-chat`.

**`backend/src/routes/ai-chat.ts`**
- Drop all `c.var.auth` references.
- The `ValidateContext.jwtAccount` / `jwtPermission` / `chainId` fields previously sourced from JWT claims now come from `body.context.{selectedAccount, chainId}` (already in the request body schema). The `permission` field is NOT sent by the FE — the AI's catalog validation already uses `validatedAccounts` for permission-aware checks, so the JWT-sourced `permission` was redundant. Drop the field from `ValidateContext`.
- Remove `AuthContext` from the router type signature.

**`backend/.env.example`**
- Remove `JWT_SECRET`.
- Rename `DEV_AUTH_BYPASS` → `DEV_RATELIMIT_BYPASS`.

### Verify (don't necessarily change)

- `backend/src/index.ts` — confirm CORS allowlist still loads correctly.
- `backend/src/routes/ai-usage.ts` — if previously gated on auth, drop the gate. It's sponsor-budget telemetry (today's `cost_usd` total) — read-only, public-safe, and a useful debugging endpoint for "is the cap close?". Subject the route to the per-IP rate limit but no auth.

---

## 5. Frontend code delta

### Verify and strip if present

- `src/utilities/aiClient.ts` — must NOT send any `Authorization: Bearer ...` header. If W1.5 residue remains, remove.
- `src/composables/useAiChat.ts` — must NOT call `/api/auth/challenge` or `/api/auth/verify`. If W1.5 residue remains, remove.
- Any sign-in flow logic in `src/components/ai/` that triggers a wallet `signMessage` for AI auth — remove.

### Keep unchanged

- `src/components/ai/ChatDrawer.vue` "Sign in with wallet" CTA — gates the UI behind wallet-connect because the AI needs `validatedAccounts` to compose anything. Pure UX nudge.
- `src/utilities/aiClient.ts` request body — already includes `context.{validatedAccounts, chainId, selectedAccount}`. No schema change.

---

## 6. Documentation delta (doc PR lands BEFORE code, per `docs/00 §0`)

### `docs/00-ai-global-guidelines.md`

**§3 — full rewrite.** New title: "Identity, rate limits, and cost caps — keyed on **client IP**". Sections:

- **§3.1 — No backend identity in v1.** AI is anonymous-callable. FE drawer's "Sign in with wallet" gate is UX only.
- **§3.2 — Rate-limit tiers (per IP).** Table with the five tiers. Notes which is in-process token-bucket vs. JSONL aggregate.
- **§3.3 — What this defends.** Threat table from §3 above.
- **§3.4 — What this does NOT defend.** T2/T3 beyond global cap, hosted-deploy IP spoofing, CGNAT false positives. Each named explicitly.
- **§3.5 — Local dev.** `DEV_RATELIMIT_BYPASS=true` + loopback IP skips all tiers. `DEV_RATELIMIT_BYPASS=true` in production = CI grep failure.
- **§3.6 — Future direction: wallet-native attestation.** One-paragraph summary pointing at `docs/proposals/wallet-native-attestation.md`. Names the additive shape (optional `Authorization: Attestation <payload>` header; falls back to per-IP if absent).

### `docs/01-ai-enhancement-roadmap.md`

- **§4 (locked decisions)** — add row 11: "v1 identity model is anonymous-per-IP with monthly cost cap. Path 1 (wallet-native attestation) is the named v2 upgrade."
- **§6 row W1.5** — title becomes "Per-IP rate limit + monthly cost cap". Acceptance criteria rewritten to match this spec.
- **§9 (deferred past v1)** — add "Wallet-native attestation (closes T2/T3 properly)."

### `scripts/ai-ci-greps.sh`

- Grep #5 changes pattern from `DEV_AUTH_BYPASS=true` → `DEV_RATELIMIT_BYPASS=true` in `.env*` files.
- New grep #10 (suggested): no `JWT_SECRET=` in any committed `.env*` at repo root (it shouldn't exist after this PR; this prevents future re-introduction).

### New file: `docs/proposals/wallet-native-attestation.md`

See companion document (separate from this spec). Captures the v2 design for handoff to the Ultra Wallet team.

---

## 7. Tests

### Delete

- All tests under `backend/test/auth/`
- `backend/test/middleware/auth.test.ts`
- Any test asserting `auth-required` refuse or 401 response

### New / modified

- `backend/test/middleware/ratelimit.ip.test.ts` — IP-keyed bucket fills, refills monotonically, blocks at min/hour/day caps, distinct IPs don't share buckets, loopback bypass works when `DEV_RATELIMIT_BYPASS=true`.
- `backend/test/middleware/ratelimit.monthly.test.ts` — monthly aggregate read, UTC month-boundary crossing, `sponsor-cap` fires when `costUsdGlobal ≥ globalMonthUsd`.
- `backend/test/routes/ai-chat.anonymous.test.ts` — POST with no Authorization header succeeds (or refuses based on rate limit, never on auth). Replaces W1.5's auth-required tests.
- `backend/test/ratelimit/usage-aggregate.month-boundary.test.ts` — directly test the monthly predicate.

### Keep unchanged

- All extractor tests.
- All pipeline tests (classify, retrieve, harness, validate).
- All catalog smoke tests.

---

## 8. Acceptance

For the implementation PR:

- `npm --prefix backend test` green.
- `npm run build` green.
- Playwright smoke (`tests/wallet-integration.spec.ts`) green — AI feature accessible after wallet-connect, no extra signing popup, chat returns a normal reply for a simple "transfer X UOS" prompt.
- `scripts/ai-ci-greps.sh` green (with updated grep #5 + new grep #10).
- New rate-limit tests assert per-IP isolation, monthly aggregate behavior, and loopback bypass.
- Net code reduction visible in the diff (no JWT/nonce/signature plumbing).
- Code-simplifier pass per `docs/01 §7.1`.
- PR body cites `docs/00 §3` (new shape) + `docs/01 §6 row W1.5` (rewritten).

---

## 9. Risks acknowledged in code

In `backend/src/middleware/ratelimit.ts`, add a leading docblock that explicitly names:

```
// PER-IP rate limit. Identity model documented in docs/00 §3.
//
// v1 is bounded but not Sybil-resistant — a botnet of ~200 distinct
// IPs can drain the $50/month sponsor cap. Wallet-native attestation
// (docs/proposals/wallet-native-attestation.md) is the named upgrade
// that closes this.
//
// Loopback bypass for local dev: DEV_RATELIMIT_BYPASS=true + 127.0.0.1/::1
// short-circuits ALL tiers. Production = CI grep failure (ai-ci-greps.sh #5).
//
// Hosted deploy WARNING: clientIpOf() reads the connection-level remote
// address. v1 binds loopback only so this is trustworthy. When hosted-deploy
// lands, this MUST be replaced with a trusted-proxy header read
// (CF-Connecting-IP for Cloudflare). Trusting X-Forwarded-For naively
// allows trivial per-request IP spoofing.
```

The honesty is load-bearing. Future readers must not be misled about what this gate does.

---

## 10. Implementation prompt

Paste-able for a fresh Claude Code session. Intentionally self-contained — the session that runs this has no memory of the brainstorm that produced this spec.

````markdown
You are working on `ultra-tool-kit` on branch `feature/ai-enhancement`.

This is a **redo** of wave W1.5. The previous attempt built per-pubkey JWT auth
(challenge → wallet `signMessage` → JWT, rate-limit keyed on `sub = hash(pubkey)`).
That whole branch was hard-reset back to `f5bbcaa`. The new design is **anonymous
backend, per-IP rate limit, monthly cost cap**.

## Read in order

1. `docs/superpowers/specs/2026-05-26-ai-access-gate-design.md` — **the full design.
   Source of truth for this wave.**
2. `docs/00-ai-global-guidelines.md` — load-bearing rules; §3 is being rewritten as
   part of this wave (see the spec).
3. `docs/01-ai-enhancement-roadmap.md` — §6 row W1.5 is being rewritten as part of
   this wave (see the spec).
4. `backend/CLAUDE.md` — backend conventions, hard rules.
5. `CLAUDE.md` (root) — frontend conventions; only relevant for verifying nothing
   in the FE sends an `Authorization: Bearer` header.
6. `docs/proposals/wallet-native-attestation.md` — context only. This is the named
   v2 upgrade and is NOT in scope for this wave.

## Wave scope (one sentence)

Replace the W1.5 JWT/per-pubkey auth with an anonymous backend, per-IP rate limit,
and a monthly cost cap; doc PR lands first, then code.

## Doc PR (lands FIRST, separate PR)

Per `docs/00 §0`, the docs change before any code. This wave is two PRs:

**PR 1 — docs only:**
- Rewrite `docs/00-ai-global-guidelines.md §3` per the spec §6.
- Rewrite `docs/01-ai-enhancement-roadmap.md §6 row W1.5` per the spec §6.
- Update `docs/01 §4` (locked decisions) and `§9` (deferred) per the spec §6.
- Update `scripts/ai-ci-greps.sh` greps #5 + new #10 per the spec §6.
- The new `docs/proposals/wallet-native-attestation.md` and the spec itself are
  already committed — verify they're present, don't rewrite.

**PR 2 — code:**
Begin only after PR 1 is merged.

## Files to touch (PR 2)

**Delete entirely:**
- `backend/src/routes/auth.ts`
- `backend/src/auth/` (entire directory: `jwt.ts`, `nonce-store.ts`, `verify-signature.ts`)
- `backend/src/middleware/auth.ts`
- `backend/test/auth/` (entire directory)
- `backend/test/middleware/auth.test.ts`

**Modify:**
- `backend/src/middleware/ratelimit.ts` — re-key from `sub` to client IP, add
  monthly tier, drop token/per-sub-USD tiers, add loopback bypass.
  New `RATE_LIMITS` constants (per spec §4):
  ```ts
  perMinute: 10, perHour: 60, perDay: 30,
  perMonthPerIP: 300, globalMonthUsd: 50
  ```
  Add the load-bearing docblock from spec §9 verbatim at file top.
- `backend/src/ratelimit/usage-aggregate.ts` — rename `readDailyAggregate` →
  `readMonthlyAggregate`. Predicate: rows with `ts` in current UTC calendar month.
  Return `{ costUsdGlobal: number }` only — drop the token fields.
- `backend/src/middleware/logging.ts` — promote `remoteAddressOf(c)` to a named
  export `clientIpOf(c)` with the hosted-deploy warning docblock from spec §9.
- `backend/src/index.ts` — drop `app.use(jwtAuth(...))`, drop
  `app.route('/api/auth', ...)`, drop `nonceStore` + `jwtSecret` from `AppConfig`.
- `backend/src/routes/ai-chat.ts` — drop `c.var.auth` references. Source
  `chainId` / `selectedAccount` from `body.context` (already in schema). Drop
  the `permission` field from `ValidateContext` entirely (was JWT-sourced and
  redundant with `validatedAccounts`-based catalog checks). Remove `AuthContext`
  from router type.
- `backend/src/routes/ai-usage.ts` — drop the JWT auth gate if present. Keep the
  route public (sponsor-budget telemetry, useful debugging). Subject to the
  per-IP rate limit only.
- `backend/.env.example` — remove `JWT_SECRET`. Rename `DEV_AUTH_BYPASS` →
  `DEV_RATELIMIT_BYPASS`.

**New tests:**
- `backend/test/middleware/ratelimit.ip.test.ts`
- `backend/test/middleware/ratelimit.monthly.test.ts`
- `backend/test/routes/ai-chat.anonymous.test.ts`
- `backend/test/ratelimit/usage-aggregate.month-boundary.test.ts`
- See spec §7 for the assertion shape of each.

**Verify (FE):**
- `src/utilities/aiClient.ts` — confirm no `Authorization: Bearer` header is
  attached. If W1.5 residue exists, strip.
- `src/composables/useAiChat.ts` — confirm no calls to `/api/auth/challenge` or
  `/api/auth/verify`. If W1.5 residue exists, strip.
- `src/components/ai/ChatDrawer.vue` — confirm the "Sign in with wallet" CTA is
  pure UI gating (gates the chat panel behind wallet-connect because the AI
  needs `validatedAccounts`). Keep unchanged.

## Files NOT to touch

- Wallet code (`src/wallets/**`).
- `Transaction.vue` existing branches.
- Page logic outside `src/components/ai/**`.
- The extractor, catalog files, pipeline (classify, retrieve, harness, validate).
- Anything outside the deletion/modification list above without stopping to ask.

## Acceptance (PR 2)

- `npm --prefix backend test` green. All new tests in the spec §7 list pass.
- `npm run build` green.
- Playwright smoke (`tests/wallet-integration.spec.ts`) green — AI feature
  accessible after wallet-connect, no extra signing popup, chat returns a normal
  reply for a "transfer X UOS" prompt.
- `scripts/ai-ci-greps.sh` green with the updated grep #5 + new grep #10.
- `git diff` shows a NET CODE REDUCTION (no JWT/nonce/signature plumbing remains).
- Code-simplifier pass executed per `docs/01 §7.1`. PR body notes what was dropped.
- PR title: `[ai-W1.5-redo] anonymous backend + per-IP rate limit + monthly cap`.
- PR body cites: `docs/superpowers/specs/2026-05-26-ai-access-gate-design.md`,
  `docs/00 §3` (rewritten), `docs/01 §6 row W1.5` (rewritten).
- PR body has the "Security check" paragraph per `docs/00 §0.3`: which guardrails
  apply (§3 IP rate limit, §3 monthly cap, §3 loopback bypass), which test
  asserts each.

## Execution preferences

- **Use subagents.** Per the user's global execution preferences, dispatch
  subagents for plan execution (`superpowers:subagent-driven-development`).
  Do not execute the implementation inline.
- **Verify versions.** Before touching any dependency, verify the latest version.
  Don't assume training-data versions.
- **TDD.** Per `superpowers:test-driven-development`, write the failing test
  before the implementation for each new test file.

## Stop and ask before

- Adding any new dependency (this PR should net-remove deps, not add).
- Touching anything outside the scope list above.
- Modifying the catalog, extractor, or LLM provider code.
- Changing the request body schema in a non-additive way.
- Building any part of `docs/proposals/wallet-native-attestation.md` —
  that's v2, not this wave.
````

The prompt is the contract for the implementation session. Keep it stable.

---

## 11. Future direction

The follow-up is **Path 1 — wallet-native silent connect-time attestation**.

Why this is the preferred v2 and not Ultra SSO (ultra-claim's pattern):

- **No second login.** Attestation rides the existing `connect()` consent flow. SSO adds a separate "Sign in with Ultra" affordance next to "Connect wallet" — cognitively heavier.
- **No third-party account requirement.** Ultra SSO is tied to Ultra accounts. Anchor / Ledger users without an Ultra SSO identity would be locked out. Wallet attestation works wherever a wallet vendor implements it (Ultra extension first, Ultra Web second, Anchor/Ledger as third-party adoptions if ever).
- **Single source of truth.** The wallet already knows the user's pubkey + accounts. SSO adds a parallel attestation system that can drift.

Full design at `docs/proposals/wallet-native-attestation.md`.
