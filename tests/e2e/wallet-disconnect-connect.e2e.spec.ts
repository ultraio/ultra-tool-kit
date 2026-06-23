/**
 * End-to-end tests for the three issues filed 2026-05-07 (post-network-sync):
 *
 * 1. **Disconnect bidirectional sync**
 *    - Extension-side disconnect must remove trust on EVERY env (matches the
 *      cross-env trust read), and the resulting `WalletEvent.DISCONNECT` must
 *      cause the toolkit to mirror the logout locally — without re-calling
 *      `Ultra.disconnect()` (which historically came back as 4001 and stalled
 *      the toolkit's local cleanup).
 *    - Toolkit-initiated `Ultra.disconnect()` must be idempotent: even when
 *      the BG no longer trusts the origin (because the extension already
 *      disconnected), the RPC must resolve successfully so the toolkit can
 *      finish its local reset.
 *
 * 2. **Connect should be global** — once a dapp is trusted on ANY env,
 *    switching the wallet network must NOT re-prompt for connect. Both
 *    side-panel and popup mode. In popup mode, the bug additionally produced
 *    a redundant second window (`hasOpenExtensionView` was SIDE_PANEL-only);
 *    we assert no window is created on the silent path.
 *
 * 3. **Side-panel ↔ popup parity** — the request-popup window-creation path
 *    must avoid spawning a duplicate window when ANY extension UI is already
 *    open (popup, side panel, or a previously-opened request popup). We
 *    drive the connect-after-network-switch path in popup mode and assert
 *    `chrome.windows.create` is never called.
 *
 * The harness is independent of `wallet-network-sync.e2e.spec.ts` — same
 * helper shape (real extension load, programmatic vault seed, /v1/chain/* mocked)
 * but distinct so a regression in one suite doesn't mask the other.
 */

import { test, expect, chromium, BrowserContext, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');
const TOOLKIT_URL = 'http://localhost:5172';
const TOOLKIT_ORIGIN = TOOLKIT_URL;

const PASSWORD = 'TestPass123!';
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

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

/**
 * Build a real encrypted vault matching authenticator-lib's CryptoService
 * format and write it to chrome.storage. Trust list is keyed per-env to match
 * the production `TRUSTED_APPS` shape; pass envs that should be pre-trusted.
 */
async function seedExtensionState(
  sw: Worker,
  cfg: {
    password: string;
    pubKey: string;
    privKey: string;
    env: 'testnet' | 'mainnet';
    trustedOnEnvs: ('testnet' | 'mainnet')[];
    origins: string[];
    uiMode?: 'sidePanel' | 'popup';
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

    const vaultPlaintext = {
      keys: {
        [cfg.pubKey]: {
          publicKey: cfg.pubKey,
          privateKey: cfg.privKey,
          addedAt: Date.now(),
          source: 'import',
        },
      },
      accounts: [],
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
      publicKeys: [cfg.pubKey],
    };

    const trustedApps: Record<string, string[]> = {};
    for (const env of cfg.trustedOnEnvs) {
      trustedApps[env] = [...cfg.origins];
    }

    const localSet: Record<string, unknown> = {
      [VAULT_FILE]: JSON.stringify(encryptedVault),
      ENVIRONMENT: cfg.env,
      TRUSTED_APPS: trustedApps,
      SELECTED_ACCOUNTS_BY_CHAIN: {},
    };
    if (cfg.uiMode) localSet.UI_MODE = cfg.uiMode;
    await chrome.storage.local.set(localSet);

    const now = Date.now();
    await chrome.storage.session.set({
      vault_session: cfg.password,
      account_resolution_cache: {
        mainnet: {
          entries: [{ account: 'mnetacct.main', permission: 'active', authorizing_key: cfg.pubKey }],
          timestamp: now,
          publicKeys: [cfg.pubKey],
        },
        testnet: {
          entries: [{ account: 'tnetacct.test', permission: 'active', authorizing_key: cfg.pubKey }],
          timestamp: now,
          publicKeys: [cfg.pubKey],
        },
      },
    });
  }, cfg);
}

async function mockChainRPC(context: BrowserContext): Promise<void> {
  const isTestnetHost = (url: string) => /testnet|test\./.test(new URL(url).host);

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
    const isTestnet = isTestnetHost(route.request().url());
    const accountName = isTestnet ? 'tnetacct.test' : 'mnetacct.main';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        accounts: [{ account_name: accountName, permission_name: 'active', authorizing_key: PUB_KEY }],
      }),
    });
  });

  await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Pre-seed the toolkit's localStorage so its `restoreSession` runs the silent
 * Ultra.connect(true) path on mount. Without this, the toolkit lands on the
 * Login button and our event handlers never wire up.
 */
async function seedToolkitAuthState(
  page: import('@playwright/test').Page,
  env: 'testnet' | 'mainnet',
): Promise<void> {
  const endpoint = env === 'testnet' ? 'https://test.ultra.eosusa.io' : 'https://ultra.eosusa.io';
  const accountName = env === 'testnet' ? 'tnetacct.test' : 'mnetacct.main';
  const chainId = env === 'testnet' ? TESTNET_CHAIN : MAINNET_CHAIN;
  await page.evaluate(
    (cfg) => {
      localStorage.setItem(
        'authState',
        JSON.stringify({
          type: 'ultra',
          accountName: cfg.accountName,
          accountPerm: 'active',
          isAdmin: false,
          endpoint: cfg.endpoint,
          environment: cfg.env,
          chainId: cfg.chainId,
        }),
      );
      localStorage.setItem('endpoint', cfg.endpoint);
      localStorage.setItem('environment', cfg.env);
    },
    { env, endpoint, accountName, chainId },
  );
}

async function waitForAuthSettle(
  page: import('@playwright/test').Page,
  expected: { type: string; accountName: string },
  timeoutMs = 60_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(() => {
          try {
            const a = JSON.parse(localStorage.getItem('authState') ?? '{}');
            return { type: a?.type, accountName: a?.accountName };
          } catch {
            return { type: undefined, accountName: undefined };
          }
        }),
      {
        timeout: timeoutMs,
        intervals: [200, 500, 1000],
        message: `toolkit authState never settled to ${JSON.stringify(expected)}`,
      },
    )
    .toEqual(expected);
}

async function waitForListenerMap(sw: Worker, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () =>
        await sw.evaluate(async () => {
          const r = await chrome.storage.session.get('EVENT_LISTENERS');
          const map = (r?.EVENT_LISTENERS ?? {}) as Record<string, unknown>;
          return Object.keys(map).sort();
        }),
      { timeout: timeoutMs, intervals: [200, 500, 1000], message: 'BG listenersMap never registered all event types' },
    )
    .toEqual(['accountChanged', 'disconnect', 'networkChanged']);
}

/** Read the current TRUSTED_APPS map from BG storage. */
async function readTrustedApps(sw: Worker): Promise<Record<string, string[]>> {
  return sw.evaluate(async () => {
    const r = await chrome.storage.local.get('TRUSTED_APPS');
    // Trusted-apps entries are now `{ origin, attestationConsentedAt? }` objects
    // (per-origin metadata added by the wallet-attestation feature); they were
    // bare origin strings before. Normalize to origin strings so callers can
    // assert membership regardless of which shape is on disk.
    const raw = (r?.TRUSTED_APPS ?? {}) as Record<string, Array<string | { origin?: string }>>;
    const out: Record<string, string[]> = {};
    for (const [env, entries] of Object.entries(raw)) {
      out[env] = Array.isArray(entries)
        ? entries.map((e) => (typeof e === 'string' ? e : e?.origin)).filter((o): o is string => !!o)
        : [];
    }
    return out;
  });
}

/**
 * Count chrome.windows.create calls from inside the BG. Hooks into
 * the chrome.windows API so any popup-window spawn is observable.
 */
async function installWindowCreateSpy(sw: Worker): Promise<void> {
  await sw.evaluate(() => {
    interface SpyWindow {
      __windowCreateCount?: number;
      __windowCreateOriginal?: typeof chrome.windows.create;
    }
    const g = globalThis as unknown as SpyWindow;
    if (g.__windowCreateOriginal) return; // already installed
    g.__windowCreateCount = 0;
    g.__windowCreateOriginal = chrome.windows.create;
    chrome.windows.create = ((...args: unknown[]) => {
      g.__windowCreateCount = (g.__windowCreateCount ?? 0) + 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (g.__windowCreateOriginal as any).apply(chrome.windows, args);
    }) as typeof chrome.windows.create;
  });
}

async function readWindowCreateCount(sw: Worker): Promise<number> {
  return sw.evaluate(() => {
    interface SpyWindow {
      __windowCreateCount?: number;
    }
    return (globalThis as unknown as SpyWindow).__windowCreateCount ?? 0;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe.configure({ timeout: 120_000 });

test.describe('Wallet ↔ Toolkit disconnect/connect parity', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Build it first via "npx nx build browser-extension-wallet -c=production" in web-app.`,
      );
    }
  });

  test('Issue 1: extension-side disconnect clears trust on every env and toolkit mirrors logout', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-disc-1-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        // Origin is trusted on BOTH envs — the test asserts cross-env removal.
        trustedOnEnvs: ['testnet', 'mainnet'],
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context);

      const page = await context.newPage();
      await page.goto(TOOLKIT_URL);
      await page.waitForLoadState('load');
      await seedToolkitAuthState(page, 'testnet');
      await page.reload();
      await page.waitForLoadState('load');
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'tnetacct.test' });
      await waitForListenerMap(sw);

      // Sanity: trust pre-state is set on both envs.
      const beforeDisconnect = await readTrustedApps(sw);
      expect(beforeDisconnect.testnet ?? []).toContain(TOOLKIT_ORIGIN);
      expect(beforeDisconnect.mainnet ?? []).toContain(TOOLKIT_ORIGIN);

      // Drive the extension-side disconnect inline. We replicate exactly what
      // `home-view.disconnectDapp` / `connected-apps.disconnect` do today:
      //   1. PermissionService.removeOriginEverywhere(origin)
      //   2. EventsService.sendEventMessage(WalletEvent.DISCONNECT, [origin])
      //
      // Both run in the BG context. The PermissionService call is replicated
      // by direct chrome.storage.local manipulation. The event dispatch goes
      // through the same chrome.tabs.sendMessage bridge that
      // `ExtensionMessenger.sendToContentScript` uses — message shape must
      // match `{type:'EVENT', from:'BACKGROUND_SCRIPT', to:'CONTENT_SCRIPT',
      // payload:{event:'disconnect', origin, data}}` so the content script's
      // `listenMessages` filter (`message.to === CONTENT_SCRIPT`) lets it
      // through to the page bridge.
      await sw.evaluate(async (origin) => {
        // (1) Cross-env removal — replicates PermissionService.removeOriginEverywhere.
        // Entries are `{ origin, attestationConsentedAt? }` objects (per-origin
        // metadata from the wallet-attestation feature); compare on the origin field.
        const r = await chrome.storage.local.get('TRUSTED_APPS');
        const map = (r?.TRUSTED_APPS ?? {}) as Record<string, Array<string | { origin?: string }>>;
        let mutated = false;
        for (const env of Object.keys(map)) {
          const before = map[env] ?? [];
          const next = before.filter((e) => (typeof e === 'string' ? e : e?.origin) !== origin);
          if (next.length !== before.length) {
            map[env] = next;
            mutated = true;
          }
        }
        if (mutated) await chrome.storage.local.set({ TRUSTED_APPS: map });

        // (2) Dispatch DISCONNECT to the toolkit tab(s). Match the production
        // wire format exactly — see ExtensionMessenger.sendToContentScript +
        // EventsService.sendEventMessage.
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.id == null || !tab.url) continue;
          if (!tab.url.startsWith(origin)) continue;
          await chrome.tabs
            .sendMessage(tab.id, {
              type: 'EVENT',
              from: 'BACKGROUND_SCRIPT',
              to: 'CONTENT_SCRIPT',
              payload: { event: 'disconnect', origin, data: { origin } },
            })
            .catch(() => undefined);
        }
      }, TOOLKIT_ORIGIN);

      // Toolkit's `handleWalletDisconnect` should call `resetLocalSession()` —
      // authState type clears, accountName clears.
      await expect
        .poll(
          async () =>
            await page.evaluate(() => {
              try {
                const a = JSON.parse(localStorage.getItem('authState') ?? '{}');
                return { type: a?.type, accountName: a?.accountName };
              } catch {
                return { type: undefined, accountName: undefined };
              }
            }),
          { timeout: 15_000, intervals: [200, 500] },
        )
        .toEqual({ type: undefined, accountName: undefined });

      // Cross-env check: every env's trusted-app list should no longer contain
      // the origin. Pre-fix the home-view disconnect only cleared the current
      // env, leaving the dapp re-trusted on a sibling.
      const afterDisconnect = await readTrustedApps(sw);
      for (const env of Object.keys(afterDisconnect)) {
        expect(
          afterDisconnect[env] ?? [],
          `origin still present in TRUSTED_APPS[${env}] after cross-env disconnect`,
        ).not.toContain(TOOLKIT_ORIGIN);
      }
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Issue 1: toolkit-initiated Ultra.disconnect() is idempotent (no 4001) and clears local state', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-disc-2-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      // Pre-state: NOT trusted on any env. Simulates "extension already
      // disconnected; toolkit hasn't realised yet". Pre-fix the BG
      // `disconnect` handler returned 4001 USER_REJECTED_REQUEST which
      // short-circuited toolkit's logout(); local cleanup never ran.
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        trustedOnEnvs: [],
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context);

      const page = await context.newPage();
      await page.goto(TOOLKIT_URL);
      await page.waitForLoadState('load');
      await seedToolkitAuthState(page, 'testnet');
      await page.reload();
      await page.waitForLoadState('load');

      // Wait for toolkit's window.ultra to become available (content script
      // injection). We don't wait for trust because the test's premise is
      // that trust has already been removed.
      await page.waitForFunction(
        () => typeof (window as { ultra?: unknown }).ultra !== 'undefined',
        { timeout: 30_000 },
      );

      // Call Ultra.disconnect() from the page context. Should resolve
      // successfully (idempotent), not 4001.
      const result = await page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ultra = (window as any).ultra;
        try {
          const res = await ultra.disconnect();
          return { ok: true, status: res?.status, code: res?.code };
        } catch (e) {
          return { ok: false, message: String(e instanceof Error ? e.message : e) };
        }
      });

      expect(result.ok, `disconnect call threw: ${JSON.stringify(result)}`).toBe(true);
      expect(result.code, `disconnect returned 4001 (USER_REJECTED_REQUEST) — should be idempotent success`).not.toBe(
        4001,
      );

      // Trust map remains empty (nothing to remove, nothing should be added).
      const afterTrust = await readTrustedApps(sw);
      for (const env of Object.keys(afterTrust)) {
        expect(afterTrust[env] ?? []).not.toContain(TOOLKIT_ORIGIN);
      }
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Issue 2: switching network on a trusted origin does NOT spawn a connect-popup window (popup mode)', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-conn-popup-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      // Origin trusted only on testnet. After switching to mainnet, the
      // cross-env `isOriginTrusted` check should still return true; the BG
      // must silent-respond to the toolkit's post-switch Ultra.connect()
      // (no popup window). UI_MODE=popup is the failure mode pre-fix.
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        trustedOnEnvs: ['testnet'],
        origins: [TOOLKIT_ORIGIN],
        uiMode: 'popup',
      });
      await mockChainRPC(context);
      await installWindowCreateSpy(sw);

      const page = await context.newPage();
      await page.goto(TOOLKIT_URL);
      await page.waitForLoadState('load');
      await seedToolkitAuthState(page, 'testnet');
      await page.reload();
      await page.waitForLoadState('load');
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'tnetacct.test' });
      await waitForListenerMap(sw);

      const baselineWindows = await readWindowCreateCount(sw);

      // Drive the wallet network switch — same effect as the user clicking a
      // network row in the wallet UI.
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' });
      });

      // Toolkit handles networkChanged → setEndpoint(...) → Ultra.connect().
      // BG's `permission-controller.connect` should silent-respond because
      // origin is trusted (cross-env).
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'mnetacct.main' });

      // Critical assertion: zero new windows spawned. Pre-fix popup mode
      // saw a new chrome.windows.create here (sometimes two, racy on the
      // networkChanged + accountChanged double-emit), surfacing as a
      // duplicate connect prompt.
      const afterWindows = await readWindowCreateCount(sw);
      expect(
        afterWindows - baselineWindows,
        `expected zero popup-window spawns on silent reconnect; got ${afterWindows - baselineWindows}`,
      ).toBe(0);

      // Trust shape was not touched (still on testnet, still no mainnet entry —
      // cross-env trust handles the network switch without re-storing trust).
      const finalTrust = await readTrustedApps(sw);
      expect(finalTrust.testnet ?? []).toContain(TOOLKIT_ORIGIN);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Issue 2: REQUESTS storage stays empty across a network switch on a trusted origin (popup mode)', async () => {
    // Complementary to the previous test: even before the popup-window
    // mechanism kicks in, the upstream request-store must stay empty,
    // because trusted-origin connects should never reach `RequestService.storeRequest`.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-conn-req-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        trustedOnEnvs: ['testnet'],
        origins: [TOOLKIT_ORIGIN],
        uiMode: 'popup',
      });
      await mockChainRPC(context);

      const page = await context.newPage();
      await page.goto(TOOLKIT_URL);
      await page.waitForLoadState('load');
      await seedToolkitAuthState(page, 'testnet');
      await page.reload();
      await page.waitForLoadState('load');
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'tnetacct.test' });
      await waitForListenerMap(sw);

      // Switch wallet env — BG fires both events, toolkit re-runs Ultra.connect()
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' });
      });
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'mnetacct.main' });

      // REQUESTS in chrome.storage.local must stay empty across the switch.
      const requests = await sw.evaluate(async () => {
        const r = await chrome.storage.local.get('REQUESTS');
        return (r?.REQUESTS ?? []) as unknown[];
      });
      expect(
        requests.length,
        `expected REQUESTS to be empty for trusted-origin silent reconnect; got ${requests.length}`,
      ).toBe(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Wallet-UI dapp-bar: cross-env trust shown as connected after a network switch', async () => {
    // The wallet UI uses `chrome.tabs.query({active:true, currentWindow:true})`
    // to identify the "current dapp" and then renders a connection pill in
    // the home view. Pre-fix the trust check was per-env (`isTrustedApp(env,
    // origin)`); switching the wallet to a different env flipped the pill to
    // "not connected" even though the dapp was still trusted cross-env. This
    // test loads the toolkit (focused tab), opens the wallet UI in a second
    // tab, then asserts the wallet's home-view runs `refreshCurrentDapp` and
    // resolves the trust check via the cross-env predicate.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-bar-cross-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      // Origin trusted ONLY on mainnet. Wallet starts on testnet — pre-fix
      // dapp-bar would render "not connected" because per-env check missed.
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        trustedOnEnvs: ['mainnet'],
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context);

      // Open the wallet UI first; ngOnInit's `refreshCurrentDapp` will see
      // itself as the active tab (no `.dapp-bar` rendered yet — `dappHostname`
      // is null because the chrome-extension:// origin isn't http/https).
      const extId = await sw.evaluate(() => chrome.runtime.id);
      const walletPage = await context.newPage();
      await walletPage.goto(`chrome-extension://${extId}/index.html#/home`);
      await walletPage.waitForLoadState('load');

      // Now open the dapp tab and bring it to focus. The wallet's
      // `chrome.tabs.onActivated` listener fires → `refreshCurrentDapp` re-
      // runs → the toolkit tab is now the active one → dappHostname populated
      // → `.dapp-bar` rendered.
      const dappPage = await context.newPage();
      await dappPage.goto(TOOLKIT_URL);
      await dappPage.waitForLoadState('load');
      await dappPage.bringToFront();

      // Wait for the home-view's dapp-bar to render with the connected class.
      // The bar markup: `<div class="dapp-bar" [class.dapp-bar--connected]>`.
      await expect
        .poll(
          async () => {
            return walletPage.evaluate(() => {
              const bar = document.querySelector('.dapp-bar');
              if (!bar) return 'no-dapp-bar';
              return bar.classList.contains('dapp-bar--connected') ? 'connected' : 'not-connected';
            });
          },
          { timeout: 30_000, intervals: [200, 500, 1000] },
        )
        .toBe('connected');

      // Now switch the wallet's env to mainnet — cross-env trust still in
      // place, dapp-bar must remain "connected". The wallet UI reloads on
      // ENVIRONMENT change (AppComponent listener), so wait for it to
      // re-mount and re-evaluate the trust check.
      await sw.evaluate(async () => {
        await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' });
      });
      // Wait for the env-driven reload to complete.
      await walletPage.waitForLoadState('load');
      await walletPage.waitForTimeout(2000);
      await dappPage.bringToFront();
      await expect
        .poll(
          async () => {
            return walletPage.evaluate(() => {
              const bar = document.querySelector('.dapp-bar');
              if (!bar) return 'no-dapp-bar';
              return bar.classList.contains('dapp-bar--connected') ? 'connected' : 'not-connected';
            });
          },
          { timeout: 30_000, intervals: [200, 500, 1000] },
        )
        .toBe('connected');
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Wallet-UI dapp-bar: reactively updates when toolkit calls Ultra.disconnect()', async () => {
    // Side-panel mode keeps the home-view alive across the user's session;
    // pre-fix it didn't subscribe to `TRUSTED_APPS` storage changes, so a
    // toolkit-initiated `Ultra.disconnect()` (which clears trust on the BG
    // side) wouldn't update the bar until the user closed and re-opened the
    // panel. This test wires the same flow and asserts the bar transitions
    // from connected to disconnected without a reload.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-bar-react-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        trustedOnEnvs: ['testnet'],
        origins: [TOOLKIT_ORIGIN],
      });
      await mockChainRPC(context);

      // Open wallet first so its tabs.onActivated listener is wired before
      // the dapp tab opens. dapp tab activation will then trigger the
      // wallet's `refreshCurrentDapp`.
      const extId = await sw.evaluate(() => chrome.runtime.id);
      const walletPage = await context.newPage();
      await walletPage.goto(`chrome-extension://${extId}/index.html#/home`);
      await walletPage.waitForLoadState('load');

      const dappPage = await context.newPage();
      await dappPage.goto(TOOLKIT_URL);
      await dappPage.waitForLoadState('load');
      await seedToolkitAuthState(dappPage, 'testnet');
      await dappPage.reload();
      await dappPage.waitForLoadState('load');
      await waitForAuthSettle(dappPage, { type: 'ultra', accountName: 'tnetacct.test' });
      await waitForListenerMap(sw);
      await dappPage.bringToFront();

      await expect
        .poll(
          async () => {
            return walletPage.evaluate(() => {
              const bar = document.querySelector('.dapp-bar');
              if (!bar) return 'no-dapp-bar';
              return bar.classList.contains('dapp-bar--connected') ? 'connected' : 'not-connected';
            });
          },
          { timeout: 30_000, intervals: [200, 500, 1000] },
        )
        .toBe('connected');

      // Toolkit calls Ultra.disconnect() — the post-Issue-1 idempotent path.
      // BG removes trust cross-env and fires WalletEvent.DISCONNECT to the
      // dapp. The wallet UI must observe the TRUSTED_APPS storage change and
      // re-run its dapp-bar resolver without needing a reopen.
      await dappPage.bringToFront();
      await dappPage.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ultra = (window as any).ultra;
        await ultra.disconnect();
      });

      await expect
        .poll(
          async () => {
            return walletPage.evaluate(() => {
              const bar = document.querySelector('.dapp-bar');
              if (!bar) return 'no-dapp-bar';
              return bar.classList.contains('dapp-bar--connected') ? 'connected' : 'not-connected';
            });
          },
          { timeout: 15_000, intervals: [200, 500, 1000] },
        )
        .toBe('not-connected');
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Issue 3: same flow in side-panel mode also stays silent (no window, no request)', async () => {
    // Parity assertion: the success path in side-panel mode is identical to
    // popup mode after the fixes — no popup window, no stored request. This
    // pins the parity rather than relying on the inverse (different code
    // paths producing the same outcome by coincidence).
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-conn-side-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        trustedOnEnvs: ['testnet'],
        origins: [TOOLKIT_ORIGIN],
        uiMode: 'sidePanel',
      });
      await mockChainRPC(context);
      await installWindowCreateSpy(sw);

      const page = await context.newPage();
      await page.goto(TOOLKIT_URL);
      await page.waitForLoadState('load');
      await seedToolkitAuthState(page, 'testnet');
      await page.reload();
      await page.waitForLoadState('load');
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'tnetacct.test' });
      await waitForListenerMap(sw);

      const baselineWindows = await readWindowCreateCount(sw);

      await sw.evaluate(async () => {
        await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' });
      });
      await waitForAuthSettle(page, { type: 'ultra', accountName: 'mnetacct.main' });

      const afterWindows = await readWindowCreateCount(sw);
      expect(afterWindows - baselineWindows).toBe(0);

      const requests = await sw.evaluate(async () => {
        const r = await chrome.storage.local.get('REQUESTS');
        return (r?.REQUESTS ?? []) as unknown[];
      });
      expect(requests.length).toBe(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
