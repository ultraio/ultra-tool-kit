# ultra-tool-kit backend

AI-assistance backend for the Ultra Tool Kit frontend. Hono + Postgres (pgvector) +
tree-sitter-cpp + a runtime-pluggable LLM provider abstraction.

Three stages, deterministic-first:

- **Stage A — extractor.** Walks `~/ultra/eosio.contracts/contracts/<name>/src/*.cpp`
  with `tree-sitter-cpp` and emits `catalog/<name>.json`. **No LLM in the fact path.**
- **Stage B — ingest.** Loads catalog JSON, optionally enriches via LLM, embeds
  chunks, and upserts to Postgres with pgvector indexes.
- **Stage C — chat API.** Hono routes (`/api/ai-action`, `/api/ai-usage`) that
  classify, retrieve, propose, validate, and log cost.

## 15-minute demo quickstart

Free, local, single-user. From the repo root:

```bash
# 1. Models (~10 min, mostly download)
brew install ollama
ollama serve &
ollama pull qwen2.5:7b
ollama pull nomic-embed-text

# 2. Postgres + backend + frontend
npm install
npm --prefix backend install
cp backend/.env.example backend/.env       # defaults to LLM_PROVIDER=ollama
npm run demo:db:start                      # pgvector/pgvector:pg17 on :54322
npm run demo:seed                          # migrate → extract → ingest
npm run demo:start                         # vite :5172 + hono :8787
```

Open `http://localhost:5172` and click the chat icon in the nav. The full setup
walkthrough (per-step verification, env-var reference, drift detection, retrieval
sanity checks) lives in [RUNNING_LOCAL.md](RUNNING_LOCAL.md); hosted Phase-2
deployment is in [RUNNING_LIVE.md](RUNNING_LIVE.md).

## Three things to try in the demo

| Prompt | Expected reply |
|---|---|
| `transfer 100 UOS from acc1 to acc2` | `propose` — ProposalCard with the right fields; **Sign now** opens the Transaction modal, **Open in Builder** queues it on the builder page |
| `send 100 to acc2` | `ask` — clarifying question for the missing `from` account (quick-reply input renders inline) |
| `what's the weather?` | `refuse` — polite scope refusal from the classifier short-circuit |

Cost badge in the nav shows `🏠 X.X K tok` and increments within ~10s of each turn.

## Demo-specific troubleshooting

For general setup issues (Ollama cold start, port collisions, CORS, ABI drift)
see [RUNNING_LOCAL.md → Common issues](RUNNING_LOCAL.md#common-issues). The
items below are specific to the `demo:*` scripts:

- **`port is already allocated` on `npm run demo:db:start`.** Something else is
  on `54322`. Stop it (`docker ps`) or change the host port and update
  `DATABASE_URL` in `backend/.env`.
- **`demo:seed` is slow on first run.** `extract` parses C++ once; `ingest`
  embeds every action via Ollama. Subsequent runs are upserts and finish in
  seconds. The script is idempotent — re-run any time.
- **`demo:clean` wipes catalog JSON and the container.** Use `demo:stop` if you
  just want to pause Postgres without losing data.

## Provider env vars

Three independent settings — chat on one provider, embeddings on another,
classifier on a third:

```
LLM_PROVIDER=ollama|anthropic|openai
EMBED_PROVIDER=ollama|openai
CLASSIFIER_PROVIDER=ollama|anthropic|openai
```

See `.env.example` for the full list and per-provider keys.

## Design docs

The full design rationale lives in `backend/docs/` (local-only, gitignored):
`00-overview.md` (vision + UX), `01-architecture.md` (components + schemas),
`02-cost-and-ops.md` (cost model + local stack), `03-guardrails.md` (five-layer
abuse prevention), `04-roadmap.md` (Phase 1 milestones).

## Tests + Playwright

The four frontend AI specs (`tests/ai-chat-drawer.spec.ts`,
`tests/ai-cost-badge.spec.ts`, `tests/ai-empty-states.spec.ts`,
`tests/ai-chat.spec.ts`) run against the stub fixture in
`tests/fixtures/ai-stub.ts` — **no backend, no Ollama, no Postgres required for CI**.
Manual end-to-end testing uses the real stack via the quickstart above.
