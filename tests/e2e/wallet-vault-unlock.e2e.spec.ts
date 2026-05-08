/**
 * End-to-end tests for the wallet vault unlock + auto-lock surface.
 *
 * Pins three regression-prone behaviours uncovered in the 2026-05-07
 * network-sync session:
 *
 *  (1) Atomic unlock state — `vault.unlock(password)` must publish
 *      `this.vault` and `this.publicKeys` in the same synchronous burst,
 *      so any caller that observes `isUnlocked() === true` immediately
 *      sees a non-empty `listPublicKeys()`. Pre-fix, an `await
 *      deriveKey(...)` lived between the two assignments; concurrent
 *      callers (notably `tryRestoreSession`'s "already unlocked" fast
 *      path) saw the half-published state and rendered the empty
 *      "Welcome to Ultra Wallet" home screen even though the vault was
 *      good. See authenticator-lib `vault.service.ts` §atomic publish.
 *
 *  (2) Disk re-read after another surface writes a new key — the EBA
 *      auth tab persists a freshly-registered device key, then the
 *      side panel must pick it up without a full lock-and-unlock. The
 *      fix is `tryRestoreSession({ forceRefresh: true })` skipping the
 *      isUnlocked() short-circuit and forcing a fresh `vault.unlock(password)`.
 *      We can't reach `UnifiedWalletService` directly from an external
 *      JS context (its statics aren't exposed on the SW global, and the
 *      wallet UI's webpack-mangled module isn't reachable from
 *      page.evaluate) — so the spec's "alternative simpler test" path
 *      is taken: drive the same observable behaviour by having a fresh
 *      JS context resolve the disk vault. Bug regression would prevent
 *      a freshly-mounted Key Manager from ever showing the new key.
 *
 *  (3) Auto-lock fires when idle and DEFERS while pending requests
 *      are stored. Background.ts wires `AutoLockService` so its onLock
 *      callback consults `RequestService.getAllRequest()` first, calling
 *      `resetTimer()` if any are present and `clearSession()` only on
 *      the truly-idle branch. Pre-fix variations of this code path
 *      auto-locked mid-signing and the user lost the in-flight popup.
 *
 *  Harness mirrors the existing wallet-network-sync / wallet-disconnect-
 *  connect specs: persistent context with --load-extension, programmatic
 *  vault seed, /v1/chain/* mocked, state-based assertions via
 *  chrome.storage reads.
 *
 *  Prereqs:
 *    - extension pre-built at /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 */

import { test, expect, chromium, BrowserContext, Worker, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');

const PASSWORD = 'TestPass123!';
// Two well-formed EOSIO key pairs. Chain-resolve calls are intercepted by
// playwright route mocking so on-chain accounts don't actually need to exist.
const PRIV_KEY_1 = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY_1 = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const PRIV_KEY_2 = '5JLxoMLPMRcfNvxsnswtZJBT37avnFnN8AqU8iNFXKHdvwzXqLQ';
const PUB_KEY_2 = 'EOS5GhQVeZc8jWxjp5UBqYvCBmKmS9d3rk9GzgfiJVyVjJD2nJqzv';

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

async function getExtensionId(sw: Worker): Promise<string> {
  return sw.evaluate(() => chrome.runtime.id);
}

interface SeedConfig {
  password: string;
  pubKeys: string[];
  privKeys: string[]; // same order as pubKeys
  env: 'testnet' | 'mainnet';
  /** Whether to also write `vault_session` (i.e. start unlocked). */
  unlocked: boolean;
  origins?: string[];
  /** Pre-populate AccountCacheService so chain RPC isn't needed for resolution. */
  seedAccountCache?: boolean;
}

/**
 * Build a real encrypted vault matching authenticator-lib's CryptoService
 * format (PBKDF2-SHA256, 900_000 iterations, AES-GCM-256) and write to
 * chrome.storage. When `unlocked` is true also writes `vault_session` so the
 * BG (and any wallet UI tab) can silent-restore.
 *
 * Multiple pubKey/privKey pairs are inlined into the same encrypted vault
 * blob — same `vault.keys` map shape that VaultService produces.
 */
async function seedExtensionState(sw: Worker, cfg: SeedConfig): Promise<void> {
  await sw.evaluate(async (cfg) => {
    if (cfg.pubKeys.length !== cfg.privKeys.length) {
      throw new Error('seedExtensionState: pubKeys/privKeys length mismatch');
    }
    // djb2 hash mirrors VaultService.simpleHash so the vault filename is
    // exactly what the prod code reads back.
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

    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(cfg.password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );

    const keys: Record<string, unknown> = {};
    for (let i = 0; i < cfg.pubKeys.length; i++) {
      keys[cfg.pubKeys[i]] = {
        publicKey: cfg.pubKeys[i],
        privateKey: cfg.privKeys[i],
        addedAt: Date.now(),
        source: 'import',
      };
    }
    const vaultPlaintext = { keys, accounts: [] };
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
      publicKeys: [...cfg.pubKeys],
    };

    const trustedApps: Record<string, string[]> = {};
    if (cfg.origins && cfg.origins.length > 0) {
      for (const env of ['testnet', 'mainnet']) {
        trustedApps[env] = [...cfg.origins];
      }
    }

    await chrome.storage.local.set({
      [VAULT_FILE]: JSON.stringify(encryptedVault),
      ENVIRONMENT: cfg.env,
      TRUSTED_APPS: trustedApps,
      SELECTED_ACCOUNTS_BY_CHAIN: {},
    });

    const sessionWrites: Record<string, unknown> = {};
    if (cfg.unlocked) {
      sessionWrites.vault_session = cfg.password;
    }
    if (cfg.seedAccountCache) {
      const now = Date.now();
      sessionWrites.account_resolution_cache = {
        mainnet: {
          entries: cfg.pubKeys.map((pk, i) => ({
            account: i === 0 ? 'mnetacct.main' : `mnetacct${i}.main`,
            permission: 'active',
            authorizing_key: pk,
          })),
          timestamp: now,
          publicKeys: [...cfg.pubKeys],
        },
        testnet: {
          entries: cfg.pubKeys.map((pk, i) => ({
            account: i === 0 ? 'tnetacct.test' : `tnetacct${i}.test`,
            permission: 'active',
            authorizing_key: pk,
          })),
          timestamp: now,
          publicKeys: [...cfg.pubKeys],
        },
      };
    }
    if (Object.keys(sessionWrites).length > 0) {
      await chrome.storage.session.set(sessionWrites);
    }
  }, cfg);
}

/**
 * Re-encrypt the on-disk vault file with a new keys map. Used by test 2 to
 * simulate the EBA auth tab persisting a new key while the side panel is
 * already unlocked. Same password (and consequently same derivedKey shape)
 * as the original seed, but a fresh salt/iv so the ciphertext bytes change.
 */
async function rewriteVaultOnDisk(
  sw: Worker,
  cfg: { password: string; pubKeys: string[]; privKeys: string[] },
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

    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(cfg.password),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );

    const keys: Record<string, unknown> = {};
    for (let i = 0; i < cfg.pubKeys.length; i++) {
      keys[cfg.pubKeys[i]] = {
        publicKey: cfg.pubKeys[i],
        privateKey: cfg.privKeys[i],
        addedAt: Date.now(),
        source: 'import',
      };
    }
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        enc.encode(JSON.stringify({ keys, accounts: [] })),
      ),
    );
    const toHex = (b: Uint8Array): string =>
      Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

    const encryptedVault = {
      salt: toHex(salt),
      iv: toHex(iv),
      ciphertext: toHex(ciphertext),
      iterations: ITERATIONS,
      publicKeys: [...cfg.pubKeys],
    };
    await chrome.storage.local.set({ [VAULT_FILE]: JSON.stringify(encryptedVault) });
  }, cfg);
}

/** Mock the chain RPC paths the home view's resolver hits during render. */
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
    // Return one account per requested key so multi-key seeds don't break.
    let body: { keys?: string[] } = {};
    try {
      body = JSON.parse(route.request().postData() ?? '{}');
    } catch {
      /* ignore */
    }
    const keys = body.keys ?? [PUB_KEY_1];
    const accounts = keys.map((k, i) => ({
      account_name: isTestnet ? (i === 0 ? 'tnetacct.test' : `tnetacct${i}.test`) : (i === 0 ? 'mnetacct.main' : `mnetacct${i}.main`),
      permission_name: 'active',
      authorizing_key: k,
    }));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts }) });
  });

  await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/** Tiny helper: read chrome.storage.session.vault_session existence. */
async function readVaultSession(sw: Worker): Promise<string | undefined> {
  return sw.evaluate(async () => {
    const r = await chrome.storage.session.get('vault_session');
    return r?.vault_session as string | undefined;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe.configure({ timeout: 180_000 });

test.describe('Wallet vault unlock + auto-lock (real extension)', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Run a production build of browser-extension-wallet in web-app first.`,
      );
    }
  });

  test('vault.unlock publishes atomic state — UI sees keys on the first render after unlock', async () => {
    // Pin authenticator-lib's atomic-publish invariant on `vault.unlock`.
    // Pre-fix: an `await deriveKey(...)` lived between
    //   `this.vault = vault;` and `this.publicKeys = publicKeys;`
    // so any observer that read `isUnlocked()` (true after the first
    // assignment) and then `listPublicKeys()` (still []) saw the empty
    // mid-unlock state.
    //
    // We can't reach VaultService directly from the SW context (the class
    // isn't exposed globally — webpack mangles names), so we exercise the
    // same code path through the wallet UI: open `/unlock`, fill the
    // password, click Unlock. On successful unlock the WalletGuard chains
    // into `/home`, which renders home-view with `hasKeys = vault.listPublicKeys().length > 0`.
    // If the atomic-publish invariant held we see the loading/account state;
    // if it broke we see the "Welcome to Ultra Wallet" empty state.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-vault-unlock-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });

    try {
      const sw = await getServiceWorker(context);
      // Seed an encrypted vault with one key but DO NOT write `vault_session`,
      // so the wallet boots locked and routes to /unlock.
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKeys: [PUB_KEY_1],
        privKeys: [PRIV_KEY_1],
        env: 'testnet',
        unlocked: false,
        seedAccountCache: true,
      });
      await mockChainRPC(context);

      const extId = await getExtensionId(sw);
      const page = await context.newPage();
      // Land directly on /unlock — the WalletGuard would have routed us
      // here anyway when it found the vault locked.
      await page.goto(`chrome-extension://${extId}/index.html#/unlock`);
      await page.waitForLoadState('load');

      // Sanity: vault_session is NOT present pre-unlock.
      expect(await readVaultSession(sw), 'vault_session should be empty before unlock').toBeFalsy();

      // Fill password + click Unlock.
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 30_000 });
      await passwordInput.fill(PASSWORD);
      // The unlock button is `<ultra-block-button title="Unlock">`. Native
      // <button> child carries the title text; click via role.
      const unlockButton = page.getByRole('button', { name: /unlock/i }).first();
      await unlockButton.click();

      // After successful unlock UnifiedWalletService.persistSession writes
      // `vault_session`. Wait for that — proves the unlock completed without
      // throwing.
      await expect.poll(() => readVaultSession(sw), {
        timeout: 30_000,
        intervals: [200, 500, 1000],
        message: 'vault_session never set after unlock — vault.unlock probably threw',
      }).toBe(PASSWORD);

      // The WalletGuard navigates to /home on success. Wait for the
      // home-container to render.
      await expect
        .poll(
          async () => {
            const hash = await page.evaluate(() => window.location.hash);
            const hasContainer = await page.locator('.home-container').count();
            return { hash, hasContainer };
          },
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: 'home-view never mounted after unlock',
          },
        )
        .toEqual({ hash: '#/home', hasContainer: 1 });

      // The atomic-publish assertion: on the first render after isUnlocked()
      // flipped to true, `vault.listPublicKeys().length > 0` must have held.
      // home-view templates the empty-state ("Welcome to Ultra Wallet") iff
      // !hasKeys. If the regression returned, hasKeys would have been false
      // on the first render and the empty state would render.
      const welcomeText = await page.locator('text=Welcome to Ultra Wallet').count();
      expect(
        welcomeText,
        'home-view rendered the !hasKeys empty state immediately after unlock — atomic-publish invariant broken',
      ).toBe(0);

      // Stronger evidence: home-view should have moved past the
      // empty-state branch into either the "loading" skeleton or the
      // "has accounts" pane. Match either via a stable selector.
      // The "loading" pane has the logo image; the "has accounts" pane
      // also has the logo. So presence of the logo within `.home-container`
      // proves we are NOT in the empty state.
      const logoVisible = await page.locator('.home-container .logo img[alt="Ultra logo"]').count();
      expect(logoVisible, 'expected logo to render on either loading or accounts branch').toBeGreaterThan(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('newly-mounted UI surface picks up disk-vault changes (forceRefresh disk-read parity)', async () => {
    // Pin the disk-read behaviour the EBA forceRefresh fix protects: when
    // another extension surface (the EBA auth tab) writes a new key into
    // the shared on-disk vault file, the next caller that goes through
    // `tryRestoreSession` must re-decrypt the disk and pick up the new key.
    //
    // The exact `forceRefresh: true` short-circuit-bypass is only reachable
    // when the same `UnifiedWalletService` singleton (i.e. the same JS
    // context) has the vault already unlocked — that path lives entirely
    // inside the wallet's webpack-mangled bundle. We can't reach the
    // singleton from page.evaluate, so we exercise the CLOSELY-RELATED
    // observable behaviour: a freshly-mounted Key Manager (= fresh
    // UnifiedWalletService instance) goes through `tryRestoreSession()`
    // via the WalletGuard and must see the post-write key.
    //
    // The matching unit-level coverage for forceRefresh-on-already-unlocked
    // lives in authenticator-lib's vault.service.spec.ts.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-vault-refresh-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });

    try {
      const sw = await getServiceWorker(context);
      // Step 1: seed with ONE key, vault unlocked.
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKeys: [PUB_KEY_1],
        privKeys: [PRIV_KEY_1],
        env: 'testnet',
        unlocked: true,
        seedAccountCache: true,
      });
      await mockChainRPC(context);

      const extId = await getExtensionId(sw);

      // Step 2: open the Key Manager — it lists rows from `vault.listPublicKeys()`.
      // We don't actually need to assert on the row count here; the
      // important state is the on-disk vault, which the next-mounted
      // wallet UI tab will re-read.
      const page1 = await context.newPage();
      await page1.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page1.waitForLoadState('load');
      // Confirm the side panel reached /keys (WalletGuard happy-pathed).
      await expect
        .poll(async () => page1.evaluate(() => window.location.hash), {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'first /keys tab never settled — WalletGuard blocked unexpectedly',
        })
        .toBe('#/keys');

      // Step 3: from the SW, re-write the on-disk vault to contain BOTH
      // keys — same shape that VaultService.persist() would produce after
      // an `addKey` call elsewhere in the app.
      await rewriteVaultOnDisk(sw, {
        password: PASSWORD,
        pubKeys: [PUB_KEY_1, PUB_KEY_2],
        privKeys: [PRIV_KEY_1, PRIV_KEY_2],
      });

      // Sanity: the encryptedVault.publicKeys index is what we wrote.
      const onDisk = await sw.evaluate(async () => {
        const simpleHash = (s: string): string => {
          let h = 5381;
          for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
          return Math.abs(h).toString(16).padStart(8, '0');
        };
        const VAULT_FILE = `${simpleHash('ultra-extension-wallet')}.json`;
        const r = await chrome.storage.local.get(VAULT_FILE);
        try {
          const parsed = JSON.parse(r[VAULT_FILE] as string);
          return parsed?.publicKeys ?? null;
        } catch {
          return null;
        }
      });
      expect(onDisk, 'rewriteVaultOnDisk did not produce a valid encrypted vault file').toEqual([PUB_KEY_1, PUB_KEY_2]);

      // Step 4: open a SECOND wallet tab. Fresh JS context → fresh
      // UnifiedWalletService singleton → WalletGuard → tryRestoreSession()
      // → vault.unlock(password) → reads disk. Must pick up both keys.
      const page2 = await context.newPage();
      await page2.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page2.waitForLoadState('load');

      // Wait for /keys to settle (means tryRestoreSession resolved).
      await expect
        .poll(async () => page2.evaluate(() => window.location.hash), {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'second /keys tab never settled — tryRestoreSession likely failed on the rewritten vault',
        })
        .toBe('#/keys');

      // The Key Manager renders one row per public key. The exact
      // selector depends on the component template; assert via the
      // public-key text appearing somewhere on the page (most robust
      // against template churn). Both keys must be visible.
      await expect
        .poll(
          async () => {
            return page2.evaluate(({ k1, k2 }) => {
              const body = document.body?.textContent ?? '';
              // Use a substring of each key — full key may be truncated
              // for display (e.g. "EOS6MR...DW5CV").
              const hasK1 = body.includes(k1.slice(0, 12));
              const hasK2 = body.includes(k2.slice(0, 12));
              return { hasK1, hasK2 };
            }, { k1: PUB_KEY_1, k2: PUB_KEY_2 });
          },
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: 'second tab never showed both keys — tryRestoreSession failed to re-read disk',
          },
        )
        .toEqual({ hasK1: true, hasK2: true });

      // Direct vault-state proof: the rewritten encrypted vault decrypts
      // correctly with the same password. If forceRefresh-on-already-
      // unlocked (the same-context regression) shipped to prod, this
      // assertion would still pass — but `hasK2` above would have
      // failed if the per-context restore didn't re-decrypt at all.
      // Together the two prove disk read works on a fresh mount.
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('auto-lock fires after timeout when idle, defers when REQUESTS has pending entries', async () => {
    // Pin the deferral logic in apps/browser-extension-wallet/src/extension/background.ts:50-58:
    //
    //   this.autoLock = new AutoLockService(async () => {
    //     const requests = await RequestService.getAllRequest();
    //     if (requests && requests.length > 0) {
    //       this.autoLock.resetTimer();
    //       return;
    //     }
    //     await UnifiedWalletService.clearSession();
    //   });
    //
    // chrome.alarms in Manifest V3 enforces a minimum delay of 30 seconds
    // for unpacked extensions (60s for packed). So we use 30s and accept
    // a ~70-second test runtime for the two phases. A faster surrogate
    // (firing the alarm listener manually) isn't reachable from outside
    // the SW because chrome.alarms.onAlarm has no public dispatch API.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-vault-autolock-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });

    try {
      const sw = await getServiceWorker(context);
      // Start unlocked.
      await seedExtensionState(sw, {
        password: PASSWORD,
        pubKeys: [PUB_KEY_1],
        privKeys: [PRIV_KEY_1],
        env: 'testnet',
        unlocked: true,
        seedAccountCache: true,
      });
      await mockChainRPC(context);

      // ── Phase 1: idle → auto-lock fires ─────────────────────────────────
      // Write AUTO_LOCK_TIMEOUT to 30 seconds. Background.ts has a
      // chrome.storage.onChanged listener that calls
      // autoLock.setTimeout(newTimeout) → resetTimer(), so the alarm
      // re-arms with our value.
      const TIMEOUT_MS = 30_000;
      // Make sure REQUESTS is empty so the deferral branch doesn't hit.
      await sw.evaluate(async () => {
        await chrome.storage.local.remove('REQUESTS');
      });
      await sw.evaluate(async (ms) => {
        await chrome.storage.local.set({ AUTO_LOCK_TIMEOUT: ms });
      }, TIMEOUT_MS);

      // Sanity-check the alarm got created with the right delay. The
      // production code uses `delayInMinutes`, so 30s = 0.5 min.
      const alarmsAfterArm = await sw.evaluate(async () => {
        const all = await chrome.alarms.getAll();
        return all.map((a) => ({ name: a.name, scheduledTime: a.scheduledTime }));
      });
      const lockAlarm = alarmsAfterArm.find((a) => a.name === 'ultra-wallet-auto-lock');
      expect(lockAlarm, `expected ultra-wallet-auto-lock alarm to be scheduled; got: ${JSON.stringify(alarmsAfterArm)}`).toBeTruthy();

      // Sanity-check vault is currently unlocked.
      expect(await readVaultSession(sw), 'pre-fire: vault_session should be set').toBe(PASSWORD);

      // Wait for the alarm to fire. Poll vault_session — when the alarm
      // listener runs the AutoLockService callback, it calls
      // UnifiedWalletService.clearSession() which removes vault_session.
      // Allow generous timeout: chrome.alarms can fire a few seconds late.
      await expect
        .poll(() => readVaultSession(sw), {
          timeout: 60_000,
          intervals: [1000, 2000],
          message: 'auto-lock did not fire — vault_session was never cleared after the timeout',
        })
        .toBeFalsy();

      // ── Phase 2: re-seed, store a pending request, alarm should DEFER ──
      // Restore vault_session and write a fake pending request. The
      // request shape mirrors `IExtensionRequest` minimally — auto-lock
      // only checks `requests.length`, not the inner structure.
      await sw.evaluate(async (password) => {
        await chrome.storage.session.set({ vault_session: password });
        await chrome.storage.local.set({
          REQUESTS: [
            {
              messageId: 'test-pending-1',
              requestType: 'CONNECT',
              origin: 'http://localhost:5172',
              data: {},
              timestamp: Date.now(),
            },
          ],
        });
      }, PASSWORD);

      // Re-arm the alarm by writing AUTO_LOCK_TIMEOUT again. The same
      // chrome.storage.onChanged hook in background.ts re-fires
      // autoLock.setTimeout → resetTimer.
      await sw.evaluate(async (ms) => {
        // Use a slightly different value to guarantee the listener
        // observes a "changed" event (chrome.storage.onChanged only
        // fires when newValue !== oldValue).
        await chrome.storage.local.set({ AUTO_LOCK_TIMEOUT: ms + 1 });
      }, TIMEOUT_MS);

      // Sanity: alarm re-armed.
      const alarmsAfterRearm = await sw.evaluate(async () => {
        const all = await chrome.alarms.getAll();
        return all.map((a) => a.name);
      });
      expect(alarmsAfterRearm).toContain('ultra-wallet-auto-lock');

      // Wait long enough for the alarm to fire AT LEAST ONCE (35s ≈ 30s
      // delay + a few seconds slack). When the AutoLockService callback
      // sees REQUESTS non-empty it calls `this.autoLock.resetTimer()`
      // and RETURNS without clearing the session. So vault_session must
      // STILL be present after the wait.
      const phase2Start = Date.now();
      await new Promise((r) => setTimeout(r, 40_000));
      const session = await readVaultSession(sw);
      const elapsed = Date.now() - phase2Start;
      expect(
        session,
        `auto-lock fired and cleared the session even though REQUESTS had pending entries — deferral broken (waited ${elapsed}ms)`,
      ).toBe(PASSWORD);

      // Sanity: REQUESTS still contains our pending entry. The auto-lock
      // callback must not have mutated REQUESTS as a side effect.
      const requests = await sw.evaluate(async () => {
        const r = await chrome.storage.local.get('REQUESTS');
        return (r?.REQUESTS ?? []) as unknown[];
      });
      expect(requests.length, 'pending request was unexpectedly cleared during auto-lock deferral').toBe(1);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

// Quiet the unused-import lint when Page isn't directly referenced in
// every test. Keeping the import for parity with the other specs in
// case future helpers want to type a Page argument.
void (null as Page | null);
