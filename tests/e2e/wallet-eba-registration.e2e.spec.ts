/**
 * End-to-end test: EBA registration — auth-tab key reaches Key Manager
 * via `tryRestoreSession({ forceRefresh: true })` after the OAuth callback.
 *
 * The flow being pinned:
 *   1. The auth tab (in production: `#/authentication`) runs
 *      `registerDeviceIfNeeded()`, which generates a new EBA keypair, calls
 *      `vault.addKey(privateKey, publicKey, 'eba')`, and writes the new
 *      encrypted vault to chrome.storage.local. It then writes
 *      `IS_AUTHENTICATED = { isAuthenticated: true, ... }` and closes.
 *   2. Meanwhile the side-panel/popup tab is sitting on
 *      `#/auth-required?redirectRoute=...`. Its `auth-required-view`
 *      observer fires on the IS_AUTHENTICATED storage change, calls
 *      `UnifiedWalletService.tryRestoreSession({ forceRefresh: true })`
 *      so the side-panel's in-memory vault picks up the auth-tab's write,
 *      then navigates to the redirectRoute.
 *   3. Navigating to `/keys` renders BOTH the original key AND the EBA
 *      key. Pre-fix (without `forceRefresh`), `tryRestoreSession` hit the
 *      "already unlocked → return true" fast path and never re-decrypted,
 *      so the side panel's `vault.keys` map stayed stale and Key Manager
 *      missed the new EBA key.
 *
 * Simplification vs the spec's two-test plan:
 * Driving the actual auth tab's `registerDeviceIfNeeded` requires bridging
 * the OAuth callback (Keycloak issuer, APP_INITIALIZER state, sessionStorage
 * `awaiting_auth_callback` flag) — too brittle for an e2e regression. We
 * instead simulate the auth-tab side directly: re-encrypt a NEW vault with
 * the extra EBA key from the BG service worker, write it to
 * chrome.storage.local, then flip IS_AUTHENTICATED. This exercises the
 * exact same side-panel observer code path that the production auth tab
 * triggers — and it's that observer's `forceRefresh: true` fix we're
 * pinning. The "already-linked early-return" test from the design doc
 * (would require the live auth tab) is dropped; the early-return logic
 * lives at L130 of authentication-view.component.ts and is unit-testable
 * separately.
 *
 * Prereqs:
 *   - extension built at /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 *   - playwright config's webServer not strictly required (no toolkit page)
 */

import { test, expect, chromium, BrowserContext, Worker, Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');

const PASSWORD = 'TestPass123!';
// Original imported key — pre-seeded into the vault and resolved on chain
// to `seeded.acct`. The pubkey/privkey pair just needs to be well-formed
// strings that survive AES-GCM round-trip; the chain-resolve mock pins
// the account name, so the actual cryptographic correctness of the
// secp256k1 pair doesn't matter for what this test asserts.
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

// Second pubkey used as the "EBA key" written by the simulated auth tab.
// Different shape from PUB_KEY so the chain-resolve mock can return a
// distinct account (`tneba.test`) for it.
const EBA_PRIV_KEY = '5JdeC9P7Pbd1uGdFVEsJ41EkEnADbbHGq6p1BwFBm5j8oXvWNCw';
const EBA_PUB_KEY = 'EOS5MJxQ6w7iBQzqNCsNtpjT2QqbmxfbqfZUiDibBNz9LLVSeFGDB';

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
 * format (PBKDF2-SHA256 / 900_000 iterations / AES-GCM-256). Identical
 * shape to the seedExtensionState helpers in wallet-network-sync /
 * wallet-disconnect-connect — kept inline (rather than imported from a
 * shared util) so a regression in one suite can't cascade into the
 * others, matching the existing pattern.
 *
 * Variant: `keys` is a record of {pubKey: privKey} pairs so we can seed a
 * vault containing 1 OR 2 keys (the EBA test uses both).
 */
async function seedVault(
  sw: Worker,
  cfg: { password: string; keys: Record<string, string>; env: 'testnet' | 'mainnet' },
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

    // vault_session = password — used by silent-restore on side-panel boot.
    await chrome.storage.session.set({ vault_session: cfg.password });
  }, cfg);
}

/** Mock chain RPC — returns deterministic accounts for the seeded pubkeys. */
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
      // ignore
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
 * Read the publicKeys array from the persisted vault file. We assert this
 * post-mutation to confirm our re-write took effect before the side panel's
 * forceRefresh runs.
 */
async function readVaultPublicKeys(sw: Worker): Promise<string[]> {
  return sw.evaluate(async () => {
    const simpleHash = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
      return Math.abs(h).toString(16).padStart(8, '0');
    };
    const VAULT_FILE = `${simpleHash('ultra-extension-wallet')}.json`;
    const r = await chrome.storage.local.get(VAULT_FILE);
    const raw = r?.[VAULT_FILE];
    if (typeof raw !== 'string') return [];
    try {
      const parsed = JSON.parse(raw) as { publicKeys?: string[] };
      return parsed.publicKeys ?? [];
    } catch {
      return [];
    }
  });
}

/**
 * Read the rendered Key Manager rows. `.key-item` is the per-row container
 * defined in keys.component.html. We pull the visible pubkey text (from the
 * `[title]` attribute on `.key-text`, since the row truncates the rendered
 * text). State-based on the DOM, not on chain or storage.
 */
async function readKeyManagerPubkeys(walletPage: Page): Promise<string[]> {
  return walletPage.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.key-item .key-text')) as HTMLElement[];
    return rows
      .map((el) => el.getAttribute('title') ?? el.textContent ?? '')
      .map((s) => s.trim())
      .filter(Boolean);
  });
}

// ── Test ───────────────────────────────────────────────────────────────────

test.describe.configure({ timeout: 120_000 });

test.describe('Wallet EBA registration (real extension)', () => {
  test.beforeAll(() => {
    if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
      throw new Error(
        `Extension build not found at ${EXTENSION_PATH}. Build it first via "npx nx build browser-extension-wallet -c=production" in web-app.`,
      );
    }
  });

  test('Auth-tab key reaches Key Manager via forceRefresh after OAuth callback', async () => {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-eba-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
      ],
    });

    const swLogs: string[] = [];
    const walletLogs: string[] = [];

    try {
      const sw = await getServiceWorker(context);
      sw.on('console', (m) => swLogs.push(`[${m.type()}] ${m.text()}`));

      // Pre-state: vault on testnet, ONE imported key linked to seeded.acct.
      // TRUSTED_APPS empty — we're not exercising any dapp, only the wallet
      // UI itself.
      await seedVault(sw, {
        password: PASSWORD,
        keys: { [PUB_KEY]: PRIV_KEY },
        env: 'testnet',
      });

      // Mock chain so Key Manager's chain-resolve populates account names.
      // Initially only PUB_KEY is on chain; after the simulated auth-tab
      // write, EBA_PUB_KEY is also resolved.
      await mockChainRPC(context, {
        [PUB_KEY]: 'seeded.acct',
        [EBA_PUB_KEY]: 'tneba.test',
      });

      // Open the wallet UI as a tab. This is the side-panel surface — same
      // Angular bundle, served from the extension's index.html.
      const extId = await sw.evaluate(() => chrome.runtime.id);
      const walletPage = await context.newPage();
      walletPage.on('console', (m) => walletLogs.push(`[${m.type()}] ${m.text()}`));
      walletPage.on('pageerror', (e) => walletLogs.push(`[pageerror] ${e.message}`));
      await walletPage.goto(`chrome-extension://${extId}/index.html#/home`);
      await walletPage.waitForLoadState('load');

      // Pre-seed sessionStorage with a fake-but-valid-shaped access_token
      // and expires_at far in the future. angular-oauth2-oidc's
      // `hasValidAccessToken()` checks ONLY (a) `access_token` is non-empty
      // and (b) `expires_at` is in the future — it does NOT verify the JWT
      // signature against the issuer. This lets `AuthService.isAuthenticated$`
      // emit `true` after `tryLoadSession`, which is the precondition the
      // auth-required-view's `combineLatest([isAuthenticated$, ...])`
      // listener needs to fire when we flip IS_AUTHENTICATED below. Without
      // this the listener stays gated on `isAuthenticated:false` and the
      // forceRefresh code path never runs, masking the regression we're
      // trying to pin.
      //
      // Reload the page so AuthService.initialize() picks up the new
      // sessionStorage on first run rather than after the fact.
      await walletPage.evaluate(() => {
        sessionStorage.setItem('access_token', 'e2e-fake-access-token');
        sessionStorage.setItem(
          'expires_at',
          String(Date.now() + 24 * 60 * 60 * 1000),
        );
      });
      await walletPage.reload();
      await walletPage.waitForLoadState('load');

      // Sanity: the side panel decrypted the seeded vault and Key Manager
      // shows exactly the imported key. Without this baseline we can't
      // distinguish "vault never loaded" from "forceRefresh never picked
      // up the EBA key".
      await walletPage.goto(`chrome-extension://${extId}/index.html#/keys`);
      await walletPage.waitForLoadState('load');
      await expect
        .poll(async () => readKeyManagerPubkeys(walletPage), {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'Key Manager never rendered the seeded key — vault decrypt failed?',
        })
        .toEqual([PUB_KEY]);

      // Navigate to /auth-required. This is what `openLoginTab` does after
      // popping the OAuth window — it leaves the side panel parked here
      // with the listener wired and waiting for IS_AUTHENTICATED to flip.
      // We pass redirectRoute=/keys so the post-auth navigate-to redirect
      // takes us straight to where we want to assert.
      await walletPage.goto(
        `chrome-extension://${extId}/index.html#/auth-required?redirectRoute=%2Fkeys`,
      );
      await walletPage.waitForLoadState('load');

      // Wait a beat for ngOnInit to subscribe to onAuthenticatedChange().
      // Without this, the IS_AUTHENTICATED write below races the listener
      // and fires into the void.
      await walletPage.waitForTimeout(500);

      // Simulate the auth tab's write side. Two atomic actions:
      //   (1) re-encrypt and persist a NEW vault containing BOTH keys
      //       (matches what `vault.addKey(eba_priv, eba_pub, 'eba')` does
      //       in the production auth tab)
      //   (2) flip IS_AUTHENTICATED — this is the trigger the
      //       auth-required-view observer is waiting for.
      await sw.evaluate(
        async (params) => {
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
            enc.encode(params.password),
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

          const vaultPlaintext = {
            keys: {
              [params.origPub]: {
                publicKey: params.origPub,
                privateKey: params.origPriv,
                addedAt: Date.now(),
                source: 'import',
              },
              [params.ebaPub]: {
                publicKey: params.ebaPub,
                privateKey: params.ebaPriv,
                addedAt: Date.now(),
                source: 'eba',
              },
            },
            accounts: [],
          };
          const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: 'AES-GCM', iv },
              aesKey,
              enc.encode(JSON.stringify(vaultPlaintext)),
            ),
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
            publicKeys: [params.origPub, params.ebaPub],
          };

          // (1) overwrite vault file
          await chrome.storage.local.set({ [VAULT_FILE]: JSON.stringify(encryptedVault) });

          // (2) flip IS_AUTHENTICATED — the observer in
          // auth-required-view.component.ts fires here. Same shape as
          // ExtensionAuthService.broadcastAuthenticatedChange(true).
          await chrome.storage.local.set({
            IS_AUTHENTICATED: { isAuthenticated: true, timestamp: Date.now() },
          });
        },
        {
          password: PASSWORD,
          origPub: PUB_KEY,
          origPriv: PRIV_KEY,
          ebaPub: EBA_PUB_KEY,
          ebaPriv: EBA_PRIV_KEY,
        },
      );

      // Confirm the vault on disk now has both keys (rules out a write
      // failure in the BG mutation as a cause of any later DOM miss).
      await expect
        .poll(async () => readVaultPublicKeys(sw), {
          timeout: 5000,
          message: 'vault file never updated to contain both keys',
        })
        .toEqual([PUB_KEY, EBA_PUB_KEY]);

      // The auth-required-view listener should now run and:
      //   - call tryRestoreSession({ forceRefresh: true })
      //   - navigate to redirectRoute=/keys
      // We assert on the URL flip first (proves the observer ran), then
      // on the Key Manager rows (proves forceRefresh actually re-decrypted).
      await expect
        .poll(async () => walletPage.url().split('#')[1] ?? '', {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message: 'auth-required-view never navigated to redirectRoute — IS_AUTHENTICATED listener did not fire',
        })
        .toMatch(/\/keys/);

      // The critical assertion: BOTH keys visible. Pre-fix (no forceRefresh)
      // tryRestoreSession's `if (isUnlocked()) return true` short-circuit
      // meant the side-panel's vault.keys map stayed at [PUB_KEY] only,
      // and the EBA key was on disk but invisible to Key Manager.
      await expect
        .poll(async () => (await readKeyManagerPubkeys(walletPage)).slice().sort(), {
          timeout: 30_000,
          intervals: [200, 500, 1000],
          message:
            'Key Manager did not pick up the EBA key after forceRefresh — pre-fix regression. The side panel stayed on its stale in-memory vault.',
        })
        .toEqual([PUB_KEY, EBA_PUB_KEY].slice().sort());
    } finally {
      const dump = (label: string, logs: string[]) => {
        const diag = logs.filter((l) => /\[DIAG|error|Error|EBA|Wallet\]/.test(l));
        console.log(`\n=== ${label} (${diag.length}/${logs.length}) ===`);
        console.log(diag.slice(0, 80).join('\n'));
      };
      dump('SERVICE WORKER', swLogs);
      dump('WALLET PAGE', walletLogs);
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
