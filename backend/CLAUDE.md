# backend/CLAUDE.md

Guidance for any Claude Code session working under `backend/`. The root
`CLAUDE.md` owns the Vue 3 frontend; this file owns the AI-assistance backend
(Hono + tree-sitter-cpp + LLM-provider abstraction, **no database**).

If you're touching anything inside `backend/`, prefer this file over root
`CLAUDE.md` where they conflict. **The architectural source of truth is
`docs/01-ai-enhancement-roadmap.md`; the rule source of truth is
`docs/00-ai-global-guidelines.md`.** When this file and the docs disagree, the
docs win — file an issue and a doc PR before code drifts.

## What this is

A small, stateless Hono backend that powers the AI chat panel in the toolkit.
Two consumers, one runtime:

1. **Offline — extractor.** A deterministic CLI (`scripts/extract-contract.ts`)
   walks `~/ultra/eosio.contracts/contracts/<name>/src/*.cpp` with
   `tree-sitter-cpp` and emits `backend/catalog/<name>.json` describing every
   action's `require_auth`, `check`, `require_recipient`, and field shape.
   **No LLM in the fact path.** Catalogs are committed.
2. **Runtime — chat API.** Hono routes (`POST /api/ai-chat`,
   `POST /api/auth/challenge`, `POST /api/auth/verify`, eventually
   `GET /api/ai-usage`) classify intent, retrieve catalog actions via
   in-memory BM25, optionally dispatch read-only RPC tools, call the active
   LLM through a schema-gated harness, validate the response against the
   catalog + citation gates, and return a structured
   `act | propose | ask | refuse | answer` reply.

The runtime is **stateless**: chat history lives in the client's
`sessionStorage`, the catalog is JSON loaded at boot, usage is appended to
`logs/usage.jsonl` (gitignored, append-only).

## Read these first

In order, before touching anything:

1. `docs/00-ai-global-guidelines.md` — load-bearing rules. §1 maxims, §3
   auth/rate-limit model, §4 security baseline, §5 CI greps. Every PR cites
   the §s it satisfies.
2. `docs/01-ai-enhancement-roadmap.md` — §3 architecture, §4 locked
   decisions, §6 wave list. The roadmap is the only feature list; if a
   change isn't on it, stop and ask.
3. Root `CLAUDE.md` — frontend conventions you may need to hand off to.

The old per-stage design docs that used to live in `backend/docs/` are
demo-era. Don't reference them.

## Hard rules

1. **No database.** Catalog = JSON files. Sessions = client `sessionStorage`.
   Usage = JSONL appended to disk. Per-pubkey rate-limit counters are
   in-process token buckets + a daily JSONL aggregate. If you find yourself
   reaching for Postgres or pgvector, you're solving a problem the v1 design
   already solved differently — re-read roadmap §3 + §4 decision 1.

2. **The catalog decides; the LLM renders** (guidelines §1 maxim 1). The
   tree-sitter-cpp extractor is the source of truth for `require_auth`,
   `check`, recipients, and field shapes. LLM output is schema-gated against
   the catalog before it ever reaches a consumer. **No LLM call inside the
   fact path** — extraction is deterministic, full stop. If you can't extract
   a fact deterministically, emit `unresolved: true` and let a future
   override file (when one exists) fill it; never let the model guess.

3. **No identifier is invented** (guidelines §1 maxim 2). Every account,
   permission, contract, action, table key, factory id, group id, or asset
   symbol in an LLM reply must trace to (a) the user's message in this turn,
   (b) a tool-call response in this turn, or (c) the validated session
   context. The citation gate in `pipeline/validate.ts` enforces this — never
   weaken it.

4. **Treat every external input as hostile. Treat every output as observable**
   (guidelines §1 maxim 3). User text, chain reads, and prior LLM output
   replayed in history are all fenced as `<user_input>`, `<chain_read>`,
   `<prior_assistant>` in the user-role message. The system prompt is static
   and version-tagged; **never concatenate untrusted text into the system
   prompt**.

5. **Two providers only: `anthropic` (Haiku 4.5) and `ollama`** (local
   Haiku-equivalent, qwen3:14b default). One interface in
   `src/llm/provider.ts`. New provider → new file under `src/llm/` + doc PR
   first. **No inline `fetch` against Anthropic or Ollama outside
   `src/llm/`** — `scripts/ai-ci-greps.sh` grep #1 + #2 enforce this once W1
   wires the greps in.

6. **Local dev binds to `127.0.0.1` only.** `0.0.0.0` in non-test code is a
   CI failure (grep #4). Hosted deploys are post-v1; when they land, the
   wallet-pubkey JWT layer (W1.5) is already the auth gate so the same code
   works hosted.

7. **The wallet/chain is the signing gate, not the AI.** The backend never
   signs. It hands a validated action list back to the frontend, which
   routes through the existing `<Transaction>` modal. If the AI proposes
   something the wallet can't sign, the wallet refuses or the chain rejects
   — both are acceptable failure modes (guidelines §4.5).

8. **Validate before returning.** Every LLM reply runs `pipeline/validate.ts`:
   schema gate (Zod) → catalog membership → field-key whitelist → required-
   field check → format regex → authorization-actor check → citation
   coverage. Any gate fails → downgrade to `kind: ask` with a clarifying
   question or `kind: refuse`. Never pass a half-validated proposal to the
   frontend. `coerceLlmShape` runs first to repair common small-model output
   quirks (see the file for the full list — every branch fixes a real
   observed failure mode and is load-bearing).

9. **CORS is explicit.** `ALLOWED_ORIGINS` env var, comma-separated. Never
   `*`. Local dev default: `http://localhost:5172`. `*` anywhere outside
   test fixtures is a CI failure (grep #9).

10. **Ricardian markdown is not a source of truth.** Ultra's
    `ricardian/*.contracts.md.in` files are stale. Action semantics,
    `require_auth`, and `check()` constraints come **exclusively** from
    C++ source under `~/ultra/eosio.contracts/contracts/<name>/src/`. Saved
    as a project memory.

## Stack

- **Hono** — HTTP. Runtime-agnostic so we can move to Bun or CF Workers later
  without rewriting.
- **`web-tree-sitter`** + **`tree-sitter-cpp`** — WASM C++ parser. No native
  build, no LLVM.
- **`@ultraos/ultra-api-lib`** — fetches ABIs from chain via
  `/v1/chain/get_abi`. Reused from the frontend.
- **`@anthropic-ai/sdk`**, **`ollama`** — the two LLM providers.
- **`zod`** — schema gates on every external boundary (request body, LLM
  output, tool input).
- **`pino`** — structured logging.
- **`vitest`** — unit + integration tests; `tsx` runs scripts during dev.

Anything else needs a doc PR before it lands.

## Layout (target — filled in across waves W0 → W8)

```
backend/
  CLAUDE.md                     # this file
  package.json
  tsconfig.json
  vitest.config.ts
  .env.example                  # documents every required env var
  catalog/                      # extractor output, committed
    eosio-types.json            # canonical EOSIO type + regex table
    known-symbols.json          # token-symbol reference
    eosio.token.json            # ┐
    eosio.nft.ft.json           # ├ three primary contracts (first-class
    eosio.msig.json             # ┘ runtime support per roadmap §1)
    eosio.{eba,group,kyc,oracle,wrap}.json  # ┐
    ultra.{avatar,bridge,claim,...}.json    # ┴ every other contract under
                                            #   ~/ultra/eosio.contracts that
                                            #   the extractor could process —
                                            #   ABI-only fallback at runtime
  logs/                         # gitignored, append-only
    usage.jsonl                 # per-turn telemetry (guidelines §7)
  src/
    index.ts                    # Hono app + route registration (W1)
    routes/
      ai-chat.ts                # POST /api/ai-chat (W3+ wires up)
      auth.ts                   # POST /api/auth/{challenge,verify} (W1.5)
    middleware/
      auth.ts                   # JWT verify (W1.5)
      ratelimit.ts              # per-pubkey token bucket + JSONL aggregate (W1.5)
      logging.ts                # pino
    llm/
      provider.ts               # ChatProvider interface (W0)
      anthropic.ts              # Haiku 4.5 (W0)
      ollama.ts                 # qwen3:14b default (W0)
    pipeline/
      classify.ts               # cheap intent gate (W2)
      retrieve.ts               # in-memory BM25 over catalog (W2)
      tools/                    # read-only RPC allowlist (W4)
      harness.ts                # provider-agnostic schema-gated call (W1)
      validate.ts               # coerceLlmShape + every gate (W0 carries, W3 rebuilds)
    extractor/
      index.ts                  # extractContract(name) public API (W0)
      cpp-parser.ts             # tree-sitter-cpp wrapper (W0)
      patterns.ts               # require_auth / check / ASSERTION_CHECK matchers (W0)
      macros.ts                 # constant resolution from headers (W0)
      eosio-types.ts            # canonical type + regex catalog (W0)
      abi.ts                    # ABI fetch + hash (W0)
      types.ts                  # ActionRules types (W0)
  scripts/
    extract-contract.ts         # Stage A CLI (W0)
  test/
    extractor/
      fixtures/                 # synthetic .cpp snippets per pattern
      *.test.ts
    smoke.catalog.test.ts       # asserts the three primary catalogs aren't empty (W0)
    pipeline/                   # W1+ as the pipeline lands
```

## Conventions

- **TypeScript strict mode.** No `any` without a comment justifying it.
- **Async, not Promise chains.** Pipeline stages are `async` functions
  returning typed results.
- **Errors carry context.** Throw typed errors (`ExtractError`,
  `ValidationError`, `ProviderError`) with the source path / action name /
  model — `pino` logs them structurally.
- **Tests live next to fixtures.** `test/extractor/fixtures/transfer.cpp`
  is a real synthetic input; the test asserts byte-exact JSON output. No
  stochastic LLM calls in unit tests — mock at the `ChatProvider` boundary.
- **One commit per wave, on `feature/ai-enhancement`.** Wave PRs cite the
  guidelines §s they satisfy + the roadmap §6 row they implement. Wave
  acceptance criteria are in roadmap §6 + §7 templates.
- **Simplify before committing a feature.** Once tests pass, dispatch the
  `code-simplifier` subagent over the wave's diff per roadmap §7.1. The
  exclusion list is in §7.1 step 3 — validation gates, extractor
  internals, regression baseline, `*.md` docs, all out of scope. Re-run
  tests after; revert any file the pass breaks.
- **Catalog JSON is generated, not hand-edited.** Re-extract via
  `npm --prefix backend run extract -- <contract>` and commit the output.
  If the extractor needs to handle a new pattern, the unit test in
  `test/extractor/` lands first.

## Pre-built skills you can lean on

- The frontend already calls `/v1/chain/get_abi` via `BlockchainService`
  (`src/utilities/blockchain.ts`). The extractor's ABI fetch (`src/extractor/
  abi.ts`) reuses `@ultraos/ultra-api-lib` — same library, no new SDK.
- The toolkit's `<Transaction>` modal handles signing. The AI never signs;
  it builds an `I.Action[]` and emits `@transact` like every other page.
  Proposal mode (msig) hands off through the existing `isMakingProposal`
  branch.
- `src/composables/useAiChat.ts` and `src/utilities/aiClient.ts` already
  exist (cherry-picked W0). They're inert until W3 wires `POST /api/ai-chat`.

## Current status (as of W0)

Landed:
- Extractor (deterministic, batch-tolerant — continues past per-contract
  failure and surfaces a summary), llm provider interface, validator's
  `coerceLlmShape` helpers, smoke test (globs every contract catalog),
  ai-ci-greps stub.
- Catalogs for **17 contracts** under `backend/catalog/` — the three
  primary first-class ones plus every other contract under
  `~/ultra/eosio.contracts` that the extractor could ABI-fetch. Three
  (`eosio.bios`, `eosio.system`, `ultra.discord`) are undeployed on both
  mainnet and testnet so their ABI fetch fails; they're skipped until a
  `--no-abi` source-only extractor mode lands or they get deployed.
- Frontend AI scaffolding cherry-picked but not yet wired into any page.

Next wave (W1): provider abstraction + schema-gated harness. See roadmap
§6 row W1 for acceptance.

## When in doubt

- Re-read `docs/00-ai-global-guidelines.md` + `docs/01-ai-enhancement-
  roadmap.md`. They're the only feature/rule docs that bind code.
- If those docs are silent, **stop and ask** before adding scope. The
  per-wave prompt's "STOP AND ASK BEFORE" list is non-exhaustive.
- Don't introduce a third backend stack (FastAPI, Express, etc.) — Hono
  is the chosen runtime for portability.
- Don't introduce a third LLM provider (no OpenAI in v1, per roadmap §4
  decision 3).
- Don't trust ricardian. (Saying it three times.)
