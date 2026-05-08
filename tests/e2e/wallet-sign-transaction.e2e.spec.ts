/**
 * End-to-end tests for the wallet's signTransaction flow:
 *
 * 1. **Default multi-action sign + respond** — dapp calls
 *    `window.ultra.signTransaction([action1, action2])` where the actions
 *    don't match the TransactionRegistry. The wallet routes to the default
 *    `DefaultTransactionViewComponent`. User clicks Confirm. The signed
 *    transaction is pushed via mocked `push_transaction`, and the response
 *    is delivered to the dapp's awaiting promise. REQUESTS storage drains.
 *
 * 2. **Token transfer specialised view** — single `eosio.token::transfer`
 *    action matches the registry; `KnownTransactionGuard` redirects the
 *    wallet to `/sign-transaction/:id/token-transfer/confirm`. Confirm,
 *    asserts the dapp's promise resolves with success.
 *
 * 3. **Decline → 4001** — Decline button rejects the request; the dapp's
 *    promise resolves with `status:'error', code:4001` and REQUESTS drains.
 *
 * 4. **Signing-as footer covers both unique authorizations** — multi-action
 *    transaction with two distinct signers; the wallet's
 *    `WalletTransactionFooterComponent` renders both `actor@permission`
 *    rows in the "Signing as" block.
 *
 * Approach:
 *   - Pre-seed an unlocked vault containing the keys + account records that
 *     `VaultTransactionService.resolvePrivateKeys` walks. Without account
 *     records the resolver finds zero keys → "No signing keys found".
 *   - Mock chain RPC: `get_info` (twice — once via buildTransaction, once
 *     via signTransaction), `get_accounts_by_authorizers`,
 *     `get_required_keys` (returns the seeded pubkey),
 *     `push_transaction` (returns a fake transaction_id + processed receipt).
 *     `allowPartialSignature: true` is the default in `VaultTransactionService`,
 *     so `get_required_keys` is actually skipped — we mock it anyway as a
 *     fallback in case other code paths probe it.
 *   - Open the dapp tab on `localhost:5172`, then open the wallet tab as a
 *     regular tab. The wallet's `RequestQueueService` watches REQUESTS in
 *     `chrome.storage.local` and naturally navigates to the active request
 *     route when the BG stores one. Because `RequestService.hasOpenExtensionView`
 *     detects an open extension TAB, no extra popup window is spawned —
 *     the wallet tab handles the request inline.
 *   - Capture the dapp's signTransaction promise via `page.evaluate(async ...)`.
 *
 * Prereqs:
 *   - extension built at /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 *     via `npx nx build browser-extension-wallet -c=production` in web-app.
 */

import { test, expect, chromium, BrowserContext, Page, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');
const TOOLKIT_URL = 'http://localhost:5172';
const TOOLKIT_ORIGIN = TOOLKIT_URL;

const PASSWORD = 'TestPass123!';

// Primary keypair — same as other e2e specs. Verified-derivable via
// @wharfkit/antelope: PrivateKey.from(PRIV_KEY_1).toPublic().toLegacyString() === PUB_KEY_1.
const PRIV_KEY_1 = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY_1 = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

// Secondary keypair for test 4 (two distinct signers). Generated locally;
// likewise verified-derivable.
const PRIV_KEY_2 = '5JkVU4yLdAyJ4Y6rEMFXX9sAH9KimKiSgNJ9VRby9hbntzwfUwp';
const PUB_KEY_2 = 'EOS7PW9v9Vs2eigSB4ZcZSmWWttwhoR5hM7nz2nDT6iavoUay7RLt';

const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

const ACCOUNT_1 = 'tnetacct.test';
const ACCOUNT_2 = '1aa2aa3aa4bl';

// Fake transaction id returned by the mocked push_transaction. 64 hex chars.
const FAKE_TX_ID = 'deadbeefcafe1234' + '0'.repeat(48);

interface AccountSeed {
  accountName: string;
  permission: string;
  publicKeys: string[];
}

interface VaultSeedKey {
  publicKey: string;
  privateKey: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function getServiceWorker(context: BrowserContext, timeoutMs = 10_000): Promise<Worker> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const workers = context.serviceWorkers();
    if (workers.length > 0) return workers[0];
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Extension service worker did not start within ${timeoutMs}ms`);
}

async function getExtensionId(sw: Worker): Promise<string> {
  return sw.evaluate(() => chrome.runtime.id);
}

/**
 * Build a real encrypted vault matching authenticator-lib's CryptoService
 * format and write it to chrome.storage. Pre-populates `vault.accounts` so
 * `VaultTransactionService.resolvePrivateKeys` finds the records it walks.
 *
 * Trust list is keyed per-env; both envs are pre-trusted so the
 * `TrustedAppGuard` on the sign-transaction route accepts our origin.
 */
async function seedExtensionState(
  sw: Worker,
  cfg: {
    password: string;
    keys: VaultSeedKey[];
    accounts: AccountSeed[];
    env: 'testnet' | 'mainnet';
    origins: string[];
  },
): Promise<void> {
  await sw.evaluate(async (cfg) => {
    const simpleHash = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
      return Math.abs(h).toString(16).padStart(8, '0');
    };
    const VAULT_FILE = `${simpleHash('ultra-extension-wallet')}.json`;

    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ITERATIONS = 900_000;

    const baseKey = await crypto.subtle.importKey('raw', enc.encode(cfg.password), 'PBKDF2', false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );

    const keysMap: Record<string, { publicKey: string; privateKey: string; addedAt: number; source: string }> = {};
    for (const k of cfg.keys) {
      keysMap[k.publicKey] = {
        publicKey: k.publicKey,
        privateKey: k.privateKey,
        addedAt: Date.now(),
        source: 'import',
      };
    }
    const vaultPlaintext = {
      keys: keysMap,
      // VaultTransactionService.resolvePrivateKeys() walks `vault.accounts`
      // (account name + permission → publicKeys). Without these records it
      // returns an empty privateKeys array and signing throws "No signing
      // keys found in vault for this transaction".
      accounts: cfg.accounts.map((a) => ({
        accountName: a.accountName,
        permission: a.permission,
        publicKeys: a.publicKeys,
        addedVia: 'import',
      })),
    };

    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(vaultPlaintext))),
    );

    const toHex = (b: Uint8Array): string =>
      Array.from(b)
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');

    const encryptedVault = {
      salt: toHex(salt),
      iv: toHex(iv),
      ciphertext: toHex(ciphertext),
      iterations: ITERATIONS,
      publicKeys: cfg.keys.map((k) => k.publicKey),
    };

    const trustedApps: Record<string, string[]> = {};
    for (const env of ['testnet', 'mainnet']) {
      trustedApps[env] = [...cfg.origins];
    }
    await chrome.storage.local.set({
      [VAULT_FILE]: JSON.stringify(encryptedVault),
      ENVIRONMENT: cfg.env,
      TRUSTED_APPS: trustedApps,
      SELECTED_ACCOUNTS_BY_CHAIN: {},
    });

    // Pre-seed AccountCacheService entries for both envs so any
    // emitAccountChanged that fires during the test doesn't depend on a
    // live chain RPC. The cache shape matches NetworkCache.
    const now = Date.now();
    const cacheEntries = cfg.accounts.flatMap((a) =>
      a.publicKeys.map((pk) => ({ account: a.accountName, permission: a.permission, authorizing_key: pk })),
    );
    await chrome.storage.session.set({
      vault_session: cfg.password,
      account_resolution_cache: {
        mainnet: {
          entries: cacheEntries,
          timestamp: now,
          publicKeys: cfg.keys.map((k) => k.publicKey),
        },
        testnet: {
          entries: cacheEntries,
          timestamp: now,
          publicKeys: cfg.keys.map((k) => k.publicKey),
        },
      },
    });
  }, cfg);
}

/**
 * Mock all chain RPC the BG / wallet UI / signer touches:
 *   - get_info: twice per signAndSend (buildTransaction + signTransaction).
 *   - get_accounts_by_authorizers: BG emitAccountChanged + wallet UI.
 *   - get_required_keys: skipped when allowPartialSignature=true (the
 *     default), but mocked anyway in case a different code path probes it.
 *   - push_transaction: returns a fixed fake transaction_id + receipt.
 *   - catch-all `/v1/{chain,history,state}/`: any other probe.
 */
async function mockChainRPC(
  context: BrowserContext,
  opts: {
    publicKeysToAccounts: Record<string, { account: string; permission: string }>;
    requiredKeys?: string[];
  },
): Promise<void> {
  const isTestnetHost = (url: string) => /testnet|test\./.test(new URL(url).host);

  // Playwright matches routes in registration order, FIRST match wins (handler
  // chain is LIFO when fallback() is used; with fulfill() the registration
  // order is the chain order). Register the catch-all FIRST so the specific
  // handlers below override it.
  await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await context.route('**/v1/chain/get_info', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        server_version: '0',
        chain_id: isTestnetHost(route.request().url()) ? TESTNET_CHAIN : MAINNET_CHAIN,
        head_block_num: 1,
        last_irreversible_block_num: 1,
        last_irreversible_block_id: '0'.repeat(64),
        head_block_id: '0'.repeat(64),
        head_block_time: '2026-04-04T00:00:00.000',
        head_block_producer: 'eosio',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576000,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
        server_version_string: '0.0.0',
      }),
    });
  });

  await context.route('**/v1/chain/get_accounts_by_authorizers', async (route) => {
    let body: Record<string, unknown> = {};
    try {
      body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    } catch { /* not JSON */ }
    const requestedKeys: string[] = Array.isArray(body?.keys) ? (body.keys as string[]) : [];
    const accounts: Array<{ account_name: string; permission_name: string; authorizing_key: string }> = [];
    for (const pk of requestedKeys) {
      const match = opts.publicKeysToAccounts[pk];
      if (match) {
        accounts.push({ account_name: match.account, permission_name: match.permission, authorizing_key: pk });
      }
    }
    // If no specific keys requested or none matched, fall back to seeding
    // every known account — preserves behaviour for callers that don't
    // pass a keys filter.
    if (accounts.length === 0) {
      for (const [pk, ap] of Object.entries(opts.publicKeysToAccounts)) {
        accounts.push({ account_name: ap.account, permission_name: ap.permission, authorizing_key: pk });
      }
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accounts }),
    });
  });

  await context.route('**/v1/chain/get_required_keys', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ required_keys: opts.requiredKeys ?? Object.keys(opts.publicKeysToAccounts) }),
    });
  });

  // Wharfkit's `Action.from(act, abi)` requires a matching ABI struct for
  // each (contract, action) so it can encode `data`. Our test transactions
  // use:
  //   - `eosio::someaction` and `eosio::otheraction` (multi-action default
  //     view test) — empty struct, no fields. Both share the `eosio` ABI.
  //   - `eosio.token::transfer` — standard EOSIO transfer signature.
  // The mock provides minimal but valid ABI definitions for both.
  await context.route('**/v1/chain/get_abi', async (route) => {
    let body: Record<string, unknown> = {};
    try {
      body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
    } catch { /* not JSON */ }
    const accountName: string = (body?.account_name as string | undefined) || '';
    let abi: Record<string, unknown>;
    if (accountName === 'eosio.token') {
      abi = {
        version: 'eosio::abi/1.2',
        types: [],
        structs: [
          {
            name: 'transfer',
            base: '',
            fields: [
              { name: 'from', type: 'name' },
              { name: 'to', type: 'name' },
              { name: 'quantity', type: 'asset' },
              { name: 'memo', type: 'string' },
            ],
          },
        ],
        actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
        tables: [],
        ricardian_clauses: [],
        error_messages: [],
        abi_extensions: [],
      };
    } else {
      // Default ABI used for `eosio` (covers `someaction`, `otheraction`,
      // and any other no-arg action our tests dispatch). Both action types
      // map to an empty struct.
      abi = {
        version: 'eosio::abi/1.2',
        types: [],
        structs: [
          { name: 'someaction', base: '', fields: [] },
          { name: 'otheraction', base: '', fields: [] },
        ],
        actions: [
          { name: 'someaction', type: 'someaction', ricardian_contract: '' },
          { name: 'otheraction', type: 'otheraction', ricardian_contract: '' },
        ],
        tables: [],
        ricardian_clauses: [],
        error_messages: [],
        abi_extensions: [],
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ account_name: accountName, abi }),
    });
  });

  await context.route('**/v1/chain/push_transaction', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        transaction_id: FAKE_TX_ID,
        processed: {
          id: FAKE_TX_ID,
          block_num: 2,
          block_time: '2026-04-04T00:00:01.000',
          producer_block_id: null,
          receipt: { status: 'executed', cpu_usage_us: 0, net_usage_words: 0 },
          elapsed: 0,
          net_usage: 0,
          scheduled: false,
          action_traces: [],
          account_ram_delta: null,
          except: null,
          error_code: null,
        },
      }),
    });
  });

}

/**
 * Wait for `window.ultra` to be injected by the extension's content script.
 * The inject script runs at document_start in MAIN world, so this should
 * resolve almost immediately on a real load.
 */
async function waitForUltraInjected(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as { ultra?: unknown }).ultra === 'object' && (window as { ultra?: unknown }).ultra !== null,
    null,
    { timeout: timeoutMs },
  );
}

/**
 * Wait for the wallet tab to settle on a sign-transaction route.
 * RequestQueueService.requests$ observes REQUESTS storage; on a new request
 * the wallet auto-navigates to the active request route. We poll the URL
 * hash because Angular's hash-based routing is what's in effect here.
 */
async function waitForWalletOnSignRoute(walletPage: Page, options: { specialised?: string } = {}): Promise<string> {
  let lastUrl = '';
  await expect
    .poll(
      async () => {
        const hash = await walletPage.evaluate(() => window.location.hash);
        lastUrl = hash;
        if (!hash.includes('/sign-transaction/')) return false;
        if (options.specialised) {
          return hash.includes(options.specialised);
        }
        return true;
      },
      {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: () => `wallet never landed on sign-transaction route; last hash=${lastUrl}`,
      },
    )
    .toBe(true);
  return lastUrl;
}

/**
 * Kick off `window.ultra.signTransaction(...)` from the dapp page WITHOUT
 * awaiting — store the pending promise on `window.__signTxPromise` so we
 * can resolve it later (after the user-triggered Confirm/Decline). Awaiting
 * inline would block the test thread; the wallet UI must run first.
 */
async function dispatchSignTransaction(
  page: Page,
  transaction: unknown,
  options?: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ transaction, options }) => {
      interface SignTxResult {
        status: string;
        code?: number;
        data?: unknown;
        message?: string;
        error?: string;
      }
      interface DapWindow extends Window {
        __signTxPromise?: Promise<SignTxResult>;
        __signTxResult?: SignTxResult;
      }
      const w = window as DapWindow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ultra = (window as any).ultra;
      // The internal `window.ultra.signTransaction` returns an IResponse-shaped
      // result. We capture both success and error shapes uniformly.
      w.__signTxPromise = ultra
        .signTransaction(transaction, options)
        .then((r: { status: string; code?: number; data?: unknown; message?: string }) => {
          w.__signTxResult = r;
          return r;
        })
        .catch((e: unknown) => {
          // Errors from the BG often arrive as IResponse-shaped objects
          // (`{status:'error', code, message}`) thrown rather than rejected
          // by the Proxy. Preserve every field we see so the assertions can
          // distinguish between "promise rejected with an Error" and
          // "promise resolved with an error-status response".
          let result: SignTxResult;
          if (e && typeof e === 'object') {
            const obj = e as Record<string, unknown>;
            result = {
              status: typeof obj.status === 'string' ? obj.status : 'error',
              code: typeof obj.code === 'number' ? obj.code : undefined,
              data: obj.data,
              message: typeof obj.message === 'string' ? obj.message : undefined,
              error: e instanceof Error ? e.message : JSON.stringify(obj),
            };
          } else {
            result = { status: 'error', error: e instanceof Error ? e.message : String(e) };
          }
          w.__signTxResult = result;
          return result;
        });
    },
    { transaction, options },
  );
}

async function awaitSignTransactionResult(
  page: Page,
  timeoutMs = 30_000,
): Promise<{ status: string; code?: number; data?: unknown; message?: string; error?: string }> {
  return page.evaluate(async (timeoutMs) => {
    interface SignTxResult {
      status: string;
      code?: number;
      data?: unknown;
      message?: string;
      error?: string;
    }
    interface DapWindow extends Window {
      __signTxPromise?: Promise<SignTxResult>;
    }
    const w = window as DapWindow;
    if (!w.__signTxPromise) throw new Error('signTransaction was never dispatched');
    return await Promise.race([
      w.__signTxPromise,
      new Promise<SignTxResult>((_, reject) =>
        setTimeout(() => reject(new Error('signTransaction promise timeout')), timeoutMs),
      ),
    ]);
  }, timeoutMs);
}

/** Read REQUESTS array length from BG storage. */
async function readRequestsCount(sw: Worker): Promise<number> {
  return sw.evaluate(async () => {
    const r = await chrome.storage.local.get('REQUESTS');
    return Array.isArray(r?.REQUESTS) ? r.REQUESTS.length : 0;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe.configure({ timeout: 120_000 });

test.describe('Wallet signTransaction (real extension)', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Build it via "npx nx build browser-extension-wallet -c=production" in web-app.`,
      );
    }
  });

  test('Default view: multi-action transaction signs and posts response to dapp', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-sign-default-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);

      await seedExtensionState(sw, {
        password: PASSWORD,
        keys: [{ publicKey: PUB_KEY_1, privateKey: PRIV_KEY_1 }],
        accounts: [{ accountName: ACCOUNT_1, permission: 'active', publicKeys: [PUB_KEY_1] }],
        env: 'testnet',
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context, {
        publicKeysToAccounts: { [PUB_KEY_1]: { account: ACCOUNT_1, permission: 'active' } },
        requiredKeys: [PUB_KEY_1],
      });

      // 1. Open the dapp tab. The content script + inject script load
      //    automatically because localhost:5172 matches the manifest's
      //    content_scripts pattern.
      const dapp = await context.newPage();
      await dapp.goto(TOOLKIT_URL);
      await dapp.waitForLoadState('load');
      await waitForUltraInjected(dapp);

      // 2. Open the wallet UI as a regular tab (not a popup window). The
      //    `RequestService.openRequestPopupQueue` path will detect this
      //    via `hasOpenExtensionView` (TAB on extension URL) and surface
      //    the request inline, not in a new popup window.
      const wallet = await context.newPage();
      await wallet.goto(`chrome-extension://${extId}/index.html#/home`);
      await wallet.waitForLoadState('load');

      // 3. Dispatch a 2-action transaction with a contract+action that does
      //    NOT match the registry → falls through to DefaultTransactionViewComponent.
      const transaction = [
        {
          contract: 'eosio',
          action: 'someaction',
          data: {},
          authorizations: [`${ACCOUNT_1}@active`],
        },
        {
          contract: 'eosio',
          action: 'otheraction',
          data: {},
          authorizations: [`${ACCOUNT_1}@active`],
        },
      ];
      await dispatchSignTransaction(dapp, transaction);

      // 4. Wait for wallet to land on the sign-transaction route.
      await waitForWalletOnSignRoute(wallet);

      // 5. Click Confirm. The button text is "Confirm" on the
      //    WalletTransactionFooterComponent (or "Sign & Return to dApp" if
      //    signOnly is true — we didn't pass signOnly).
      await wallet.locator('button:has-text("Confirm")').click();

      // 6. Dapp's promise must resolve with success and the fake transaction id.
      const result = await awaitSignTransactionResult(dapp);
      expect(
        result.status,
        `expected status 'success'; got ${JSON.stringify(result)}`,
      ).toBe('success');
      const data = result.data as { transactionHash?: string; transaction_id?: string } | undefined;
      // The wallet's wallet-extension service forwards the signing service's
      // `{ transaction_id, processed }` shape into `notifyTransactionSuccess`,
      // which in turn writes `transactionHash: transaction_id` onto the
      // response. Match either shape so a future field rename doesn't break
      // the test for the wrong reason.
      const hashFound = data?.transactionHash === FAKE_TX_ID || data?.transaction_id === FAKE_TX_ID;
      expect(hashFound, `expected transaction id ${FAKE_TX_ID} in response data; got ${JSON.stringify(data)}`).toBe(
        true,
      );

      // 7. REQUESTS storage drained.
      await expect.poll(async () => readRequestsCount(sw), { timeout: 10_000, intervals: [200, 500] }).toBe(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Token transfer specialised view signs', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-sign-token-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);

      await seedExtensionState(sw, {
        password: PASSWORD,
        keys: [{ publicKey: PUB_KEY_1, privateKey: PRIV_KEY_1 }],
        accounts: [{ accountName: ACCOUNT_1, permission: 'active', publicKeys: [PUB_KEY_1] }],
        env: 'testnet',
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context, {
        publicKeysToAccounts: { [PUB_KEY_1]: { account: ACCOUNT_1, permission: 'active' } },
        requiredKeys: [PUB_KEY_1],
      });

      const dapp = await context.newPage();
      await dapp.goto(TOOLKIT_URL);
      await dapp.waitForLoadState('load');
      await waitForUltraInjected(dapp);

      const wallet = await context.newPage();
      await wallet.goto(`chrome-extension://${extId}/index.html#/home`);
      await wallet.waitForLoadState('load');

      // Single eosio.token::transfer action — matches the
      // TransactionRegistry → KnownTransactionGuard redirects the wallet
      // to /sign-transaction/:id/token-transfer/confirm.
      const transaction = [
        {
          contract: 'eosio.token',
          action: 'transfer',
          data: {
            from: ACCOUNT_1,
            to: ACCOUNT_2,
            quantity: '1.0000 UOS',
            memo: '',
          },
          authorizations: [`${ACCOUNT_1}@active`],
        },
      ];
      await dispatchSignTransaction(dapp, transaction);

      // Wait until the wallet's URL contains the specialised transfer route.
      // KnownTransactionGuard for eosio.token::transfer redirects from
      // `/sign-transaction/:id` to `/sign-transaction/:id/transfer`, which
      // maps to `TransferUosViewComponent`.
      await waitForWalletOnSignRoute(wallet, { specialised: '/transfer' });

      // Click Confirm. The TokenTransferConfirmComponent has its own footer
      // button labelled "Confirm" (same text as default-view footer).
      await wallet.locator('button:has-text("Confirm")').click();

      const result = await awaitSignTransactionResult(dapp);
      expect(
        result.status,
        `expected status 'success' on token-transfer specialised view; got ${JSON.stringify(result)}`,
      ).toBe('success');
      const data = result.data as { transactionHash?: string; transaction_id?: string } | undefined;
      expect(data?.transactionHash === FAKE_TX_ID || data?.transaction_id === FAKE_TX_ID).toBe(true);

      await expect.poll(async () => readRequestsCount(sw), { timeout: 10_000, intervals: [200, 500] }).toBe(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Decline rejects with USER_REJECTED_REQUEST (4001)', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-sign-decline-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);

      await seedExtensionState(sw, {
        password: PASSWORD,
        keys: [{ publicKey: PUB_KEY_1, privateKey: PRIV_KEY_1 }],
        accounts: [{ accountName: ACCOUNT_1, permission: 'active', publicKeys: [PUB_KEY_1] }],
        env: 'testnet',
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context, {
        publicKeysToAccounts: { [PUB_KEY_1]: { account: ACCOUNT_1, permission: 'active' } },
        requiredKeys: [PUB_KEY_1],
      });

      const dapp = await context.newPage();
      await dapp.goto(TOOLKIT_URL);
      await dapp.waitForLoadState('load');
      await waitForUltraInjected(dapp);

      const wallet = await context.newPage();
      await wallet.goto(`chrome-extension://${extId}/index.html#/home`);
      await wallet.waitForLoadState('load');

      const transaction = [
        {
          contract: 'eosio',
          action: 'someaction',
          data: {},
          authorizations: [`${ACCOUNT_1}@active`],
        },
        {
          contract: 'eosio',
          action: 'otheraction',
          data: {},
          authorizations: [`${ACCOUNT_1}@active`],
        },
      ];
      await dispatchSignTransaction(dapp, transaction);
      await waitForWalletOnSignRoute(wallet);

      // Click Decline. Both default-view and specialised footers expose
      // "Decline" — text is unique enough.
      await wallet.locator('button:has-text("Decline")').click();

      const result = await awaitSignTransactionResult(dapp);
      // Wire format: dapp's window.ultra promise resolves with
      // {status:'error', code:4001} when rejected. The `IResponse` enum
      // uses lowercase string values ('success'/'fail'/'error') and the
      // ExtensionErrorCode enum has USER_REJECTED_REQUEST = 4001.
      expect(
        result.status,
        `expected status 'error' on decline; got ${JSON.stringify(result)}`,
      ).toBe('error');
      expect(
        result.code,
        `expected code 4001 (USER_REJECTED_REQUEST) on decline; got ${JSON.stringify(result)}`,
      ).toBe(4001);

      await expect.poll(async () => readRequestsCount(sw), { timeout: 10_000, intervals: [200, 500] }).toBe(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Signing-as footer covers all unique authorizations', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-sign-multi-auth-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);

      // Seed BOTH keys + matching account records so VaultTransactionService
      // can resolve private keys for both signers, and so the resolvedAuths
      // logic in TransactionAppService.signTransactionHandler can mark both
      // as 'available' (driving the ✓ badge in the Signing-as block).
      await seedExtensionState(sw, {
        password: PASSWORD,
        keys: [
          { publicKey: PUB_KEY_1, privateKey: PRIV_KEY_1 },
          { publicKey: PUB_KEY_2, privateKey: PRIV_KEY_2 },
        ],
        accounts: [
          { accountName: ACCOUNT_1, permission: 'active', publicKeys: [PUB_KEY_1] },
          { accountName: ACCOUNT_2, permission: 'active', publicKeys: [PUB_KEY_2] },
        ],
        env: 'testnet',
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context, {
        publicKeysToAccounts: {
          [PUB_KEY_1]: { account: ACCOUNT_1, permission: 'active' },
          [PUB_KEY_2]: { account: ACCOUNT_2, permission: 'active' },
        },
        requiredKeys: [PUB_KEY_1, PUB_KEY_2],
      });

      const dapp = await context.newPage();
      await dapp.goto(TOOLKIT_URL);
      await dapp.waitForLoadState('load');
      await waitForUltraInjected(dapp);

      const wallet = await context.newPage();
      await wallet.goto(`chrome-extension://${extId}/index.html#/home`);
      await wallet.waitForLoadState('load');

      // Two-action transaction with TWO distinct signers. Same contract/
      // action both times so it stays multi-action (>1 → default view, no
      // registry match).
      const transaction = [
        {
          contract: 'eosio',
          action: 'someaction',
          data: {},
          authorizations: [`${ACCOUNT_1}@active`],
        },
        {
          contract: 'eosio',
          action: 'otheraction',
          data: {},
          authorizations: [`${ACCOUNT_2}@active`],
        },
      ];
      await dispatchSignTransaction(dapp, transaction);
      await waitForWalletOnSignRoute(wallet);

      // Wait for the body to render — the WalletTransactionFooterComponent
      // is rendered via @if (transaction$ | async). The footer's "Signing as"
      // block is only emitted when authorizations.length > 0 (which we
      // guaranteed above). Poll the footer DOM for both auth strings.
      await expect
        .poll(
          async () => {
            return wallet.evaluate(() => {
              const footer = document.querySelector('ultra-wallet-transaction-footer');
              if (!footer) return { hasFooter: false, text: '' };
              return { hasFooter: true, text: (footer.textContent ?? '').replace(/\s+/g, ' ').trim() };
            });
          },
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: 'wallet-transaction-footer never rendered',
          },
        )
        .toMatchObject({ hasFooter: true });

      const footerText = await wallet.evaluate(() => {
        const footer = document.querySelector('ultra-wallet-transaction-footer');
        return (footer?.textContent ?? '').replace(/\s+/g, ' ').trim();
      });
      expect(
        footerText,
        `footer should contain 'Signing as' header; got: ${JSON.stringify(footerText)}`,
      ).toMatch(/Signing as/i);
      expect(footerText, `footer missing ${ACCOUNT_1}@active row: ${footerText}`).toContain(`${ACCOUNT_1}@active`);
      expect(footerText, `footer missing ${ACCOUNT_2}@active row: ${footerText}`).toContain(`${ACCOUNT_2}@active`);

      // We don't click Confirm here — the assertion under test is the
      // pre-sign footer rendering. Cancel via Decline so the dapp's
      // pending promise resolves cleanly and the test exits without an
      // orphan unresolved promise warning.
      await wallet.locator('button:has-text("Decline")').click();
      await awaitSignTransactionResult(dapp);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
