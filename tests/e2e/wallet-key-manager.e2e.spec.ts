/**
 * End-to-end tests for the Key Manager (`/keys`) view of the wallet
 * extension. Pins four user-visible behaviours:
 *
 *   1. The list renders all keys returned by `vault.listPublicKeys()` and
 *      attaches the chain-resolved account name to each row.
 *   2. The Copy icon writes the full pubkey (not the truncated form) to the
 *      system clipboard.
 *   3. Export reveals the seeded private key when the password is correct
 *      and surfaces "Incorrect password" otherwise.
 *   4. Delete removes the row when the password is correct, AND falls
 *      through to the orphan-tolerant bypass when `vault.exportKey` throws
 *      "Key not found" (the OAuth-tab/popup write-race remediation in
 *      keys.component.ts:onConfirmDelete).
 *
 * Harness: same shape as the other wallet-* e2e specs — real extension
 * loaded via `chromium.launchPersistentContext`, vault seeded
 * programmatically through `chrome.storage.local`, chain RPC mocked at
 * the network layer. We open the wallet UI as a regular tab via
 * `chrome-extension://${extId}/index.html#/keys`; `WalletGuard` runs
 * `tryRestoreSession` which silent-unlocks from the seeded `vault_session`.
 *
 * Prereqs:
 *   - extension built at /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 *     (the toolkit dev server is unused — these tests don't open localhost:5172)
 */

import { test, expect, chromium, BrowserContext, Page, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');

const PASSWORD = 'TestPass123!';
const WRONG_PASSWORD = 'wrong-password!';

// Two well-formed EOSIO keypairs — chain-resolve calls are mocked, so the
// cryptographic correctness of the pair only matters insofar as the AES-GCM
// round-trip preserves the strings (it does — the values are opaque to the
// vault). Distinct keys so the list-rendering test can verify both rows
// appear and carry their distinct account names.
const PRIV_KEY_A = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY_A = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

const PRIV_KEY_B = '5JdeC9P7Pbd1uGdFVEsJ41EkEnADbbHGq6p1BwFBm5j8oXvWNCw';
const PUB_KEY_B = 'EOS5MJxQ6w7iBQzqNCsNtpjT2QqbmxfbqfZUiDibBNz9LLVSeFGDB';

const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';

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
 * format (PBKDF2-SHA256 / 900_000 iterations / AES-GCM-256). Same shape as
 * the seed helpers in wallet-network-sync / wallet-disconnect-connect /
 * wallet-eba-registration — kept inline (not imported from a shared util)
 * so a regression in one suite cannot cascade into the others.
 *
 * `keys` is a record of {pubKey: privKey}; the vault file is written with
 * `EncryptedVault.publicKeys` mirroring those entries' keys. Pre-seeded
 * `vault_session` carries the password so `WalletGuard.tryRestoreSession`
 * silent-unlocks on the first wallet-tab visit.
 */
async function seedVault(
  sw: Worker,
  cfg: {
    password: string;
    keys: Record<string, string>;
    env: 'testnet' | 'mainnet';
    /**
     * Optional: pre-populate AccountCacheService's per-network cache so the
     * Key Manager renders account names on first paint without depending
     * on the live chain RPC. Map of pubKey → accountName.
     */
    cachedAccounts?: Record<string, string>;
    /**
     * Optional override for the cache slot's `publicKeys` array. Use when
     * the running vault's `listPublicKeys()` will include keys that aren't
     * in `keys` — e.g. the orphan-injection patch in the delete test.
     */
    cachedPublicKeys?: string[];
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

    interface VaultKeyEntry {
      publicKey: string;
      privateKey: string;
      addedAt: number;
      source: string;
    }
    const keysMap: Record<string, VaultKeyEntry> = {};
    for (const [pub, priv] of Object.entries(cfg.keys)) {
      keysMap[pub] = { publicKey: pub, privateKey: priv, addedAt: Date.now(), source: 'import' };
    }

    const vaultPlaintext = { keys: keysMap, accounts: [] };
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
      publicKeys: Object.keys(cfg.keys),
    };

    await chrome.storage.local.set({
      [VAULT_FILE]: JSON.stringify(encryptedVault),
      ENVIRONMENT: cfg.env,
      TRUSTED_APPS: {},
      SELECTED_ACCOUNTS_BY_CHAIN: {},
    });

    const sessionSet: Record<string, unknown> = { vault_session: cfg.password };
    if (cfg.cachedAccounts) {
      const entries = Object.entries(cfg.cachedAccounts).map(([authorizing_key, account]) => ({
        account,
        permission: 'active',
        authorizing_key,
      }));
      // keysMatch sorts both sides — supply the cache.publicKeys override
      // when the running vault's listPublicKeys() will diverge from
      // Object.keys(cfg.keys), e.g. when the orphan-injection patch in the
      // delete test adds an extra pubkey that's not in the encrypted map.
      const cachedPublicKeys = cfg.cachedPublicKeys ?? Object.keys(cfg.keys);
      sessionSet.account_resolution_cache = {
        [cfg.env]: {
          entries,
          timestamp: Date.now(),
          publicKeys: [...cachedPublicKeys].sort(),
        },
      };
    }
    // vault_session = password — used by silent-restore on side-panel boot.
    await chrome.storage.session.set(sessionSet);
  }, cfg);
}

/**
 * Mock chain RPC so the keys component's `AccountCacheService.resolve` path
 * returns deterministic account names. `resolutions` maps each pubkey to
 * the account that should appear in its row.
 */
async function mockChainRPC(
  context: BrowserContext,
  resolutions: Record<string, string>,
): Promise<void> {
  await context.route('**/v1/chain/get_info', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        server_version: '0',
        chain_id: TESTNET_CHAIN,
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
    let body: { keys?: string[] } = {};
    try {
      body = JSON.parse(route.request().postData() ?? '{}');
    } catch {
      // ignore malformed body
    }
    const requestedKeys = Array.isArray(body.keys) ? body.keys : [];
    const accounts = requestedKeys
      .filter((k) => k in resolutions)
      .map((k) => ({ account_name: resolutions[k], permission_name: 'active', authorizing_key: k }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ accounts }),
    });
  });

  // Catch-all so any other /v1/chain/* doesn't 404.
  await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Read the `.key-item` rows currently rendered by Key Manager. Each entry
 * is `{ pubKey, accountText, isOrphan }`. `pubKey` comes from `[title]` on
 * `.key-text` (full key — the row visibly truncates), `accountText` from
 * the per-row account-name line, `isOrphan` from the "Re-add needed" badge.
 */
async function readKeyRows(
  page: Page,
): Promise<Array<{ pubKey: string; accountText: string; isOrphan: boolean }>> {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.key-item')) as HTMLElement[];
    return rows.map((row) => {
      const keyEl = row.querySelector('.key-text') as HTMLElement | null;
      const pubKey = (keyEl?.getAttribute('title') ?? keyEl?.textContent ?? '').trim();

      // The account-name line is the second child block under the row's
      // first column — `.b3-regular.text-white-alpha-5.mt-1.text-truncate`.
      const acctEl = row.querySelector('.key-item__summary .b3-regular.text-white-alpha-5');
      const accountText = (acctEl?.textContent ?? '').trim();

      // Orphan badge: a `.text-red-light` span carrying "Re-add needed"
      // text. We just look for the class/text.
      const orphanBadge = row.querySelector('.text-red-light');
      const isOrphan = !!orphanBadge;

      return { pubKey, accountText, isOrphan };
    });
  });
}

/** Click the i-th row's icon button identified by aria-label. */
async function clickRowAction(page: Page, rowIndex: number, ariaLabel: string): Promise<void> {
  const row = page.locator('.key-item').nth(rowIndex);
  await row.locator(`[aria-label="${ariaLabel}"]`).click();
}

/**
 * Type into the password input that's currently rendered inside the
 * expanded row's action form. There's only ever one such input visible
 * at a time, so the page-wide selector is unambiguous.
 */
async function typePassword(page: Page, password: string): Promise<void> {
  const input = page.locator('.key-item__expanded input[type="password"], .key-item__expanded input[type="text"]').first();
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill(password);
}

/** Click the form's primary submit button (Confirm / Delete). It's the first `<button>` inside the form. */
async function clickFormSubmit(page: Page): Promise<void> {
  // The submit lives at `.key-item__expanded form button.btn` — `ultra-block-button`'s
  // template renders a `<button class="btn ...">` and the submit one comes
  // before the cancel one in DOM order.
  const submit = page.locator('.key-item__expanded form button.btn').first();
  await submit.click();
}

/** Click the form's Cancel button (the second `<button>` inside the form). */
async function clickFormCancel(page: Page): Promise<void> {
  const cancel = page.locator('.key-item__expanded form button.btn').nth(1);
  await cancel.click();
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe.configure({ timeout: 120_000 });

test.describe('Wallet Key Manager (real extension)', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Build it first via "npx nx build browser-extension-wallet -c=production" in web-app.`,
      );
    }
  });

  test('List renders all keys with chain-resolved account names', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-keys-list-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedVault(sw, {
        password: PASSWORD,
        keys: { [PUB_KEY_A]: PRIV_KEY_A, [PUB_KEY_B]: PRIV_KEY_B },
        env: 'testnet',
        // Pre-seeding the resolution cache makes the rows render with their
        // account names on first paint — getCachedForDisplay returns the
        // entries before any chain RTT. The chain RPC mock below covers
        // the SWR refresh path that fires when isStale returns true.
        cachedAccounts: { [PUB_KEY_A]: 'accta.test', [PUB_KEY_B]: 'acctb.test' },
      });
      await mockChainRPC(context, {
        [PUB_KEY_A]: 'accta.test',
        [PUB_KEY_B]: 'acctb.test',
      });

      const extId = await sw.evaluate(() => chrome.runtime.id);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page.waitForLoadState('load');

      // Wait for the chain-resolve to populate the account-name lines.
      // Pre-resolve the row list shows the truncated pubkey + "No account
      // on this network"; once `AccountCacheService.resolve` returns the
      // account name lands in the second line.
      await expect
        .poll(
          async () => {
            const rows = await readKeyRows(page);
            return rows.map((r) => ({ pubKey: r.pubKey, accountText: r.accountText })).sort((a, b) =>
              a.pubKey.localeCompare(b.pubKey),
            );
          },
          {
            timeout: 30_000,
            intervals: [200, 500, 1000],
            message: 'Key Manager rows did not render with both seeded keys + chain-resolved account names',
          },
        )
        .toEqual(
          [
            { pubKey: PUB_KEY_A, accountText: 'accta.test' },
            { pubKey: PUB_KEY_B, accountText: 'acctb.test' },
          ].sort((a, b) => a.pubKey.localeCompare(b.pubKey)),
        );

      // Sanity: the visible truncated key follows the
      // `truncateKey(pk) = pk[0..12] ...pk[-8..]` shape from keys.component.ts.
      // We assert this on the first row to pin the formatting.
      const firstRowVisibleKey = await page
        .locator('.key-item .key-text')
        .first()
        .innerText();
      expect(firstRowVisibleKey).toMatch(/^EOS[1-9A-HJ-NP-Za-km-z]{9}\.\.\.[1-9A-HJ-NP-Za-km-z]{8}$/);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Copy public key writes the full key to the clipboard', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-keys-copy-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedVault(sw, {
        password: PASSWORD,
        keys: { [PUB_KEY_A]: PRIV_KEY_A },
        env: 'testnet',
        cachedAccounts: { [PUB_KEY_A]: 'accta.test' },
      });
      await mockChainRPC(context, { [PUB_KEY_A]: 'accta.test' });

      const extId = await sw.evaluate(() => chrome.runtime.id);

      // Clipboard read/write is permission-gated. chrome-extension:// is an
      // opaque origin to Playwright (`grantPermissions({origin: ...})` will
      // throw "Permission can't be granted to opaque origins"), so grant
      // context-wide. Effect at runtime: every origin in this context can
      // read/write the clipboard, which is fine for a test fixture.
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);

      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page.waitForLoadState('load');

      // Wait for the row to render before clicking Copy.
      await expect
        .poll(async () => (await readKeyRows(page)).length, {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'Key Manager row did not render in time',
        })
        .toBe(1);

      await clickRowAction(page, 0, 'Copy public key');

      // The handler is sync; clipboard write happens immediately. Poll
      // because Playwright's clipboard API can momentarily report the
      // pre-write state in CI.
      await expect
        .poll(async () => page.evaluate(() => navigator.clipboard.readText()), {
          timeout: 5_000,
          intervals: [100, 200, 500],
          message: 'clipboard never received the full pubkey',
        })
        .toBe(PUB_KEY_A);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Export with right password reveals the private key; wrong password rejects', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-keys-export-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedVault(sw, {
        password: PASSWORD,
        keys: { [PUB_KEY_A]: PRIV_KEY_A },
        env: 'testnet',
        cachedAccounts: { [PUB_KEY_A]: 'accta.test' },
      });
      await mockChainRPC(context, { [PUB_KEY_A]: 'accta.test' });

      const extId = await sw.evaluate(() => chrome.runtime.id);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page.waitForLoadState('load');

      await expect
        .poll(async () => (await readKeyRows(page)).length, {
          timeout: 30_000,
          intervals: [200, 500, 1000],
        })
        .toBe(1);

      // ── Wrong-password path ─────────────────────────────────────────
      await clickRowAction(page, 0, 'Export private key');
      await typePassword(page, WRONG_PASSWORD);
      await clickFormSubmit(page);

      // The component sets `actionError = 'Incorrect password'` on any
      // exportKey throw. The text renders in `.b3-regular.text-danger`.
      await expect(page.locator('.key-item__expanded .text-danger', { hasText: 'Incorrect password' })).toBeVisible({
        timeout: 10_000,
      });

      // The private key view must NOT have rendered.
      await expect(page.locator('.private-key-text')).toHaveCount(0);

      // Cancel out and re-open Export so the form re-mounts in pristine state.
      await clickFormCancel(page);

      // ── Right-password path ─────────────────────────────────────────
      await clickRowAction(page, 0, 'Export private key');
      await typePassword(page, PASSWORD);
      await clickFormSubmit(page);

      // The exported private key is rendered hidden behind dots until the
      // user toggles it. Click the eye icon to reveal, then read the text.
      const privateKeyDiv = page.locator('.private-key-text');
      await privateKeyDiv.waitFor({ state: 'visible', timeout: 15_000 });

      // Toggle visibility — the eye icon sits next to the masked text.
      // It's an `<i class="icon ... icon-eye-on">` (visibility off) or
      // `icon-eye-off` (visibility on); `.cursor-pointer` is unique to it.
      await page.locator('.key-item__expanded .icon.cursor-pointer').first().click();

      await expect
        .poll(
          async () => (await privateKeyDiv.innerText()).trim(),
          {
            timeout: 10_000,
            intervals: [100, 200, 500],
            message: 'private key text never updated to the seeded value after toggling visibility',
          },
        )
        .toBe(PRIV_KEY_A);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('Delete: regular key requires password; orphan key bypasses password (Re-add needed)', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-keys-delete-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
      const sw = await getServiceWorker(context);
      await seedVault(sw, {
        password: PASSWORD,
        keys: { [PUB_KEY_A]: PRIV_KEY_A },
        env: 'testnet',
        // Cache covers both real and orphan keys so the rows render with
        // their account names without a chain RTT. The orphan won't actually
        // resolve on chain in production, but for the test we only care
        // that "acctb.test" appears next to the orphan row.
        cachedAccounts: { [PUB_KEY_A]: 'accta.test', [PUB_KEY_B]: 'acctb.test' },
        // Vault's listPublicKeys() will include PUB_KEY_B post-patch, so
        // the cache slot must too — otherwise keysMatch fails and the cache
        // is bypassed.
        cachedPublicKeys: [PUB_KEY_A, PUB_KEY_B],
      });
      await mockChainRPC(context, {
        [PUB_KEY_A]: 'accta.test',
        [PUB_KEY_B]: 'acctb.test',
      });

      const extId = await sw.evaluate(() => chrome.runtime.id);
      const page = await context.newPage();

      // ── Orphan-injection hook ──────────────────────────────────────────
      // The wallet's VaultService derives `this.publicKeys` post-unlock as
      // `Object.keys(vault.keys)` (vault.service.ts:73). To exercise the
      // orphan-tolerant branch in keys.component.ts:onConfirmDelete (the
      // "Key not found" → bypass-password → removeKey path), the running
      // vault must hold a pubkey in `this.publicKeys` that is missing from
      // `this.vault.keys`. Production paths self-heal this state, so we
      // synthesise it via a narrowly-scoped Object.keys patch installed
      // in the page context BEFORE the extension's bundle evaluates:
      //   - detect calls where the argument is a small object whose values
      //     all match the VaultEntry shape `{publicKey, privateKey, addedAt,
      //     source}` — that is, vault.keys
      //   - return the natural keys plus our injected orphan pubkey
      // Effect at runtime:
      //   * unlock's `Object.keys(vault.keys)` line returns [PUB_KEY_A, ORPHAN_KEY]
      //     → vault.publicKeys = both
      //   * vault.keys is unchanged (still { PUB_KEY_A only }) → orphan
      //   * keys.component sees 2 rows; PUB_KEY_B is flagged orphan because
      //     `getPrivateKey(PUB_KEY_B)` throws "Key not found"
      // Detection condition is specific enough to leave every other
      // Object.keys callsite untouched — Angular's framework code never
      // traverses an object whose values look like vault entries.
      await page.addInitScript((orphanKey) => {
        const origKeys = Object.keys.bind(Object);
        const isVaultKeysShape = (obj: unknown): boolean => {
          if (!obj || typeof obj !== 'object') return false;
          const keys = origKeys(obj);
          // Only patch the populated case — once the user deletes every
          // real key, vault.keys is `{}` and the natural Object.keys is `[]`.
          // Returning `[orphan]` from there would reintroduce the orphan
          // after the bypass-on-delete has already removed it.
          if (keys.length === 0 || keys.length > 16) return false;
          for (const k of keys) {
            const v = (obj as Record<string, unknown>)[k];
            if (!v || typeof v !== 'object') return false;
            const e = v as Record<string, unknown>;
            if (typeof e.publicKey !== 'string') return false;
            if (typeof e.privateKey !== 'string') return false;
            if (typeof e.addedAt !== 'number') return false;
            if (typeof e.source !== 'string') return false;
            if (e.publicKey !== k) return false;
          }
          return true;
        };
        // A toggle on `globalThis` lets the test disable orphan injection
        // mid-run (e.g. after the orphan has been deleted, to keep
        // subsequent loadKeys re-renders honest about the empty state).
        interface OrphanInjectGlobals {
          __orphanInjectActive?: boolean;
        }
        (globalThis as unknown as OrphanInjectGlobals).__orphanInjectActive = true;
        Object.keys = function patchedKeys(obj: object): string[] {
          const ks = origKeys(obj);
          const active = (globalThis as unknown as OrphanInjectGlobals).__orphanInjectActive;
          if (active && isVaultKeysShape(obj) && !ks.includes(orphanKey)) {
            return [...ks, orphanKey];
          }
          return ks;
        } as typeof Object.keys;
      }, PUB_KEY_B);

      await page.goto(`chrome-extension://${extId}/index.html#/keys`);
      await page.waitForLoadState('load');

      // Two rows render: the real PUB_KEY_A and the synthetic orphan PUB_KEY_B.
      await expect
        .poll(async () => (await readKeyRows(page)).length, {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'orphan-injection failed to surface a second row in Key Manager',
        })
        .toBe(2);

      const initialRows = await readKeyRows(page);
      const orphanRow = initialRows.find((r) => r.pubKey === PUB_KEY_B);
      const realRow = initialRows.find((r) => r.pubKey === PUB_KEY_A);
      expect(orphanRow, 'orphan row missing — Object.keys patch did not take effect').toBeDefined();
      expect(realRow, 'real-key row missing').toBeDefined();
      expect(orphanRow!.isOrphan, '"Re-add needed" badge missing on orphan row').toBe(true);
      expect(realRow!.isOrphan, 'real-key row should not be flagged as orphan').toBe(false);

      // ── 4a. Regular-key delete: wrong password → error; right password → row removed ──
      // Find the row index of the real key. Rows track by `key.publicKey`,
      // matching the @for directive — the order in the DOM matches
      // `filteredKeys` which preserves the insertion order. The real key
      // was added first, the orphan second.
      const realIndex = initialRows.findIndex((r) => r.pubKey === PUB_KEY_A);

      await clickRowAction(page, realIndex, 'Delete key');
      await typePassword(page, WRONG_PASSWORD);
      await clickFormSubmit(page);
      await expect(page.locator('.key-item__expanded .text-danger', { hasText: 'Incorrect password' })).toBeVisible({
        timeout: 10_000,
      });

      // Submit again with the correct password — onConfirmDelete calls
      // exportKey (re-reads disk, decrypts), then finishKeyRemoval which
      // calls vault.removeKey + invalidate cache + reload list.
      await typePassword(page, PASSWORD);
      await clickFormSubmit(page);

      // Wait for the real-key row to disappear. The orphan row should still
      // be there, because we deleted only the real key.
      await expect
        .poll(
          async () => {
            const rows = await readKeyRows(page);
            return rows.map((r) => r.pubKey).sort();
          },
          {
            timeout: 15_000,
            intervals: [200, 500, 1000],
            message: 'regular-key delete did not remove the row from Key Manager',
          },
        )
        .toEqual([PUB_KEY_B]);

      // ── 4b. Orphan delete: bypass-on-Key-not-found ─────────────────
      // After 4a, the in-memory vault has been persisted with
      //   - vault.keys = {}              (real key removed)
      //   - publicKeys = [PUB_KEY_B]     (orphan still present in the array)
      // → the next loadKeys renders a single orphan row.
      //
      // Disable orphan-injection so the patched Object.keys doesn't keep
      // re-injecting PUB_KEY_B every time vault.unlock or persist runs
      // Object.keys(vault.keys). The orphan is now naturally present in
      // the persisted EncryptedVault.publicKeys; we want subsequent reads
      // to reflect ONLY what the vault actually persists.
      interface OrphanInjectGlobals { __orphanInjectActive?: boolean }
      await page.evaluate(() => {
        (globalThis as unknown as OrphanInjectGlobals).__orphanInjectActive = false;
      });

      // Click Delete on the orphan (only row left, index 0). The component
      // calls vault.exportKey(PUB_KEY_B, password) which re-reads disk and
      // decrypts — so the password must be CORRECT (otherwise we get
      // "Incorrect password" from the OperationError, not the orphan
      // bypass). After decrypt: vault.keys[PUB_KEY_B] is undefined →
      // throws "Key not found" → catch branch matches /key not found/i →
      // bypass → finishKeyRemoval → vault.removeKey → publicKeys.filter.
      await clickRowAction(page, 0, 'Delete key');
      await typePassword(page, PASSWORD);
      await clickFormSubmit(page);

      // Empty state: keys.length === 0 renders the "No keys imported"
      // empty panel rather than any `.key-item`. We assert on the row
      // count.
      await expect
        .poll(async () => (await readKeyRows(page)).length, {
          timeout: 15_000,
          intervals: [200, 500, 1000],
          message: 'orphan delete did not clear the row — bypass-on-key-not-found path is broken',
        })
        .toBe(0);

      // No error message rendered: the bypass succeeded silently.
      await expect(page.locator('.key-item__expanded .text-danger')).toHaveCount(0);
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
