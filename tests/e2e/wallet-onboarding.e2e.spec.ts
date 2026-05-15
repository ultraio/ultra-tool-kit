/**
 * End-to-end tests for the wallet's onboarding paths:
 *
 * 1. **Setup creates vault from password** — fresh user-data-dir → wallet UI
 *    at `/setup` → fill the two password inputs → click "Create Wallet" →
 *    assert encrypted vault file lands in chrome.storage.local with the
 *    expected EncryptedVault shape and `vault_session` is set in
 *    chrome.storage.session.
 *
 * 2. **Import private key adds entry to vault and Key Manager** — pre-seed
 *    an empty unlocked vault → wallet UI at `/add-account/import` → paste
 *    a known testnet private key → click "Import Key" → assert the encrypted
 *    vault's `publicKeys` array now contains the derived pubkey, and the
 *    Key Manager (`/keys`) renders a row for it (account name resolved via
 *    a mocked `get_accounts_by_authorizers`).
 *
 * 3. **Legacy two-file vault migrates to atomic format on first unlock** —
 *    pre-seed: write the OLD `EncryptedVault` blob WITHOUT a `publicKeys`
 *    field PLUS a separate `<hash>.keys.json` file containing the pubkey
 *    array. Set `vault_session` to drive an automatic unlock when the
 *    wallet boots. Open the wallet at `/home`. The `WalletGuard` calls
 *    `tryRestoreSession` which calls `vault.unlock(password)`, and
 *    `VaultService.unlock` performs the migration: rewrites the vault file
 *    in atomic format (publicKeys inlined into the EncryptedVault) and
 *    removes the legacy `.keys.json` file. We poll chrome.storage.local
 *    for the migrated shape.
 *
 * Each test uses its own `mkdtempSync` user-data-dir and cleans it up in
 * `finally` — extension load is per-context state and the persistent dir
 * needs to be fresh per test (especially test 1, which is "no seed").
 *
 * State-based polling (chrome.storage reads via sw.evaluate) is preferred
 * over DOM polling for the assertions: storage state is the load-bearing
 * outcome of these flows and is far less brittle than chasing post-Angular-
 * change-detection DOM transitions. DOM is only used to drive UI (the
 * setup form, the import form) — never to assert on outcome.
 *
 * Prereqs:
 *   - extension must be built at /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 *     via `npx nx build browser-extension-wallet --skip-nx-cache` in web-app.
 */

import { test, expect, chromium, BrowserContext, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');

// Password chosen to satisfy ALL of UltraValidators on the setup form:
// length ≥ 8, has lowercase, uppercase, special symbol, no 3-char alphabet/
// digit sequence (`abc`, `123`), no 3+ repeated chars. `TestPass123!` from the
// existing specs would fail `checkSequentialCharacter` because "123" is a
// substring of the digits dictionary used by UltraValidators.
const PASSWORD = 'Wq#7Pa!8Yz';
// Same testnet key pair used by the existing e2e specs — well-formed EOSIO
// pair; chain calls are intercepted so we don't need a real on-chain account.
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

// `simpleHash('ultra-extension-wallet')` (djb2) — see VaultService in
// authenticator-lib. The vault file key is `${hash}.json`; the legacy index
// is `${hash}.keys.json`. Hard-coded so the migration test can write the
// legacy file without re-implementing the hash here.
const VAULT_HASH = '04815a93';
const VAULT_FILE = `${VAULT_HASH}.json`;
const LEGACY_KEYS_FILE = `${VAULT_HASH}.keys.json`;

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
 * Mock the chain RPC paths the wallet hits during import + key-manager
 * resolution. Catch-all returns `{}` for any other `/v1/{chain,history,state}/*`
 * call so library probes don't escape to the real internet.
 */
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
 * Seed an UNLOCKED empty vault for tests that exercise post-setup paths
 * (import, key-manager). Uses the same encryption format as the existing
 * specs (PBKDF2-SHA256 / AES-GCM-256 / 900_000 iterations) so the wallet's
 * own decrypt path can read it back. The plaintext `keys` map is empty
 * here — the test will populate it via the UI's import flow.
 */
async function seedEmptyUnlockedVault(
  sw: Worker,
  cfg: { password: string; env: 'testnet' | 'mainnet'; vaultHash: string },
): Promise<void> {
  await sw.evaluate(async (cfg) => {
    const VAULT_FILE = `${cfg.vaultHash}.json`;

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

    // Empty vault — keys map is `{}`, accounts is empty. Matches
    // `createEmptyVault` in authenticator-lib's vault.types.
    const vaultPlaintext = { keys: {}, accounts: [] };
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
      publicKeys: [], // atomic format — empty list
    };

    await chrome.storage.local.set({
      [VAULT_FILE]: JSON.stringify(encryptedVault),
      ENVIRONMENT: cfg.env,
      TRUSTED_APPS: {},
      SELECTED_ACCOUNTS_BY_CHAIN: {},
    });

    // chrome.storage.session.vault_session is the silent-unlock token —
    // tryRestoreSession reads it and calls vault.unlock(password) without
    // prompting the user. Required so the post-import navigation doesn't
    // bounce through the unlock screen.
    await chrome.storage.session.set({ vault_session: cfg.password });
  }, cfg);
}

/**
 * Seed a LEGACY two-file vault for the migration test: an EncryptedVault
 * blob WITHOUT a `publicKeys` field, plus a separate `<hash>.keys.json`
 * file containing the public-key array. `vault_session` is set so
 * `WalletGuard` triggers `tryRestoreSession` → `vault.unlock(password)`
 * → migration on first wallet load.
 *
 * Plaintext shape mirrors the `keys[pub] = { publicKey, privateKey,
 * addedAt, source }` map produced by `vault.addKey` and matches the
 * existing specs' seedExtensionState exactly — the post-migration vault
 * must decrypt to the same plaintext.
 */
async function seedLegacyTwoFileVault(
  sw: Worker,
  cfg: {
    password: string;
    pubKey: string;
    privKey: string;
    env: 'testnet' | 'mainnet';
    vaultFile: string;
    legacyKeysFile: string;
  },
): Promise<void> {
  await sw.evaluate(async (cfg) => {
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

    // KEY DETAIL: legacy format — no `publicKeys` field on the
    // EncryptedVault blob. The old code stored the pubkey array in a
    // separate `<hash>.keys.json` file.
    const legacyEncryptedVault = {
      salt: toHex(salt),
      iv: toHex(iv),
      ciphertext: toHex(ciphertext),
      iterations: ITERATIONS,
      // (no publicKeys field — this is what makes it legacy)
    };

    await chrome.storage.local.set({
      [cfg.vaultFile]: JSON.stringify(legacyEncryptedVault),
      [cfg.legacyKeysFile]: JSON.stringify([cfg.pubKey]),
      ENVIRONMENT: cfg.env,
      TRUSTED_APPS: {},
      SELECTED_ACCOUNTS_BY_CHAIN: {},
    });
    await chrome.storage.session.set({ vault_session: cfg.password });
  }, cfg);
}

/** Read the EncryptedVault blob from chrome.storage.local. */
async function readEncryptedVault(sw: Worker, vaultFile: string): Promise<{
  salt?: string;
  iv?: string;
  ciphertext?: string;
  iterations?: number;
  publicKeys?: string[];
} | null> {
  return sw.evaluate(async (key) => {
    const r = await chrome.storage.local.get(key);
    const raw = r?.[key];
    if (typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, vaultFile);
}

// ── Tests ──────────────────────────────────────────────────────────────────

// MV3 service-worker boot + Angular bootstrap is much slower than the default
// 30s test timeout in playwright.config.ts. 120s matches the existing two
// e2e specs' override.
test.describe.configure({ timeout: 120_000 });

test.describe('Wallet onboarding (real extension)', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Build it first via "npx nx build browser-extension-wallet --skip-nx-cache" in web-app.`,
      );
    }
  });

  test('Setup creates vault from password', async () => {
    // Fresh user-data-dir — no pre-seeded storage. The wallet's
    // WalletGuard sees `isVaultCreated() === false` and routes us to
    // `/setup`. We then drive the create-wallet form ourselves.
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-onboarding-setup-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);
      await mockChainRPC(context);

      // Pre-state sanity: the vault file should not exist yet.
      const before = await readEncryptedVault(sw, VAULT_FILE);
      expect(before, 'expected no vault file pre-setup').toBeNull();

      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/index.html#/setup`);

      // Wait for both password inputs to be in the DOM. Setup form has
      // `placeholder="New password"` on the first and `Confirm password`
      // on the second — semantic enough to identify without an
      // autotest hook. ultra-input wraps a native <input type="password">,
      // so the [type="password"] selector matches via DOM bubble-up.
      const passwordInputs = page.locator('input[type="password"]');
      await expect(passwordInputs).toHaveCount(2, { timeout: 30_000 });

      await passwordInputs.nth(0).fill(PASSWORD);
      await passwordInputs.nth(1).fill(PASSWORD);

      // ultra-block-button renders a native <button> with the title text
      // inside. Click via text — `Create Wallet` is unique on this view.
      await page.locator('button:has-text("Create Wallet")').click();

      // SetupComponent.onSubmit awaits vault.create(password) → persist()
      // → chrome.storage.local.set(VAULT_FILE, ...). Then persistSession()
      // sets vault_session. Both writes are async but small — poll on
      // both keys to converge.
      await expect
        .poll(
          async () => readEncryptedVault(sw, VAULT_FILE),
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: `vault file ${VAULT_FILE} never appeared after Create Wallet click`,
          },
        )
        .not.toBeNull();

      const vault = await readEncryptedVault(sw, VAULT_FILE);
      // Shape assertion — every required EncryptedVault field present.
      expect(vault).toBeTruthy();
      expect(typeof vault!.salt).toBe('string');
      expect(vault!.salt!.length).toBeGreaterThan(0);
      expect(typeof vault!.iv).toBe('string');
      expect(vault!.iv!.length).toBeGreaterThan(0);
      expect(typeof vault!.ciphertext).toBe('string');
      expect(vault!.ciphertext!.length).toBeGreaterThan(0);
      expect(vault!.iterations).toBe(900_000);
      // Atomic-format invariant: publicKeys present and is an array (empty
      // until the user imports a key — this is the post-setup state).
      expect(Array.isArray(vault!.publicKeys)).toBe(true);
      expect(vault!.publicKeys).toEqual([]);

      // Session state: vault_session contains the password we entered, so
      // subsequent guards can silently unlock without a prompt.
      const sessionPassword = await sw.evaluate(async () => {
        const r = await chrome.storage.session.get('vault_session');
        return r?.vault_session;
      });
      expect(sessionPassword).toBe(PASSWORD);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Import private key adds entry to vault and Key Manager', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-onboarding-import-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);
      // Pre-seed an UNLOCKED empty vault — the import path needs an
      // already-created vault to call `vault.addKey` on. seedEmptyUnlockedVault
      // mirrors the post-setup state of test 1 so the import flow can run
      // standalone.
      await seedEmptyUnlockedVault(sw, { password: PASSWORD, env: 'testnet', vaultHash: VAULT_HASH });
      await mockChainRPC(context);

      // RE-register the specific get_accounts_by_authorizers handler AFTER
      // mockChainRPC so it takes precedence over mockChainRPC's catch-all
      // regex (`/\/v1\/(chain|history|state)\//` returning `{}`). Playwright
      // evaluates route handlers in reverse-registration order: without this
      // override, the catch-all swallows get_accounts_by_authorizers and the
      // Key Manager renders "No account on this network".
      //
      // The existing two e2e specs don't hit this issue because they always
      // pre-seed `account_resolution_cache` — so post-import key resolution
      // never reaches the chain. Our test invalidates the cache via the
      // import flow, so the chain RPC must actually return real data.
      await context.route('**/v1/chain/get_accounts_by_authorizers', async (route) => {
        const isTestnet = /testnet|test\./.test(new URL(route.request().url()).host);
        const accountName = isTestnet ? 'tnetacct.test' : 'mnetacct.main';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            accounts: [{ account_name: accountName, permission_name: 'active', authorizing_key: PUB_KEY }],
          }),
        });
      });

      const page = await context.newPage();
      // Step 1: visit `/home` first. The `WalletGuard` runs there, sees the
      // vault file exists but the in-memory `VaultService` is locked, then
      // calls `tryRestoreSession` which reads `vault_session` and calls
      // `vault.unlock(password)`. The vault is now unlocked in-memory for
      // the lifetime of this Angular bootstrap. Navigating directly to
      // `/add-account/import` skips this guard (the route lives outside
      // the WalletGuard'd parent), and `vault.addKey` would throw
      // "Vault is locked".
      await page.goto(`chrome-extension://${extId}/index.html#/home`);
      // Wait for the unlock to land in memory — the easiest signal is the
      // home view replacing the bootstrap shell. We check via DOM presence
      // of an `ultra-home-view` host element (the home view's selector).
      await expect
        .poll(
          async () =>
            await page.evaluate(() => document.querySelector('ultra-home-view') !== null).catch(() => false),
          { timeout: 30_000, intervals: [200, 500, 1000], message: 'home view never mounted after silent unlock' },
        )
        .toBe(true);

      // Step 2: now navigate to the import form. The Angular router stays
      // within the same SPA bootstrap so the unlocked VaultService instance
      // persists.
      await page.goto(`chrome-extension://${extId}/index.html#/add-account/import`);

      // The Import form has a single password-typed input for the private
      // key. ultra-input renders a native <input type="password">.
      const privKeyInput = page.locator('input[type="password"]');
      await expect(privKeyInput).toHaveCount(1, { timeout: 30_000 });
      await privKeyInput.fill(PRIV_KEY);

      // Click the Import Key button — text is unique on this view.
      await page.locator('button:has-text("Import Key")').click();

      // AddImportAccountComponent.onImport awaits:
      //   1. provider.validatePrivateKey + derivePublicKey (sync)
      //   2. vault.addKey(privateKey, publicKey, 'import') — persists
      //      EncryptedVault with the new pubkey in publicKeys.
      //   3. provider.discoverAccounts(publicKey) — chain RPC, mocked.
      //   4. router.navigate(['/home']).
      // Poll for the publicKeys array containing the imported pubkey —
      // step 2's disk persist is the load-bearing outcome.
      await expect
        .poll(
          async () => {
            const v = await readEncryptedVault(sw, VAULT_FILE);
            return v?.publicKeys ?? null;
          },
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: 'EncryptedVault.publicKeys never gained the imported pubkey',
          },
        )
        .toEqual([PUB_KEY]);

      // Drive to the Key Manager. The view loads, calls
      // `getAccountsByAuthorizers` (mocked → returns tnetacct.test), then
      // renders one row per pubkey with the resolved account name. We
      // assert on the visible account name + a key.publicKey attribute on
      // the [title] of the truncated key span — the row's title includes
      // the full pubkey so it's a robust DOM signal.
      await page.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page.waitForLoadState('load');

      // The key-list renders `<span class="key-text" [title]="key.publicKey">`
      // — wait until that title attribute matches our imported pubkey. This
      // proves both that the vault was rehydrated AND that the row rendered.
      await expect
        .poll(
          async () =>
            await page.evaluate(() => {
              const spans = Array.from(document.querySelectorAll('.key-text')) as HTMLElement[];
              return spans.map((s) => s.getAttribute('title') ?? '');
            }),
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: 'Key Manager row never rendered for imported pubkey',
          },
        )
        .toContain(PUB_KEY);

      // Cross-check: the resolved account name is also visible. The row
      // template renders `{{ key.accountNames.join(', ') }}` when the
      // chain returned at least one account. tnetacct.test is what our
      // mocked get_accounts_by_authorizers returns for the testnet host.
      try {
        await expect
          .poll(
            async () =>
              await page.evaluate(() =>
                Array.from(document.querySelectorAll('.key-item__summary')).some(
                  (el) => (el as HTMLElement).innerText.includes('tnetacct.test'),
                ),
              ),
            {
              timeout: 30_000,
              intervals: [200, 500, 1000],
              message: 'Key Manager row did not render the chain-resolved account name',
            },
          )
          .toBe(true);
      } catch (err) {
        const rowText = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('.key-item__summary')) as HTMLElement[];
          return els.map((e) => e.innerText);
        });
        const cache = await sw.evaluate(async () => {
          const r = await chrome.storage.session.get('account_resolution_cache');
          return r?.account_resolution_cache ?? null;
        });
        console.log('=== KEY MANAGER DIAG ===');
        console.log('row inner text:', JSON.stringify(rowText));
        console.log('account_resolution_cache:', JSON.stringify(cache));
        console.log('chain calls intercepted:', JSON.stringify(chainCalls));
        throw err;
      }
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Legacy two-file vault migrates to atomic format on first unlock', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-onboarding-migrate-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      const extId = await getExtensionId(sw);

      // Pre-seed a LEGACY two-file vault. vault_session is set, so when
      // the wallet boots and WalletGuard runs `tryRestoreSession`, it'll
      // call `vault.unlock(password)` which performs the migration:
      //   1. Read legacy EncryptedVault (no publicKeys field)
      //   2. Decrypt → derive publicKeys from Object.keys(vault.keys)
      //   3. Persist atomic-format vault (publicKeys inlined)
      //   4. Remove legacy `.keys.json` file
      await seedLegacyTwoFileVault(sw, {
        password: PASSWORD,
        pubKey: PUB_KEY,
        privKey: PRIV_KEY,
        env: 'testnet',
        vaultFile: VAULT_FILE,
        legacyKeysFile: LEGACY_KEYS_FILE,
      });
      await mockChainRPC(context);

      // Sanity-check the seed wrote what we expect: legacy vault present,
      // legacy keys file present, NO publicKeys field on the vault blob.
      const seeded = await readEncryptedVault(sw, VAULT_FILE);
      expect(seeded).toBeTruthy();
      expect(seeded!.publicKeys, 'seed must NOT have publicKeys field — that is the legacy invariant').toBeUndefined();
      const legacyKeysSeed = await sw.evaluate(async (key) => {
        const r = await chrome.storage.local.get(key);
        return r?.[key] ?? null;
      }, LEGACY_KEYS_FILE);
      expect(legacyKeysSeed, 'legacy .keys.json file must be present pre-unlock').toBeTruthy();

      // Boot the wallet at /home — WalletGuard sees a vault file exists,
      // sees vault not yet unlocked in memory, calls tryRestoreSession,
      // which unlocks → migrates.
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/index.html#/home`);
      await page.waitForLoadState('load');

      // Poll for the migration to complete — both invariants must hold:
      //   (a) EncryptedVault now has publicKeys: [PUB_KEY] inlined
      //   (b) Legacy `.keys.json` file is gone from chrome.storage.local
      // Combine into one poll so we don't observe a half-migrated state.
      await expect
        .poll(
          async () => {
            const vault = await readEncryptedVault(sw, VAULT_FILE);
            const legacyStillThere = await sw.evaluate(async (key) => {
              const r = await chrome.storage.local.get(key);
              return r?.[key] != null;
            }, LEGACY_KEYS_FILE);
            return {
              publicKeys: vault?.publicKeys ?? null,
              legacyStillThere,
            };
          },
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message:
              'legacy two-file vault never migrated to atomic format — expected publicKeys inlined and .keys.json removed',
          },
        )
        .toEqual({ publicKeys: [PUB_KEY], legacyStillThere: false });

      // Final shape check on the post-migration EncryptedVault — every
      // atomic-format invariant should hold.
      const after = await readEncryptedVault(sw, VAULT_FILE);
      expect(after).toBeTruthy();
      expect(typeof after!.salt).toBe('string');
      expect(typeof after!.iv).toBe('string');
      expect(typeof after!.ciphertext).toBe('string');
      expect(after!.iterations).toBe(900_000);
      expect(after!.publicKeys).toEqual([PUB_KEY]);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
