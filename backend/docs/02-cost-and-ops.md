# AI-Assisted Action Assembly — Cost, Models, Ops

> Companion to `00-overview.md` and `01-architecture.md`.

## 1. Model selection

| Model | Input $/1M | Output $/1M | Cache read $/1M | Strengths | Weaknesses |
|-------|-----------:|------------:|----------------:|-----------|------------|
| Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | $1.00 | $5.00 | $0.10 | Excellent JSON / tool-use; native prompt caching; Anthropic SDK already familiar in this stack | ~7× more expensive per token than mini |
| GPT-4o mini (`gpt-4o-mini`) | $0.15 | $0.60 | $0.075 (with cache) | Cheapest credible model; OpenAI structured-output is rock-solid | Slightly weaker on free-form reasoning; mixed up similar action names in prior testing |
| Embeddings — OpenAI `text-embedding-3-small` | $0.02 | n/a | n/a | Standard pick; 1536-dim fits pgvector defaults | One more API surface |

**Default recommendation: Haiku 4.5** for the chat path, with prompt caching aggressively applied. Reasons:

- Structured output reliability matters more than raw cost here — a malformed proposal forces a re-roll, wiping out the savings.
- The system prompt + catalog block (≈3 KB) is reused across every turn in a session → the cache read rate (~$0.10/1M) makes Haiku effectively cheap after turn 1.
- The toolkit doesn't otherwise need an OpenAI dependency beyond embeddings (and embeddings are a one-time index cost).

GPT-4o mini stays as a user-selectable alternative behind a settings toggle, used for cost-sensitive or high-volume sessions.

## 2. Cost model — concrete numbers

**Assumptions (per user turn that returns a proposal):**

- System prompt + catalog (cached after turn 1): 2,500 tokens
- Conversation history: 500 tokens
- User turn: 80 tokens
- LLM output (JSON proposal + rationale): 250 tokens

**Haiku 4.5, turn 1 (no cache yet):**
- Input: 3,080 tok × $1.00 / 1M = **$0.00308**
- Output: 250 tok × $5.00 / 1M = **$0.00125**
- **Turn cost: ~$0.0043**

**Haiku 4.5, turns 2–N (cache hit on system+catalog):**
- Cached input: 2,500 tok × $0.10 / 1M = $0.00025
- Fresh input: 580 tok × $1.00 / 1M = $0.00058
- Output: 250 tok × $5.00 / 1M = $0.00125
- **Turn cost: ~$0.0021**

**Per 10-turn session:** ≈ **$0.022** with caching.

**GPT-4o mini equivalent:**
- Turn 1: ~$0.00061
- Turns 2–N: ~$0.00040
- **Per 10-turn session: ~$0.0042** (~5× cheaper).

**Embedding cost (per chat turn):**
- 80 tok × $0.02 / 1M = $0.0000016 — negligible.

**One-time indexing cost:**
- ~30 contracts × ~10 actions × 3 chunks ≈ 1,000 chunks × 250 tok avg = 250K tok
- Embeddings: 250K × $0.02 / 1M = $0.005
- Optional Haiku-authored descriptions: ~30 × 800 tok output = 24K tok × $5/1M ≈ $0.12
- **Total to build the catalog: ~$0.13.**

**Headline:** A heavy day for a single user (50 sessions, 10 turns each) costs roughly **$1.10 with Haiku** or **$0.21 with mini**. The cost meter exists to confirm this in practice, not because cost is a real risk.

## 3. Cost UI

### 3.1 `<CostBadge>` in `Navigation`

- Pill-shaped badge, e.g. `💰 $0.0042`.
- Shows **lifetime** cost for the current `authState.account` (not session — sessions are short-lived).
- Click → opens `/usage` page.
- Tooltip on hover:
  ```
  This session:  $0.0021  (3 turns)
  Today:         $0.0156  (8 turns)
  Lifetime:      $0.4231  (188 turns)
  Default model: Haiku 4.5
  ```
- Refreshes via the `useAiUsage()` composable (polling `GET /api/ai-usage` every 10 s while the chat drawer or `/aiUsage` page is open). The earlier design considered a Postgres LISTEN/NOTIFY push channel, but polling is simpler, the badge tolerates a few seconds of staleness, and the backend is loopback-only in Phase 1.

### 3.2 `/usage` page

Sections:

1. **Headline cards** — Lifetime spend, today, last 7d, last 30d.
2. **Time-series chart** — daily cost stacked by model. Reuse a small chart lib already in the project, or render a tiny inline SVG (chart-light enough that adding `chart.js` isn't justified).
3. **Per-request log** — paginated table: time, model, tokens (in/out/cached), cost, kind (chat/embed), session id (linkable). This is the same data backing the badge.
4. **Reset / export** — reset button (clears `usage_log` for the current user, asks to confirm). Export → CSV download.

### 3.3 Where the number comes from

The backend computes `cost_usd` per call from a hardcoded pricing table in `backend/src/pipeline/cost.ts`:

```ts
const PRICING = {
  'claude-haiku-4-5-20251001': {
    input:        1.00 / 1_000_000,
    output:       5.00 / 1_000_000,
    cache_read:   0.10 / 1_000_000,
    cache_write:  1.25 / 1_000_000,
  },
  'gpt-4o-mini': {
    input:  0.15 / 1_000_000,
    output: 0.60 / 1_000_000,
  },
  'text-embedding-3-small': {
    input: 0.02 / 1_000_000,
  },
} as const;
```

Pricing is read from this table — never inferred. When prices change, update the table; old `usage_log` rows keep their original computed value (correct behavior — it's a historical record).

## 4. Operational concerns

### 4.1 Secrets

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` live in the Hono backend's environment (Phase 2 only — Phase 1 has none). On Fly.io: `fly secrets set ANTHROPIC_API_KEY=...`. Never reach the browser.
- Optional: route through Cloudflare AI Gateway, in which case the keys still belong to the backend but the Gateway adds logging + caching + fallback.
- The indexer script reads the same env vars when run from the dev's machine.

### 4.2 Phase 2 hosting (post-demo, when shipping)

Recommended: **Fly.io + Neon Postgres + CF DNS proxy + AI Gateway.**

```bash
# Backend
cd backend
fly launch --no-deploy            # generates fly.toml; pick a region near most users
fly secrets set \
  DATABASE_URL=postgres://...neon.tech... \
  ANTHROPIC_API_KEY=... \
  OPENAI_API_KEY=... \
  ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/anthropic \
  JWT_SECRET=$(openssl rand -hex 32)
fly deploy

# DB
# (provision Neon free tier in their dashboard — gives you DATABASE_URL)
psql $DATABASE_URL -c "create extension if not exists vector;"
npm --prefix backend run db:migrate
npm --prefix backend run index   # one-time catalog seed

# CF DNS
# Add a CNAME from ai.toolkit.ultra.io → <app>.fly.dev with proxy ON
```

Alternative: small VPS (Hetzner / DO / Vultr) with `docker compose` running Hono + Postgres on the same box. ~$5/mo, more ops surface but full control.

### 4.3 Privacy

- In Phase 2, chat content is sent to Anthropic / OpenAI by definition. Don't include private keys, mnemonics, or memos with sensitive content. The system prompt instructs the model to refuse to handle key material.
- Phase 1 demo never sends data off-machine — Ollama runs locally.
- `chat_messages` and `usage_log` retention: 90 days, then a daily cron in the backend deletes older rows. Configurable.

### 4.4 Phase 1 — Local stack setup (the demo path)

Goal: 15 minutes from `git clone` to a working chat demo. No API keys, no deploys.

```bash
# 1. Install Ollama + pull models  (~10 min, mostly download time)
brew install ollama
ollama serve &
ollama pull qwen3:14b            # ~9 GB; the recommended chat model
ollama pull nomic-embed-text     # ~270 MB

# 2. Bring up local Postgres + pgvector  (single container, ~2 sec boot)
docker run -d --name ultra-pg17 \
  -e POSTGRES_PASSWORD=postgres \
  -p 54322:5432 \
  --restart unless-stopped \
  pgvector/pgvector:pg17
# DATABASE_URL: postgres://postgres:postgres@127.0.0.1:54322/postgres
# Browse data with any Postgres GUI (TablePlus / pgweb / DBeaver).

# 3. Backend
cd ultra-tool-kit/backend
cp .env.example .env             # provided; sets LLM_PROVIDER=ollama by default
npm install
npm run db:migrate
npm run extract -- eosio.token   # ~5 sec
npm run ingest -- eosio.token    # ~10 sec; embeds the catalog with nomic-embed-text
npm run dev                      # Hono on :8787

# 4. Frontend (in a separate terminal, from repo root)
npm run dev                      # Vite on :5172
```

Open `http://localhost:5172`, click the chat icon in the nav, type "transfer 100 UOS from acc1 to acc2". Done.

**Single-command alternative:** the root `package.json` ships `npm run demo:start` (uses `concurrently` to run Vite + Hono in one terminal, after the `ultra-pg17` container is up and `ollama serve` is running). `npm run demo:stop` stops both. `npm run demo:clean` destroys the container and removes catalog JSONs. See `01-architecture.md §3.5` for the full orchestration script set.

**Catalog staleness check:**
```bash
npm --prefix backend run catalog:check    # compares catalog ABI hashes against live chain
```
Re-extract any contract that drifted: `npm --prefix backend run extract -- <name> && npm --prefix backend run ingest`.

**Ollama model choices for the demo (May 2026):**

| Model | RAM (Q4) | JSON quality | Notes |
|---|---:|---|---|
| `qwen3:14b` | ~9 GB | ★★★★★ | **Default.** Strong tool-use discipline; rarely drops fields or invents shapes. Comfortable on a 16 GB+ laptop with other services running. |
| `mistral-small:24b` | ~14 GB | ★★★★★ | Native function calling baked into weights. Best agentic JSON quality, but needs ~24 GB free RAM. Slower per-turn. |
| `qwen3:8b` | ~5 GB | ★★★★ | Smaller footprint; weaker shape discipline. Use only if `qwen3:14b` doesn't fit. |
| `qwen2.5:14b` | ~9 GB | ★★★★ | Previous default. Workable, but qwen3 family is more stable on follow-up turns. |
| `phi-4` | ~8 GB | ★★★★ | Microsoft 14B dense. Strong JSON; slightly weaker on multi-turn coherence. |
| `qwen2.5:7b` | ~5 GB | ★★★ | Legacy default. Shape errors frequent without the retry pass; not recommended. |

**Pin the model resident** between turns via `OLLAMA_KEEP_ALIVE=30m` in `backend/.env` (Ollama unloads after 5 min by default, which surfaces as `provider-error` mid-conversation after a pause). The provider passes this on every chat / embed call.

**Embedding model:** `nomic-embed-text` (768-dim) is the default — fast, free, good enough for a 1k-chunk catalog. `mxbai-embed-large` (1024-dim) is an alternative if retrieval quality is poor.

**What you give up vs. hosted:**

- **No prompt caching** in Ollama. Each turn re-pays the full input. For local dev this is irrelevant (electricity, not API spend) but means you cannot benchmark turn-2 cache savings locally.
- **No streaming** of structured output (Ollama streams tokens but the JSON validator wants a complete document — same as in the hosted path, this is a non-issue).
- **Slower first request** — Ollama loads the model into VRAM on first call. Pin it with `ollama run qwen3:14b` once before the dev session, or rely on `OLLAMA_KEEP_ALIVE` (default 30m via `.env.example`) to keep it resident after the first request.

**Cost-meter behavior in local mode:**

- `cost_usd = 0` for every Ollama-tagged row in `usage_log`.
- Badge switches to `🏠 12.3K tok` (token totals, no dollar sign).
- The `/aiUsage` page filters by provider so you can see "what this *would* have cost on Haiku" alongside the actual zero — useful sanity check before flipping the env var for the demo.

**Mixed mode for development:** Use Ollama for chat (free, fast iteration on prompts) but keep OpenAI for embeddings (the index is built once and cheap — $0.005 total). Set `LLM_PROVIDER=ollama` and override `EMBED_PROVIDER=openai`. The provider interface separates the two calls so they don't have to share a vendor.

## 5. Phase-1 demo cost

The point of Phase 1 is to **prove the value before spending API dollars**. Cost should be effectively zero — and the cost meter exists in part to show teammates what Phase 2 *would* cost so the funding ask is grounded in real numbers, not estimates.

### 5.1 What you actually spend during Phase 1

| Item | Cost | Notes |
|---|---:|---|
| Ollama chat model (`qwen2.5:7b`) | $0 | Local inference |
| Ollama embeddings (`nomic-embed-text`) | $0 | Local inference |
| Local Postgres + pgvector (`pgvector/pgvector:pg17` container) | $0 | One Docker container on the dev's laptop |
| Catalog re-indexing (~1k chunks, every ABI change) | $0 | Local embedding |
| Disk space | ~6 GB | Models + Postgres data |
| Dev laptop electricity (typical 8h demo session) | ~$0.10 | Apple M-series w/ Ollama at ~30 W |
| **Total recurring** | **$0/mo** | |

Optional one-time hosted spend during Phase 1, only if you want to dual-embed the catalog so the same Postgres dump can ship to Phase 2 without re-indexing:

| Item | Cost | Notes |
|---|---:|---|
| OpenAI `text-embedding-3-small` for ~1k chunks (~250K tok) | ~$0.005 | Run `npm run index -- --dual` once |

That's it. **The headline number for the team meeting is "$0 ongoing cost during the demo phase."**

### 5.2 The cost meter shows projected hosted cost

The `/aiUsage` page in Phase 1 shows two columns side-by-side per request:

| Time | Model | Tokens (in / out) | Actual cost | Projected on Haiku 4.5 |
|---|---|---|---:|---:|
| 14:02 | `ollama:qwen2.5:7b` | 2,840 / 287 | $0.000 | $0.0043 |
| 14:03 | `ollama:qwen2.5:7b` | 540 / 198 | $0.000 | $0.0015 (with cache) |

The projected column uses the same `PRICING` table as Phase 2 — applied to the actual local token counts. This makes the "if we ship this, here's what it costs" pitch concrete and unimpeachable during the team meeting.

### 5.3 Phase 2 cost projections (for the funding ask)

Once Phase 2 is approved and shipped to the team, here's what the bill looks like at different adoption levels. All numbers assume:

- Default model: Haiku 4.5 with prompt caching enabled
- Average session: 5 turns
- Average request: 3,000 tok in / 250 tok out (turn 1: full input; turns 2-5: cached input)
- Indexer: free monthly re-index (~$0.005)

| Active users | Sessions / user / month | Total turns / month | Anthropic cost | Hosting (Fly + Neon free) | **Total / month** |
|---:|---:|---:|---:|---:|---:|
| 5 (core team) | 20 | 500 | ~$1.10 | $0 (free tier) | **~$1** |
| 20 (engineering) | 20 | 2,000 | ~$4.40 | $5 (Fly Hobby) | **~$10** |
| 50 (whole company) | 15 | 3,750 | ~$8.20 | $5 | **~$15** |
| 200 (public toolkit users) | 8 | 8,000 | ~$17.50 | $15 (scaled Fly + paid Neon) | **~$35** |
| 1,000 (heavy public use) | 5 | 25,000 | ~$55 | $30 | **~$85** |

**Caps in place to bound runaway cost:**

- $0.50/day per user soft cap (configurable). At 200 users this caps the **theoretical worst case** at ~$3,000/mo, but the projected number stays at $35 because real usage is far below the cap.
- AI Gateway prompt cache deduplication makes the marginal cost of duplicate queries effectively zero (top-10 popular phrasings → 1 LLM call across the user base).

### 5.4 Break-even framing for the team meeting

The pitch isn't about API spend — it's about engineering time saved. A few framings to bring to the meeting:

- **One avoided "what does this action expect?" Slack thread** ≈ 5 min saved across two people. At Ultra eng salary that's ~$10. The whole monthly Phase-2 cost for 50 users is recouped after the AI prevents ~2 such threads.
- **One avoided malformed transaction** that gets signed and bricks state ≈ hours of recovery / multisig rerun. Single-digit dollars of API spend prevents this regularly.
- **Onboarding new toolkit users** — the AI is effectively a self-serve docs+UX layer. Phase-2 cost for the entire onboarding cohort is less than one engineer-hour of pair-onboarding.

If the demo shows even one of these moments compellingly, the funding case writes itself.

## 6. Phase-1 task list (rough)

Phase 1 catalog scope: `eosio.token` only. Other contracts get added contract-by-contract after approval.

| # | Task | Est. | Notes |
|---|------|-----:|-------|
| 1 | Add chat / cost icons to `src/icons.ts` | 0.5h | |
| 2 | `useAiChat` composable + `aiClient.ts` | 4h | Streaming text, structured proposal handling |
| 3 | `ChatDrawer.vue`, `MessageBubble.vue`, `ProposalCard.vue` | 6h | Tailwind, follows `bg-neutral-800/900` palette |
| 4 | `Navigation.vue` integration + `CostBadge.vue` | 2h | Includes "projected hosted cost" tooltip |
| 5 | `/aiUsage` page + `useAiUsage.ts` | 3h | Side-by-side actual vs projected, inline SVG chart |
| 6 | `backend/` scaffold: Hono + Drizzle + Postgres connection + JWT-stub middleware | 4h | One-time |
| 7 | DB schema + migrations | 2h | §3.1 in architecture doc |
| 8 | Provider abstraction (Ollama + Anthropic + OpenAI implementations) | 5h | OpenAI is for embeddings only in Phase 1 |
| 9a | **Extractor (Stage A): tree-sitter-cpp + pattern matchers + helper-resolution + macro lookup + override loader** | 14h | Per-contract CLI; deterministic; no LLM on fact path. Tested against `eosio.token` |
| 9b | Catalog ingest (Stage B): load JSON, optional LLM enrichment, dual-embed, upsert | 4h | Provider-pluggable via existing abstraction |
| 10 | Pipeline: classify + retrieve + prompt + validate + cost | 8h | Heart of the backend |
| 11 | Builder page handoff (`pages/builder/index.vue` watcher) | 1h | Minimal change |
| 12 | Playwright e2e demo + LLM stub harness | 4h | Mock LLM via fetch interceptor |
| 13 | Phase-1 docs / README for the demo flow | 2h | "git clone → demo in 15 min" |
| | **Total** | **~60h** | One person, ~7-8 working days |

(Prior estimate ~48h; the +12h is the extractor's `tree-sitter-cpp` analysis. In return, the catalog is auditable C++ → JSON → DB with no LLM hallucination in the rule layer; adding new contracts later is one CLI invocation each.)

### 6.1 Recommended build order

1. **Extractor first** (#9a). Build it, run against `eosio.token`, eyeball `backend/catalog/eosio.token.json`. This validates the whole approach before touching the frontend or DB.
2. Backend scaffold + DB + ingest (#6, #7, #9b) — wire Stage A's output into Postgres.
3. Pipeline + provider abstraction (#8, #10) — proves end-to-end "catalog → proposal" with a curl test.
4. Frontend (#1–#5, #11) — wraps the working backend.
5. Polish (#12, #13).

This sequence keeps the riskiest part (extractor accuracy) at the front, where it can fail fast.

## 7. Definition of done (Phase 1)

- 15-minute setup from `git clone` to a working demo (Ollama + the `ultra-pg17` Docker container + backend + frontend).
- A real Ultra wallet connected; chat drawer opens from the navigation bar.
- Type "I want to transfer 100 UOS from acc1 to acc2"; AI proposes `eosio.token::transfer` with `100.00000000 UOS`, `acc1@active`, both account names correctly filled.
- Click "Open in Builder" → builder shows `eosio.token` added with the `transfer` form pre-filled.
- Click "Sign now" → existing `<Transaction>` modal opens with the action ready for the user to sign with their wallet.
- Cost badge shows `🏠 X.X K tok` (actual = $0); tooltip + `/aiUsage` page show **projected Phase-2 cost** alongside.
- A request with missing context (`"send 100 to acc2"`) triggers a clarifying question instead of a wrong proposal.
- An out-of-scope request (`"what's the weather?"`) yields a polite refusal at the classifier layer (~free).
- A second example for a different contract works (e.g. `eosio.nft.ft::transfer.b` or a multisig propose) — proves the catalog is general, not a one-trick demo.
- `npm run build` and `npx playwright test` both still pass.
- A second example with missing context (`"send 100 to acc2"`) triggers a clarifying question instead of a wrong proposal.
- An out-of-scope example (`"what's the weather?"`) yields a polite refusal.
