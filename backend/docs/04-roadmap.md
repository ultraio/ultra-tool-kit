# AI-Assisted Action Assembly — Roadmap

> Companion to `00-overview.md`, `01-architecture.md`, `02-cost-and-ops.md`, `03-guardrails.md`.
> Phase 1 only. Phase 2 milestones get drafted post-approval.

## How to use this doc

The Phase-1 work is split into **6 milestones**, each sized to land in one focused session and one commit on the `task/ai-enhance-demo` branch. Each milestone has:

- **Goal** — what success looks like
- **Scope** — file boundaries (what to touch, what to leave alone)
- **Prompt** — copy/paste this into a fresh Claude session to execute the milestone

The prompts are self-contained: they reference `backend/CLAUDE.md` and the design docs, list specific files, and end with a commit instruction. Don't paste two milestones into the same session — the point of the split is to keep each session focused and the diff reviewable.

After each milestone, eyeball the result, run any acceptance check listed at the end of the prompt, then move on.

## Milestone overview

| # | Milestone | Est. | Outcome |
|---|---|---:|---|
| M1 | Backend scaffold + extractor against `eosio.token` | ~14h | `backend/` exists; running `npm --prefix backend run extract -- eosio.token` produces a reviewable JSON file |
| M2 | DB schema + Stage B ingest | ~10h | Local Postgres has `eosio.token` actions ingested with embeddings; pgvector retrieval returns `transfer` for "send tokens" queries |
| M3 | Backend chat API | ~14h | `curl POST /api/ai-action` with "transfer 100 UOS" returns a valid `kind: propose` payload |
| M4 | Frontend chat drawer | ~12h | Chat panel works end-to-end: type → propose → "Sign now" opens existing `<Transaction>` modal |
| M5 | Cost meter + builder handoff | ~6h | `CostBadge` shows `🏠 X.X K tok` + projected cost; "Open in Builder" pre-fills the builder page |
| M6 | Tests + demo polish | ~6h | Playwright e2e green; README walks teammates through the demo |
| | **Total** | **~62h** | One person, ~7-8 working days |

Recommended order is the order listed. Each milestone depends on the previous in code (M2 needs M1's catalog; M3 needs M2's data; M4 needs M3's API). Don't try to parallelize — the design's risk concentrates in M1 (the extractor) and M3 (the pipeline correctness).

## Conventions across all milestones

- All work happens on branch `task/ai-enhance-demo`. Don't create new branches; don't open PRs.
- Each milestone ends with **one commit** containing only that milestone's changes. Use the milestone title as the commit subject.
- Pre-commit hooks (Prettier via Husky) run automatically — don't bypass.
- **Don't run `npm install` in the root** without checking `package.json` diff first. Frontend deps and backend deps are intentionally separate.
- If a milestone uncovers a design gap, **write the gap into the relevant doc before fixing it in code.** The docs are the spec.
- Tests pass before commit (`npm test` for frontend if affected; `npm --prefix backend test` for backend).

---

## M1 — Backend scaffold + extractor against `eosio.token`

### Goal

Stand up the `backend/` folder with the bare minimum to run the Stage A extractor. By the end of M1, running:

```bash
npm --prefix backend run extract -- eosio.token
```

…produces `backend/catalog/eosio.token.json` containing every action in the contract with extracted `auths`, `preconditions`, `field_constraints`, and `recipients`. No DB, no frontend changes, no LLM. **Pure C++ → JSON.**

### Scope

**Touch:**
- `backend/package.json` (new)
- `backend/tsconfig.json` (new)
- `backend/.env.example` (new)
- `backend/.gitignore` (new — ignore `node_modules`, `dist`, `.env`, `catalog/*.json` … actually wait, catalog should be checked in for review)
- `backend/src/extractor/*.ts` (new — `index.ts`, `cpp-parser.ts`, `patterns.ts`, `macros.ts`, `types.ts`)
- `backend/scripts/extract-contract.ts` (new)
- `backend/test/extractor/fixtures/*.cpp` (new — synthetic inputs)
- `backend/test/extractor/*.test.ts` (new — vitest)
- `backend/catalog/eosio.token.json` (new — generated output, **checked in for review**)

**Don't touch:**
- Anything under `src/` (frontend)
- `package.json` at repo root
- `.gitignore` at repo root (already excludes `backend/docs/`)

### Prompt to paste into a fresh session

```
You're working on the `ultra-tool-kit` repo on branch `task/ai-enhance-demo`. Read these first, in order:

1. backend/CLAUDE.md  — backend conventions and stack choices
2. backend/docs/01-architecture.md §5  — the indexer design (Stage A is your scope)
3. backend/docs/01-architecture.md §5.5 — source-path resolution rules
4. backend/docs/01-architecture.md §5.6 — the eosio.token actions you should expect to extract

Your milestone is M1: Backend scaffold + extractor against eosio.token. Do NOT do M2-M6.

What to build:

1. `backend/package.json` with these deps (verify latest versions before adding — don't use training-data versions):
   - dependencies: hono, postgres, drizzle-orm, web-tree-sitter, tree-sitter-cpp, @ultraos/ultra-api-lib, pino, dotenv, zod, yaml
   - devDependencies: tsx, vitest, drizzle-kit, typescript, @types/node
   - scripts: "extract": "tsx scripts/extract-contract.ts", "test": "vitest run", "typecheck": "tsc --noEmit"

2. `backend/tsconfig.json` — strict TS, ESM, Node 22 target, "types": ["node"], extends nothing.

3. `backend/.env.example` documenting every var per backend/docs/01-architecture.md §5.5 + §3.3:
   - ULTRA_CONTRACTS_PATH, ULTRA_EOS_PATH, MAINNET_URL, TESTNET_URL
   - DATABASE_URL, ALLOWED_ORIGINS, BIND_HOST=127.0.0.1, BIND_PORT=8787
   - LLM_PROVIDER=ollama, EMBED_PROVIDER=ollama, CLASSIFIER_PROVIDER=ollama
   - OLLAMA_URL, OLLAMA_CHAT_MODEL, OLLAMA_EMBED_MODEL
   - ANTHROPIC_API_KEY (blank), ANTHROPIC_BASE_URL (blank)
   - OPENAI_API_KEY (blank)

4. `backend/.gitignore` — node_modules, dist, .env, *.log. Do NOT ignore `catalog/`.

5. `backend/src/extractor/types.ts` — define `ActionRules` per backend/docs/01-architecture.md §5.2 schema. Strict types, no `any`.

6. `backend/src/extractor/cpp-parser.ts` — wrapper around `web-tree-sitter` with `tree-sitter-cpp`. Loads the WASM grammar lazily; exposes a `parse(source: string) => Tree` function and a small AST-walker helper.

7. `backend/src/extractor/patterns.ts` — pattern matchers for:
   - `require_auth(<expr>)` and `require_auth2(<actor>, <permission>)`
   - `check(<bool_expr>, "<msg>")` and `eosio::check(...)` variant
   - `ASSERTION_CHECK(<bool_expr>, <ERROR_CODE>)`
   - `require_recipient(<expr>)`
   Each matcher takes an AST node and returns the structured capture or null.

8. `backend/src/extractor/macros.ts` — small symbol-table builder. Walk all `*.hpp` in the contract dir, find `constexpr static const char*` and similar declarations, build a `Map<string, string>`. Used to resolve `ASSERTION_CHECK(cond, ERROR_X)` → message string.

9. `backend/src/extractor/index.ts` — public API: `extractContract({ name, sourceRoot, mainnetUrl, testnetUrl }): Promise<CatalogFile>`. Steps:
   a. Resolve contract dir from sourceRoot.
   b. Fetch ABI from chain (mainnet → testnet fallback). Compute sha256 → `abi_hash`.
   c. Build macros symbol table from contract headers.
   d. For each action in ABI:
      - Find handler function in `*.cpp` files (function name == action name OR matches `[[eosio::action]]` attribute).
      - Walk function body, capture each pattern with file:line.
      - Recurse one level into helper calls in same translation unit.
      - If anything fails, set `unresolved: true` and record the source link.
   e. Build the JSON output (CatalogFile = { contract, abi_hash, abi_chain_id, abi_fetched_at, source_path, actions: { [name]: ActionRules } }).

10. `backend/scripts/extract-contract.ts` — CLI:
    - Parses argv: contract name(s), `--source <root>`, `--source-dir <dir>`.
    - Loads `.env` via dotenv.
    - Resolves source per backend/docs/01-architecture.md §5.5 (auto-discovery: ../eosio.contracts, ~/ultra/eosio.contracts, ~/eosio.contracts).
    - Calls `extractContract(...)` and writes `backend/catalog/<name>.json`.
    - Logs every step in the format shown in §5.5.
    - Exits with code 1 on resolution failure with the friendly error message from §5.5.

11. `backend/test/extractor/fixtures/` — write 4 synthetic .cpp snippets:
    - `simple-transfer.cpp` (one require_auth, three checks)
    - `helper-delegate.cpp` (handler calls a helper that does the require_auth)
    - `assertion-check.cpp` (uses ASSERTION_CHECK with an error code defined in a sibling .hpp)
    - `multi-line-check.cpp` (check call spans 4 lines)
    Each fixture has a paired `.expected.json` showing the desired ActionRules output.

12. `backend/test/extractor/extract.test.ts` — vitest tests asserting each fixture produces its expected JSON.

13. **Run the extractor** against `~/ultra/eosio.contracts/contracts/eosio.token` and write `backend/catalog/eosio.token.json`. Eyeball it: every action listed in §5.6 of the architecture doc should be present with non-empty `auths`. If `unresolved: true` appears anywhere, investigate why before committing — that's the failure mode this milestone is designed to detect.

Acceptance checks before commit:
- `npm --prefix backend test` passes (unit tests on fixtures)
- `npm --prefix backend run typecheck` passes
- `backend/catalog/eosio.token.json` has all 9 actions from §5.6 with at least one `auths` entry each
- The script logs follow the format in §5.5

Commit message:
"feat(ai-backend): scaffold backend + Stage A extractor working against eosio.token"

Don't add scope. Don't touch the frontend. Don't open a PR.
```

---

## M2 — DB schema + Stage B ingest

### Goal

Local Postgres has the `eosio.token` catalog ingested with embeddings. Running:

```bash
LLM_PROVIDER=ollama npm --prefix backend run ingest
```

…reads `backend/catalog/eosio.token.json`, embeds each chunk with Ollama, and upserts into `contracts` + `actions` + `action_chunks`. A pgvector similarity query for "send tokens" returns the `transfer` action in the top-3.

### Scope

**Touch:**
- `backend/package.json` (add `db:migrate`, `db:reset`, `ingest`, `catalog:check` scripts)
- `backend/drizzle.config.ts` (new)
- `backend/drizzle/` (generated migrations — commit them)
- `backend/src/db/schema.ts` (new — full schema per §3.1)
- `backend/src/db/client.ts` (new — postgres.js + drizzle wrapper)
- `backend/src/llm/provider.ts` (new — `ChatProvider` interface)
- `backend/src/llm/router.ts` (new — selects provider from env)
- `backend/src/llm/ollama.ts` (new — Ollama embed + chat impl)
- `backend/src/llm/openai.ts` (new — embed only for now; chat in M3)
- `backend/src/llm/anthropic.ts` (new — chat only for now; embed via openai)
- `backend/scripts/ingest-catalog.ts` (new)
- `backend/scripts/catalog-check.ts` (new — ABI-hash drift check)
- `backend/test/db/*.test.ts` (new — schema + ingest smoke tests)

**Don't touch:**
- Anything in `src/` (frontend)
- The Hono app itself (M3 builds that)

### Prompt to paste into a fresh session

```
You're working on `ultra-tool-kit` branch `task/ai-enhance-demo`. M1 is committed. You're doing M2 only.

Read first:
1. backend/CLAUDE.md
2. backend/docs/01-architecture.md §3.1 (full schema)
3. backend/docs/01-architecture.md §3.3 (provider abstraction with CLASSIFIER_PROVIDER)
4. backend/docs/01-architecture.md §5.3 (Stage B ingest, including orphan cleanup)
5. backend/docs/01-architecture.md §5.4-§5.5 (catalog staleness check)

Your milestone is M2: DB schema + Stage B ingest + provider scaffolding. Do NOT touch the Hono app or frontend.

What to build:

1. `backend/drizzle.config.ts` — points at `backend/src/db/schema.ts`, output `backend/drizzle/`, dialect "postgresql".

2. `backend/src/db/schema.ts` — every table from backend/docs/01-architecture.md §3.1:
   - contracts (with abi_hash, abi_fetched_at, abi_chain_id added per the review)
   - actions (with rules, source_ref, unresolved fields)
   - action_chunks (embedding_768 + embedding_1536 — install pgvector via Drizzle helper)
   - chat_sessions, chat_messages
   - usage_log, incidents
   Use Drizzle's pgvector type. ivfflat indexes on both embedding columns.

3. `backend/src/db/client.ts` — postgres.js client + Drizzle wrapper. Reads DATABASE_URL from env. Single shared instance for the process.

4. `backend/src/llm/provider.ts` — interface from §3.3 of architecture doc. ChatProvider with chat(), embed(), modelTag(), vectorDim().

5. `backend/src/llm/router.ts` — reads LLM_PROVIDER, EMBED_PROVIDER, CLASSIFIER_PROVIDER from env. Returns three provider instances. Each can be a different concrete provider.

6. `backend/src/llm/ollama.ts` — wraps the `ollama` npm package. Implements chat() (calls /api/chat with format=json for json_schema mode) and embed() (calls /api/embeddings with the model from OLLAMA_EMBED_MODEL). vectorDim() returns 768 for nomic-embed-text.

7. `backend/src/llm/openai.ts` — embeddings only (text-embedding-3-small, vectorDim 1536). Chat impl can return "not implemented" for M2; M3 will use it as a fallback.

8. `backend/src/llm/anthropic.ts` — chat impl using @anthropic-ai/sdk with `tool_use` for structured output. Reads ANTHROPIC_BASE_URL env (so AI Gateway is one env-var flip). Embed impl errors out — Anthropic doesn't have embeddings; routes through `openai.ts` if EMBED_PROVIDER=openai.

9. `backend/scripts/ingest-catalog.ts` — Stage B CLI:
   - Argv: optional contract name(s); default: every `*.json` under `backend/catalog/`.
   - For each contract JSON:
     a. Upsert `contracts` row (account, source_repo, abi_hash, abi_fetched_at, abi_chain_id).
     b. Upsert each action row (fields, rules, default_auth=rules.auths[0], is_admin, source_ref, unresolved).
     c. Optional LLM enrichment (`--enrich` flag): for each action, call the chat provider once for description + 3 examples. Skip if action.unresolved=true (no point describing something we couldn't extract).
     d. Build chunks per action: one "summary" (description + first example), one "rules" (compact rendering of auths/preconditions/field_constraints), one "example" per NL example. Embed each.
     e. Upsert `action_chunks` rows. Cascade-delete old chunks first to avoid duplicates.
     f. **Orphan cleanup**: `delete from actions where contract_id = ? and name not in (?)` for the current set of action names.
   - Logs each step Pino-style.

10. `backend/scripts/catalog-check.ts` — ABI-hash drift detector:
    - For each contract row in `contracts`, fetch the live ABI from chain.
    - Compute sha256, compare with stored abi_hash.
    - Print one line per contract: ✓ (matches), ⚠ (stale > 7 days), ✗ (drift detected with both hashes).
    - Exit 1 if any drift, 0 otherwise.

11. Update `backend/package.json` scripts:
    - "db:migrate": "drizzle-kit migrate"
    - "db:generate": "drizzle-kit generate"
    - "db:reset": "drizzle-kit drop && drizzle-kit migrate"
    - "ingest": "tsx scripts/ingest-catalog.ts"
    - "catalog:check": "tsx scripts/catalog-check.ts"

12. `backend/test/db/ingest.test.ts` — vitest. Spin up a temp Postgres via `@testcontainers/postgresql` against `pgvector/pgvector:pg17`. Ingest a small synthetic catalog JSON. Assert rows are present. Assert orphan cleanup removes a removed action on second ingest.

Acceptance checks before commit:
- The `ultra-pg17` Docker container is running locally (or any pgvector-enabled Postgres at `DATABASE_URL`); `ollama serve` is running locally with qwen2.5:7b + nomic-embed-text pulled.
- `npm --prefix backend run db:generate && npm --prefix backend run db:migrate` produces a clean migration.
- `LLM_PROVIDER=ollama EMBED_PROVIDER=ollama npm --prefix backend run ingest -- eosio.token` succeeds.
- A manual SQL query: `select name, jsonb_array_length(rules->'auths') from actions join contracts on actions.contract_id = contracts.id where contracts.account = 'eosio.token';` returns ≥9 rows, all with auths_length ≥ 1.
- A pgvector cosine-similarity query for an embedding of "send 100 UOS to acc2" puts `eosio.token::transfer` in the top 3.
- `npm --prefix backend run catalog:check` exits 0.

Commit message:
"feat(ai-backend): DB schema + Stage B ingest + LLM provider abstraction"

Don't add the Hono app yet (M3). Don't touch the frontend. Don't open a PR.
```

---

## M3 — Backend chat API

### Goal

`POST /api/ai-action` works end-to-end. A `curl` with the right JSON body returns a valid `kind: "propose"` payload for a `transfer` request, or a `kind: "ask"` for a missing field, or a `kind: "refuse"` for off-topic input. Cost is logged per request. Rate limiting is enforced.

### Scope

**Touch:**
- `backend/src/index.ts` (new — Hono app entry)
- `backend/src/routes/ai-action.ts` (new)
- `backend/src/routes/ai-usage.ts` (new)
- `backend/src/routes/auth.ts` (new — Phase 1 stub)
- `backend/src/middleware/auth.ts` (new — stub for Phase 1)
- `backend/src/middleware/ratelimit.ts` (new)
- `backend/src/middleware/logging.ts` (new)
- `backend/src/pipeline/classify.ts` (new)
- `backend/src/pipeline/retrieve.ts` (new)
- `backend/src/pipeline/prompt.ts` (new)
- `backend/src/pipeline/validate.ts` (new)
- `backend/src/pipeline/cost.ts` (new — PRICING table)
- `backend/test/pipeline/*.test.ts` (new)
- `backend/package.json` (add `dev`, `start` scripts)

**Don't touch:**
- Frontend (M4)
- Catalog or extractor (done)

### Prompt to paste into a fresh session

```
You're on `ultra-tool-kit` branch `task/ai-enhance-demo`. M1 + M2 are committed. Your milestone is M3 only.

Read first:
1. backend/CLAUDE.md
2. backend/docs/01-architecture.md §3.2 (endpoint pipeline)
3. backend/docs/01-architecture.md §4 (prompt design + JSON schema)
4. backend/docs/03-guardrails.md §2 (all five layers)

What to build:

1. `backend/src/index.ts` — Hono app:
   - Binds to `${BIND_HOST}:${BIND_PORT}` (defaults 127.0.0.1:8787).
   - `hono/cors` allowing ALLOWED_ORIGINS only (no wildcards).
   - Mount routes: /api/auth/*, /api/ai-action, /api/ai-usage.
   - Pino logger middleware first.
   - Auth middleware second (stub in Phase 1: synth user_id).
   - Rate-limit middleware third (only on /api/ai-action).

2. `backend/src/middleware/auth.ts` — Phase-1 stub: every request gets `c.set('userId', '00000000-0000-0000-0000-000000000001')`. Phase 2 will verify a wallet JWT here.

3. `backend/src/middleware/ratelimit.ts` — two-tier per backend/docs/03-guardrails.md §2 Layer 2:
   - In-process token bucket (LRU, key = `${userId}:${ip}`). Limits: perMinute=6, perHour=30. Configurable via env.
   - Postgres aggregate: turns_today < 200, cost_today < 0.50. SQL from §2 Layer 2.
   - Exceeded → return 200 with `{ kind: "refuse", reason: "rate-limit", detail: "..." }`. Don't 429 — frontend handles uniformly.

4. `backend/src/pipeline/classify.ts` — Layer-3 intent classifier:
   - Accepts last 3 turns.
   - Calls `classifierProvider.chat()` with prompt from §2 Layer 3 of guardrails. max_tokens: 4.
   - Returns 'ON_TOPIC' | 'OFF_TOPIC' | 'AMBIGUOUS'.
   - Logs cost.

5. `backend/src/pipeline/retrieve.ts`:
   - Accepts user query + active provider's vector dim.
   - Embeds query via `embedProvider.embed()`.
   - SQL: `select ... from action_chunks ac join actions a on ... where a.unresolved = false order by ac.embedding_<dim> <=> $1 limit 12`.
   - Expands chunks back to action rows; dedupes by action_id; returns top 6 actions with their compact `rules` rendering.
   - Filter out `is_admin = true` actions if context.isAdmin is false.

6. `backend/src/pipeline/prompt.ts`:
   - Builds the system prompt per §4 of architecture doc.
   - Renders each retrieved action's `rules` as compact natural language (see backend/docs/01-architecture.md §5.2 example).
   - Includes user context (account, permission, chainId, knownAccounts).
   - Returns the message array ready for `chatProvider.chat()`.

7. `backend/src/pipeline/validate.ts`:
   - Schema parse the LLM response; reject if not the expected shape.
   - Catalog membership: contract+action exists; every key in data is in action.fields.
   - Format regex per §3 of guardrails: asset and name patterns.
   - Admin gate: if action.is_admin and !context.isAdmin → refuse.
   - URL/code-fence/jailbreak strip on `rationale`.
   - On any failure: return `{ kind: 'ask', question: '<missing field>' }` if a required field is missing, or `{ kind: 'refuse', reason: '<generic>' }` otherwise. Log to `incidents` table.

8. `backend/src/pipeline/cost.ts`:
   - PRICING table per backend/docs/02-cost-and-ops.md §3.3.
   - `computeCost(model, usage) → { actual_usd, projected_usd }`. For Ollama models, actual_usd = 0; projected_usd uses Haiku 4.5 rates over the same token counts.
   - Persists to `usage_log`.

9. `backend/src/routes/ai-action.ts` — POST handler:
   a. Parse body (sessionId, messages, context).
   b. Get/create chat_sessions row.
   c. Run classify(); if OFF_TOPIC, return refuse and skip the rest.
   d. Run retrieve().
   e. Run prompt() → chatProvider.chat() with json_schema response mode.
   f. Run validate() on the response.
   g. computeCost() and write usage_log + chat_messages.
   h. Return the validated reply.

10. `backend/src/routes/ai-usage.ts` — GET handler:
    - Returns lifetime / today / last-request summary for the current userId.
    - Includes both `actual` and `projected` columns for Phase-1 demo.
    - Includes per-model breakdown.

11. `backend/src/routes/auth.ts` — Phase-1 stub:
    - POST /api/auth/challenge → 501 Not Implemented (Phase 2).
    - POST /api/auth/verify → 501 Not Implemented (Phase 2).
    - Documented in code that Phase 1 uses the auth middleware stub.

12. Tests:
    - `backend/test/pipeline/classify.test.ts` — mock provider; assert 3 outcomes.
    - `backend/test/pipeline/retrieve.test.ts` — uses real Postgres (after M2's ingest); asserts transfer ranks top-3 for "send 100 UOS to acc2".
    - `backend/test/pipeline/validate.test.ts` — known-good and known-bad LLM outputs.
    - `backend/test/routes/ai-action.test.ts` — Hono `app.request()` integration; mock LLM provider; assert end-to-end propose/ask/refuse flows.

13. Update `backend/package.json` scripts:
    - "dev": "tsx watch src/index.ts"
    - "start": "tsx src/index.ts"

Acceptance checks before commit:
- `LLM_PROVIDER=ollama npm --prefix backend run dev` starts; logs show 127.0.0.1:8787.
- `curl -X POST http://localhost:8787/api/ai-action -H 'Content-Type: application/json' -d '{"sessionId":"test","messages":[{"role":"user","content":"transfer 100 UOS from acc1 to acc2"}],"context":{"account":"acc1","permission":"active","chainId":"...","isAdmin":false,"knownAccounts":["acc1"]}}'` returns a kind: "propose" payload with contract eosio.token, action transfer, data.from=acc1, data.to=acc2, data.quantity matching the asset regex.
- An off-topic curl ("solve x^2 + 3x = 0") returns kind: "refuse" with the classifier short-circuit.
- A missing-field curl ("send 100 UOS to acc2") returns kind: "ask" asking about the from account.
- All vitest tests pass.

Commit message:
"feat(ai-backend): chat pipeline + rate limit + provider routing"

Don't touch the frontend. Don't open a PR.
```

---

## M4 — Frontend chat drawer

### Goal

The chat panel works in the toolkit UI end-to-end, against the M3 backend. User opens drawer, types a request, sees an AI proposal, clicks "Sign now" → existing `<Transaction>` modal opens pre-filled.

### Scope

**Touch:**
- `src/components/ai/ChatDrawer.vue` (new)
- `src/components/ai/MessageBubble.vue` (new)
- `src/components/ai/ProposalCard.vue` (new)
- `src/composables/useAiChat.ts` (new)
- `src/utilities/aiClient.ts` (new)
- `src/icons.ts` (add chat / cost icons)
- `src/main.ts` (register new global components if needed — match existing pattern)
- `src/components/Navigation.vue` (add chat-toggle button)
- `src/App.vue` (mount `<ChatDrawer>` + listen for its `@transact` emit, same handler as existing pages)

**Don't touch:**
- Backend (done)
- `src/components/Transaction.vue` (handoff goes through existing event)
- `src/components/AbiRender.vue`

### Prompt to paste into a fresh session

```
You're on `ultra-tool-kit` branch `task/ai-enhance-demo`. M1-M3 are committed. Backend is running. Your milestone is M4 only.

Read first:
1. /Users/duncandam/ultra/ultra-tool-kit/CLAUDE.md (root frontend conventions)
2. backend/docs/01-architecture.md §2 (frontend components)
3. backend/docs/00-overview.md §4 (UX flow)
4. backend/docs/03-guardrails.md §2 Layer 1 (client-side input sanity)

Skim:
- src/App.vue to see how pages emit `@transact` and how AppState flows
- src/components/Navigation.vue to match the existing button styling
- src/components/Transaction.vue (only the props it accepts — don't modify)

What to build:

1. `src/utilities/aiClient.ts`:
   - `sendChat({ sessionId, messages, context }): Promise<Reply>` — POST /api/ai-action.
   - `getUsage(): Promise<UsageSummary>` — GET /api/ai-usage.
   - Base URL from `import.meta.env.VITE_AI_BACKEND_URL ?? 'http://localhost:8787'`.
   - AbortController with 60s timeout. If 5s elapses without response, fire a `slowStart` event the composable can subscribe to.
   - Auth header: `Authorization: Bearer phase1-stub` for Phase 1 (matches the M3 stub middleware).

2. `src/composables/useAiChat.ts`:
   - State: messages (User/Assistant turns), pending boolean, error, lastReply, slowStart boolean.
   - `sendMessage(text: string)`:
     a. Layer-1 client guards: trim, length cap (1000 chars), session length cap (30 turns) per backend/docs/03-guardrails.md §2 Layer 1. Reject inline.
     b. Push user turn, set pending=true.
     c. Call aiClient.sendChat() with current authState context (account, permission, chainId, knownAccounts from `useWalletAccounts`).
     d. Push assistant turn from reply.
     e. If reply.kind === 'propose', expose it on `pendingProposal` for ProposalCard.
   - `applyProposal(p, mode: 'sign' | 'builder')`:
     - 'sign' → emit `transact` with [{ account: p.contract, name: p.action, authorization: [p.authorization], data: p.data }] via the bus or a hidden helper. Match existing `@transact` shape (see how `AbiRender.vue` emits it).
     - 'builder' → router.push to /builder with the proposal in a shared ref (M5 wires the pickup).
   - `reset()` clears messages.

3. `src/components/ai/MessageBubble.vue`:
   - Props: `role: 'user'|'assistant'`, `content: string|null`, `proposal?: Proposal`.
   - For user: right-aligned bubble, neutral-900 bg.
   - For assistant text: left-aligned, neutral-800 bg, simple markdown rendering (newlines).
   - For assistant proposal: render <ProposalCard>.

4. `src/components/ai/ProposalCard.vue`:
   - Props: `proposal: Proposal`.
   - Renders contract.action heading, fields table (key/value with type hint from action.fields), authorization line, rationale.
   - Two buttons: "Sign now" → emit `apply('sign')`; "Open in Builder" → emit `apply('builder')`.

5. `src/components/ai/ChatDrawer.vue`:
   - Slide-in panel from right, 480px wide, full height.
   - Header with close button + "Reset" button.
   - Scrollable message list.
   - Input area at bottom: textarea + Send button. Enter submits; Shift+Enter newline.
   - Reads from useAiChat. Wires apply event to useAiChat.applyProposal.
   - Show "Model warming up..." hint when slowStart is true.

6. `src/icons.ts` — add `fa-comment-dots` (or similar) and a "robot" icon if available. Verify icon names against the FontAwesome version in package.json.

7. `src/main.ts` — register the three new components globally if they fit the pattern (keep registration minimal; the chat components don't need to be global, just imported in App.vue).

8. `src/components/Navigation.vue`:
   - Add a chat-toggle button. State: isAiOpen (lifted to App.vue).
   - Match existing button styling.

9. `src/App.vue`:
   - Add `isAiOpen` ref + `<ChatDrawer v-model:open="isAiOpen" :state="authState" @transact="onTransact" />`.
   - The `onTransact` handler is the same one already used by the router-view emits — reuse, don't fork.

Phase-1 single-user note: the backend's auth middleware is a stub, so the drawer doesn't need login. Document this in a code comment near where the request is sent so Phase 2 knows what to wire.

Acceptance checks before commit:
- `npm run dev` (frontend, port 5172) and `npm --prefix backend run dev` both running.
- Open localhost:5172, click the chat icon in nav, drawer opens.
- Type "transfer 100 UOS from acc1 to acc2" → see a ProposalCard with contract eosio.token, action transfer, fields filled.
- Click "Sign now" → existing Transaction modal opens with the action pre-filled.
- Type "what's the weather" → see a polite refusal.
- Type a 2000-char string → inline length-cap message appears, no network call.
- `npm run build` succeeds.

Commit message:
"feat(ai-frontend): chat drawer + proposal card + sign handoff"

Don't open a PR.
```

---

## M5 — Cost meter + builder handoff

### Goal

`<CostBadge>` in the navigation bar shows live token + projected cost. `/aiUsage` page shows time-series + per-request log. "Open in Builder" handoff fully works (race-condition-safe).

### Scope

**Touch:**
- `src/components/ai/CostBadge.vue` (new)
- `src/composables/useAiUsage.ts` (new)
- `src/pages/aiUsage/index.vue` (new — auto-routed via unplugin-vue-router)
- `src/components/Navigation.vue` (add CostBadge)
- `src/pages/builder/index.vue` (add the AI handoff watcher per backend/docs/01-architecture.md §2 "Hand-off into the existing builder")
- `src/composables/useAiHandoff.ts` (new — shared ref for the proposal, used by useAiChat → builder page)
- `src/icons.ts` (add cost-meter icons)

**Don't touch:**
- Backend (done)
- `Transaction.vue`, `AbiRender.vue`

### Prompt to paste into a fresh session

```
You're on `ultra-tool-kit` branch `task/ai-enhance-demo`. M1-M4 committed. Your milestone is M5 only.

Read first:
1. backend/CLAUDE.md
2. backend/docs/01-architecture.md §2 (frontend components and the handoff race-condition fix)
3. backend/docs/02-cost-and-ops.md §5.2 (cost meter side-by-side actual vs projected)

Skim:
- src/pages/builder/index.vue — understand `addContract`, `accounts` array, `mutableObject` flow.
- src/components/Navigation.vue — match the badge styling.

What to build:

1. `src/composables/useAiHandoff.ts`:
   - Module-scope reactive ref `pendingProposal: Ref<Proposal | null>`.
   - `setHandoff(p)` and `consumeHandoff()` helpers; consumer clears on use.

2. `src/composables/useAiChat.ts` (modify the M4 version):
   - In `applyProposal(p, 'builder')`: call `setHandoff(p)`, then `router.push({ name: 'builder', query: { ai: 'pending' }})`.

3. `src/pages/builder/index.vue` (extend):
   - In `onMounted`, check `useAiHandoff()` for a pending proposal.
   - If present:
     a. `await addContract(p.contract)`.
     b. Set up a watcher on the contract's row in `accounts`. When `status === 'found'` and ABI fields present, mutate the corresponding action's `mutableObject` with `p.data` and `p.authorization`.
     c. After mutation, call `consumeHandoff()`.
     d. If `status === 'not found'`, surface an inline error (re-emit to the AI drawer or show on the page).
   - The watcher must self-unbind after one fire to avoid double-mutation on subsequent navigation.

4. `src/composables/useAiUsage.ts`:
   - Polls /api/ai-usage every 10s while `mounted` is true.
   - Returns `{ lifetime, today, last7d, last30d, perRequest, perModel }` with both actual and projected.

5. `src/components/ai/CostBadge.vue`:
   - Pill-shaped, in nav. Format: 🏠 12.3K tok (when LLM_PROVIDER=ollama) or 💰 $0.0042 (hosted).
   - Tooltip on hover shows the breakdown listed in backend/docs/02-cost-and-ops.md §3.1.
   - Click → router.push('/aiUsage').
   - Refreshes from useAiUsage.

6. `src/pages/aiUsage/index.vue`:
   - Headline cards: lifetime, today, last 7d, last 30d.
   - Inline SVG sparkline chart (no chart lib — keep bundle small).
   - Per-request table: time, model, tokens (in/out/cached), actual $, projected $. Filterable by `request_kind` (chat / classify / embed) per the §8 Phase-2 TODO note in architecture doc.
   - "Reset" button (deletes usage_log rows for the current synthetic user — harmless in Phase 1).

7. Update `src/components/Navigation.vue` to render `<CostBadge>` next to the existing chat toggle.

Acceptance checks before commit:
- After triggering a chat turn from M4, the badge increments within 10s.
- Click "Open in Builder" on a proposal → builder page loads, contract auto-added, action form pre-filled.
- /aiUsage page renders with the right headline numbers and a non-empty per-request table.
- Both actual ($0 for Ollama) and projected (non-zero, computed via PRICING in backend) columns are visible.
- `npm run build` succeeds.

Commit message:
"feat(ai-frontend): cost meter + /aiUsage page + builder handoff"
```

---

## M6 — Tests + demo polish

### Goal

The demo is bulletproof for a teammate walkthrough. End-to-end Playwright spec passes. The README is the single thing a teammate reads to understand the demo.

### Scope

**Touch:**
- `tests/ai-chat.spec.ts` (new — Playwright)
- `tests/fixtures/ai-stub.ts` (new — deterministic LLM mock harness)
- `backend/scripts/seed-demo.ts` (new — populates DB with eosio.token from the catalog JSON)
- `backend/README.md` (new — backend-specific quickstart)
- `README.md` (root — add a "Phase 1 AI demo" section linking to backend/README.md)
- Root `package.json` (add `demo:start`, `demo:stop`, `demo:clean` scripts using `concurrently`)
- `playwright.config.ts` (extend webServer config to also start the backend if needed)

**Don't touch:**
- Anything substantive — this milestone is polish + tests.

### Prompt to paste into a fresh session

```
You're on `ultra-tool-kit` branch `task/ai-enhance-demo`. M1-M5 committed. Your milestone is M6 only.

Read first:
1. backend/CLAUDE.md
2. backend/docs/01-architecture.md §3.5 (orchestration scripts)
3. backend/docs/02-cost-and-ops.md §4.4 + §6 (Phase-1 setup + acceptance tests)
4. backend/docs/02-cost-and-ops.md §7 (definition of done — these are your acceptance criteria)

Skim:
- tests/wallet-integration.spec.ts to match the existing Playwright style.
- playwright.config.ts to understand the webServer block.

What to build:

1. `tests/fixtures/ai-stub.ts`:
   - A Playwright route handler that intercepts POST http://localhost:8787/api/ai-action.
   - Returns deterministic responses keyed off the user message — e.g. "transfer 100 UOS from acc1 to acc2" → fixed propose payload; "send 100 to acc2" → fixed ask payload; "what's the weather" → fixed refuse payload.
   - Used by the e2e spec to avoid Ollama latency in CI.

2. `tests/ai-chat.spec.ts`:
   - Three tests, all using the AI stub:
     a. Happy path: opens drawer → types transfer request → sees propose card → clicks "Sign now" → existing Transaction modal opens with the right fields. Asserts the data matches.
     b. Clarification: types missing-field request → sees ask response → types the missing field → sees propose. (The stub returns the appropriate next response on follow-up.)
     c. Refusal: types off-topic → sees polite refuse text in the bubble.
   - Each test resets state between runs.

3. `backend/scripts/seed-demo.ts`:
   - Idempotent: runs `db:reset` then `ingest`, then prints "Demo data ready."
   - Used by the demo orchestration scripts and by CI before Playwright.

4. Root `package.json` — add scripts using `concurrently` (add as devDependency):
   - "demo:db:start": "docker start ultra-pg17 || docker run -d --name ultra-pg17 -e POSTGRES_PASSWORD=postgres -p 54322:5432 --restart unless-stopped pgvector/pgvector:pg17"
   - "demo:start": "npm run demo:db:start && (ollama serve &) && concurrently -n web,api 'npm run dev' 'npm --prefix backend run dev'"
   - "demo:stop": "docker stop ultra-pg17 && pkill -f 'ollama serve' || true"
   - "demo:clean": "docker rm -f ultra-pg17 && rm -rf backend/catalog/*.json"
   - "demo:seed": "npm --prefix backend run db:migrate && npm --prefix backend run extract -- eosio.token && npm --prefix backend run ingest"

5. `backend/README.md`:
   - 15-minute quickstart per backend/docs/02-cost-and-ops.md §4.4 (Ollama install, `docker run pgvector/pgvector:pg17`, env, db:migrate, extract, ingest, dev).
   - Troubleshooting: Ollama cold-start is slow on first request; pin with `ollama run qwen2.5:7b` once.
   - "What to type during the demo" — three example prompts that cover propose, ask, and refuse paths.
   - Link to the design docs in `backend/docs/`.

6. Root `README.md` — add a "Phase 1 AI demo" section. One paragraph + link to backend/README.md. Don't dump the full quickstart at the root.

7. Update `playwright.config.ts` if needed — the existing webServer starts `npm run dev`. Either: (a) add a second webServer entry for the backend with the AI stub mode, or (b) document that AI tests require `npm run demo:seed && npm --prefix backend run dev` running. Pick whichever is cleaner.

Acceptance checks before commit:
- `npm run demo:start` brings everything up.
- `npm run demo:seed` populates the DB.
- `npx playwright test tests/ai-chat.spec.ts` passes all three specs.
- The full demo workflow listed in backend/docs/02-cost-and-ops.md §7 (definition of done) works manually:
  - 15-min setup from scratch
  - "transfer 100 UOS from acc1 to acc2" → propose card + correct fields
  - "send 100 to acc2" → asks for from
  - "what's the weather" → polite refusal
  - Cost badge increments
- `npm run build` succeeds for the frontend.
- `npm --prefix backend run typecheck` succeeds for the backend.
- `npx playwright test` (full suite) still green.

Commit message:
"test(ai): e2e Playwright spec + demo orchestration scripts + README"

This is the last milestone. After this, the Phase-1 demo is ready to show.
```

---

## After M6

The demo is ready. Show it to the team. If they approve Phase 2:

1. Draft `05-roadmap-phase2.md` with milestones for: wallet-JWT auth, Anthropic + AI Gateway integration, Fly.io deploy, multilingual support, and any features the team requested during the demo.
2. Add more contracts one at a time using the existing `extract` + `ingest` flow.
3. Re-evaluate model choice based on real cost data from the demo.

Don't start Phase 2 work without explicit approval — the value of Phase 1 is also that it's *narrowly scoped* and doesn't pre-spend on infra Ultra hasn't committed to.
