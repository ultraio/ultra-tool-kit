# AI-Assisted Action Assembly — Architecture

> Companion to `00-overview.md`. Concrete components, data shapes, control flow.

## 1. System diagram

The deployment shape is the same in both phases — only the **destinations** of the LLM and DB calls change. This keeps the code identical between local demo and hosted production.

```
                  ┌──────────────────────────────────────┐
                  │           Browser (Vue)               │
                  │                                      │
                  │  ChatDrawer.vue                      │
                  │     │                                │
                  │     │ useAiChat()                    │
                  │     ▼                                │
                  │  POST /api/ai-action                 │
                  │     │             ProposalCard.vue   │
                  │     │             ▼                  │
                  │     │             emits @transact    │
                  │     │             ▼                  │
                  │     │             App.vue ─► <Transaction>
                  └─────┼──────────────────────────────────┘
                        │ HTTPS (CF DNS proxy in Phase 2)
                        ▼
              ┌──────────────────────────────────────┐
              │    Hono backend (Node 22 / Bun)       │
              │    /api/ai-action                     │
              │                                      │
              │   1. Auth (JWT from wallet challenge) │
              │   2. Rate + budget pre-flight         │
              │   3. Intent classifier (small LLM)    │
              │   4. Embed query                      │
              │   5. pgvector retrieval (top-K)       │
              │   6. Build prompt + call main LLM     │
              │   7. Validate JSON against ABI        │
              │   8. Log usage + cost                 │
              │   9. Return proposal / ask / refuse   │
              └──────────┬───────────────────┬────────┘
                         │                   │
                         ▼                   ▼
       ┌──────────────────────────┐   ┌──────────────────────────────┐
       │  Postgres + pgvector      │   │  LLM provider                │
       │                           │   │                              │
       │  contracts                │   │  Phase 1 (local demo):       │
       │  actions                  │   │   Ollama @ localhost:11434   │
       │  action_chunks (vector)   │   │   - qwen2.5:7b (chat)        │
       │  chat_sessions            │   │   - nomic-embed-text         │
       │  chat_messages            │   │                              │
       │  usage_log                │   │  Phase 2 (hosted):           │
       │  incidents                │   │   AI Gateway → Anthropic     │
       │                           │   │   - Haiku 4.5 (chat)         │
       │  Phase 1: docker pgvector │   │   - text-embedding-3-small   │
       │  Phase 2: managed (Neon / │   │                              │
       │           Fly Postgres)   │   │  Provider abstraction lives  │
       └──────────────────────────┘   │  in backend/src/llm/*        │
                  ▲                    └──────────────────────────────┘
                  │ batch upsert
                  │
       ┌──────────────────────────────────────────────────┐
       │  Stage A: scripts/extract-contract.ts <name>     │
       │    tree-sitter-cpp on ~/ultra/eosio.contracts    │
       │    → backend/catalog/<name>.json (deterministic) │
       │  Stage B: scripts/ingest-catalog.ts              │
       │    JSON → embed → Postgres upsert                │
       │  Run per-contract; re-run when source changes.   │
       └──────────────────────────────────────────────────┘
```

**Phase 1** (local demo, "convince the team"): Hono backend running on the dev's laptop, talking to a single `pgvector/pgvector:pg17` Docker container (Postgres + pgvector preinstalled), calling Ollama on localhost. **Zero recurring cost.**

**Phase 2** (hosted, "if approved"): same Hono code shipped to a small VPS / Fly.io machine, talking to managed Postgres (Neon free tier or Fly Postgres), calling Anthropic via Cloudflare AI Gateway. CF DNS proxy in front of the backend for DDoS + caching.

**Same backend binary, same frontend, same SQL schema, same prompts** — only env vars change between phases.

## 2. Frontend components

| File | Responsibility |
|------|----------------|
| `src/components/ai/ChatDrawer.vue` | Slide-over panel. Renders message list + input. Owns no business logic. |
| `src/components/ai/MessageBubble.vue` | Renders one user/assistant turn (markdown for text). |
| `src/components/ai/ProposalCard.vue` | Renders a `propose` payload — contract, action, table of fields with type hints, authorization, rationale. Two CTAs: "Open in Builder", "Sign now". |
| `src/components/ai/CostBadge.vue` | Small badge in `Navigation` showing `$x.xxxx` lifetime; tooltip shows session + by-model breakdown. |
| `src/pages/aiUsage/index.vue` | Full usage page: time-series chart, per-request log, model breakdown, reset button. |
| `src/composables/useAiChat.ts` | Reactive chat state, `sendMessage()`, `applyProposal(p)`, `reset()`, hooks into `eventBus.emit('updateAppActions')` for the "Sign now" path. |
| `src/composables/useAiUsage.ts` | Reads usage from `/api/ai-usage` (poll every 10s while drawer open or `/aiUsage` page is mounted); exposes `lifetimeCost`, `sessionCost`, `lastRequestCost`. |
| `src/utilities/aiClient.ts` | Thin wrapper around the Hono backend endpoints. Handles JWT, retry, abort. Base URL from `VITE_AI_BACKEND_URL` (defaults to `http://localhost:8787` in dev). Uses `AbortController` with 60 s timeout per request; if the server hasn't responded after 5 s, the chat UI shows a "Model warming up — first request takes a few seconds" hint (Ollama cold-start handling). |

### Hand-off into the existing builder

Two paths:

- **"Sign now"** — `useAiChat.applyProposal(p)` builds an `I.Action[]` (one element) and emits the existing `@transact` event from a hidden helper component, exactly the same shape `AbiRender` already uses. `App.vue` opens `<Transaction>` pre-filled. **No changes to Transaction.vue or App.vue's event handling.**
- **"Open in Builder"** — `applyProposal(p)` calls `router.push({ name: 'builder', query: { ai: 'pending' }})`, then writes the proposal into a small `aiHandoff` ref imported by `pages/builder/index.vue`. The builder page picks it up `onMounted`:
  1. Calls `addContract(p.contract)`. This is async; the contract enters the page's `accounts` array with `status: 'loading'`.
  2. Sets up a `watch` on `accounts` filtered for `acc.account === p.contract`. The watcher fires when the entry transitions to `status: 'found'` and the ABI fields are present.
  3. *Then* mutates the corresponding action's `mutableObject` with `p.data` and `p.authorization`. Only one mutation per handoff; the watcher unbinds itself afterward.
  4. If the contract fails (`status: 'not found'`), surface an inline error in the AI drawer instead of attempting the builder fill.

  This sequence avoids the race where the watcher runs before ABI data is available. No changes to `AbiRender.vue` or `App.vue`.

## 3. Backend (Hono + Postgres + pgvector)

The backend is a small Hono app — single binary, runs on Node 22, Bun, or Deno without code changes (Hono is runtime-agnostic). Lives in `backend/` at the repo root, not under `src/`.

```
backend/
  package.json                          # tsx, hono, drizzle-orm, postgres, @ai-sdk/anthropic, ollama
  drizzle.config.ts
  src/
    index.ts                            # Hono app + route registration
    routes/
      ai-action.ts                      # POST /api/ai-action  (chat turn)
      ai-usage.ts                       # GET  /api/ai-usage    (cost data for UI)
      auth.ts                           # POST /api/auth/challenge + verify (wallet JWT)
    db/
      schema.ts                         # Drizzle schema (mirrors §3.1 below)
      client.ts                         # postgres.js client
    llm/
      provider.ts                       # ChatProvider interface
      anthropic.ts                      # Hosted provider (production)
      openai.ts                         # Embeddings + alt chat
      ollama.ts                         # Local provider (Phase 1 demo)
      router.ts                         # Picks provider from env vars
    pipeline/
      classify.ts                       # Layer-3 intent classifier
      retrieve.ts                       # pgvector top-K
      prompt.ts                         # System prompt builder
      validate.ts                       # ABI + format + catalog membership
      cost.ts                           # Pricing table → cost_usd
    middleware/
      auth.ts                           # JWT verify
      ratelimit.ts                      # Token bucket per user/IP
      logging.ts                        # Pino structured logs
  scripts/
    extract-contract.ts                 # Stage A: per-contract C++ extractor (no LLM, deterministic)
    ingest-catalog.ts                   # Stage B: JSON → embed → Postgres
    seed-examples.ts                    # Optional: LLM-authored NL examples (provider-pluggable)
  catalog/
    eosio.token.json                    # Stage A output, checked in for review
    overrides/
      eosio.token/
        transfer.yaml                   # Hand-written facts for any unresolved extraction
  test/
    *.test.ts                           # Vitest
```

### 3.1 Tables

```sql
-- contracts the user can target
create table contracts (
  id              bigserial primary key,
  account         text unique not null,            -- 'eosio.token'
  display_name    text,
  source_repo     text,                            -- 'eosio.contracts/contracts/eosio.token'
  description     text,                            -- short, AI-authored summary
  abi_hash        text,                            -- sha256 of the ABI JSON used during extraction (for drift detection)
  abi_fetched_at  timestamptz,                     -- when ABI was last fetched from chain
  abi_chain_id    text,                            -- which chain we fetched from
  updated_at      timestamptz default now()
);

-- one row per action; populated by the extractor (Stage A) + ingest (Stage B)
create table actions (
  id                  bigserial primary key,
  contract_id         bigint references contracts on delete cascade,
  name                text not null,                   -- 'transfer'
  fields              jsonb not null,                  -- [{name, type, required, hint}] from ABI
  rules               jsonb not null,                  -- ActionRules from extractor: auths, preconditions, field_constraints, recipients
  default_auth        jsonb,                           -- denormalized convenience: rules.auths[0]
  is_admin            boolean default false,           -- inferred from contract account + auths
  description         text,                            -- LLM-authored 1-line summary (Stage B)
  examples            jsonb,                           -- LLM-authored NL examples (Stage B)
  source_ref          jsonb,                           -- {path, lines: [start, end]} for audit
  unresolved          boolean default false,           -- true if extractor couldn't fully parse
  unique (contract_id, name)
);

-- retrieval chunks
-- Two embedding columns to support both Ollama (768-dim, Phase 1) and OpenAI (1536-dim, Phase 2)
create table action_chunks (
  id              bigserial primary key,
  action_id       bigint references actions on delete cascade,
  kind            text not null,                   -- 'summary' | 'rules' | 'example'
  content         text not null,
  embedding_768   vector(768),                     -- Ollama nomic-embed-text
  embedding_1536  vector(1536),                    -- OpenAI text-embedding-3-small
  created_at      timestamptz default now()
);

create index on action_chunks using ivfflat (embedding_768  vector_cosine_ops);
create index on action_chunks using ivfflat (embedding_1536 vector_cosine_ops);

-- chat persistence (useful for cost attribution + debugging)
create table chat_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,                            -- nullable for Phase-1 single-user demo
  account         text,                            -- toolkit authState.account
  endpoint        text,                            -- chain endpoint at session start
  started_at      timestamptz default now()
);

create table chat_messages (
  id              bigserial primary key,
  session_id      uuid references chat_sessions on delete cascade,
  role            text check (role in ('user', 'assistant', 'system')),
  content         jsonb,                           -- text or structured proposal
  created_at      timestamptz default now()
);

-- per-request usage; one row per LLM call
create table usage_log (
  id              bigserial primary key,
  session_id      uuid references chat_sessions on delete set null,
  user_id         uuid,
  model           text,                            -- 'claude-haiku-4-5-20251001'
  input_tokens    int,
  output_tokens   int,
  cache_read      int default 0,
  cache_write     int default 0,
  cost_usd        numeric(12, 8),                  -- pre-computed
  request_kind    text,                            -- 'embed' | 'chat'
  created_at      timestamptz default now()
);
```

Add an `incidents` table per `03-guardrails.md §4`. Schema migrations live in `backend/drizzle/` and run automatically on backend startup (`drizzle-kit migrate`).

**Multi-user gating.** Phase 1 demo runs single-user (skip auth, all rows under one synthetic `user_id`). Phase 2 verifies a wallet-derived JWT and filters every query by `user_id` in app code (no RLS dependency, since we're not using Supabase auth).

### 3.2 Backend endpoint: `POST /api/ai-action`

**Input**:
```ts
{
  sessionId: string;        // client-generated UUID, persisted across drawer opens
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  context: {
    account: string;        // toolkit's active account
    permission: string;
    endpoint: string;
    chainId: string;
    isAdmin: boolean;
    knownAccounts: string[]; // wallet's validatedAccounts (helps disambiguate "from")
  };
  model?: 'haiku' | 'gpt4o-mini';
}
```

**Steps** (each implemented in its own file under `backend/src/pipeline/`):
1. **Auth** — verify JWT (Phase 2) or accept anonymously (Phase 1); load or create `chat_sessions` row.
2. **Rate-limit** — token-bucket check per `(user_id, IP)`. See `03-guardrails.md §2 Layer 2`.
3. **Classify intent** — short LLM call returns `ON_TOPIC | OFF_TOPIC | AMBIGUOUS`. Off-topic short-circuits to `kind: refuse`. See `03-guardrails.md §2 Layer 3`.
4. **Embed** the latest user turn (Ollama in Phase 1, OpenAI in Phase 2). Cached by SHA-256 of the input string in `usage_log`-adjacent table to dedupe identical queries.
5. **Retrieve** top-12 `action_chunks` from pgvector — query `embedding_768` or `embedding_1536` based on active provider. Expand to parent `actions` rows. Filter out admin-only actions if `!context.isAdmin`.
6. **Build prompt** — system prompt + compact JSON of candidate actions (≈3 KB cap). Include last 6 conversation turns.
7. **Call main LLM** with strict JSON schema (Anthropic `tool_use` in Phase 2; Ollama OpenAI-compat `response_format: json_schema` in Phase 1).
8. **Validate** the JSON output against canonical ABI in `actions.fields`:
   - Asset fields match `^\d+\.\d+ [A-Z]{1,7}$`.
   - Name fields match `^[a-z1-5.]{1,13}$`.
   - All required fields present; if not, downgrade to `kind: ask` with the missing field name.
   - Catalog membership: `contract` and `action` must exist; every key in `data` must be a known field.
9. **Log** input/output tokens + computed cost (`backend/src/pipeline/cost.ts`).
10. **Return** the JSON to the client.

**Output**:
```ts
type Reply =
  | { kind: 'ask'; question: string }
  | { kind: 'propose';
      contract: string;
      action: string;
      data: Record<string, unknown>;
      authorization: { actor: string; permission: string };
      rationale: string;
      candidates?: Array<{ contract: string; action: string; score: number }>;
    }
  | { kind: 'refuse'; reason: string };
```

### 3.3 LLM provider abstraction

The backend selects its model backend at runtime via env vars. All providers conform to the same internal interface so the validator, prompt builder, and cost logger don't care which one is in use.

```ts
// backend/src/llm/provider.ts
export type Provider = 'anthropic' | 'openai' | 'ollama';

export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;        // parsed JSON + token usage
  embed(text: string): Promise<{ vector: number[]; usage: Usage }>;
  modelTag(): string;                                    // logged into usage_log.model
  vectorDim(): 768 | 1536;
}

// backend/src/llm/router.ts
const chatProvider       = process.env.LLM_PROVIDER        ?? 'ollama';   // Phase-1 default
const embedProvider      = process.env.EMBED_PROVIDER       ?? chatProvider;
const classifierProvider = process.env.CLASSIFIER_PROVIDER  ?? chatProvider;  // intent classifier (§Layer 3)
```

Chat, embedding, and **classifier** providers are independently configurable. Three common configurations:

| Mode | `LLM_PROVIDER` | `EMBED_PROVIDER` | `CLASSIFIER_PROVIDER` |
|---|---|---|---|
| Phase 1 demo (zero cost) | `ollama` | `ollama` | `ollama` |
| Phase 2 default | `anthropic` | `openai` | `anthropic` |
| Phase 2 cost-optimized | `anthropic` | `openai` | `openai` (mini) — classifier on cheapest model |
| Mixed local | `ollama` | `openai` | `ollama` |

Splitting the classifier matters: it's called on every turn and is structurally simpler, so running it on the cheapest available model (`gpt-4o-mini` or even Ollama on Phase 2) saves ~7× per-classify call vs running it on Haiku. The cost numbers in `02-cost-and-ops.md §2` assume same-provider; switching to a cheap classifier shaves another ~$0.0001 per turn.

| Provider | Chat model (default) | Embedding model (default) | Endpoint | Vector dim |
|---|---|---|---|---|
| `anthropic` | `claude-haiku-4-5-20251001` | OpenAI `text-embedding-3-small` | `api.anthropic.com` + `api.openai.com` | 1536 |
| `openai` | `gpt-4o-mini` | `text-embedding-3-small` | `api.openai.com` | 1536 |
| `ollama` | `qwen2.5:7b` (or `qwen2.5-coder:7b`, `llama3.1:8b`, `mistral-nemo:12b`) | `nomic-embed-text` | `http://host.docker.internal:11434` (Docker) or `http://localhost:11434` | 768 |

**Cost behavior under Ollama.** All `cost_usd` rows for an Ollama-tagged model are `0`; the badge shows token totals only and switches its icon to `🏠`. Token counts are still recorded — they're a faithful predictor of what the same prompts would cost on hosted models, which is exactly what you want during the demo to show "this would cost $X if we shipped it."

### 3.4 AI Gateway (Phase 2 only)

In Phase 2, all hosted-provider calls go through Cloudflare AI Gateway instead of directly to `api.anthropic.com`:

```ts
// backend/src/llm/anthropic.ts
const baseURL = process.env.ANTHROPIC_BASE_URL
  ?? 'https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/anthropic';
```

This is a one-env-var change vs direct provider calls and gives:

- **Per-request logs** with custom metadata (we tag `userId`, `sessionId`, `kind=chat|classify|embed`).
- **Cost analytics** in the CF dashboard, broken out by user / model / route — frees us from maintaining the `PRICING` table for production-side reporting (we still keep it for the in-app `/aiUsage` view because it works in Phase 1 too).
- **Caching**: identical prompts return cached responses for free. Especially useful for the classifier — many users typing "transfer 100 UOS to acc2" → 1 LLM call.
- **Rate limiting** at the gateway layer in addition to backend in-process limits — defense in depth for unexpected abuse.
- **Provider fallback**: configure Haiku 4.5 primary, GPT-4o mini fallback. Anthropic outage → automatic switchover, no code change.

Phase 1 doesn't use AI Gateway because Phase 1 doesn't use hosted providers at all. Code path is the same — Phase 2 deploy just sets `ANTHROPIC_BASE_URL` in env.

### 3.5 Hosting decision (phased)

The toolkit is a static site (`vite build` → GitHub Pages). It cannot hold a secret API key. Backend choice was **Hono + Postgres + AI Gateway** (per the evaluation conversation — see commit history / chat log). Phased deploy:

#### Phase 1 — Fully local demo

Goal: run the entire stack on a developer's laptop. Show the team the value, ask for buy-in. No external services, no API keys, no deploy.

```
┌─────────────────────────────────────────────────────────────┐
│  Developer's laptop                                          │
│                                                              │
│   ┌──────────────────┐    ┌──────────────────────────────┐  │
│   │  npm run dev     │    │  docker run pgvector/        │  │
│   │  (Vue, :5172)    │    │    pgvector:pg17             │  │
│   │                  │    │  (Postgres+pgvector on :54322)│ │
│   └────────┬─────────┘    └──────────────┬───────────────┘  │
│            │                             │                   │
│            ▼                             │                   │
│   ┌──────────────────────────────┐       │                   │
│   │  npm --prefix backend run dev │      │                   │
│   │  (Hono on :8787)             │──────┘                   │
│   └──────────┬───────────────────┘                          │
│              │                                              │
│              ▼                                              │
│   ┌──────────────────────────────┐                          │
│   │  ollama serve (:11434)       │                          │
│   │  - qwen2.5:7b                │                          │
│   │  - nomic-embed-text          │                          │
│   └──────────────────────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

- **A bare `pgvector/pgvector:pg17` container** is the local DB. The Hono backend connects via `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres`. The Supabase CLI was the original choice (it bundles Postgres + pgvector + Studio + GoTrue + Storage + Realtime + a Datadog-Vector log-shipper) but the toolkit demo only uses the Postgres half, and the Vector sidecar pulls from ECR Public — which has had availability hiccups that broke the local boot path. A single `docker run` is faster, more reliable, and uses the same image the ingest test (`@testcontainers/postgresql`) already pulls. For browsing data, point any Postgres GUI (TablePlus, pgweb, DBeaver) at `127.0.0.1:54322` instead of using Supabase Studio.
- **Single-user mode**: skip auth, all rows under one synthetic `user_id`. The "demo" is run by one developer driving the toolkit while teammates watch.
- **Bind to `127.0.0.1` only.** The Hono backend in Phase 1 listens on `127.0.0.1:8787`, never `0.0.0.0`. Reason: Phase-1 mode skips auth, so anything reachable on the LAN could spend Anthropic tokens (if the dev has switched to hosted) or read the chat log. The single-user assumption is enforced by network-level isolation, not by trust.
- **Recurring cost: $0**. See `02-cost-and-ops.md §5` for the full Phase-1 cost model.

##### Local dev-loop orchestration

Phase 1 needs four processes running: Vite, Hono, Postgres (a long-lived `ultra-pg17` container), Ollama. Manage them with one command via `concurrently` (added as a root devDependency):

```bash
# Root package.json scripts:
"demo:db:start": "docker start ultra-pg17 || docker run -d --name ultra-pg17 -e POSTGRES_PASSWORD=postgres -p 54322:5432 --restart unless-stopped pgvector/pgvector:pg17",
"demo:start":    "npm run demo:db:start && (ollama serve &) && npm run demo:dev",
"demo:dev":      "concurrently -n web,api 'npm run dev' 'npm --prefix backend run dev'",
"demo:stop":     "docker stop ultra-pg17 && pkill -f 'ollama serve' || true",
"demo:clean":    "docker rm -f ultra-pg17 && rm -rf backend/catalog/*.json"
```

`npm run demo:start` brings up the demo; `npm run demo:stop` cleans up; `npm run demo:clean` resets state for a fresh run. Documented in the Phase-1 README.

##### CORS

Backend installs `hono/cors` middleware allowing `http://localhost:5172` (frontend dev) and the Phase-2 production origin from `ALLOWED_ORIGINS` env var. Phase 1 default: `ALLOWED_ORIGINS=http://localhost:5172`. No wildcard origins, ever — JWT auth in Phase 2 needs a fixed allow-list.

##### Catalog staleness detection

The extractor records `abi_hash` (sha256 of the canonical ABI JSON) into `contracts.abi_hash` at ingest time. A small CLI surfaces drift:

```bash
npm --prefix backend run catalog:check
# [check] eosio.token: ABI hash matches chain (a3f2...)
# [check] eosio.nft.ft: ABI HASH DRIFT — chain has 7d12... ; catalog has 4c8a...
#         Run: npm --prefix backend run extract -- eosio.nft.ft && npm --prefix backend run ingest
```

Runs in CI weekly and on-demand. The chat panel also displays a small `⚠ Catalog stale (last verified 5 days ago)` notice if `abi_fetched_at` exceeds 7 days, prompting a re-extraction.

#### Phase 2 — Hosted production

Goal: ship to the team / public after Phase-1 buy-in.

```
                    Browser
                       │
                       ▼  HTTPS, CF DNS proxy (free, DDoS protection)
                       │
              ┌────────────────────────────────┐
              │  Hono on small VPS / Fly.io     │
              │  /api/ai-action                │
              │  /api/ai-usage                 │
              │  /api/auth/*                   │
              └──────────┬─────────────┬───────┘
                         │             │
                         ▼             ▼
              ┌─────────────────┐  ┌─────────────────────────┐
              │  Managed        │  │  CF AI Gateway           │
              │  Postgres       │  │   → Anthropic Haiku 4.5  │
              │  (Neon free /   │  │   → OpenAI embeddings    │
              │   Fly Postgres) │  │   → fallback: GPT-4o mini│
              └─────────────────┘  └─────────────────────────┘
```

- Backend host options, in rough order of preference for an Ultra context:
  - **Fly.io** — single-machine app from a Dockerfile, free TLS, easy Postgres companion, ~$3-5/mo for our load. Good fit because Hono Dockerizes trivially.
  - **A small VPS** (Hetzner / DigitalOcean / Vultr) — $5/mo, full control, more ops.
  - **Cloudflare Workers** — Hono runs on Workers natively. Drop Postgres for Hyperdrive→Neon. Worth considering if Ultra wants to consolidate to CF; we picked Node-host primarily for indexer-time-limit reasons (§5), but the chat path itself runs fine on Workers.
- **Postgres**: Neon free tier (3 GB, autosuspend) is enough for Phase-2 launch. Move to Fly Postgres or a dedicated instance when active users exceed ~50.
- **CF DNS proxy** in front of the VPS / Fly app — covers DDoS, edge caching of static `/api/ai-usage` polls.
- **Auth**: wallet-derived JWT. Frontend asks the user's Ultra wallet to sign a server-issued challenge; backend verifies the signature using the chain's public-key infra and issues a 24h JWT.

This phased plan means the **Phase-1 demo code = Phase-2 production code**, just different env vars. There's no rewrite when crossing the boundary, only ops.

## 4. Prompt design

### System prompt (compact, ~600 tokens)

```
You are an assistant that converts natural-language intents into Ultra blockchain
transactions. You output ONLY valid JSON matching the provided schema.

You have access to a CATALOG of contract actions (provided below). You may only
propose actions present in the catalog.

Rules:
1. If the user request is ambiguous about a REQUIRED field (an action field with
   `required: true` and no inferable default), respond with kind="ask" and a single
   question covering the most important missing field. Never ask multiple questions.
2. Format `asset` values with 8 decimal places by default (e.g. "100.00000000 UOS")
   unless the catalog specifies otherwise.
3. Pick the authorization from the action's `default_auth`, substituting `<from>`
   with the actual sender, etc. If the actor is unknown, ask for it.
4. If the user's request doesn't map to any action in the catalog, respond with
   kind="refuse" and a brief explanation.
5. Never invent contract names or action names. Never invent field names.
6. Keep `rationale` ≤ 2 short sentences.

User context:
  active account: {{account}}@{{permission}}
  chain: {{chainId}}
  known accounts on this wallet: {{knownAccounts}}

Catalog (top {{K}} candidates):
  {{candidates_json}}
```

### Response schema (Anthropic tool / OpenAI json_schema)

```json
{
  "type": "object",
  "oneOf": [
    {
      "properties": { "kind": { "const": "ask" }, "question": { "type": "string" } },
      "required": ["kind", "question"]
    },
    {
      "properties": {
        "kind": { "const": "propose" },
        "contract": { "type": "string" },
        "action": { "type": "string" },
        "data": { "type": "object" },
        "authorization": {
          "type": "object",
          "properties": {
            "actor": { "type": "string" },
            "permission": { "type": "string" }
          },
          "required": ["actor", "permission"]
        },
        "rationale": { "type": "string" }
      },
      "required": ["kind", "contract", "action", "data", "authorization", "rationale"]
    },
    {
      "properties": { "kind": { "const": "refuse" }, "reason": { "type": "string" } },
      "required": ["kind", "reason"]
    }
  ]
}
```

### Caching

- **Anthropic prompt caching** — the system prompt + catalog block is identical across requests in a session. Mark it `cache_control: ephemeral`. After the first request, every subsequent turn reads the catalog at the discounted cache-read rate (~10% of input cost).
- **Embedding cache** — hash the user query; skip re-embedding identical strings.

## 5. Indexer (per-contract, source-driven)

The indexer is split into **two independent stages** with separate CLIs. They write a checked-in JSON file as their handoff so each can be re-run on its own.

```
Stage A: extract       Stage B: ingest
  C++ source          extracted JSON files
       │                       │
       ▼                       ▼
  ┌─────────────┐         ┌─────────────────┐
  │  extract    │ ──────► │ catalog/*.json  │ ──────► Postgres
  └─────────────┘         └─────────────────┘
   tree-sitter-cpp        deterministic IO     embed + upsert
   no LLM in fact path    one file/contract
```

### 5.1 Phase 1 scope

The Phase-1 demo catalog contains **`eosio.token` only**. One contract is enough to demonstrate the full chat → propose → sign flow on the canonical "transfer" action. Adding more contracts is one CLI invocation each — done after the team approves Phase 2, not before.

### 5.2 Stage A — extractor CLI

`backend/scripts/extract-contract.ts`. Per-contract; deterministic; no LLM call required.

```bash
npm --prefix backend run extract -- eosio.token
# →  backend/catalog/eosio.token.json

# add another contract later
npm --prefix backend run extract -- eosio.nft.ft
# →  backend/catalog/eosio.nft.ft.json
```

**Inputs (one contract at a time):**

- ABI fetched from a live chain (mainnet → testnet fallback) via `@ultraos/ultra-api-lib`.
- C++ source under `~/ultra/eosio.contracts/contracts/<name>/src/*.cpp` and headers under `include/<name>/*.hpp`.
- *Not* ricardian markdown. Per project policy, ricardian is unmaintained and unreliable. Action semantics, auth, and constraints come exclusively from C++ source.

**Pipeline (per contract):**

1. Fetch ABI → list of actions + parameter shapes.
2. Parse each `.cpp` file with `tree-sitter-cpp` (via `web-tree-sitter`, WASM, no native deps).
3. For each action in the ABI, locate its handler function in the AST (action name = function name by convention).
4. Walk the function body, capturing call expressions:

   | C++ pattern | Captured as |
   |---|---|
   | `require_auth( from )` | `auths[]: { actor: "$from", permission: "active" }` |
   | `require_auth2( a, b )` | `auths[]: { actor: "$a", permission: "$b" }` |
   | `check( a != b, "msg" )` | `preconditions[]: { kind: "cross_field", expr, message }` |
   | `check( is_account(x), "..." )` | `preconditions[]: { kind: "state", expr, message }` |
   | `check( q.amount > 0, "..." )` | `field_constraints[q]: [{ expr: ".amount > 0", message }]` |
   | `check( memo.size() <= 256, "..." )` | `field_constraints[memo]: [{ expr: ".size() <= 256", message }]` |
   | `require_recipient( x )` | `recipients[]: "$x"` |
   | `ASSERTION_CHECK( cond, ERROR_CODE )` | `preconditions[]` (resolves `ERROR_CODE` from header to its string) |
   | Time literals like `2 * 60 * 60` inside checks | `time_constants[]: { literal, seconds }` |

5. **Helper-function follow-up (one level).** If the handler delegates to a same-translation-unit helper (e.g. `setconrecv` → `setconrecv_v1`), recurse once and merge captures.
6. **Macro / constant resolution.** Build a small symbol table from `*.hpp` for `constexpr` strings and known macros so `ASSERTION_CHECK(cond, ERROR_X)` resolves to its message.
7. Anything that doesn't parse cleanly is recorded as `unresolved: true` with a source link — not silently dropped. Per-action override YAML (`backend/catalog/overrides/<contract>/<action>.yaml`) fills these gaps with hand-written facts.
8. Write `backend/catalog/<contract>.json` (idempotent, content-hashed).

**Output schema (one row per action):**

```ts
type ActionRules = {
  contract:  string;                                     // 'eosio.token'
  action:    string;                                     // 'transfer'
  params:    Array<{ name: string; type: string }>;      // from ABI
  auths:     Array<{ actor: string; permission: string }>;
  preconditions: Array<{
    kind: 'cross_field' | 'state' | 'invariant';
    expr: string;
    message: string;
  }>;
  field_constraints: Record<string, Array<{ expr: string; message: string }>>;
  recipients: string[];
  time_constants?: Array<{ field: string; literal: string; seconds: number }>;
  source: { path: string; lines: [number, number] };
  unresolved?: boolean;
  notes?: string;                                         // from override YAML
};
```

This is what the runtime prompt renders as constraints alongside the field schema. The LLM at chat time sees real rules, not heuristics.

### 5.3 Stage B — catalog ingest

`backend/scripts/ingest-catalog.ts`. Loads every JSON in `backend/catalog/*.json`, optionally enriches each action with an LLM-authored description + examples, embeds, and upserts into Postgres.

```bash
# Phase 1: free, local, slow-ish (~30s for eosio.token alone)
LLM_PROVIDER=ollama  npm --prefix backend run ingest

# Phase 2: hosted, faster, ~$0.05 for eosio.token
LLM_PROVIDER=anthropic  npm --prefix backend run ingest
```

The LLM is used **only** for enrichment of subjective fields:
- `description`: 1-line plain English summary of what the action does.
- `examples`: 3 natural-language ways a user might phrase a request that maps to this action.

The LLM never authors `auths`, `preconditions`, or `field_constraints` — those come from Stage A and are immutable through ingestion. If Stage A failed to extract a fact (`unresolved: true`), the override YAML fills it; if neither, the field is left empty rather than guessed.

The same provider abstraction from §3.3 applies — no change. Both stages can run with `LLM_PROVIDER` ∈ `{anthropic, openai, ollama}` and `EMBED_PROVIDER` independently set. Stage A doesn't call any LLM; it only depends on `LLM_PROVIDER` if `--enrich-inline` is passed (off by default).

**Embedding policy** (unchanged from prior design): write `embedding_768` under Ollama, `embedding_1536` under OpenAI, or both with `--dual`.

**Stage B also handles cleanup.** When re-ingesting a contract, the script:
1. Fetches the latest set of action names from the catalog JSON.
2. `delete from actions where contract_id = $contract_id and name not in (<current names>)` — drops orphaned actions from previous catalog versions.
3. Cascades to `action_chunks` via the FK.

This keeps the DB in sync with the JSON; nothing lingers from removed/renamed actions.

**Unresolved-action gating.** Actions with `unresolved=true` (extractor couldn't fully parse, no override YAML) are ingested but **excluded from retrieval by default**. The `retrieve.ts` query has a `where unresolved = false` clause. To opt in for development, set `INCLUDE_UNRESOLVED=true` — useful for testing the extractor's gap-coverage but never in a real demo. Rationale: an action with empty `auths` would let the LLM guess, which is the failure mode we explicitly designed to avoid.

### 5.4 Why this split

- **Auditable.** `backend/catalog/eosio.token.json` is small (~30 KB), human-readable, and gets reviewed in PR before it lands in Postgres. Every fact has a `source.path:lines` link back to the C++.
- **Re-extractable without DB access.** Re-run Stage A any time (e.g., when a contract changes); diff the JSON; if diff looks correct, re-run Stage B.
- **No LLM in the fact path.** Stage A is deterministic; the LLM only writes prose. A wrong description is a UX paper cut; a wrong `require_auth` is a real bug.
- **Provider freedom.** Stage A doesn't care about LLMs at all. Stage B works under Ollama or hosted providers per the existing abstraction.
- **Per-contract growth.** Add `eosio.nft.ft` later by running two commands; Phase-1 demo doesn't get blocked on full catalog coverage.

### 5.5 Source path resolution

The extractor doesn't hardcode `~/ultra/eosio.contracts` — that path varies per dev machine, CI environment, and feature branch. Resolution order:

1. **CLI flag** — `--source <root>` (where `<root>` contains `contracts/<name>/`) or `--source-dir <contract>` (direct path to one contract).
2. **Env var** — `ULTRA_CONTRACTS_PATH` from `backend/.env`. Recommended for daily use.
3. **Auto-discovery** — checks `../eosio.contracts` (sibling of toolkit), `~/ultra/eosio.contracts`, `~/eosio.contracts` in order. Convenient default for the common Ultra dev setup.
4. **Fail with clear error** — lists each candidate it tried and what to set. No silent fallback.

The script logs which source it picked on every run so the catalog JSON header records `source.path` for audit:

```
[extract] Source: /Users/duncandam/ultra/eosio.contracts (from ULTRA_CONTRACTS_PATH)
[extract] Contract dir: .../contracts/eosio.token
```

`backend/.env.example` ships with `ULTRA_CONTRACTS_PATH`, `ULTRA_EOS_PATH`, `MAINNET_URL`, `TESTNET_URL`, `DATABASE_URL`, and the LLM provider variables — one file documents every external dependency the extractor + backend need.

### 5.6 Phase-1 catalog target: `eosio.token`

The actions we expect to extract from `eosio.token` (validated against current source):

| Action | Required auth (from source) | Notable rules |
|---|---|---|
| `create` | `eosio.token@active` (from `get_self()`) | Symbol must be valid; max_supply > 0 |
| `issue` | `issuer@active` | `to == issuer`; quantity matches symbol; positive amount |
| `retire` | `issuer@active` (resolved through `get_self`) | Quantity validations |
| `transfer` | `from@active` | `from != to`; `to` must exist; positive amount; symbol matches supply; memo ≤ 256 bytes; tax/burn config branch |
| `open` | `ram_payer@active` | Symbol must be in stats |
| `close` | `owner@active` | Balance must be zero |
| `burn` | `from@active` | Positive amount |
| `correlate` / `clrcorrelate` | `payer@active` | (utility actions for the burn-tracking subsystem) |
| `setconfig` | `eosio.token@active` | Config bounds checks |

Validating this list by running the extractor against the actual source is part of the prototype task in §6 of `02-cost-and-ops.md`.

## 6. Failure modes & guardrails

| Failure | Detection | Mitigation |
|---------|-----------|------------|
| LLM hallucinates a contract or action | Catalog membership check after parse | Reject and reissue with `kind: refuse` |
| LLM emits malformed asset / name | Regex validation step 6 | Downgrade to `kind: ask` for that field |
| LLM picks admin action for non-admin user | `is_admin` flag check | Refuse with explanation |
| Embedding API fails | Try/catch, fall back to lexical search via `to_tsvector` | Lower retrieval quality but still functional |
| Anthropic outage | AI Gateway provider fallback (Phase 2) / try-catch in code (Phase 1) | Auto-fall-back to GPT-4o mini; flag in UI |
| Rate-limit abuse | Backend in-process token-bucket + AI Gateway gateway-level rate limit | 30 req/hour soft cap, configurable; see `03-guardrails.md §2 Layer 2` |
| User signs anyway despite `refuse` | The toolkit's `<Transaction>` is still the gate | The AI's role is advisory; the user always reviews fields before signing |
| Slow Ollama cold start (~30 s on first request) | Frontend `AbortController` with 60 s timeout; surface "model warming up..." after 5 s | Pin the model with `ollama run qwen2.5:7b` once at session start; retry once on timeout |
| Stale catalog vs deployed contract | `npm run catalog:check` cron + chat-panel banner if `abi_fetched_at` > 7 days | Re-extract + re-ingest the affected contract |
| Backend restart wipes in-process rate-limit buckets | Postgres aggregate is durable and enforces the daily $ cap | Per-minute burst protection degrades briefly; daily cost cap is unaffected |
| Action with `unresolved=true` and no override leaks into runtime prompt | `retrieve.ts` excludes `unresolved=true` rows by default | Override YAML must land before action becomes user-facing |

## 7. Testing

- **Extractor unit tests** — `backend/test/extractor/` with synthetic `.cpp` snippets exercising each pattern (`require_auth`, multi-line `check`, `ASSERTION_CHECK`, helper-follow, macro resolution). Asserts byte-exact JSON output. No network.
- **Catalog-correctness test** — for each ingested action, assert that one canned NL example produces a valid proposal (mock the LLM with a deterministic stub).
- **Schema validation unit tests** — feed the validator known-good and known-bad LLM outputs.
- **End-to-end demo** — a single Playwright spec walks "transfer 100 UOS from acc1 to acc2" through the chat → builder → modal → mocked sign.
- **Cost regression** — assert that a single propose-turn stays under N tokens with cached system prompt.

## 8. Phase-2 TODOs (out of scope for Phase 1)

These are flagged as known gaps so they don't surprise anyone during the Phase-2 launch. None blocks the Phase-1 demo.

- **Wallet challenge auth.** Verify the Ultra wallet SDK's `signMessage` semantics. If `signMessage` rejects arbitrary strings (some EOSIO wallets only sign valid transaction headers), use a no-op proxy transaction with the challenge in the memo and verify server-side. Document the chosen approach before Phase-2 deploy.
- **Multilingual support.** Phase 1 is English-only — both the system prompt and the classifier expect English. Vietnamese / Korean Ultra users will get OFF_TOPIC false-positives. Phase 2 adds language detection as a pre-classifier step + translates the system prompt's user-facing strings.
- **AI Gateway runbook.** Phase-2 deploy needs an explicit checklist for CF dashboard config: cache TTL (suggest 1 h for classifier, 0 for chat), provider fallback chain (Haiku 4.5 → GPT-4o mini), per-route rate limits, metadata-tag schema. Land in `02-cost-and-ops.md §4.2` before the first Phase-2 deploy.
- **JSON Schema for catalog + override files.** Ship `backend/catalog/schema.json` (action JSON) and `backend/catalog/overrides/schema.json` (override YAML). Stage B validates against both at ingest time. Avoid silent corruption when hand-editing override YAMLs.
- **Indexing-vs-chat cost separation in `/aiUsage`.** When Stage B runs with hosted enrichment, those rows currently mix into the user's chat cost. Filter by `request_kind` in the page so users see "chat" vs "catalog build" separately.
