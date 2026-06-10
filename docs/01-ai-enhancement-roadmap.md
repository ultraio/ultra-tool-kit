# AI Enhancement — Design & Roadmap

> Branch: `feature/ai-enhancement` (to be created)
> Replaces the demo on `task/ai-enhance-demo`. Borrows code, not architecture.
> Model: Anthropic **Haiku 4.5** (hosted), Ollama-served Haiku-equivalent (qwen2.5:14b or llama3.1:8b) locally.
> **Mandatory pairing:** `docs/00-ai-global-guidelines.md` — read it first; every PR cites it.

---

## 1. What we are building

A chat box in the toolkit that does three things, in priority order:

1. **Compose an action and sign it.** User describes intent in natural language; the AI emits a validated action and hands it to the existing `<Transaction>` modal. Smart enough to notice missing params or insufficient funds and ask back.
2. **Compose a proposal (`eosio.msig::proposex`).** One or many inner actions, requested approvers gathered automatically, validates each inner tx against the chain before submission. Hands off through `Transaction.vue`'s existing `isMakingProposal` path.
3. **Answer Ultra/contract questions.** Technical Q&A grounded on the deterministic catalog + ABIs. Scoped to Ultra only.

Out of scope: signing (wallet does it), writing to chain without user review, anything that bypasses `<Transaction>`.

Primary contract surface (must work well): `eosio.token`, `eosio.nft.ft`, `eosio.msig`. Other contracts work via fallback to ABI-only mode.

---

## 2. Three load-bearing maxims

Canonical wording lives in `docs/00-ai-global-guidelines.md §1`. Summarized here for context:

- The catalog decides; the AI renders.
- No identifier is invented.
- Treat every external input as hostile; treat every output as observable.

Plus a roadmap-specific rule: **§6 is the only feature list. If a wave PR builds something not in §6, stop and ask. Schema changes are their own PR. One concept per PR.**

---

## 3. Architecture (no database, in-memory)

```
┌───────────────────────────── ultra-tool-kit (Vue 3) ───────────────────────────┐
│                                                                                 │
│  ChatDrawer (existing, lightly refactored)                                      │
│       │                                                                          │
│       │ POST /api/ai-chat  { messages, context, sessionId }                      │
│       ▼                                                                          │
└───────┼──────────────────────────────────────────────────────────────────────────┘
        │
┌───────▼──────────────── Hono backend (Node, stateless) ────────────────────────┐
│                                                                                  │
│  routes/ai-chat.ts                                                               │
│       │                                                                           │
│       ▼                                                                           │
│  pipeline/                                                                        │
│   ├── classify.ts      (cheap intent gate: act | propose | ask | refuse)         │
│   ├── retrieve.ts      (BM25 over catalog/*.json, top-K=5)                       │
│   ├── tools/                                                                      │
│   │    ├── get_action_schema  (returns 1 ABI entry from catalog)                 │
│   │    ├── get_account        (RPC: /v1/chain/get_account)                       │
│   │    ├── get_balance        (RPC: /v1/chain/get_currency_balance)              │
│   │    ├── get_table_rows     (RPC, restricted scopes/tables)                    │
│   │    └── get_factory        (eosio.nft.ft factory table, helper)               │
│   ├── harness.ts       (provider-agnostic, JSON-schema-gated, budget-capped)     │
│   └── validate.ts      (catalog membership + ABI field shape + coerce LLM quirks)│
│                                                                                   │
│  llm/                                                                             │
│   ├── provider.ts      (interface only)                                          │
│   ├── anthropic.ts     (Haiku 4.5; with prompt caching + tool use)               │
│   └── ollama.ts        (Haiku-equivalent local: qwen2.5:14b / llama3.1:8b)       │
│                                                                                   │
│  catalog/              (JSON, committed)                                          │
│   ├── eosio.token.json                                                            │
│   ├── eosio.nft.ft.json                                                           │
│   └── eosio.msig.json                                                             │
│                                                                                   │
│  logs/usage.jsonl      (append-only cost log; gitignored)                        │
│                                                                                   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**Why no DB:** with three contracts the catalog is < 100 KB and the LLM rarely needs more than 1–2 action schemas per turn. BM25 over titles + summaries is enough to pick the right action; we never beat a few-hundred-line keyword index. Chat history stays in `sessionStorage` and we send the last N turns on every request — backend stays stateless. Usage log is JSONL appended to disk.

**Token-saving levers built in:**

| Lever | What it does | Saved |
|---|---|---|
| Catalog as JSON, indexed in memory | No embedding round-trip, no DB | ~constant infra |
| Tool-use, not full ABIs in prompt | LLM asks for the one schema it needs | ~70% input tokens |
| Anthropic prompt caching on system prompt | System prompt cached across turns | ~80% on cached portion |
| JSON-schema-gated structured output | No prose padding, no "okay so first…" preamble | ~50% output tokens |
| Last-N (N=6) message window + sliding summary | History truncated server-side | linear → flat |
| Classifier short-circuit | "What's the weather?" never reaches the planner | full call avoided |
| Per-call + per-session budget caps | Hard ceilings on tokens, wall-time, retries | bounded worst-case |
| Local Ollama path (no per-call cost) | Same harness, different provider | offline dev = $0 |

Per-turn target (hosted): **≤ 1.5 K input + ≤ 400 output**, ~$0.0008 on Haiku 4.5 list pricing. Per-session cap: 50 K total tokens.

---

## 4. Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| 1 | **No database.** Catalog = JSON files. Sessions = client `sessionStorage`. Usage = JSONL on disk. | Smallest infra, fastest cold-start, fits ≤ 500 actions easily. |
| 2 | **Keep the tree-sitter-cpp extractor.** Re-run for `eosio.token`, `eosio.nft.ft`, `eosio.msig`. | Already works; this is the deterministic fact path the demo proved out. |
| 3 | **Single provider interface (`anthropic` ↔ `ollama`).** No OpenAI in v1. | We're sponsoring Haiku 4.5; one less provider to maintain. Add later if needed. |
| 4 | **Tool-use, not RAG-everything-into-prompt.** | Token saver. Haiku 4.5 supports tool-use natively. |
| 5 | **RPC grounding on by default.** Read-only tools call the active toolkit endpoint. | Kills "insufficient funds" confusion in one turn. User's explicit ask. |
| 6 | **AI never signs.** Always hands to `<Transaction>` via `@transact`. Proposal mode hands to the existing `proposex` flow in `Transaction.vue`. | Wallet is the trust boundary; keep it. |
| 7 | **JSON-schema-gated outputs.** Every LLM call returns a typed `Reply` (`act | propose | ask | refuse | answer`). | bi-platform's pattern. Catches hallucinations early. |
| 8 | **Three-contract priority.** `eosio.token`, `eosio.nft.ft`, `eosio.msig` first-class. Others work via ABI fallback. | Per user instruction; covers 90% of toolkit traffic. |
| 9 | **Branch:** `feature/ai-enhancement`. One PR per wave. PR title format: `[ai-NN] <imperative>`. | Matches bi-platform's "one PR = one feature" cadence. |
| 10 | **Nothing outside the AI scope is changed.** Wallet code, Transaction.vue's existing paths, page logic — all frozen. | User instruction. |
| 11 | **v1 identity model is anonymous-per-IP with monthly cost cap. Path 1 (wallet-native silent attestation) is the named v2 upgrade — see `docs/proposals/wallet-native-attestation.md`.** | Smallest defense that's still binding; net code reduction; closes T1 cheaply, bounds T2/T3 via global cap. |
| 12 | **Wallet-native attestation is the v2 identity primitive** (RFC: `docs/proposals/wallet-native-attestation.md`); per-IP from §3.2 of `docs/00-ai-global-guidelines.md` is the v1 fallback for unattested users. | Adopts the Path-1 upgrade named in decision 11. Header-only, strictly additive: no request-body change, response shape unchanged, Anchor/Ledger users unaffected. Lands in W9. |

---

## 5. Guardrails always in effect

- All untrusted text (user message, RPC response, prior LLM output replayed in history) is **fenced** inside `<user_input>…</user_input>` in the user message — never concatenated into the system prompt.
- Every LLM reply is **Pydantic-style schema-validated** (Zod here) before any consumer sees it. Schema failure → downgrade to `kind: ask`. Never pass a half-validated proposal to the frontend.
- Every reply with a `contract`/`action` is **catalog-membership-checked**: the contract+action pair must exist in `catalog/*.json` OR the AI must have called `get_abi` for an unknown contract in this turn.
- Every `*_id`, account name, or table key in the reply must trace to: (a) the user message, (b) a tool-call response in this turn, or (c) `context.knownAccounts`. **No invented identifiers.**
- Per-call budget: `max_input_tokens`, `max_output_tokens`, `max_wall_ms`, `max_retries` enforced in the harness. Per-session: 50 K total tokens.
- Per-call + tool-call trace logged to `logs/usage.jsonl`: `provider:model`, tokens in/out, latency, retries, tools called, validation outcome.
- **The AI is not the signing gate.** If the AI proposes an action the wallet can't sign, the chain rejects it — that's by design.
- **No tool calls outside the allowlist.** Tools are explicitly registered per turn; unknown tool names are rejected, not dispatched.

---

## 6. Roadmap — 9 waves, each 1–3 days

Each wave is one branch commit / one PR off `feature/ai-enhancement`. Don't merge to main until wave 9.

| # | Wave | Est. | Outcome | Guidelines satisfied |
|---|---|---:|---|---|
| W0 | Branch + skeleton + extractor refresh | 1d | Branch exists, `backend/catalog/{token,nft.ft,msig}.json` regenerated, smoke tests pass. No LLM. | §1, §5 (greps land here) |
| W1 | Provider abstraction + harness (Haiku 4.5 + Ollama) | 2d | `harness.call(schema, prompt, tools?)` works against both providers. Budget caps enforced. Schema gate trips on bad output. | §4.3 gate 1, §4.7, §5 grep 1+2 |
| **W1.5** | **Per-IP rate limit + monthly cost cap** | **2d** | **Anonymous backend (no JWT, no signature). `POST /api/ai-chat` accepts any caller; rate-limit middleware buckets on client IP across minute/hour/day/month tiers; global $50/month USD cap reads `logs/usage.jsonl` aggregate. `DEV_RATELIMIT_BYPASS=true` + loopback bypass for dev. Net code reduction from the original W1.5 attempt.** | **§3 in full, §4.6, §5 rules 5 + 10 (grep #5 lands here; grep #12 enforcing rule 10 lands in PR 2)** |
| W2 | Catalog index + classify + retrieve | 1d | `classify(text)` returns `act | propose | ask | refuse | answer`. BM25 retrieval returns top-K=5 catalog hits. Pure functions, unit-tested. | §4.1 (injection prefixes), §1 |
| W3 | Action composer for `eosio.token` end-to-end | 2d | Chat "transfer 100 UOS from a to b" → JSON proposal → `<Transaction>` modal opens with prefilled data. No RPC yet. | §4.3 gates 1–6, §4.5 |
| W4 | RPC grounding tools (read-only) | 2d | `get_account`, `get_balance`, `get_abi`, `get_table_rows`, `get_action_schema` allowlisted. Per-turn tool budget enforced. Responses fenced as untrusted. AI catches "insufficient funds" in one turn. | §4.1, §4.2 full, §4.4 |
| W5 | `eosio.nft.ft` full support | 3d | Factory create + mint + transfer + group + URI flows all work. AI fetches factory state via allowlisted `get_table_rows`. Metadata schema validated via existing `schemaValidator` plumbing. | §4.2 row `factory.a`/`group.a`, §4.3, §4.4 |
| W6 | `eosio.msig` proposal composer | 2d | "propose: transfer 100 UOS from corp@active, require ceo + cfo" → multi-action `proposex` built; **every inner action passes §4.3 gates 1–6 individually**; handed to `Transaction.vue`'s `isMakingProposal` path. | §4.3 full, §4.5 |
| W7 | Q&A mode (knowledge answers) | 1d | "What does `eosio.nft.ft::setfact.uri` do?" returns a grounded explanation citing catalog entries. Refuses non-Ultra questions politely. | §1 maxim 2 (no invented refs), §4.1 |
| W8 | Telemetry + regression baseline + polish | 2d | `logs/usage.jsonl` written per §7. Baseline fixtures green (§6). Prompt caching headers on, sliding-window summary, cost badge live, Playwright suite green. | §6 full, §7 full |
| W9 | Wallet-native attestation + balance-gated AI | 1d | Toolkit adopts `@ultraos/wallet-sdk@0.4.0` attestation as the v2 identity primitive. The FE forwards `Authorization: Attestation` when the wallet provides it; the backend verifies it, attaches `c.var.identity`, gates AI access on the summed UOS balance across `signableAccounts`, and re-keys the rate limit from `ip:` to `pubkey:` with looser tiers. Unattested (Anchor/Ledger) requests hit the per-IP path unchanged. Matches RFC §9. | §3.7, §5 grep 13, §7 |
| W10 | Stake-tiered daily cost cap | 2d | Per-identity daily USD cap on AI spend; attested users raise their cap by staking UOS (read from `eosio/userres`, priced via `eosio.oracle` with config fallback). In-memory counters; single replica. `GET /api/ai-quota` powers the FE badge. No new contract, no new LLM tool. | §3.8, §7 |

**Total: ~18 working days, one person.** W1.5 adds 2 days but is non-negotiable for sponsored AI.

Dependencies: W0 → W1 → W1.5 → W2 → W3 → W4 → W5 → W6 → W7 → W8. W7 can run in parallel with W6 if needed.

---

## 7. Per-wave prompt templates

Each wave starts a fresh Claude session with a copy-paste prompt. Pattern below — fill in the blanks per wave; the user will hand you the exact prompt when the previous wave is merged.

```
You are working on `ultra-tool-kit` on branch `feature/ai-enhancement`.
Read in order:
  1. docs/00-ai-global-guidelines.md  — load-bearing rules; quote sections you satisfy
  2. docs/01-ai-enhancement-roadmap.md — §2 maxims, §4 decisions, §6 wave [WN] row
  3. CLAUDE.md (root)
  4. /Users/duncandam/scalestack/bi-platform/CLAUDE.md — code-quality standards section
  5. backend/CLAUDE.md (carry-over from the demo) — extractor + harness conventions

Wave [WN] scope: <one sentence>
Files to touch: <bullet list>
Files NOT to touch: <bullet list> (NEVER modify wallet code, Transaction.vue's existing branches, or page logic outside `src/components/ai/`)

Acceptance:
- <test 1>
- <test 2>
- `npm run build` green, `npm --prefix backend test` green, smoke playwright green
- `scripts/ai-ci-greps.sh` green (after W1)
- Security check paragraph in PR body: list guideline §s satisfied and the test asserting each
- **Code simplifier pass executed before commit** (see §7.1). PR body notes the simplifier ran and what it dropped.
- One commit, PR title `[ai-WN] <imperative>`, body cites docs/00-ai-global-guidelines.md §s + docs/01-ai-enhancement-roadmap.md §6 row [WN]

Stop and ask before:
- Adding any new dependency
- Touching a file outside the listed scope
- Inventing a doc requirement not in either guideline doc
- Adding a tool, allowlist row, or rate-limit tier (those require a docs PR first)
```

### 7.1 Code-simplifier pass — mandatory before every wave's commit

Borrowed from `backend/CLAUDE.md` "Simplify before committing a feature". Every wave runs this between "tests green" and "commit":

1. Take the file list from `git diff --name-only HEAD` (excluding generated files like `catalog/*.json`, lockfiles, `typed-router.d.ts`).
2. Dispatch a `code-simplifier` subagent over those files with the brief: tighten naming, drop scaffolding that proved unnecessary, remove defensive code that no test exercises, collapse helpers that only one caller uses, strip comments that restate WHAT instead of explaining WHY.
3. **Do not let the simplifier touch:**
   - `docs/00-ai-global-guidelines.md`, `docs/01-ai-enhancement-roadmap.md`, any other doc (`*.md`).
   - Validation gates, citation checks, rate-limit / budget code, fenced-input wrappers — these are load-bearing per §4 of the guidelines and look like dead defensive code at first glance.
   - Test fixtures and the regression baseline.
4. Re-run `npm run build` + `npm --prefix backend test` + Playwright smoke after the simplifier pass. Anything fails → revert the simplifier diff for that file and call it out.
5. Commit. PR body lists what the simplifier dropped (one bullet per file changed by the pass).

**Skip the simplifier only for:** doc-only PRs, one-line hotfixes, or commits that already contain ≤ 10 LOC of non-test code. Call out skips explicitly in the PR body.

Rationale: this is sponsored AI infrastructure with strict cost + security guarantees. Code that compounds over 9 waves without trimming becomes the bug surface that hides budget leaks and validation bypasses. The simplifier keeps each wave's delta reviewable and the cumulative surface small.

---

## 7.2 W0 prompt (ready to paste)

Paste this into a fresh Claude session once `feature/ai-enhancement` is checked out:

```
You are working on `ultra-tool-kit` on branch `feature/ai-enhancement`.

Read in order:
  1. docs/00-ai-global-guidelines.md  — load-bearing; quote sections you satisfy
  2. docs/01-ai-enhancement-roadmap.md §6 row W0 + §3 (architecture) + §8 (what survives)
  3. CLAUDE.md (root)
  4. backend/CLAUDE.md

Wave W0 scope: branch hygiene + extractor refresh.

Goals:
  - Verify branch `feature/ai-enhancement` is checked out (do not switch).
  - Cherry-pick from `task/ai-enhance-demo` only the files listed in roadmap §8 ("What survives"). Do NOT bring over the DB layer, OpenAI provider, embeddings, or auth stub.
  - Re-run the extractor against the three primary contracts and commit the JSON:
      npm --prefix backend run extract -- eosio.token
      npm --prefix backend run extract -- eosio.nft.ft
      npm --prefix backend run extract -- eosio.msig
  - Add a single smoke test that loads each catalog file and asserts the top-level shape (no LLM, no DB).
  - Add (empty for now) `scripts/ai-ci-greps.sh` with a stub that exits 0. W1 fills it in.
  - Update `backend/.env.example` to drop EMBED_PROVIDER + DATABASE_URL + OpenAI keys.

Files to touch:
  - backend/src/extractor/**  (carried from demo)
  - backend/catalog/{eosio.token,eosio.nft.ft,eosio.msig}.json  (regenerated)
  - backend/src/pipeline/validate.ts  (carried; trim DB references)
  - backend/src/llm/{provider,anthropic,ollama}.ts  (carried; drop openai.ts)
  - backend/scripts/extract-contract.ts
  - backend/test/extractor/**
  - backend/test/smoke.catalog.test.ts  (new)
  - backend/package.json (drop drizzle/postgres/openai deps; keep tree-sitter, hono, zod, anthropic, ollama)
  - backend/.env.example
  - scripts/ai-ci-greps.sh (stub)

Files NOT to touch:
  - Anything under src/ (frontend) except later waves — W0 is backend-only
  - Wallet code (src/wallets/**), Transaction.vue, page logic outside src/components/ai/**

Acceptance:
  - `npm --prefix backend test` green
  - `npm --prefix backend run extract -- eosio.token` produces a reviewable JSON file with > 0 actions
  - Same for eosio.nft.ft and eosio.msig
  - `npm run build` green (no frontend change should mean no regression)
  - Code-simplifier pass executed per §7.1; PR body notes what was dropped
  - PR title: `[ai-W0] backend skeleton + extractor refresh for the three primary contracts`
  - PR body: cite docs/00-ai-global-guidelines.md §1 + §5 (greps land here), docs/01-ai-enhancement-roadmap.md §6 row W0

Stop and ask before:
  - Adding any new dependency
  - Touching anything under src/ (frontend)
  - Modifying any *.md doc beyond fixing typos
```

---

## 8. What survives from the demo (`task/ai-enhance-demo`)

Cherry-pick into `feature/ai-enhancement` as starting points:

- `backend/src/extractor/**` (entire C++ extractor — works, re-run for the three contracts)
- `backend/src/pipeline/validate.ts` (the `coerceLlmShape` repairs for small-model output drift — still useful for Ollama)
- `backend/src/llm/provider.ts` + `anthropic.ts` + `ollama.ts` (interface stays; trim openai)
- `src/components/ai/ChatDrawer.vue`, `MessageBubble.vue`, `ProposalCard.vue` (UI is fine — they hand off to `@transact` already)
- `src/composables/useAiChat.ts` + `src/utilities/aiClient.ts` (refactor signatures, keep the structure)

What gets dropped:

- Postgres + Drizzle + pgvector (entire DB layer; `backend/src/db/**`, `backend/drizzle/**`)
- `backend/src/pipeline/retrieve.ts` pgvector path (replaced by in-memory BM25)
- `backend/src/auth/** + backend/src/middleware/auth.ts + backend/src/routes/auth.ts` (W1.5-redo drops all JWT/nonce/signature plumbing; PR 2 of this wave deletes the directory).
- Anything embeddings-related (`EMBED_PROVIDER`, `nomic-embed-text`, etc.)
- OpenAI provider (single-provider-cleanup; bring back later if needed)

---

## 9. Open items deferred past v1

- Hosted deploy (Fly.io / Dokploy). v1 is local-first. When hosted-deploy lands, the per-IP rate limit (§3 of docs/00) MUST switch from connection-level remote address to a trusted-proxy header read (e.g., CF-Connecting-IP).
- Wallet-native silent connect-time attestation (Path 1). Closes T2/T3 properly by binding requests to a wallet-issued attestation instead of just an IP. Requires Ultra Wallet team coordination. Full design at docs/proposals/wallet-native-attestation.md.
- Cross-process rate limiting (Redis-backed). In v1 the token buckets are in-process + JSONL aggregate, fine for single-instance.
- Bulk flows (`bulkFactoryCreation`, `uosMassTransfer`) — same chat, but emits N actions.
- Factory metadata authoring assistant (the `schemaValidator` page hook).
- Streaming responses (current design is unary; streaming is a UX polish, not a feature).

These are documented so they don't sneak into v1 PRs.
