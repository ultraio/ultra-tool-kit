# Running with live services (Phase 2)

Hosted deployment. Managed Postgres + pgvector for storage; Anthropic for chat;
OpenAI for embeddings; optionally Cloudflare AI Gateway in front of both LLM
APIs for caching, retries, and observability.

The same code as the local mode — only env vars change.

## Prerequisites

| Service | Why | Notes |
|---------|-----|-------|
| Node 22+ runtime | Backend | Anywhere — Fly.io, Render, a VPS, or a laptop. |
| Managed Postgres with `pgvector` | Storage | Neon, Supabase, Fly Postgres, or self-hosted pg17 with `pgvector` extension installed. The schema requires `CREATE EXTENSION vector` to succeed during migration. |
| Anthropic API key | Chat | https://console.anthropic.com/ |
| OpenAI API key | Embeddings (`text-embedding-3-small`) | https://platform.openai.com/ |
| Cloudflare AI Gateway (optional) | Caching, rate-limit smoothing, audit log | https://developers.cloudflare.com/ai-gateway/ |

## 1. Provision Postgres

Whichever provider you pick, before running migrations confirm that
`pgvector` is available. From `psql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

Most managed Postgres products ship pgvector as an opt-in extension. Neon, Supabase,
and Fly Postgres all support it on recent plans. If `CREATE EXTENSION` fails, the
provider doesn't have pgvector — pick a different host or upgrade the plan.

## 2. Configure `.env` for hosted mode

```env
# Managed Postgres connection string (Neon / Supabase / Fly / etc.)
DATABASE_URL=postgres://USER:PASS@HOST:5432/DB?sslmode=require

# Where Stage A reads C++ source from. Only required if you re-extract on this host.
ULTRA_CONTRACTS_PATH=/srv/eosio.contracts

# Chain endpoints for ABI fetch (Stage A + catalog:check)
MAINNET_URL=https://ultra.eosusa.io
TESTNET_URL=https://test.ultra.eosusa.io

# Provider selection (the §3.3 "Phase 2 default" row)
LLM_PROVIDER=anthropic
EMBED_PROVIDER=openai
CLASSIFIER_PROVIDER=anthropic        # or `openai` for the cost-optimized split

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_CHAT_MODEL=claude-haiku-4-5-20251001
# Optional: route through Cloudflare AI Gateway. Set the gateway base URL here
# and AI Gateway will proxy to api.anthropic.com transparently.
ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic

# OpenAI (for embeddings under hosted mode)
OPENAI_API_KEY=sk-...
OPENAI_EMBED_MODEL=text-embedding-3-small
OPENAI_CHAT_MODEL=gpt-4o-mini        # only used if you switch CLASSIFIER_PROVIDER=openai
```

Keep `ANTHROPIC_BASE_URL` blank for direct Anthropic; set it to your AI Gateway
URL once you've created the gateway in the Cloudflare dashboard. The toolkit
writes `usage_log.model` as `anthropic:<model>` so cost rows stay attributable
even when traffic is mediated by the gateway.

## 3. Run migrations against the live DB

```bash
cd backend
npm install
npm run db:migrate
```

The first migration runs `CREATE EXTENSION IF NOT EXISTS vector` — make sure
the connection role has the privilege. On Neon and Supabase, the default owner
role does; on locked-down Postgres you may need to ask the DBA to enable the
extension out-of-band and then re-run with that statement removed (or split out
into a manually applied step).

Verify:

```bash
psql "$DATABASE_URL" -c "\dt"
psql "$DATABASE_URL" -c "\dx vector"
```

## 4. Stage A — extract contracts

Stage A doesn't need the LLM provider — it parses C++. If you maintain the
catalog on a separate dev machine and only ship JSON to production, you can
skip running `extract` on the production host and just rsync `catalog/` files
in instead.

If you do extract on the live host:

```bash
npm run extract -- eosio.token
```

Commit the resulting `catalog/eosio.token.json` to git for audit; ingest will
read it from disk.

## 5. Stage B — ingest with enrichment

```bash
npm run ingest -- eosio.token --enrich
```

Under hosted mode this calls Anthropic for description/examples and OpenAI for
embeddings. Expect ~$0.05 per contract per `--enrich` run (mostly the embedding
calls dominate; chat enrichment is one short request per action). The exact
per-token rates are tracked in [docs/02-cost-and-ops.md §2](docs/02-cost-and-ops.md)
(local-only, gitignored).

Without `--enrich`, no chat calls are made; only the embedding API is touched.

To populate both embedding columns (so you can switch provider later without
re-ingesting), run with `--dual`:

```bash
npm run ingest -- eosio.token --enrich --dual
```

`--dual` requires a working secondary embed provider — if your primary is
OpenAI (1536-dim), the secondary spins up an Ollama provider (768-dim). For
hosted-only deployments without Ollama nearby, just stick to single-dim and
re-ingest later.

## 6. Verify retrieval

```bash
npm run verify:similarity
```

Same as local mode, except the embed call hits OpenAI. The acceptance check
is unchanged: `eosio.token::transfer` in the top 3 for `"send 100 UOS to acc2"`.

## 7. Drift monitoring

Run `catalog:check` on a schedule (e.g. nightly cron). It exits 1 on drift,
which any cron supervisor will surface as a failure:

```bash
0 3 * * *  cd /srv/ultra-tool-kit/backend && npm run catalog:check
```

The output lines are stable enough to grep:

- `✓ <account>` — match
- `⚠ <account>` — match but stored ABI is older than 7 days; refresh advised
- `✗ <account>` — drift; the printed `stored:` and `live:` hashes diverge

When drift fires, re-run Stage A for that contract, review the JSON diff, then
re-run Stage B.

## 8. Cost monitoring

Every chat call writes a row to `usage_log` with `cost_usd` precomputed.
The per-call cost rate comes from the `PRICING` table in `pipeline/cost.ts`
(coming in M3). Until the runtime is in place, you can already inspect
embedding spend by counting embed calls during `ingest --enrich`:

```sql
select model, request_kind, count(*), sum(input_tokens), sum(output_tokens), sum(cost_usd)
from usage_log
group by model, request_kind;
```

(The runtime fills `usage_log`; ingest alone does not log here. Nothing
to query yet on a fresh DB.)

## 9. Optional: Cloudflare AI Gateway

The benefit of the gateway, beyond DDoS protection, is **prompt caching across
identical embedding/chat requests** — particularly valuable if multiple users
hit the assistant with similar phrasings.

Setup:

1. In the Cloudflare dashboard, create an AI Gateway and note the gateway
   slug.
2. The Anthropic-compatible URL is
   `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`.
3. Set `ANTHROPIC_BASE_URL` to that. The Anthropic SDK respects the override
   transparently — every call your backend makes flows through the gateway.
4. Repeat for OpenAI if you also want embeddings cached. (The current
   `OpenAIProvider` does not yet expose a `baseURL` override; that's a
   one-line change when you need it.)

The schema's `usage_log.cost_usd` column reflects the **provider** rate; AI
Gateway doesn't reduce billed usage, but it does reduce **call count** for
cached requests.

## 10. Phase-1 → Phase-2 cutover checklist

When promoting an existing local-mode deployment to hosted:

- [ ] New managed Postgres provisioned with `pgvector`.
- [ ] `DATABASE_URL` updated.
- [ ] `LLM_PROVIDER=anthropic`, `EMBED_PROVIDER=openai`, both API keys present.
- [ ] `npm run db:migrate` against the new DB.
- [ ] Re-ingest with the hosted embed provider so `embedding_1536` is populated:
      `npm run ingest -- --enrich`.
- [ ] `npm run verify:similarity` returns `eosio.token::transfer` in top 3.
- [ ] `npm run catalog:check` exits 0.
- [ ] Cron set up for nightly `catalog:check`.
- [ ] (Optional) AI Gateway base URLs in place; verify via `ANTHROPIC_BASE_URL`
      logging in `usage_log.model`.

## Common issues

**`relation "actions" does not exist`** — `db:migrate` didn't run, or it ran
against a different `DATABASE_URL` than the app. Confirm with `\dt`.

**`extension "vector" is not available`** — pgvector isn't installed on the
provider plan. Either upgrade the plan or pick a different provider.

**Ingest fails with `ANTHROPIC_API_KEY is not set`** — `--enrich` needs the
chat provider configured. For embed-only you can leave `ANTHROPIC_API_KEY`
blank and the chat provider is never instantiated.

**`Anthropic response did not include the structured tool_use block`** — the
model declined to emit the tool call. Usually means the prompt triggered safety
filters; inspect the system+user pair printed at log level `debug` and adjust.

**OpenAI embedding latency spikes after redeploy** — first cold call to a new
region is slow. Subsequent calls warm up. AI Gateway caches help here.
