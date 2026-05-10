# Running locally (Phase 1)

Free, single-user, on-your-laptop setup. Postgres + pgvector via a single Docker
container; LLM via Ollama. Use this for the demo and day-to-day development.

## Prerequisites

| Tool | Why | Install |
|------|-----|---------|
| Node 22+ | Backend runtime | `brew install node@22` |
| Docker Desktop | Postgres container + the ingest test container | https://docs.docker.com/desktop/ |
| Ollama | Local LLM | `brew install ollama` (or https://ollama.com/download) |
| `psql` (optional) | Quick SQL inspection | comes with `postgresql` on Homebrew |
| `~/ultra/eosio.contracts` | C++ source the extractor reads | `git clone <eosio.contracts repo> ~/ultra/eosio.contracts` (already in place if you set up the toolkit normally) |

## 1. Install backend dependencies

```bash
cd backend
npm install
```

## 2. Start Postgres + pgvector

One container, one command:

```bash
docker run -d --name ultra-pg17 \
  -e POSTGRES_PASSWORD=postgres \
  -p 54322:5432 \
  --restart unless-stopped \
  pgvector/pgvector:pg17
```

This is the same image the ingest test uses, so it's already cached if you've
run `npm test` once. Boots in ~2 seconds; pgvector 0.8.x is preinstalled.

Verify:

```bash
docker exec ultra-pg17 pg_isready -U postgres
docker exec ultra-pg17 psql -U postgres -c "select version();"
```

To stop or destroy later:

```bash
docker stop ultra-pg17       # pause; data persists in the container
docker rm -f ultra-pg17      # destroy; everything gone
```

> **Why not Supabase?** The Supabase CLI bundles Studio, GoTrue, Storage,
> Realtime, and a Datadog-Vector log shipper alongside Postgres — none of which
> the toolkit demo uses. A bare pgvector container boots in seconds and avoids
> ECR Public outages that occasionally break `supabase start`. If you want
> Supabase Studio for browsing data, install [pgweb](https://github.com/sosedoff/pgweb)
> or use any Postgres GUI pointed at `127.0.0.1:54322`.

## 3. Configure `.env`

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```env
# Matches the docker run command above
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54322/postgres

# Where your eosio.contracts checkout lives
ULTRA_CONTRACTS_PATH=/Users/<you>/ultra/eosio.contracts

# Default URLs are fine
MAINNET_URL=https://ultra.eosusa.io
TESTNET_URL=https://test.ultra.eosusa.io

# All three on Ollama for local
LLM_PROVIDER=ollama
EMBED_PROVIDER=ollama
CLASSIFIER_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_CHAT_MODEL=qwen2.5:7b
OLLAMA_EMBED_MODEL=nomic-embed-text
```

Leave the `ANTHROPIC_*` / `OPENAI_*` blocks blank — they're not used in local mode.

## 4. Pull Ollama models

```bash
ollama serve &                       # keep this running in a separate terminal
ollama pull qwen2.5:7b               # ~4.4 GB
ollama pull nomic-embed-text         # ~270 MB
```

Sanity-check Ollama is alive:

```bash
curl http://localhost:11434/api/tags
```

## 5. Apply the schema

From `backend/`:

```bash
npm run db:migrate
```

This runs every file in `backend/drizzle/` against `DATABASE_URL`. The first
migration creates the `vector` and `pgcrypto` extensions, all seven tables, and
the two ivfflat cosine indexes on `action_chunks`. Re-running is a no-op —
Drizzle records applied migrations in a `__drizzle_migrations` table.

Verify:

```bash
psql "$DATABASE_URL" -c "\dt"
```

You should see `contracts`, `actions`, `action_chunks`, `chat_sessions`,
`chat_messages`, `usage_log`, `incidents`.

## 6. Stage A — extract a contract

Re-extracting after the C++ source changes is safe; the JSON is overwritten
atomically.

```bash
npm run extract -- eosio.token
```

Output: `backend/catalog/eosio.token.json` with one entry per action. Actions
the parser couldn't fully resolve are flagged `unresolved: true` (e.g. inline-only
notify actions like `burn`/`tax`/`nettransfer` on `eosio.token`).

If your `eosio.contracts` checkout is somewhere unusual:

```bash
npm run extract -- eosio.token --source /path/to/eosio.contracts
```

## 7. Stage B — ingest into Postgres

Embed-only (fast, no LLM enrichment):

```bash
npm run ingest -- eosio.token
```

With LLM-authored descriptions + 3 natural-language examples per action:

```bash
npm run ingest -- eosio.token --enrich
```

Pino prints a structured log per step. Expect ~30 s for `eosio.token` with
enrichment under Ollama; embed-only is a few seconds.

Verify the row counts:

```bash
psql "$DATABASE_URL" -c "
  select c.account, count(a.*) as actions, count(a.*) filter (where a.unresolved) as unresolved
  from contracts c left join actions a on a.contract_id = c.id
  group by c.account;"
```

For `eosio.token` you should see 13 actions, 3 unresolved (the inline-only ones).

```bash
psql "$DATABASE_URL" -c "
  select name, jsonb_array_length(rules->'auths') as n_auths
  from actions a join contracts c on a.contract_id = c.id
  where c.account = 'eosio.token' and unresolved = false;"
```

10 rows, every `n_auths` ≥ 1.

## 8. Verify retrieval quality

```bash
npm run verify:similarity
```

Default query is `"send 100 UOS to acc2"`. The script embeds the query via the
active embed provider, runs a pgvector cosine-similarity scan, and prints the
top 5 chunks. The acceptance criterion is that `eosio.token::transfer` is in
the top 3 — the script exits 1 if it isn't.

Custom query:

```bash
npm run verify:similarity -- "open a balance row for alice"
```

## 9. Drift detection

Run when an upstream contract may have changed:

```bash
npm run catalog:check
```

For each contracts row, fetches the live ABI (mainnet → testnet fallback) and
compares the sha256. Exits 1 if any contract has drifted.

## 10. Tests + typecheck

```bash
npm test         # 16 tests, including a pgvector pg17 testcontainer
npm run typecheck
```

The ingest test pulls `pgvector/pgvector:pg17` the first time you run it
(~200 MB); subsequent runs reuse the cached image and complete in ~25 s.

## Common issues

**`docker run` fails with `port is already allocated`.** Something else is on
54322. Either stop it (`docker ps | grep 54322`) or pick a different host port
(`-p 54323:5432` and update `DATABASE_URL` to match).

**`docker exec ultra-pg17 ...` says "no such container".** The container was
never started or got removed. Re-run the `docker run` from §2.

**`Error: connect ECONNREFUSED 127.0.0.1:11434` from ingest.** Ollama isn't
running. Start `ollama serve` in another terminal.

**Ingest test hangs or times out.** Docker Desktop probably isn't running.
The test uses `@testcontainers/postgresql` to start an ephemeral container.

**`unknown vector dimension for Ollama embed model`.** You changed
`OLLAMA_EMBED_MODEL` to a model not in the dimension table. Add a mapping in
`src/llm/ollama.ts` or stick to `nomic-embed-text`.

**Ingest writes embeddings into the wrong column.** The active `EMBED_PROVIDER`'s
`vectorDim()` decides which column gets written. Ollama's `nomic-embed-text` →
`embedding_768`; OpenAI's `text-embedding-3-small` → `embedding_1536`.

**"ivfflat index created with little data" notice.** Cosmetic — pgvector warns
that recall is poor when the table has fewer rows than `lists`. With more
contracts ingested it stops complaining.

## Resetting

Wipe the schema and re-apply (data + ingested catalog gone, container intact):

```bash
npm run db:reset
```

Or nuke the container entirely (faster than `db:reset` for a fresh start):

```bash
docker rm -f ultra-pg17
docker run -d --name ultra-pg17 \
  -e POSTGRES_PASSWORD=postgres \
  -p 54322:5432 \
  --restart unless-stopped \
  pgvector/pgvector:pg17
npm run db:migrate
```
