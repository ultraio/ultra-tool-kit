# backend/CLAUDE.md

Guidance for any Claude Code session working under `backend/`. The root `CLAUDE.md` covers the Vue 3 frontend; this file owns the AI-assistance backend (Hono + Postgres + pgvector + tree-sitter-cpp + LLM-provider abstraction).

If you're touching anything inside `backend/`, prefer this file's conventions over root `CLAUDE.md` where they conflict. If the conflict is unclear, the design docs in `backend/docs/` are the tiebreaker.

## What this is

A small, runtime-agnostic Hono backend that powers the AI chat panel in the toolkit. Two stages, two consumers:

1. **Stage A — extractor.** A deterministic CLI (`scripts/extract-contract.ts`) that walks `~/ultra/eosio.contracts/contracts/<name>/src/*.cpp` with `tree-sitter-cpp` and emits `backend/catalog/<name>.json` describing every action's `require_auth`, `check`, and `require_recipient` calls. **No LLM in the fact path.**
2. **Stage B — ingest.** A second CLI (`scripts/ingest-catalog.ts`) that loads the JSON files, optionally enriches each action with LLM-authored description + examples, embeds the chunks, and upserts to Postgres.
3. **Runtime — chat API.** Hono routes (`/api/ai-action`, `/api/ai-usage`, `/api/auth/*`) that classify user intent, retrieve catalog actions, call the active LLM with a strict JSON schema, validate the response, and return a structured proposal/clarification/refusal to the frontend.

## Read these first

The design docs in `backend/docs/` are local-only (gitignored). Skim in this order:

- `00-overview.md` — vision, UX flow, phase scope (Phase 1 = local demo with `eosio.token` only)
- `01-architecture.md` — components, schemas, provider abstraction, hosting decisions, indexer split
- `02-cost-and-ops.md` — cost model, local stack setup, demo cost breakdown
- `03-guardrails.md` — five-layer abuse prevention
- `04-roadmap.md` — milestone breakdown with paste-able prompts

Don't repeat work the docs already specify; if the docs and your instinct disagree, raise the conflict before changing direction.

## Hard rules

1. **Never use ricardian markdown as a source of truth.** Ultra's `ricardian/*.contracts.md.in` files are not maintained. Action semantics, `require_auth`, and `check()` constraints come exclusively from C++ source under `~/ultra/eosio.contracts/contracts/<name>/src/`. Saved as a project memory.

2. **Never put LLM output in the fact path.** Stage A is deterministic. The LLM authors descriptions and natural-language examples only. If you can't extract a fact deterministically, mark the action `unresolved: true` and let the override YAML fill it — never let the LLM guess.

3. **Per-contract everything.** Extraction, ingest, override files, catalog JSON — all keyed by contract name. Adding `eosio.nft.ft` later is one CLI invocation, not a big-bang rebuild.

4. **Provider-agnostic chat path.** All outbound LLM calls go through `backend/src/llm/router.ts`. Three providers (`anthropic` / `openai` / `ollama`), three independent settings (`LLM_PROVIDER`, `EMBED_PROVIDER`, `CLASSIFIER_PROVIDER`). New providers add a file under `backend/src/llm/`, never inline `fetch` calls in pipeline code.

5. **Phase-1 single-user mode binds to `127.0.0.1` only.** No auth in Phase 1 → no LAN exposure. If you find yourself listening on `0.0.0.0`, you're in Phase 2 territory and need wallet-JWT auth.

6. **Validate before returning.** Every LLM proposal goes through `backend/src/pipeline/validate.ts`: catalog membership, regex format, admin gate. If validation fails, downgrade to `kind: ask` or `kind: refuse` — never pass a half-validated proposal to the frontend.

7. **Cost rows are immutable.** When provider prices change, update `PRICING` in `cost.ts` and let new rows in `usage_log` use the new rates. Never back-fill historical rows.

8. **CORS is explicit.** `ALLOWED_ORIGINS` env var; never `*`. Phase 1 default is `http://localhost:5172`.

## Stack

- **Hono** — HTTP. Runtime-agnostic so we can move to Bun or CF Workers later without rewriting.
- **Drizzle ORM** + **postgres.js** — type-safe Postgres with native pgvector support. Migrations in `backend/drizzle/`.
- **`web-tree-sitter`** + **`tree-sitter-cpp`** — WASM C++ parser. No native build, no LLVM.
- **`@ultraos/ultra-api-lib`** (already a frontend dep, re-used here) — fetches ABIs from chain via `/v1/chain/get_abi`.
- **`pino`** — structured logging.
- **`vitest`** — unit + integration tests.
- **`tsx`** — script runner during dev.
- **`hono/cors`** — CORS middleware.
- **LLM SDKs**: `@anthropic-ai/sdk` (or `@ai-sdk/anthropic`), `openai`, `ollama` (npm) for the provider abstraction.

## Layout (target — fill in across milestones)

```
backend/
  CLAUDE.md                     # this file
  package.json
  tsconfig.json
  drizzle.config.ts
  .env.example                  # documents every required env var
  docs/                         # local-only design docs (gitignored)
  drizzle/                      # generated SQL migrations
  catalog/                      # extractor output, checked in
    eosio.token.json
    overrides/
      eosio.token/
        <action>.yaml           # hand-written facts for unresolved extractions
  src/
    index.ts                    # Hono app + route registration
    routes/
      ai-action.ts              # POST /api/ai-action
      ai-usage.ts               # GET  /api/ai-usage
      auth.ts                   # wallet-JWT (Phase 2; stub in Phase 1)
    db/
      schema.ts                 # Drizzle schema
      client.ts                 # postgres.js client
    llm/
      provider.ts               # ChatProvider interface
      router.ts                 # Picks provider from env
      anthropic.ts
      openai.ts
      ollama.ts
    pipeline/
      classify.ts               # Layer-3 intent classifier
      retrieve.ts               # pgvector top-K (excludes unresolved=true by default)
      prompt.ts                 # System prompt builder
      validate.ts               # Catalog + format + admin gate
      cost.ts                   # PRICING table → cost_usd
    middleware/
      auth.ts                   # JWT verify (Phase 2)
      ratelimit.ts              # In-process token bucket + Postgres aggregate
      logging.ts                # Pino
    extractor/
      index.ts                  # extractContract(name) public API
      cpp-parser.ts             # tree-sitter-cpp wrapper
      patterns.ts               # require_auth / check / ASSERTION_CHECK matchers
      macros.ts                 # constant resolution from headers
      types.ts                  # ActionRules type
  scripts/
    extract-contract.ts         # Stage A CLI
    ingest-catalog.ts           # Stage B CLI
    catalog-check.ts            # ABI hash drift check
  test/
    extractor/
      fixtures/                 # synthetic .cpp snippets per pattern
      *.test.ts
    pipeline/
      *.test.ts
```

## Conventions

- **TypeScript strict mode.** No `any` without a comment justifying it. Drizzle types should propagate.
- **Async iteration over Promise chains.** Pipeline stages are `async` functions returning typed results.
- **Errors carry context.** Throw typed errors (`ExtractError`, `ValidationError`, `ProviderError`) with the source path / action name / model — Pino logs them structurally.
- **Tests live next to fixtures.** `test/extractor/fixtures/transfer.cpp` is a real synthetic input; the test asserts byte-exact JSON output. No stochastic LLM calls in unit tests; mock at the `ChatProvider` boundary.
- **Don't add a feature without a doc reference.** If the design docs don't mention it, raise it before building. The docs are the spec.
- **One commit per milestone.** Milestones in `docs/04-roadmap.md` are sized to land in one focused session and one commit on the feature branch. Don't open PRs — the user is on `task/ai-enhance-demo` and merges manually.
- **Migrations are forward-only.** Drizzle generates idempotent up-migrations; we don't write down-migrations. Local resets use `supabase db reset`.

## Pre-built skills you can use

- The frontend already calls `/v1/chain/get_abi` via `BlockchainService` (see `src/utilities/blockchain.ts`). Stage A's ABI fetch reuses the same library (`@ultraos/ultra-api-lib`).
- The toolkit's existing `<Transaction>` modal handles signing — the AI never signs anything; it builds an `I.Action[]` and emits `@transact` like any other page.
- `pages/builder/index.vue` already implements `addContract` + `mutableObject` — the AI handoff is one watcher hook on this page; don't reinvent.

## When in doubt

- Read `backend/docs/01-architecture.md` for the relevant section.
- If the docs are silent, ask the user before adding scope.
- Don't introduce a third backend stack (e.g., FastAPI, Express) just because a library is more familiar — Hono is the chosen runtime for portability across Node/Bun/CF Workers.
- Don't introduce a fourth LLM provider without updating the abstraction in `src/llm/`.
- Don't trust ricardian. (Saying it three times.)
