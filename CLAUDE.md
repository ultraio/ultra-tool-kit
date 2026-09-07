# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Ultra Tool Kit is a Vue 3 + Vite single-page app for interacting with the Ultra (EOSIO-based) blockchain from the browser. It supports Ultra Wallet, Ledger, and Anchor wallets; lets users build/sign/execute arbitrary contract transactions; manages multisig proposals; queries the Ultra NFT API; and validates Uniq/Factory metadata schemas.

## Commands

- `npm run dev` — Vite dev server on port **5172** (configured in `vite.config.ts`). The `-- --dev` arg enables `@vitejs/plugin-basic-ssl`.
- `npm run build` — `vue-tsc` typecheck, then `vite build`.
- `npm run buildonly` — `vue-tsc` + `vite build -- --pages`. The `--pages` flag sets `base: '/ultra-tool-kit'` for GitHub Pages deploys.
- `npm run format` — Prettier check + write over `./src`, then `git add -A ./src`. Also runs via Husky `pre-commit`.
- `npx playwright test` — Run the Playwright suite in `tests/` (baseURL `http://localhost:5172`; `webServer` auto-starts `npm run dev -- --host`). Single test: `npx playwright test tests/wallet-integration.spec.ts -g "pattern"`.

## Architecture

### Entry & global component registry
`src/main.ts` mounts `App.vue` and **globally registers** every shared component (widgets, `Login`, `UserOverlay`, `Transaction`, `AbiRender`, `Navigation`, help components, `EasyDataTable`, `Icon`). Any new reusable component must be added here before it can be used in templates without imports. Monaco editor is installed as a Vue plugin pointing at a jsdelivr CDN.

### Routing
Uses **`unplugin-vue-router`** (file-based routing). Pages under `src/pages/<name>/index.vue` become routes automatically; generated types live in `typed-router.d.ts` (do not hand-edit). The router is created in `src/router.ts` via `vue-router/auto`.

### Central state flow (`App.vue`)
`App.vue` owns the global `authState` (account, permission, endpoint, environment, wallet type, chainId), `pageState` (which modal is visible), and `runtimeMetadata`. It passes these via props to `router-view` and listens for child signals:
- `@transact` → opens the global `<Transaction>` modal with the requested actions.
- `@set-endpoint` / `@set-page-state` → mutate central state.
- Two `key` refs (`keyRouterUpdate`, `keyUserUpdate`) are manually incremented to force re-renders of the router-view and `UserOverlay` after state changes that don't otherwise propagate.

**Session persistence** is via `localStorage` keys `authState`, `endpoint`, `environment`, restored on mount by `restoreSession()`.

### Wallet abstraction (`src/wallets/`)
- `ultra.ts` wraps `@ultraos/wallet-sdk` for the browser extension. Exposes `connect`, `disconnect`, `isAvailable`, `getChainId`, `getAccounts`, `getSelectedAccount`, `getAvailableAuthorizations`, `switchNetwork`, `signTransaction`, `extractAccountInfo`, `resolveSelectedAccount`, and an **event emitter** (`on`/`off`) for `accountChanged`, `networkChanged`, `disconnect`. The event-listener block (around lines 150–256) is a **load-bearing workaround** for two SDK bugs (callbacks aren't auto-registered with the extension; the message format the SDK expects doesn't match what the extension sends) — don't remove it without a corresponding SDK fix.
- `ultra-web.ts` wraps `@ultraos/wallet-sdk` for the web (popup) wallet. Per-environment SDK instance, no event listeners, no `switchNetwork` (env is fixed at SDK construction).
- `anchor.ts` wraps `@wharfkit/session` with the Anchor plugin and `@wharfkit/web-renderer`.
- `wallet-accounts.ts` is a **shared reactive store** of the wallet's accounts (populated via `populateWalletAccountsFromConnectResult` after each `connect()`). Exposes `useWalletAccounts()` returning `accounts`, `selectedAccountName`, `authOptions`, `validAccountNames`, and `validatedAccounts`. Used by `UserOverlay`, `AuthorizerForm`, `SignatureForm`, and `ActionFormPrimitive` to render account pickers consistently. `validateAccountsAgainstEndpoint(endpoint)` POSTs `/v1/chain/get_account` per account to drop accounts that don't exist on the active chain (the wallet returns mainnet + testnet accounts together); cached per-endpoint and reset by `clearWalletAccounts()` on logout/endpoint change.
- `resolveSelectedAccount(connectResult)` (in `ultra.ts`) picks the authoritative active account using a four-step fallback: live `getSelectedAccount()` → `connectResult.selectedAccount` → first entry from `getAvailableAuthorizations()` → legacy `blockchainid`. Use this — not raw `extractAccountInfo` — anywhere a connect response needs to become the toolkit's active account.
- Ledger signing uses `@ultraos/ultra-ledger-lib` and is handled inside the `Transaction` component.

### Bidirectional wallet ↔ toolkit network sync
`App.vue` implements two-way sync between the Ultra Wallet extension's chain and the toolkit's selected endpoint. The `isNetworkSyncing` flag (module-local to `App.vue`) prevents circular loops — set it before initiating a switch, clear it in `finally`. When handling events from the wallet, bail out early if `isNetworkSyncing` is true (it means we initiated the change). When the toolkit user changes endpoint, `setEndpoint(..., userInvoked=true)` fetches `/v1/chain/get_info`, compares chainIds, and calls `Ultra.switchNetwork()`.

### Silent reconnect & session restore
On mount, `restoreSession()` reads `authState` from `localStorage` and calls `Ultra.connect(true)` (i.e. `onlyIfTrusted: true`) to revive the prior session without a popup. The wallet can return `status: 'success'` with empty data when no real session exists for this origin, so `restoreSession` checks `selectedAccount`, `accounts`, and `getAvailableAuthorizations()` before trusting the cached `authState`; if all three are empty it clears `localStorage.authState`. The `accountChanged` handler doesn't trust the event payload shape (different extension versions wrap the account differently) — it always re-queries `Ultra.getSelectedAccount()` for the live value.

### Eventing
`src/eventBus.ts` exports a `mitt()` emitter (`emitter`). Current channels: `updateAppActions` (children can push new actions into the pending transaction modal). Prefer props/emits for parent-child flow; use the bus only for cross-tree broadcasts.

### Blockchain & API services
- `src/utilities/blockchain.ts` — `BlockchainService` singleton initialized from `authState` in `initServices()`. Wraps `@ultraos/ultra-api-lib` / `@ultraos/ultra-signer-lib` for RPC calls.
- `src/utilities/nftapi/` — Ultra NFT API client (`api.ts`) + credentials + JSON schemas for Uniq/Factory metadata validation (used by the `schemaValidator` page with `ajv`).
- `src/utilities/networks.ts` — Default network list (Mainnet/Testnet/Diablo/Preprod/Dev/QA/Local), `chainId` map, `getNetworkByChainId`, explorer URLs, and `fetchWithTimeout`.
- `src/utilities/abi.ts` + `abiRender.ts` — ABI parsing/rendering helpers used by the generic `AbiRender` component (drives the contract `builder` page).

### Polyfills / build quirks
`vite.config.ts` uses `vite-plugin-node-polyfills` (protocolImports enabled) and aliases `vue` to `vue/dist/vue.esm-bundler.js` so runtime templates (`vue3-runtime-template`) work. `optimizeDeps.esbuildOptions.define.global = 'globalThis'` is required for the EOSIO libraries.

## Conventions

- **Tailwind only** for styling; config in `tailwind.config.js`. The dark theme uses `bg-neutral-800/900` throughout.
- **Prettier**: 4-space tabs, 120 print width, single quotes, `es5` trailing commas (config in `package.json`). Enforced on commit.
- **Icons**: FontAwesome. Add new icons to the `library.add(...)` call in `src/icons.ts` before using them.
- **Component placement**:
  - `src/components/` — page-level components (`Login`, `Navigation`, `Transaction`, etc.).
  - `src/components/widgets/` — reusable primitives; these are globally registered.
  - `src/pages/<feature>/index.vue` — one directory per page/route.
- **Parent↔child data flow**: props down, `emits`/signals up. To force a re-render after internal mutation, increment a `key` ref on the bound component (existing pattern — see `keyUserUpdate`/`keyRouterUpdate`).
- **Elevated accounts**: `I.ELEVATED_ACCOUNTS` (in `src/interfaces/index.ts`) gates admin-only UI via `authState.isAdmin`.
- **Wallet account pickers**: any UI that lists accounts the user can act as (UserOverlay switcher, AuthorizerForm, SignatureForm, ActionFormPrimitive name-field shortcut) reads `validatedAccounts` from `wallet-accounts.ts`. Display account name only (no `@permission` suffix); the store deduplicates by accountName and filters out accounts that don't exist on the current endpoint, so each picker shows the same network-correct list. New pickers should follow this pattern instead of pulling from `accounts` or `authOptions` directly.


### Extension connect shortcut

The extension utility link adds `?connect=extension`. On initial load the dapp consumes this flag, waits up to 3 seconds for extension injection, and starts the existing Ultra extension connection flow once. Ordinary visits retain their existing login/reconnect behavior; cancellation does not retry. Unlock and connection approval remain wallet-controlled.
