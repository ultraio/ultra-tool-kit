# AI-Assisted Action Assembly — Overview

> Branch: `task/ai-enhance-demo`
> Status: design draft (local-only, not committed)
> Author: design pass, 2026-05-10

## 1. Problem

Today, building a transaction in the toolkit requires the user to:

1. Know **which contract account** owns the action (`eosio.token`, `eosio.nft.ft`, etc.).
2. Know the **exact action name** (`transfer`, `create.b`, `manageaccgrp`, …).
3. Know the **field schema** of that action (e.g. `quantity` is an `asset` formatted `100.00000000 UOS`, `memo` is a `string`, `from` is a `name`).
4. Know **which authorization** is required (`from@active` for transfers, `eosio@active` for system actions, etc.).

For new users — and even experienced ones who haven't touched a given contract in months — this is friction. The toolkit has all the data (ABIs are already fetched and rendered in `AbiRender`) but the discovery path is "scroll through every contract's ABI."

## 2. Goal

Add a **chat panel** where a user describes their intent in natural language and the toolkit:

- Identifies the right contract + action.
- Fills in the parameters with correctly-formatted values.
- Picks the right authorization.
- **Asks back** when essential parameters are missing or ambiguous.
- Routes the result into the existing `<Transaction>` modal so the user reviews + signs as usual — **the AI never signs anything**.

Cost-conscious: target Claude Haiku 4.5 (or GPT-4o mini as alternative). Surface live + cumulative cost in the UI.

## 3. Scope (phased)

### Phase 1 — Fully local demo (this branch)

**Goal: convince teammates the feature is worth funding.** Runs entirely on a developer's laptop, zero recurring cost, no API keys.

- One chat panel (slide-over drawer accessible from `Navigation`).
- **Catalog scope: `eosio.token` only.** One contract is enough to demo the full chat → propose → sign loop on the canonical `transfer` action. Other contracts are added one at a time post-approval, each via a single CLI invocation against `~/ultra/eosio.contracts/contracts/<name>`.
- Catalog is built from C++ source via a deterministic extractor (no LLM in the fact path — see `01-architecture.md §5`). Ricardian markdown is ignored: the team doesn't keep it in sync with source.
- Single-turn intent → action proposal, with clarification turns.
- Hand-off to existing `<Transaction>` modal via the existing `@transact` event on `App.vue`.
- Cost meter showing both `🏠 X.X K tokens` (actual local spend = $0) and **projected hosted cost** so teammates see what Phase 2 would cost.
- Stack: Vue (`npm run dev`) + Hono backend (`npm --prefix backend run dev`) + local Postgres+pgvector via a single `docker run pgvector/pgvector:pg17` container + Ollama (`qwen2.5:7b` + `nomic-embed-text`).

### Phase 2 — Hosted production (post-demo, if approved)

Same code, different env vars. Team-wide deploy.

- Hono backend deployed to Fly.io / VPS with CF DNS proxy in front.
- Managed Postgres (Neon free tier).
- LLM via Cloudflare AI Gateway → Anthropic Haiku 4.5 (chat) + OpenAI `text-embedding-3-small` (embeddings). Provider fallback to GPT-4o mini.
- Wallet-derived JWT auth (sign challenge with Ultra wallet → 24h JWT).
- Per-user rate + budget caps (defaults: 30 req/hr, 200/day, $0.50/day/user).

### Phase 3 — Multi-action flows

- Compose multiple actions into one transaction ("create a factory and immediately mint 5 tokens to acc2").
- Use existing multisig flow — propose multi-sig if intent involves elevated accounts.

### Phase 4 — Live RPC grounding

- Let the AI read account balance, factory state, etc. via a small toolset (read-only RPC reads against the active endpoint) before proposing.
- E.g. "transfer all my UOS to acc2" → AI fetches balance, fills `quantity` exactly.

### Phase 5 — Schema validator + bulk flows

- Apply the same chat to the `schemaValidator` and `bulkFactoryCreation` pages.
- Let users describe a Uniq factory in prose; AI emits valid metadata JSON.

This document focuses on Phases 1 and 2.

## 4. UX flow (Phase 1)

```
┌──────────────────────────────────────────────────────────────┐
│  Navigation                          [💬 AI]  [💰 $0.0042]   │
├──────────────────────────────────────────────────────────────┤
│  Page content                                                │
│                                                              │
│                                                       ┌──────┤
│                                                       │ Chat │
│                                                       │      │
│                                                       │ User:│
│                                                       │  send│
│                                                       │  100 │
│                                                       │  UOS │
│                                                       │  to  │
│                                                       │  acc2│
│                                                       │      │
│                                                       │ AI:  │
│                                                       │ From │
│                                                       │ which│
│                                                       │ acct?│
│                                                       │      │
│                                                       │ User:│
│                                                       │ acc1 │
│                                                       │      │
│                                                       │ AI:  │
│                                                       │ ┌──┐ │
│                                                       │ │📋│ │
│                                                       │ │Tx│ │
│                                                       │ │Pre│ │
│                                                       │ │vw│ │
│                                                       │ └──┘ │
│                                                       │      │
│                                                       │[Open │
│                                                       │ in   │
│                                                       │ Build│
│                                                       │  er] │
└──────────────────────────────────────────────────────────────┘
```

### Flow steps

1. **User opens chat** from a `<Icon icon="fa-robot" />` button in `Navigation.vue`. Drawer slides in from the right; chat state lives in a Pinia-style composable (`useAiChat()`) so it survives route changes.
2. **User types**: *"I want to transfer 100 UOS from acc1 to acc2"*.
3. **Frontend** posts `{messages, endpoint, accountContext}` to the Hono backend at `POST /api/ai-action`.
4. **Backend** retrieves top-K matching actions from the catalog (pgvector similarity), assembles a compact prompt, calls the active LLM (Phase 1: Ollama; Phase 2: Anthropic Haiku 4.5 via AI Gateway) with a strict JSON-schema response.
5. **LLM returns one of**:
   - `{ kind: "ask", question: "Which token? UOS or a custom symbol?" }`
   - `{ kind: "propose", contract, action, data, authorization, rationale }`
   - `{ kind: "refuse", reason }` (out of scope, e.g. "tell me a joke")
6. **Backend** validates the proposal against the canonical ABI (asset format, account-name regex, required fields all present), logs token usage + cost to `usage_log`, returns to frontend.
7. **Frontend renders** the assistant turn:
   - If `ask` → plain markdown bubble with the question.
   - If `propose` → bubble with a structured preview card (contract, action, fields, authorization). Two buttons: **"Open in Builder"** (loads `/builder`, pre-adds the contract account, scrolls to the action, fills fields via `mutableObject`) and **"Sign now"** (emits `@transact` directly to `App.vue` → opens `<Transaction>` modal pre-filled).
8. **User reviews + signs** in the existing modal. AI is out of the loop.

### Authorization rules baked in

The catalog stores a default-authorizer policy per action:

- `from`-style fields → `<from>@active`.
- `owner`-style fields → `<owner>@active`.
- `eosio.system` admin actions → `eosio@active` (only proposed if `authState.isAdmin`).
- Otherwise → `authState.account@authState.permission`.

The user can always override in the modal — the AI just picks a sensible default.

### Clarification policy

The system prompt instructs the model to **ask exactly one** clarifying question per turn when essential fields are missing. "Essential" = required ABI field with no inferable default. Optional fields (e.g. `memo`) get a sensible empty default and are flagged in the rationale, not asked about.

### Companion documents

- `01-architecture.md` — components, schemas, provider abstraction (Anthropic / OpenAI / Ollama), hosting decision.
- `02-cost-and-ops.md` — cost model, model selection, local Ollama development loop, deploy.
- `03-guardrails.md` — abuse prevention, scope enforcement, rate + budget caps, jailbreak hygiene.

## 5. Non-goals (Phase 1)

- AI-driven signing or auto-execution.
- Free-form contract development (writing C++ contract code).
- Reading mainnet state to ground numeric answers (Phase 3).
- Multi-action transactions (Phase 2).
- Translating between languages other than English in the chat UI.

## 6. Open questions

| # | Question | Default if undecided |
|---|----------|----------------------|
| 1 | Phase 2 backend host: Fly.io vs VPS vs CF Workers? | Fly.io. Dockerfile-driven, free TLS, easy Postgres companion, ~$5/mo. CF Workers viable if Ultra wants to consolidate to CF, but the indexer's runtime profile fits Node better. |
| 2 | Phase 2 LLM model: Haiku 4.5 or GPT-4o mini? | Haiku 4.5 — better tool/JSON output, ~7× more expensive than mini but well under the cost ceiling. AI Gateway fallback to mini on Anthropic outage. Provide model picker in settings. |
| 3 | Chat UI placement: drawer vs. dedicated page? | Drawer — lets users see the builder fill in real time. |
| 4 | Local model: which Ollama model? | `qwen2.5:7b` default. ~5 GB RAM, strong JSON output. Document `qwen2.5:14b` and `mistral-nemo:12b` as alternatives if quality lacking. |
| 5 | Streaming responses? | Yes for the assistant text; structured proposal block waits for completion (validator needs full document). |
