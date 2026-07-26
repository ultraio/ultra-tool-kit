# Quota & Unlock Discoverability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the AI daily budget and the minimum-UOS-to-unlock proactively (on chat-drawer open) with real numbers, plus a text-only "stake to raise" hint — reusing the existing `GET /api/ai-quota` fetch.

**Architecture:** Extend `GET /api/ai-quota` with three unlock fields (`heldUos`, `thresholdUos`, `locked`) read via the same balance reader the W9 gate uses; the FE renders three drawer states (anon teaser / locked unlock-panel / unlocked under-input budget line). No new gate, no behavioral change to W9/W10 — this is a discoverability layer.

**Tech Stack:** TypeScript (strict), Hono, Vitest (backend); Vue 3 + Tailwind, vue-tsc (frontend).

**Spec:** `docs/superpowers/specs/2026-06-11-quota-unlock-discoverability-design.md`. Read it first.

**Conventions (from `backend/CLAUDE.md` + root `CLAUDE.md`):** Backend TS strict, no `any` without a justifying comment, tests under `backend/test/` mirroring `src/`, mock at injection boundaries (no live RPC). Backend formatting is **4-space spaces / single quotes / 120 width** and is NOT covered by `npm run format` — run `npx prettier --write <files>` manually before each commit. FE is covered by `npm run format`; FE typecheck is `npm run build` (vue-tsc + vite). Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `backend/src/routes/ai-quota.ts` | Add `readUosBalance`+`thresholdUos` deps; return `heldUos`/`thresholdUos`/`locked` | Modify |
| `backend/test/routes/ai-quota.test.ts` | New cases: locked/unlocked/anon/threshold≤0/read-throws | Modify |
| `backend/src/middleware/balance-gate.ts` | Export `makeDefaultReader` so the route can build the same reader | Modify |
| `backend/src/index.ts` | Build one shared `readUosBalance`; spread it + `thresholdUos` into the route deps | Modify |
| `backend/test/quota-wiring.test.ts` | Assert the new fields flow through `createApp` | Modify |
| `src/utilities/aiClient.ts` | Extend `QuotaView` + `fetchQuota` coercion with the 3 fields | Modify |
| `src/components/ai/ChatDrawer.vue` | Three drawer states (anon teaser / locked panel / under-input budget line) | Modify |
| `tests/ai-chat-smoke.spec.ts` | Add the 3 fields to the existing `/api/ai-quota` mock | Modify |
| `docs/00-ai-global-guidelines.md` | One sentence in §3.8: route also surfaces unlock threshold/held/locked | Modify |

---

## Pre-flight (do once, before Task 1)

- [ ] **Confirm green baseline**

Run: `npm --prefix backend test`
Expected: PASS (was 54 files / 441 tests). If red on a clean checkout, stop and report.

Run: `npm run build`
Expected: vue-tsc + vite build green.

---

## Task 1: Backend — `ai-quota.ts` returns unlock fields

**Files:**
- Modify: `backend/src/routes/ai-quota.ts`
- Test: `backend/test/routes/ai-quota.test.ts`

- [ ] **Step 1: Update the test file**

Replace the entire contents of `backend/test/routes/ai-quota.test.ts` with:

```ts
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createAiQuotaRouter, type AiQuotaDeps } from '../../src/routes/ai-quota.js';
import { InMemoryUsageStore } from '../../src/usage/store.js';
import { readQuotaConfig } from '../../src/usage/quota-config.js';
import type { IdentityVariables } from '../../src/middleware/attestation.js';

const CFG = readQuotaConfig({
    QUOTA_RATE_PER_DAY: '0.02',
    QUOTA_FREE_FLOOR_USD: '0.01',
    QUOTA_MAX_CAP_USD: '1.00',
});

const ATTESTED = { account: 'whale', pubkey: 'P', permission: 'active', signableAccounts: [] };

// Response.json() is `unknown` under strict TS; tests assert on parsed bodies.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

function mount(store: InMemoryUsageStore, identity?: object, overrides: Partial<AiQuotaDeps> = {}) {
    const app = new Hono<IdentityVariables>();
    if (identity)
        app.use('/api/ai-quota', async (c, next) => {
            c.set('identity', identity as never);
            await next();
        });
    app.route(
        '/api/ai-quota',
        createAiQuotaRouter({
            config: CFG,
            store,
            readStakedUos: async () => 500,
            readUosPrice: async () => 0.02,
            readUosBalance: async () => 500,
            thresholdUos: 1.0,
            now: () => new Date('2026-06-09T12:00:00Z'),
            ...overrides,
        })
    );
    return app;
}

describe('GET /api/ai-quota', () => {
    it('reports the free floor for an unattested caller', async () => {
        const res = await mount(new InMemoryUsageStore()).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(res.status).toBe(200);
        expect(b.dailyCapUsd).toBe(0.01);
        expect(b.stakedUos).toBe(0);
        expect(b.spentTodayUsd).toBe(0);
    });

    it('reports the stake-tiered cap for an attested staker', async () => {
        const res = await mount(new InMemoryUsageStore(), ATTESTED).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        // 500 UOS * $0.02 = $10 staked → $0.20/day
        expect(b.stakedUos).toBe(500);
        expect(b.dailyCapUsd).toBe(0.2);
    });

    it('reflects spend already accumulated for the identity key', async () => {
        const store = new InMemoryUsageStore();
        store.addSpentMicroUsd('acct:whale', '2026-06-09', 50_000); // $0.05
        const res = await mount(store, ATTESTED).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(b.spentTodayUsd).toBe(0.05);
    });

    it('reports locked:true when held UOS is below the threshold (attested)', async () => {
        const res = await mount(new InMemoryUsageStore(), ATTESTED, {
            readUosBalance: async () => 0.5,
            thresholdUos: 1.0,
        }).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(b.locked).toBe(true);
        expect(b.heldUos).toBe(0.5);
        expect(b.thresholdUos).toBe(1.0);
    });

    it('reports locked:false when held UOS meets the threshold (attested)', async () => {
        const res = await mount(new InMemoryUsageStore(), ATTESTED, {
            readUosBalance: async () => 5,
            thresholdUos: 1.0,
        }).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(b.locked).toBe(false);
        expect(b.heldUos).toBe(5);
    });

    it('never reads balance or locks an anonymous caller', async () => {
        const readUosBalance = vi.fn(async () => 0);
        const res = await mount(new InMemoryUsageStore(), undefined, { readUosBalance }).request(
            '/api/ai-quota?sessionId=s1'
        );
        const b = await json(res);
        expect(b.locked).toBe(false);
        expect(b.heldUos).toBe(0);
        expect(readUosBalance).not.toHaveBeenCalled();
    });

    it('does not read balance or lock when the threshold is disabled (<=0)', async () => {
        const readUosBalance = vi.fn(async () => 0);
        const res = await mount(new InMemoryUsageStore(), ATTESTED, { readUosBalance, thresholdUos: 0 }).request(
            '/api/ai-quota?sessionId=s1'
        );
        const b = await json(res);
        expect(b.locked).toBe(false);
        expect(b.thresholdUos).toBe(0);
        expect(readUosBalance).not.toHaveBeenCalled();
    });

    it('fails closed (locked:true, heldUos:0) when the balance read throws', async () => {
        const res = await mount(new InMemoryUsageStore(), ATTESTED, {
            readUosBalance: async () => {
                throw new Error('rpc down');
            },
            thresholdUos: 1.0,
        }).request('/api/ai-quota?sessionId=s1');
        const b = await json(res);
        expect(b.locked).toBe(true);
        expect(b.heldUos).toBe(0);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix backend test -- ai-quota`
Expected: FAIL — `AiQuotaDeps` has no `readUosBalance`/`thresholdUos`, and the response has no `locked`/`heldUos`/`thresholdUos`.

- [ ] **Step 3: Update the implementation**

Replace the entire contents of `backend/src/routes/ai-quota.ts` with:

```ts
// GET /api/ai-quota — the caller's current quota + unlock view for the FE badge
// (docs/00 §3.8 cap, §3.7 balance gate). Identity is optional: if an upstream
// attestation middleware set c.var.identity we report the stake-tiered cap and
// the unlock state, else the free floor and unlocked. sessionId comes from the
// query string (this is a GET; no body). Reuses the gate's config + store +
// readers (single source of truth).

import { Hono } from 'hono';

import type { IdentityVariables } from '../middleware/attestation.js';
import type { UsageStore } from '../usage/store.js';
import { type QuotaConfig, dailyCapMicroUsd, nextTier, MICRO } from '../usage/quota-config.js';
import { identityKey } from '../usage/identity.js';

export type AiQuotaDeps = {
    config: QuotaConfig;
    store: UsageStore;
    readStakedUos: (account: string, endpoint: string) => Promise<number>;
    readUosPrice: (endpoint: string) => Promise<number>;
    // Liquid UOS reader (W9 balance gate). Powers the unlock view.
    readUosBalance: (account: string, endpoint: string) => Promise<number>;
    // BALANCE_THRESHOLD_UOS — the unlock minimum (<=0 disables the gate).
    thresholdUos: number;
    now?: () => Date;
};

export function createAiQuotaRouter(deps: AiQuotaDeps): Hono<IdentityVariables> {
    const now = deps.now ?? (() => new Date());
    const app = new Hono<IdentityVariables>();

    app.get('/', async (c) => {
        const identity = c.get('identity');
        const sessionId = c.req.query('sessionId') ?? '';
        const endpoint = c.req.query('endpoint') ?? '';
        const dayUtc = now().toISOString().slice(0, 10);

        const key = identityKey(c, identity);

        let stakedUos = 0;
        let uosPriceUsd = deps.config.priceFallbackUsd;
        let capMicro: number;
        if (identity && !deps.config.disabled) {
            stakedUos = await deps.readStakedUos(identity.account, endpoint);
            uosPriceUsd = await deps.readUosPrice(endpoint);
            capMicro = dailyCapMicroUsd(deps.config, stakedUos, uosPriceUsd);
        } else {
            capMicro = Math.round(deps.config.freeFloorUsd * MICRO);
        }

        // Unlock state (W9 balance gate, docs/00 §3.7): liquid UOS vs threshold.
        // Mirror the gate exactly — anonymous callers and a disabled gate
        // (threshold<=0) do NO read and are never locked; an attested read
        // failure counts as 0 UOS (fail-closed, like balance-gate.ts), so the
        // badge agrees with what a real send would do.
        let heldUos = 0;
        let locked = false;
        if (identity && deps.thresholdUos > 0) {
            try {
                heldUos = await deps.readUosBalance(identity.account, endpoint);
            } catch {
                heldUos = 0;
            }
            locked = heldUos < deps.thresholdUos;
        }

        const spentToday = deps.store.getSpentMicroUsd(key, dayUtc);
        const sessionSpent = sessionId ? deps.store.getSessionMicroUsd(sessionId) : 0;

        return c.json(
            {
                spentTodayUsd: spentToday / MICRO,
                dailyCapUsd: capMicro / MICRO,
                stakedUos,
                uosPriceUsd,
                sessionSpentUsd: sessionSpent / MICRO,
                nextTier: nextTier(deps.config, uosPriceUsd),
                heldUos,
                thresholdUos: deps.thresholdUos,
                locked,
            },
            200
        );
    });

    return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix backend test -- ai-quota`
Expected: PASS (8 cases).

- [ ] **Step 5: Prettier + commit**

```bash
npx prettier --write backend/src/routes/ai-quota.ts backend/test/routes/ai-quota.test.ts
npm --prefix backend test -- ai-quota   # re-confirm green after formatting
git add backend/src/routes/ai-quota.ts backend/test/routes/ai-quota.test.ts
git commit -m "$(printf 'feat(ai): ai-quota route reports unlock state (heldUos/thresholdUos/locked)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 2: Backend — wire the shared balance reader into the route

**Files:**
- Modify: `backend/src/middleware/balance-gate.ts` (export `makeDefaultReader`)
- Modify: `backend/src/index.ts`
- Test: `backend/test/quota-wiring.test.ts`

Context: `index.ts` builds a lean `quotaDeps` (used by `quotaGate`, which needs no balance data) BEFORE `catalog` is loaded. The route needs a balance reader, which needs `catalog`. So we build one shared `readUosBalance` after `catalog` loads, pass it to BOTH the balance gate and the route, and spread it + `thresholdUos` into the route deps at mount time. No reordering of the existing `quotaDeps`.

- [ ] **Step 1: Export `makeDefaultReader` from `balance-gate.ts`**

In `backend/src/middleware/balance-gate.ts`, change the function declaration (currently `function makeDefaultReader(`) to add `export`:

```ts
export function makeDefaultReader(
    catalog: CatalogIndex,
    allowlist: readonly string[],
    fetchImpl?: typeof globalThis.fetch
): (account: string, endpoint: string) => Promise<number> {
```

(Body unchanged.)

- [ ] **Step 2: Write the failing wiring test**

Replace the entire contents of `backend/test/quota-wiring.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { createApp, type AppConfig } from '../src/index.js';
import type { ChatProvider } from '../src/llm/provider.js';

// Minimal mock provider: /api/ai-quota never calls the provider, so an empty
// cast satisfies the dependency without behavior.
function mockProvider(): ChatProvider {
    return { modelTag: () => 'anthropic:haiku-4-5' } as unknown as ChatProvider;
}

const CFG: AppConfig = {
    allowedOrigins: ['http://localhost:5172'],
    devRatelimitBypass: true,
    llmProvider: 'anthropic',
    allowedChainHosts: ['127.0.0.1', 'localhost', '*.ultra.io'],
    balanceThresholdUos: 2, // gate enabled; anon is never locked regardless
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (res: Response): Promise<any> => res.json();

describe('quota wiring', () => {
    it('mounts GET /api/ai-quota and returns quota + unlock fields for an anon caller', async () => {
        const app = await createApp(CFG, {
            provider: mockProvider(),
            readStakedUos: async () => 0,
            readUosPrice: async () => 0.02,
            readUosBalance: async () => 0,
        });
        const res = await app.request('/api/ai-quota?sessionId=s1');
        expect(res.status).toBe(200);
        const b = await json(res);
        expect(b.dailyCapUsd).toBe(0.01); // free floor for anon
        // Unlock fields present; anon is never locked and triggers no balance read.
        expect(b.thresholdUos).toBe(2);
        expect(b.heldUos).toBe(0);
        expect(b.locked).toBe(false);
    });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix backend test -- quota-wiring`
Expected: FAIL — the response has no `thresholdUos`/`heldUos`/`locked` (route deps don't yet receive them).

- [ ] **Step 4: Wire `index.ts`**

(a) Extend the balance-gate import to also pull in `makeDefaultReader`. Find the existing import of `balanceGate` (e.g. `import { balanceGate } from './middleware/balance-gate.js';`) and change it to:

```ts
import { balanceGate, makeDefaultReader } from './middleware/balance-gate.js';
```

(b) Immediately AFTER the provider model-tag warning block (the `if (!isKnownModelTag(tag)) { ... }` block) and BEFORE the `if (!cfg.attestationChainId)` block, add:

```ts
    // One liquid-UOS reader shared by the W9 balance gate and the /api/ai-quota
    // unlock view, so both report the same held balance (single source of truth).
    const readUosBalance = deps.readUosBalance ?? makeDefaultReader(catalog, cfg.allowedChainHosts);
    const thresholdUos = cfg.balanceThresholdUos ?? 1.0;
```

(c) In the `balanceGate({ ... })` mount, replace the line `readUosBalance: deps.readUosBalance,` with the shared reader and use the shared threshold:

```ts
    app.use(
        '/api/ai-chat',
        balanceGate({
            thresholdUos,
            catalog,
            allowlist: cfg.allowedChainHosts,
            readUosBalance,
        })
    );
```

(d) In the `createAiQuotaRouter(...)` mount at the bottom, spread the lean `quotaDeps` and add the unlock deps:

```ts
    app.route('/api/ai-quota', createAiQuotaRouter({ ...quotaDeps, readUosBalance, thresholdUos }));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix backend test -- quota-wiring`
Expected: PASS.

- [ ] **Step 6: Prettier + full suite + typecheck + commit**

```bash
npx prettier --write backend/src/middleware/balance-gate.ts backend/src/index.ts backend/test/quota-wiring.test.ts
npm --prefix backend test
npm --prefix backend run typecheck
```
Expected: full suite green (446 tests now: +5 route cases from Task 1, wiring test count unchanged), typecheck clean.

```bash
git add backend/src/middleware/balance-gate.ts backend/src/index.ts backend/test/quota-wiring.test.ts
git commit -m "$(printf 'feat(ai): share UOS balance reader with ai-quota route; expose threshold/locked (wiring)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 3: Frontend — extend `QuotaView` + `fetchQuota`

**Files:**
- Modify: `src/utilities/aiClient.ts`

No unit test (the FE has no vitest for `src/`; covered by `npm run build` typecheck and the Task 5 preview). The contract is exercised by Task 4.

- [ ] **Step 1: Extend the `QuotaView` type**

In `src/utilities/aiClient.ts`, replace the `QuotaView` type definition with (adds the three unlock fields at the end):

```ts
export type QuotaView = {
    spentTodayUsd: number;
    dailyCapUsd: number;
    stakedUos: number;
    uosPriceUsd: number;
    sessionSpentUsd: number;
    nextTier: { stakeUosForMax: number | null; maxDailyUsd: number };
    // Unlock view (W9 balance gate, docs/00 §3.7).
    heldUos: number;
    thresholdUos: number;
    locked: boolean;
};
```

- [ ] **Step 2: Extend the `fetchQuota` coercion**

In `src/utilities/aiClient.ts`, inside `fetchQuota`, the returned object currently ends with the `nextTier` block. Add the three coerced fields after `nextTier`:

```ts
    return {
        spentTodayUsd: Number(body.spentTodayUsd) || 0,
        dailyCapUsd: Number(body.dailyCapUsd) || 0,
        stakedUos: Number(body.stakedUos) || 0,
        uosPriceUsd: Number(body.uosPriceUsd) || 0,
        sessionSpentUsd: Number(body.sessionSpentUsd) || 0,
        nextTier: {
            stakeUosForMax: body.nextTier?.stakeUosForMax == null ? null : Number(body.nextTier.stakeUosForMax),
            maxDailyUsd: Number(body.nextTier?.maxDailyUsd) || 0,
        },
        heldUos: Number(body.heldUos) || 0,
        thresholdUos: Number(body.thresholdUos) || 0,
        locked: Boolean(body.locked),
    };
```

- [ ] **Step 3: Typecheck**

Run: `npm run build`
Expected: vue-tsc + vite build green.

- [ ] **Step 4: Commit**

```bash
git add src/utilities/aiClient.ts
git commit -m "$(printf 'feat(ai): FE QuotaView carries unlock state (heldUos/thresholdUos/locked)\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Task 4: Frontend — three-state drawer

**Files:**
- Modify: `src/components/ai/ChatDrawer.vue`

Render by state: anonymous (sign-in CTA + teaser), logged-in+locked (unlock panel replaces the input), logged-in+unlocked (input + under-input budget line). `quota` is already destructured from `useAiChat` and fetched on open — no composable change needed.

- [ ] **Step 1: Replace the footer block**

In `src/components/ai/ChatDrawer.vue`, replace the entire `<footer>…</footer>` element (the block starting `<footer class="border-t border-neutral-700 p-3 bg-neutral-800">` and ending at its closing `</footer>`) with:

```html
                    <!-- Footer -->
                    <footer class="border-t border-neutral-700 p-3 bg-neutral-800">
                        <!-- Unauthenticated CTA (guidelines §3.1) -->
                        <div
                            v-if="!loggedIn"
                            class="flex flex-col items-center gap-2 py-2 text-center"
                            data-testid="ai-chat-signin-cta"
                        >
                            <div class="text-xs text-neutral-400">Sign in with your wallet to use AI.</div>
                            <button
                                class="px-3 py-1.5 rounded bg-purple-600 hover:bg-purple-500 text-white text-sm"
                                @click="onSignInClick"
                                data-testid="ai-chat-signin"
                            >
                                Sign in
                            </button>
                            <div class="text-[10px] text-neutral-500">
                                Sign in and stake UOS to raise your daily AI budget.
                            </div>
                        </div>

                        <!-- Logged in but below the unlock threshold (W9 balance gate) -->
                        <div
                            v-else-if="quota?.locked"
                            class="flex flex-col items-center gap-1 py-2 text-center"
                            data-testid="ai-chat-locked"
                        >
                            <Icon icon="fa-lock" class="text-amber-300" />
                            <div class="text-xs text-neutral-300">
                                AI needs ≥ {{ formatUos(quota.thresholdUos) }} UOS to unlock.
                            </div>
                            <div class="text-[10px] text-neutral-500">
                                Your account holds {{ formatUos(quota.heldUos) }} UOS.
                            </div>
                        </div>

                        <!-- Logged in + unlocked (or quota not yet known) -->
                        <template v-else>
                            <div v-if="inlineError" class="mb-2 text-xs text-red-400" data-testid="ai-inline-error">
                                {{ inlineError }}
                            </div>
                            <div class="flex gap-2 items-end">
                                <textarea
                                    v-model="draft"
                                    rows="2"
                                    placeholder="Describe the transaction…"
                                    class="flex-grow resize-none bg-neutral-950 rounded border border-neutral-700 px-2 py-1.5 text-sm text-neutral-200 focus:outline-none focus:border-purple-500"
                                    @keydown="onKeydown"
                                    data-testid="ai-chat-input"
                                />
                                <button
                                    class="px-3 py-2 rounded bg-purple-600 hover:bg-purple-500 disabled:bg-neutral-700 text-white"
                                    :disabled="pending || !draft.trim()"
                                    @click="onSend"
                                    data-testid="ai-chat-send"
                                >
                                    <Icon icon="fa-paper-plane" />
                                </button>
                            </div>
                            <!-- Usage under the chat (Claude-style). Budget line only when quota is known. -->
                            <div class="flex items-center justify-between gap-2 text-[10px] text-neutral-500 mt-1">
                                <span v-if="quota" data-testid="ai-quota-budget">
                                    Daily AI budget: ${{ formatUsd4(quota.spentTodayUsd) }} /
                                    ${{ formatUsd2(quota.dailyCapUsd) }}
                                    <span class="text-neutral-600">· {{ raiseHint }}</span>
                                </span>
                                <span class="whitespace-nowrap">
                                    Cmd/Ctrl+Enter to send · {{ remaining }}/{{ MAX_MESSAGE_CHARS }}
                                </span>
                            </div>
                        </template>
                    </footer>
```

- [ ] **Step 2: Add the formatting helpers + `raiseHint` to the script**

In `src/components/ai/ChatDrawer.vue`, in the `<script setup>` block, after the line `const remaining = computed(() => draft.value.length);`, add:

```ts
// Display helpers for the quota/unlock footer.
function formatUos(v: number): string {
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
}
function formatUsd4(v: number): string {
    return Number(v).toFixed(4);
}
function formatUsd2(v: number): string {
    return Number(v).toFixed(2);
}
// Text-only "stake to raise" hint — never composes a stake transaction
// (eosio.system is not in the catalog; see spec §7).
const raiseHint = computed(() => {
    const n = quota.value?.nextTier.stakeUosForMax;
    const max = quota.value?.nextTier.maxDailyUsd ?? 0;
    return n == null
        ? 'stake UOS to raise'
        : `stake ~${n.toLocaleString()} UOS for the $${max.toFixed(2)}/day max`;
});
```

(`quota` is already in scope from the `useAiChat` destructure; `computed` is already imported.)

- [ ] **Step 3: Confirm `fa-lock` icon is registered**

`fa-lock` is NOT currently registered (confirmed). `src/icons.ts` imports the whole solid set as a namespace (`import * as solid from '@fortawesome/free-solid-svg-icons';`) and registers icons by adding `solid.faXxx` entries to the `library.add(...)` call. Add `faLock` the same way: insert a line `    solid.faLock,` into the `library.add(...)` solid block (near the other `solid.fa*` entries — e.g. after `solid.faCoins,`). Do not switch to individual named imports — match the existing `solid.faX` pattern. (`solid.faBan` and `solid.faCoins`, used elsewhere in the AI drawer, are already registered this way.)

- [ ] **Step 4: Typecheck/build**

Run: `npm run build`
Expected: vue-tsc + vite build green.

- [ ] **Step 5: Update the smoke-test mock to carry the new fields**

In `tests/ai-chat-smoke.spec.ts`, find the `/api/ai-quota` route mock and update its JSON body to include the three fields (keeps the mock representative; `locked:false` so the smoke flow is unaffected):

```ts
            body: JSON.stringify({
                spentTodayUsd: 0,
                dailyCapUsd: 0.01,
                stakedUos: 0,
                uosPriceUsd: 0.004,
                sessionSpentUsd: 0,
                nextTier: { stakeUosForMax: 12500, maxDailyUsd: 1.0 },
                heldUos: 0,
                thresholdUos: 0,
                locked: false,
            }),
```

- [ ] **Step 6: Run the smoke test**

Run: `npx playwright test ai-chat-smoke --reporter=line`
Expected: PASS. (Playwright auto-starts the dev server per config. If it fails for environment reasons unrelated to this change, capture the output and report rather than forcing it.)

- [ ] **Step 7: Format + commit**

```bash
npm run format   # FE is covered by the format script; commits src/ formatting
git add src/components/ai/ChatDrawer.vue src/icons.ts tests/ai-chat-smoke.spec.ts
git commit -m "$(printf 'feat(ai): proactive quota budget line + UOS unlock panel in chat drawer\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

> Note: `npm run format` runs `prettier --check && --write && git add -A ./src`. Per project tooling notes the `--check` may fail on pre-existing drift and short-circuit the script; if so, run `npx prettier --write src/components/ai/ChatDrawer.vue src/icons.ts` and `npx prettier --write tests/ai-chat-smoke.spec.ts` directly, then `git add` only the three files above. Do NOT reformat unrelated drifted files into this commit.

---

## Task 5: Docs note + final verification + simplifier

**Files:**
- Modify: `docs/00-ai-global-guidelines.md`

- [ ] **Step 1: Add a sentence to §3.8**

In `docs/00-ai-global-guidelines.md`, in the §3.8 block, find the line that begins `- **Single instance.**` and insert this bullet immediately before it:

```markdown
- **Quota view.** `GET /api/ai-quota` returns the caller's `spentTodayUsd` /
  `dailyCapUsd` / `stakedUos` / `nextTier` AND the §3.7 unlock state
  (`heldUos`, `thresholdUos`, `locked`) so the FE can show the daily budget and
  the minimum UOS to unlock proactively, without a blocked send.
```

- [ ] **Step 2: Commit the doc**

```bash
git add docs/00-ai-global-guidelines.md
git commit -m "$(printf 'docs(ai): note ai-quota unlock fields in guidelines §3.8\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

- [ ] **Step 3: Full verification**

Run: `npm --prefix backend test` → Expected: PASS.
Run: `npm --prefix backend run typecheck` → Expected: clean.
Run: `npm run build` → Expected: green.
Run: `bash scripts/ai-ci-greps.sh` → Expected: exit 0 (no new tool/secret; unaffected).

- [ ] **Step 4: Preview verification (the proof)**

Start the backend (`QUOTA_FREE_FLOOR_USD` left default) and the FE preview. Confirm the three states:
- **Anonymous:** drawer footer shows the sign-in CTA + the "Sign in and stake UOS…" teaser.
- **Logged-in + unlocked:** the under-input line shows `Daily AI budget: $x / $y · stake ~N UOS for the $Z/day max`. (To exercise without a real wallet, fake a session in the preview the way W10 was verified — `localStorage.authState` with a non-`ultra` type, e.g. `ledger` — and intercept `GET /api/ai-quota` with `locked:false` and a non-zero `dailyCapUsd`.)
- **Logged-in + locked:** intercept `GET /api/ai-quota` with `locked:true`, `heldUos < thresholdUos`; confirm the textarea is replaced by the unlock panel ("AI needs ≥ B UOS… holds A UOS") and `data-testid="ai-chat-locked"` is present while `ai-chat-input` is absent.

Capture a screenshot of the locked panel + the budget line as proof.

- [ ] **Step 5: Code-simplifier pass over the diff**

Dispatch the `code-simplifier` over this feature's changed source files (exclude tests/fixtures and the docs). Likely candidate: the formatting helpers in `ChatDrawer.vue` (keep them if they read clearly). Do NOT simplify the fail-closed branch in `ai-quota.ts` (load-bearing per spec §3.2) or the three-state `v-if` structure. Re-run `npm --prefix backend test` + `npm run build` after; revert any simplification that breaks a test. Commit if anything changed:

```bash
git add -A backend/src src/
git commit -m "$(printf 'refactor(ai): simplifier pass over quota/unlock discoverability\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>')"
```

---

## Self-review notes (author)

- **Spec coverage:** §3 BE contract → Tasks 1–2; §3.1 field semantics (anon/threshold≤0/fail-closed) → Task 1 tests + impl; §3.3 wiring/shared reader → Task 2; §3.4 refuse unchanged → no task (intentional); §4.1 anon teaser → Task 4; §4.2 locked panel + null-fallback (`quota?.locked` falsy when null → normal input) → Task 4; §4.3 under-input budget line + null-omit (`v-if="quota"`) → Task 4; §4.4 formatting/coercion → Tasks 3–4; §4.5 CostBadge unchanged → no task; §5 components → all tasks; §6 tests → Tasks 1/2 + Task 4 preview; §7 text-only staking → Task 4 `raiseHint` (no compose).
- **Type consistency:** `AiQuotaDeps` (`readUosBalance`, `thresholdUos`) used identically in route, tests, and the `index.ts` spread; `QuotaView` fields (`heldUos`/`thresholdUos`/`locked`) match between `aiClient.ts` and the BE response; `makeDefaultReader(catalog, allowlist, fetchImpl?)` signature matches its definition.
- **Fail-closed consistency:** BE read failure → `locked:true` (Task 1), but a whole-fetch failure on the FE (`quota === null`) → normal input shown (Task 4 `quota?.locked` falsy) — different layers, both per spec §4.2/§7 (FE never locks a user the server would allow; the server send is always authoritative).
