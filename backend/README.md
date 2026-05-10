# ultra-tool-kit backend

AI-assistance backend for the Ultra Tool Kit frontend. Hono + Postgres (pgvector) +
tree-sitter-cpp + a runtime-pluggable LLM provider abstraction.

This package owns Stages A and B of the AI pipeline:

- **Stage A — extractor.** Walks `~/ultra/eosio.contracts/contracts/<name>/src/*.cpp`
  with `tree-sitter-cpp` and emits `catalog/<name>.json` with each action's
  `require_auth` / `check` / `require_recipient` calls. **No LLM in the fact path.**
- **Stage B — ingest.** Loads catalog JSON, optionally enriches via LLM, embeds
  chunks, and upserts everything into Postgres with pgvector indexes.

The runtime Hono app (Stage C) is not included in this milestone.

## Quick start

Two operating modes — pick the one that matches your situation:

| Mode | When to use | Guide |
|------|------|------|
| **Local** | Demoing on your laptop. Free. Postgres via Supabase CLI, LLM via Ollama. | [RUNNING_LOCAL.md](RUNNING_LOCAL.md) |
| **Live** | Hosted Phase-2 deployment. Managed Postgres + Anthropic + OpenAI embeddings, optionally via Cloudflare AI Gateway. | [RUNNING_LIVE.md](RUNNING_LIVE.md) |

Both modes use the same code and the same SQL schema — only env vars change.

## npm scripts

| Script | What it does |
|--------|------|
| `npm run typecheck` | `tsc --noEmit` over `src/`, `scripts/`, `test/`. |
| `npm test` | Runs the full vitest suite (extractor, llm, ingest). The ingest test starts an ephemeral pgvector pg17 container via `@testcontainers/postgresql`; Docker must be running. |
| `npm run db:generate` | Generate a new Drizzle migration from `src/db/schema.ts` diff. |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL`. |
| `npm run db:reset` | Drop all migrations + re-apply. Destructive — local only. |
| `npm run extract -- <contract>` | Stage A. Walks the C++ source for the named contract and writes `catalog/<contract>.json`. |
| `npm run ingest [-- <contract>...] [-- --enrich] [-- --dual]` | Stage B. With no args, ingests every catalog file. `--enrich` adds LLM-authored description + 3 NL examples per action. `--dual` writes both 768- and 1536-dim embeddings (requires both Ollama and OpenAI configured). |
| `npm run catalog:check` | Compare each contract's stored `abi_hash` against a live ABI fetch. Exits 1 on drift. |
| `npm run verify:similarity [-- "<query>"]` | Embed a natural-language query and print the top-5 matching action chunks. Used to sanity-check ingest quality. |

## Environment variables

Everything is in `.env.example`. The two stages read different variables:

- **Stage A** (`extract`): `ULTRA_CONTRACTS_PATH`, `MAINNET_URL`, `TESTNET_URL`.
- **Stage B** (`ingest`): `DATABASE_URL`, `LLM_PROVIDER`, `EMBED_PROVIDER`,
  `CLASSIFIER_PROVIDER`, plus the per-provider `OLLAMA_*` / `ANTHROPIC_*` /
  `OPENAI_*` blocks. `ingest --enrich` requires the chat provider to be
  reachable; the basic embed-only path needs only `EMBED_PROVIDER`.

The three provider env vars are independent — you can run chat on one provider,
embeddings on another, and the intent classifier on a third. See
[docs/01-architecture.md §3.3](docs/01-architecture.md) (local-only, gitignored)
for the full table.

## Layout

```
backend/
  catalog/                  # Stage A output, checked into git for review
    <contract>.json
    eosio-types.json        # hand-authored EOSIO type rules (verified against ~/ultra/eosio source)
    overrides/<contract>/<action>.yaml   # hand-written facts for unresolved extractions
  drizzle/                  # generated SQL migrations (checked in)
  src/
    db/                     # Drizzle schema + postgres.js client
    extractor/              # Stage A: tree-sitter-cpp parser, ABI fetch, type-rule loader
    ingest/                 # Stage B: override merge, chunk rendering, embed + upsert
    llm/                    # Provider abstraction: provider/router + anthropic/openai/ollama
  scripts/                  # CLI entry points (extract, ingest, catalog:check, verify:similarity)
  test/                     # vitest suites (extractor fixtures, llm router, ingest integration)
```
