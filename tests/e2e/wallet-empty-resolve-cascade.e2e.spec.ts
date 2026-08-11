/**
 * Regression suite for the empty-resolve cascade (2026-05-15).
 *
 * Reference: `ultraOS-doc/web-browser-extension/HOME_VIEW_EMPTY_RESOLVE_CASCADE_REGRESSION_2026-05-15.md`
 *
 * Two scenarios:
 *
 *  1. **Refresh disconnect (Reg 1)** — when the BG silent-reconnect returns
 *     success with `accounts:[]` (cold cache + transient chain RPC empty),
 *     the toolkit's `restoreSession` must KEEP authState. Pre-fix it
 *     wiped via `App.vue:454` ("silent reconnect returned no session —
 *     clearing stale authState").
 *
 *  2. **Wallet-selected sync (Reg 2)** — when the wallet emits
 *     `accountChanged` with a new `selected.accountName`, the toolkit must
 *     adopt that value into `authState.accountName`. Pre-fix the toolkit
 *     intentionally ignored `data.selected` (per-action override was the
 *     stated design); per the 2026-05-15 user directive, wallet-selected
 *     is authoritative and the toolkit must reflect it.
 *
 * Mocks the chain RPC so the test is deterministic — `get_accounts_by_authorizers`
 * returns `[]` for the first scenario (forces the empty-resolve cascade),
 * and a populated array for the second.
 */

import { test, expect, chromium, BrowserContext, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { assertLocalDappExtensionBuild } from './helpers/extension-build';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');

const PASSWORD = 'TestPass123!';
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

const TOOLKIT_ORIGIN = 'http://localhost:5172';

async function getServiceWorker(context: BrowserContext, timeoutMs = 10_000): Promise<Worker> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const workers = context.serviceWorkers();
        if (workers.length > 0) return workers[0];
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Extension service worker did not start within ' + timeoutMs + 'ms');
}

/**
 * Build a real encrypted vault in chrome.storage.local, seed
 * SELECTED_ACCOUNTS_BY_CHAIN, TRUSTED_APPS, and the unlock session.
 * Mirrors the format authenticator-lib's CryptoService expects.
 */
async function seedExtensionState(
    sw: Worker,
    cfg: {
        password: string;
        pubKey: string;
        privKey: string;
        env: 'testnet' | 'mainnet';
        origins: string[];
        selectedAccountByChain: Record<string, string>;
        accountResolutionCache?: Record<string, { entries: Array<{ account: string; permission: string; authorizing_key: string }>; publicKeys: string[] }>;
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
                [cfg.pubKey]: { publicKey: cfg.pubKey, privateKey: cfg.privKey, addedAt: Date.now(), source: 'import' },
            },
            accounts: [],
        };
        const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(vaultPlaintext))),
        );

        const toHex = (b: Uint8Array): string =>
            Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

        const encryptedVault = {
            salt: toHex(salt),
            iv: toHex(iv),
            ciphertext: toHex(ciphertext),
            iterations: ITERATIONS,
            publicKeys: [cfg.pubKey],
        };

        const trustedApps: Record<string, string[]> = {};
        for (const env of ['testnet', 'mainnet']) trustedApps[env] = [...cfg.origins];

        await chrome.storage.local.set({
            [VAULT_FILE]: JSON.stringify(encryptedVault),
            ENVIRONMENT: cfg.env,
            TRUSTED_APPS: trustedApps,
            SELECTED_ACCOUNTS_BY_CHAIN: cfg.selectedAccountByChain,
        });

        const sessionPayload: Record<string, unknown> = { vault_session: cfg.password };
        if (cfg.accountResolutionCache) {
            const now = Date.now();
            const cacheWithTs: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(cfg.accountResolutionCache)) {
                cacheWithTs[k] = { ...v, timestamp: now };
            }
            sessionPayload['account_resolution_cache'] = cacheWithTs;
        }
        await chrome.storage.session.set(sessionPayload);
    }, cfg);
}

/**
 * Install chain RPC mocks. `accountsResponse` controls what
 * /v1/chain/get_accounts_by_authorizers returns — pass `[]` to force the
 * empty-resolve cascade, or populated entries to test normal flow.
 */
async function mockChainRPC(
    context: BrowserContext,
    accountsResponse: Array<{ account_name: string; permission_name: string; authorizing_key: string }>,
): Promise<void> {
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
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ accounts: accountsResponse }),
        });
    });

    // Catch-all for any other /v1/chain/* hits.
    await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
}

test.describe.configure({ timeout: 120_000 });

test.describe('Empty-resolve cascade — regression guards', () => {
    test.beforeAll(() => {
        assertLocalDappExtensionBuild(EXTENSION_PATH);
    });

    test('Reg 1: refresh with empty chain resolve KEEPS authState (no silent disconnect)', async () => {
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-empty-cascade-reg1-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
            ],
        });

        const toolkitLogs: string[] = [];

        try {
            const sw = await getServiceWorker(context);

            // Pre-seed: trusted origin, vault unlocked, per-chain selected
            // populated. Chain RPC will return empty — simulates cold cache
            // + transient chain failure on the silent-reconnect path.
            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                env: 'testnet',
                origins: [TOOLKIT_ORIGIN],
                selectedAccountByChain: { [TESTNET_CHAIN]: 'tnetacct.test' },
            });

            await mockChainRPC(context, []); // forces empty resolve

            const page = await context.newPage();
            page.on('console', (m) => toolkitLogs.push(`[${m.type()}] ${m.text()}`));

            // Pre-seed authState in localStorage so restoreSession fires on
            // mount. Mirrors the user's "I was previously connected" state.
            await page.goto(TOOLKIT_ORIGIN);
            await page.waitForLoadState('load');
            await page.evaluate(({ chainId }) => {
                localStorage.setItem(
                    'authState',
                    JSON.stringify({
                        type: 'ultra',
                        accountName: 'tnetacct.test',
                        accountPerm: 'active',
                        isAdmin: false,
                        endpoint: 'https://api.ultra-testnet.cryptolions.io',
                        environment: 'testnet',
                        chainId,
                    }),
                );
                localStorage.setItem('endpoint', 'https://api.ultra-testnet.cryptolions.io');
                localStorage.setItem('environment', 'testnet');
            }, { chainId: TESTNET_CHAIN });

            // Reload — restoreSession runs on mount, calls Ultra.connect(true),
            // which lands on the BG silent-success-with-empty path.
            await page.reload();
            await page.waitForLoadState('load');

            // Give restoreSession + getAvailableAuthorizations a generous
            // window — both RPCs go through the mocked chain (instant) so
            // 5s is far more than needed; the poll below is the real
            // assertion.
            await expect
                .poll(
                    async () => {
                        const auth = await page.evaluate(() => {
                            try {
                                return JSON.parse(localStorage.getItem('authState') ?? '{}');
                            } catch {
                                return {};
                            }
                        });
                        return auth?.accountName ?? null;
                    },
                    {
                        timeout: 30_000,
                        intervals: [200, 500, 1000],
                        message: 'authState.accountName was wiped on refresh despite empty-resolve guard',
                    },
                )
                .toBe('tnetacct.test');

            // Pre-fix log: '[ultra-tool-kit] silent reconnect returned no session — clearing stale authState'
            const sawPreFix = toolkitLogs.some((l) =>
                l.includes('silent reconnect returned no session — clearing stale authState'),
            );

            expect(sawPreFix, 'pre-fix wipe log fired — restoreSession resilience regressed').toBe(false);
        } finally {
            await context.close();
        }
    });

    test('Reg 2: wallet-emitted selected propagates into authState.accountName', async () => {
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-empty-cascade-reg2-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
            ],
        });

        try {
            const sw = await getServiceWorker(context);

            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                env: 'testnet',
                origins: [TOOLKIT_ORIGIN],
                selectedAccountByChain: { [TESTNET_CHAIN]: 'initial.test' },
                // Pre-warm the cache with TWO accounts so the dropdown is
                // populated AND the selected swap will produce a non-empty
                // accountChanged event.
                accountResolutionCache: {
                    testnet: {
                        entries: [
                            { account: 'initial.test', permission: 'active', authorizing_key: PUB_KEY },
                            { account: 'switched.test', permission: 'active', authorizing_key: PUB_KEY },
                        ],
                        publicKeys: [PUB_KEY],
                    },
                },
            });

            // Mock chain to return BOTH accounts so any re-resolve produces
            // the same dropdown.
            await mockChainRPC(context, [
                { account_name: 'initial.test', permission_name: 'active', authorizing_key: PUB_KEY },
                { account_name: 'switched.test', permission_name: 'active', authorizing_key: PUB_KEY },
            ]);

            const page = await context.newPage();
            await page.goto(TOOLKIT_ORIGIN);
            await page.waitForLoadState('load');
            await page.evaluate(({ chainId }) => {
                localStorage.setItem(
                    'authState',
                    JSON.stringify({
                        type: 'ultra',
                        accountName: 'initial.test',
                        accountPerm: 'active',
                        isAdmin: false,
                        endpoint: 'https://api.ultra-testnet.cryptolions.io',
                        environment: 'testnet',
                        chainId,
                    }),
                );
                localStorage.setItem('endpoint', 'https://api.ultra-testnet.cryptolions.io');
                localStorage.setItem('environment', 'testnet');
            }, { chainId: TESTNET_CHAIN });
            await page.reload();
            await page.waitForLoadState('load');

            // Wait for restoreSession to settle.
            await expect
                .poll(
                    async () => {
                        const auth = await page.evaluate(() => {
                            try {
                                return JSON.parse(localStorage.getItem('authState') ?? '{}');
                            } catch {
                                return {};
                            }
                        });
                        return auth?.accountName ?? null;
                    },
                    { timeout: 30_000, intervals: [200, 500, 1000] },
                )
                .toBe('initial.test');

            // Drive a wallet-side selection switch by writing the per-chain
            // map. The BG's DataStorage.onChange listener fires
            // emitAccountChanged with `selected.accountName = 'switched.test'`.
            await sw.evaluate(
                async ({ chainId }) => {
                    await chrome.storage.local.set({
                        SELECTED_ACCOUNTS_BY_CHAIN: { [chainId]: 'switched.test' },
                    });
                },
                { chainId: TESTNET_CHAIN },
            );

            // Toolkit's handleWalletAccountChanged must adopt the new
            // selection into authState.accountName AND default to the
            // 'active' permission (not 'owner') even when the walker
            // returned both for this key.
            await expect
                .poll(
                    async () => {
                        const auth = await page.evaluate(() => {
                            try {
                                return JSON.parse(localStorage.getItem('authState') ?? '{}');
                            } catch {
                                return {};
                            }
                        });
                        return { name: auth?.accountName ?? null, perm: auth?.accountPerm ?? null };
                    },
                    {
                        timeout: 30_000,
                        intervals: [200, 500, 1000],
                        message: 'authState did not adopt wallet-emitted `selected` with active permission',
                    },
                )
                .toEqual({ name: 'switched.test', perm: 'active' });
        } finally {
            await context.close();
        }
    });

    test('Reg 2b: when the walker returns both owner and active for a key, active wins', async () => {
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-empty-cascade-reg2b-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
            ],
        });

        try {
            const sw = await getServiceWorker(context);

            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                env: 'testnet',
                origins: [TOOLKIT_ORIGIN],
                selectedAccountByChain: { [TESTNET_CHAIN]: 'initial.test' },
                accountResolutionCache: {
                    testnet: {
                        entries: [
                            { account: 'initial.test', permission: 'active', authorizing_key: PUB_KEY },
                            // owner BEFORE active in walker order — pre-fix
                            // bug picked the first match, which would be
                            // owner if the chain returned it first.
                            { account: 'multiperm.test', permission: 'owner', authorizing_key: PUB_KEY },
                            { account: 'multiperm.test', permission: 'active', authorizing_key: PUB_KEY },
                        ],
                        publicKeys: [PUB_KEY],
                    },
                },
            });

            // Chain mock returns BOTH owner and active for multiperm.test
            // (owner row first — the order the bug hinges on).
            await mockChainRPC(context, [
                { account_name: 'initial.test', permission_name: 'active', authorizing_key: PUB_KEY },
                { account_name: 'multiperm.test', permission_name: 'owner', authorizing_key: PUB_KEY },
                { account_name: 'multiperm.test', permission_name: 'active', authorizing_key: PUB_KEY },
            ]);

            const page = await context.newPage();
            await page.goto(TOOLKIT_ORIGIN);
            await page.waitForLoadState('load');
            await page.evaluate(({ chainId }) => {
                localStorage.setItem(
                    'authState',
                    JSON.stringify({
                        type: 'ultra',
                        accountName: 'initial.test',
                        accountPerm: 'active',
                        isAdmin: false,
                        endpoint: 'https://api.ultra-testnet.cryptolions.io',
                        environment: 'testnet',
                        chainId,
                    }),
                );
                localStorage.setItem('endpoint', 'https://api.ultra-testnet.cryptolions.io');
                localStorage.setItem('environment', 'testnet');
            }, { chainId: TESTNET_CHAIN });
            await page.reload();
            await page.waitForLoadState('load');

            // Drive a switch to the multi-permission account. BG emits
            // accountChanged with `selected = first matching entry from
            // trustedAccounts` — which will be the owner row (it's first
            // in the resolved cache). Toolkit MUST prefer active anyway.
            await sw.evaluate(
                async ({ chainId }) => {
                    await chrome.storage.local.set({
                        SELECTED_ACCOUNTS_BY_CHAIN: { [chainId]: 'multiperm.test' },
                    });
                },
                { chainId: TESTNET_CHAIN },
            );

            await expect
                .poll(
                    async () => {
                        const auth = await page.evaluate(() => {
                            try {
                                return JSON.parse(localStorage.getItem('authState') ?? '{}');
                            } catch {
                                return {};
                            }
                        });
                        return { name: auth?.accountName ?? null, perm: auth?.accountPerm ?? null };
                    },
                    {
                        timeout: 30_000,
                        intervals: [200, 500, 1000],
                        message: 'authState did not prefer active permission when both owner and active are available',
                    },
                )
                .toEqual({ name: 'multiperm.test', perm: 'active' });
        } finally {
            await context.close();
        }
    });
});
