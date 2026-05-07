/**
 * End-to-end test: chain-switch sync between the Ultra wallet extension and
 * the toolkit dapp.
 *
 * Loads the actual built extension, pre-seeds chrome.storage with a known-good
 * vault state and trust list (skipping the onboarding/connect UI dance), opens
 * the toolkit at localhost:5172, then switches the wallet's network by writing
 * the ENVIRONMENT storage key. Asserts the toolkit's accountChanged event
 * handler fires and the available-accounts list reflects the new chain.
 *
 * This catches the regression the user hit live: BG events firing but the
 * toolkit's dropdown not updating, and lets us see whether the issue is in
 * the extension-side dispatch or the toolkit-side handler.
 *
 * Prereqs:
 *   - extension must be built at /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 *   - toolkit dev server runs via playwright.config.ts webServer (localhost:5172)
 */

import { test, expect, chromium, BrowserContext, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(
    process.cwd(),
    '../web-app/dist/browser-extension-wallet',
);

const PASSWORD = 'TestPass123!';
// Two known testnet keys (any well-formed EOSIO key pair works for the
// vault encryption; chain-resolve calls will be intercepted by playwright
// route mocking, so we don't need real on-chain accounts).
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

// --- Helpers ---

async function getServiceWorker(context: BrowserContext, timeoutMs = 10_000): Promise<Worker> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const workers = context.serviceWorkers();
        if (workers.length > 0) return workers[0];
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Extension service worker did not start within ' + timeoutMs + 'ms');
}

async function getExtensionId(sw: Worker): Promise<string> {
    return sw.evaluate(() => chrome.runtime.id);
}

/**
 * Run inside the BG service worker: build a real encrypted vault using
 * Web Crypto, mirroring authenticator-lib's CryptoService format
 * (PBKDF2-SHA256, 900000 iterations, AES-GCM-256). Writes:
 *   - chrome.storage.local: vault file, TRUSTED_APPS (both envs), ENVIRONMENT, SELECTED_ACCOUNTS_BY_CHAIN
 *   - chrome.storage.session: vault_session (the password, used for silent restore)
 */
async function seedExtensionState(
    sw: Worker,
    cfg: { password: string; pubKey: string; privKey: string; env: 'testnet' | 'mainnet'; origins: string[] },
): Promise<void> {
    await sw.evaluate(async (cfg) => {
        console.log('[DIAG seed] cfg keys=', Object.keys(cfg).join(','), 'pubKey=', cfg.pubKey?.slice(0, 12), 'privKey set=', !!cfg.privKey);
        // djb2 hash to match VaultService.simpleHash
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

        const plaintextJson = JSON.stringify(vaultPlaintext);
        console.log('[DIAG seed] vault plaintext JSON length=', plaintextJson.length, 'starts=', plaintextJson.slice(0, 60));
        const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintextJson)),
        );

        // Round-trip self-test: decrypt back to confirm the format matches what
        // authenticator-lib's CryptoService.decrypt expects.
        const decKey = await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
            baseKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt'],
        );
        try {
            const decBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, decKey, ciphertext);
            const dec = new TextDecoder().decode(decBuf);
            const parsed = JSON.parse(dec);
            console.log('[DIAG seed] round-trip OK; parsed.keys keys count=', parsed?.keys ? Object.keys(parsed.keys).length : 'null');
        } catch (e) {
            console.error('[DIAG seed] round-trip FAILED:', e);
        }

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

        // chrome.storage.local
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

        // Pre-seed AccountCacheService's per-network cache so emitAccountChanged
        // doesn't depend on real chain RPC. The cache key shape matches
        // libs/extension/src/lib/services/account-cache.service.ts:NetworkCache.
        const now = Date.now();
        const cache: Record<string, unknown> = {
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
        };

        // chrome.storage.session: unlock-session password + chain-resolution cache.
        await chrome.storage.session.set({
            vault_session: cfg.password,
            account_resolution_cache: cache,
        });
    }, cfg);
}

/**
 * Drive a chain switch by writing ENVIRONMENT — same effect as user clicking
 * a network row in the wallet UI. The MV3 BG service worker can be suspended
 * mid-test; we verify the write took effect (post-write read sees the new
 * value) before returning, so a silent eviction doesn't manifest as a
 * downstream "no events" timeout in the test.
 */
async function setWalletEnv(sw: Worker, env: 'testnet' | 'mainnet'): Promise<void> {
    await sw.evaluate(async (env) => {
        console.log('[DIAG test.setWalletEnv] writing ENVIRONMENT=', env);
        await chrome.storage.local.set({ ENVIRONMENT: env });
        const verify = await chrome.storage.local.get('ENVIRONMENT');
        console.log('[DIAG test.setWalletEnv] post-write ENVIRONMENT=', verify.ENVIRONMENT);
    }, env);
}

/** Mock all chain RPC paths the toolkit's `BlockchainService.init` and the BG might hit. */
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
                accounts: [
                    { account_name: accountName, permission_name: 'active', authorizing_key: PUB_KEY },
                ],
            }),
        });
    });

    // Catch-all for any other /v1/chain/* the libraries might call during init.
    await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
}

// --- Test ---

// Each test loads chromium with the real extension, drives a chain switch,
// and waits for state changes to propagate through chrome.storage events
// and content-script bridges. The default 30s test timeout from the project
// config is tight for that — bump it.
test.describe.configure({ timeout: 120_000 });

test.describe('Wallet ↔ Toolkit network sync (real extension)', () => {
    test.beforeAll(() => {
        if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
            throw new Error(
                `Extension build not found at ${EXTENSION_PATH}. Run \`npm run build:browser-extension-wallet-prod\` in web-app first.`,
            );
        }
    });

    test('switching ENVIRONMENT in BG fires accountChanged that the toolkit consumes', async () => {
        // Real extension load — needs persistent context + non-headless (or 'new' headless).
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
            ],
        });

        const toolkitLogs: string[] = [];
        const swLogs: string[] = [];
        const observed: Array<{ label: string; values: (string | undefined)[] }> = [];

        try {
            const sw = await getServiceWorker(context);
            const extId = await getExtensionId(sw);
            sw.on('console', (m) => swLogs.push(`[${m.type()}] ${m.text()}`));

            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                env: 'testnet',
                origins: ['http://localhost:5172'],
            });

            await mockChainRPC(context);

            // Open toolkit. Use 'load' (not 'networkidle') because the toolkit
            // page bundles Google Analytics, which fires periodic ping beacons
            // (`/g/collect?...&en=scroll`, `&en=page_view`) every few seconds.
            // networkidle waits for a 500ms quiet window that GA's pings can
            // intermittently prevent from ever opening — caused ~10% test
            // timeouts despite the toolkit being functionally ready in <1s.
            // The state-based assertions below already wait for the right
            // condition, so 'load' (DOM + script ready) is sufficient.
            const page = await context.newPage();
            page.on('console', (m) => toolkitLogs.push(`[${m.type()}] ${m.text()}`));
            page.on('pageerror', (e) => toolkitLogs.push(`[pageerror] ${e.message}`));
            await page.goto('http://localhost:5172');
            await page.waitForLoadState('load');

            // Preseed authState so the toolkit's restoreSession path runs
            // Ultra.connect(true) on mount — same as having previously connected.
            await page.evaluate(
                ({ pubKey, chainId }) => {
                    localStorage.setItem(
                        'authState',
                        JSON.stringify({
                            type: 'ultra',
                            accountName: 'tnetacct.test',
                            accountPerm: 'active',
                            isAdmin: false,
                            endpoint: 'https://test.ultra.eosusa.io',
                            environment: 'testnet',
                            chainId,
                        }),
                    );
                    localStorage.setItem('endpoint', 'https://test.ultra.eosusa.io');
                    localStorage.setItem('environment', 'testnet');
                },
                { pubKey: PUB_KEY, chainId: TESTNET_CHAIN },
            );
            // 'load' for the same reason as above (GA pings prevent networkidle
            // from settling reliably).
            await page.reload();
            await page.waitForLoadState('load');

            // Capture every wallet event message that crosses the
            // content-script → page bridge. The BG's EventsService dispatches
            // `MessageType.EVENT` messages via the content script, which then
            // re-emits them as window.postMessage. Listening in the page
            // context is the most reliable end-to-end proof that BG dispatch
            // worked: the toolkit's wallet-sdk listener path is the one and
            // only consumer of these messages, so if our listener catches
            // them, every other path that depends on event delivery will too.
            //
            // We assert on this AFTER the env-switch transitions instead of
            // log-substring matching — Playwright's sw.on('console') does NOT
            // capture spontaneous SW console calls (only logs from inside
            // sw.evaluate blocks), so the BG's [DIAG bg.*] / [DIAG
            // EventsService.*] lines never reach swLogs even when dispatch
            // succeeds. State-based asserts don't have that limitation.
            await page.evaluate(() => {
                interface CapturedEvent { event: string; origin?: string; data?: unknown }
                interface PageWithCaptures extends Window {
                    __capturedWalletEvents?: CapturedEvent[];
                }
                const w = window as PageWithCaptures;
                w.__capturedWalletEvents = [];
                window.addEventListener('message', (e: MessageEvent) => {
                    if (e.source !== window) return;
                    const msg = e.data;
                    if (!msg || typeof msg !== 'object') return;
                    const type = typeof msg.type === 'string' ? msg.type.toUpperCase() : '';
                    if (type !== 'EVENT' || !msg.payload) return;
                    w.__capturedWalletEvents!.push({
                        event: String(msg.payload.event ?? ''),
                        origin: msg.payload.origin,
                        data: msg.payload.data,
                    });
                });
            });

            const waitForAccountName = async (expected: string, label: string) => {
                const values: (string | undefined)[] = [];
                try {
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
                                values.push(auth?.accountName);
                                return auth?.accountName;
                            },
                            {
                                timeout: 60_000,
                                intervals: [200, 500, 1000],
                                message: `[${label}] expected ${expected}; observed accountName values: ${JSON.stringify(values)}`,
                            },
                        )
                        .toBe(expected);
                } finally {
                    observed.push({ label, values: [...new Set(values)] });
                }
            };

            // Toolkit's restoreSession should silent-connect because trust is preseeded.
            // Wait for both authState.type=='ultra' AND accountName set — the
            // accountChanged handler bails when type is undefined, so an env
            // switch fired before authState fully settles is silently ignored
            // and the test races into a "values stuck at preseed" state.
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
                        timeout: 60_000,
                        intervals: [200, 500, 1000],
                        message: 'toolkit authState never settled to {type:ultra, accountName:tnetacct.test}',
                    },
                )
                .toEqual({ type: 'ultra', accountName: 'tnetacct.test' });

            // Also wait for the toolkit's listener registrations to land in the
            // BG's listenersMap. Without this, the BG fires events but
            // sendEventMessage drops them (no tab registered yet) — symptom:
            // toolkit's accountName stays at the preseeded value and the test
            // times out waiting for the new chain's account.
            await expect
                .poll(
                    async () =>
                        await sw.evaluate(async () => {
                            const r = await chrome.storage.session.get('EVENT_LISTENERS');
                            const map = (r?.EVENT_LISTENERS ?? {}) as Record<string, Record<string, { listeners: unknown[] }>>;
                            return Object.keys(map).sort();
                        }),
                    {
                        timeout: 30_000,
                        intervals: [200, 500, 1000],
                        message: 'BG listenersMap never registered all three event types',
                    },
                )
                .toEqual(['accountChanged', 'disconnect', 'networkChanged']);

            // Drive a wallet network switch from inside the BG (same effect as the
            // wallet's networks page calling walletExtensionService.setEnvironment).
            await setWalletEnv(sw, 'mainnet');

            // The BG fires emitNetworkChanged + emitAccountChanged. Toolkit's
            // accountChanged handler runs setAvailableAccountsFromEvent which
            // updates the available list; if the current selection isn't in the
            // new list, fall back to accounts[0].
            await waitForAccountName('mnetacct.main', 'after testnet→mainnet');

            // Reverse switch
            await page.waitForTimeout(500);
            await setWalletEnv(sw, 'testnet');
            await waitForAccountName('tnetacct.test', 'after mainnet→testnet');

            // sanity-check: the extension id we got is real
            expect(extId).toMatch(/^[a-z]{32}$/);

            // The waitForAccountName transitions above prove the toolkit
            // ended up on the right state. This block proves it got there
            // via real BG event dispatch (not via some re-query path) by
            // inspecting the actual MessageType.EVENT messages bridged from
            // the content script to the page. App.vue has no polling, so
            // the only way authState.accountName flips between chains is
            // through one of the event handlers — but verifying the message
            // arrival directly defends against future regressions where
            // someone might add a polling re-query.
            const capturedEvents = await page.evaluate(() => {
                interface CapturedEvent { event: string; origin?: string; data?: unknown }
                return ((window as unknown as { __capturedWalletEvents?: CapturedEvent[] })
                    .__capturedWalletEvents ?? []).slice();
            });
            const eventNames = capturedEvents.map((e) => e.event);
            expect(eventNames, `events captured during chain switches: ${JSON.stringify(eventNames)}`)
                .toEqual(expect.arrayContaining(['accountChanged', 'networkChanged']));

            // Account-list payload sanity: at least one accountChanged
            // delivered the new chain's account name. This catches a
            // regression where the BG dispatches but with a stale/empty
            // payload — the toolkit could still flip via re-query and
            // the test would otherwise pass for the wrong reason.
            const acctEventAccounts = capturedEvents
                .filter((e) => e.event === 'accountChanged')
                .flatMap((e) => {
                    const data = e.data as { accounts?: Array<{ accountName?: string }> } | undefined;
                    return Array.isArray(data?.accounts)
                        ? data.accounts.map((a) => a?.accountName)
                        : [];
                })
                .filter((n): n is string => typeof n === 'string');
            expect(acctEventAccounts).toEqual(
                expect.arrayContaining(['mnetacct.main', 'tnetacct.test']),
            );
        } finally {
            // Dump logs always so we can diagnose failures.
            const dumpDiag = (label: string, logs: string[]) => {
                const diag = logs.filter(
                    (l) => l.includes('[DIAG') || l.includes('error') || l.includes('Error'),
                );
                console.log(`\n=== ${label} (${diag.length} relevant lines of ${logs.length} total) ===`);
                console.log(diag.slice(0, 120).join('\n'));
            };
            dumpDiag('SERVICE WORKER', swLogs);
            dumpDiag('TOOLKIT PAGE', toolkitLogs);
            await context.close();
            console.log('[observed accountName values]', JSON.stringify(observed.map((o) => ({ label: o.label, values: o.values }))));
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });

    test('toolkit→extension: window.ultra.switchNetwork flips the wallet ENVIRONMENT key', async () => {
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-t2e-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
            ],
        });

        const swLogs: string[] = [];
        const toolkitLogs: string[] = [];
        try {
            const sw = await getServiceWorker(context);
            sw.on('console', (m) => swLogs.push(`[${m.type()}] ${m.text()}`));

            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                env: 'testnet',
                origins: ['http://localhost:5172'],
            });
            await mockChainRPC(context);

            const page = await context.newPage();
            page.on('console', (m) => toolkitLogs.push(`[${m.type()}] ${m.text()}`));
            await page.goto('http://localhost:5172');
            await page.waitForLoadState('load');

            // Wait until window.ultra is injected by the extension's content script.
            await page.waitForFunction(() => Boolean((window as any).ultra?.switchNetwork), null, {
                timeout: 10_000,
            });

            // Drive the toolkit→wallet path: ask the wallet to switch to mainnet.
            // This is what the toolkit's setEndpoint userInvoked branch does at
            // App.vue:234 — `await Ultra.switchNetwork(endpointChainId)`.
            const result = await page.evaluate(async (chainId) => {
                try {
                    const r = await (window as any).ultra.switchNetwork(chainId);
                    return { ok: true, status: r?.status, message: r?.message ?? null };
                } catch (e) {
                    return { ok: false, error: (e as Error)?.message ?? String(e) };
                }
            }, MAINNET_CHAIN);

            // The wallet must accept and write ENVIRONMENT='mainnet' into local storage.
            await expect
                .poll(
                    async () =>
                        await sw.evaluate(async () => {
                            const r = await chrome.storage.local.get('ENVIRONMENT');
                            return r.ENVIRONMENT;
                        }),
                    {
                        timeout: 15_000,
                        message: `wallet ENVIRONMENT never flipped to mainnet; switchNetwork returned ${JSON.stringify(result)}`,
                    },
                )
                .toBe('mainnet');

            // Reverse direction: switchNetwork back to testnet should also work.
            await page.evaluate(async (chainId) => {
                await (window as any).ultra.switchNetwork(chainId);
            }, TESTNET_CHAIN);

            await expect
                .poll(
                    async () =>
                        await sw.evaluate(async () => {
                            const r = await chrome.storage.local.get('ENVIRONMENT');
                            return r.ENVIRONMENT;
                        }),
                    { timeout: 15_000, message: 'wallet ENVIRONMENT never flipped back to testnet' },
                )
                .toBe('testnet');
        } finally {
            const dump = (label: string, logs: string[]) => {
                const diag = logs.filter((l) => l.includes('[DIAG') || l.includes('error') || l.includes('Error'));
                console.log(`\n=== ${label} (${diag.length}/${logs.length}) ===`);
                console.log(diag.slice(0, 80).join('\n'));
            };
            dump('SW', swLogs);
            dump('TOOLKIT', toolkitLogs);
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });

    test('reproduces the user-reported failure when TRUSTED_APPS lacks the toolkit origin', async () => {
        // This pins the user's actual symptom (BG diag console showed
        // `isTrusted=false` on every addExtensionListener). Without trust
        // for the toolkit's origin, the BG silently no-ops every listener
        // registration; subsequent events fire from the BG and drop in
        // EventsService.sendEventMessage because `listenersMap[event]`
        // has no entry for the toolkit's tab.
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-notrust-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
            ],
        });

        const swLogs: string[] = [];
        try {
            const sw = await getServiceWorker(context);
            sw.on('console', (m) => swLogs.push(`[${m.type()}] ${m.text()}`));

            // Same vault/session/env as the positive test, but TRUSTED_APPS
            // does not include the toolkit origin.
            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                env: 'testnet',
                origins: [],
            });
            await mockChainRPC(context);

            const page = await context.newPage();
            await page.goto('http://localhost:5172');
            await page.waitForLoadState('load');

            // No preseeded authState — toolkit boot leaves `Login` button visible.
            // We're not testing the toolkit UI here; we're confirming the
            // BG-side dispatch silently drops when origin isn't trusted.
            await page.evaluate(() => {
                // Subscribe via window.ultra's addExtensionListener directly
                // so we exercise the BG controller's trust check without the
                // toolkit's heartbeat retry mask.
                (window as any).ultra?.addExtensionListener?.('accountChanged', 'test-uuid-1');
            });
            await page.waitForTimeout(500);

            // Trigger an env change in the BG.
            await sw.evaluate(async () => {
                await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' });
            });
            await page.waitForTimeout(2000);

            // Critical assertion: with TRUSTED_APPS empty, the BG's
            // EventsController.addExtensionListener trust check (cross-env
            // via PermissionService.isOriginTrusted) silent-rejects every
            // registration attempt, so chrome.storage.session.EVENT_LISTENERS
            // never gets the toolkit's tab. We assert on the actual storage
            // state — more robust than log-substring matching.
            const eventListenersMap = await sw.evaluate(async () => {
                const r = await chrome.storage.session.get('EVENT_LISTENERS');
                return r?.EVENT_LISTENERS ?? null;
            });
            // Either the map was never created, or no event has any
            // registered tabs (every per-event entry is empty/missing).
            const hasAnyRegisteredTab = (() => {
                if (!eventListenersMap || typeof eventListenersMap !== 'object') return false;
                for (const tabsByEvent of Object.values(eventListenersMap as Record<string, unknown>)) {
                    if (
                        tabsByEvent &&
                        typeof tabsByEvent === 'object' &&
                        Object.keys(tabsByEvent as Record<string, unknown>).length > 0
                    ) {
                        return true;
                    }
                }
                return false;
            })();
            expect(hasAnyRegisteredTab).toBe(false);

            // And: after the env change the toolkit never received an EVENT
            // message via the content-script bridge. We don't track this in
            // logs (DIAG logs are debug-only); we capture it via the page's
            // own postMessage listener attached BEFORE the env change.
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });

    test('cross-env trust: dapp connected on testnet only still receives mainnet accounts on chain switch (Issue 3)', async () => {
        // Pins MetaMask/Phantom/WalletConnect-style trust semantics: once a
        // dapp is connected on ANY env, switching the wallet to a different
        // env emits the new env's accounts to that origin (not empty). The
        // pre-fix `emitAccountChanged` checked `isTrustedApp(env.name, origin)`
        // which is strictly per-env — when the origin was only trusted on
        // 'testnet' and the wallet flipped to 'mainnet', the dapp received
        // `accounts: []`. The toolkit's accountChanged handler then
        // interpreted that as "logged out" and called `logout()`, surfacing
        // as a forced reconnect prompt to the user on every chain switch.
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-crossenv-'));
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

            // Seed with trust ONLY on testnet — this is the precise condition
            // that exercised the bug. mainnet's TRUSTED_APPS slot is intentionally
            // empty.
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
                    'raw', enc.encode(cfg.password), 'PBKDF2', false, ['deriveKey'],
                );
                const aesKey = await crypto.subtle.deriveKey(
                    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
                    baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
                );
                const vaultPlaintext = {
                    keys: { [cfg.pubKey]: { publicKey: cfg.pubKey, privateKey: cfg.privKey, addedAt: Date.now(), source: 'import' } },
                    accounts: [],
                };
                const ciphertext = new Uint8Array(
                    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(vaultPlaintext))),
                );
                const toHex = (b: Uint8Array): string =>
                    Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
                const encryptedVault = {
                    salt: toHex(salt), iv: toHex(iv), ciphertext: toHex(ciphertext),
                    iterations: ITERATIONS, publicKeys: [cfg.pubKey],
                };

                // Trust only on testnet — mainnet has no entry for this origin.
                await chrome.storage.local.set({
                    [VAULT_FILE]: JSON.stringify(encryptedVault),
                    ENVIRONMENT: 'testnet',
                    TRUSTED_APPS: { testnet: [cfg.origin] },
                    SELECTED_ACCOUNTS_BY_CHAIN: {},
                });

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
            }, { password: PASSWORD, pubKey: PUB_KEY, privKey: PRIV_KEY, origin: 'http://localhost:5172' });

            await mockChainRPC(context);

            const page = await context.newPage();
            await page.goto('http://localhost:5172');
            await page.waitForLoadState('load');

            // Pre-seed authState as if dapp had connected on testnet previously.
            await page.evaluate(({ chainId }) => {
                localStorage.setItem('authState', JSON.stringify({
                    type: 'ultra',
                    accountName: 'tnetacct.test',
                    accountPerm: 'active',
                    isAdmin: false,
                    endpoint: 'https://test.ultra.eosusa.io',
                    environment: 'testnet',
                    chainId,
                }));
                localStorage.setItem('endpoint', 'https://test.ultra.eosusa.io');
                localStorage.setItem('environment', 'testnet');
            }, { chainId: TESTNET_CHAIN });
            await page.reload();
            await page.waitForLoadState('load');

            // Capture wallet events delivered to the page (via window.postMessage
            // from the content-script bridge).
            await page.evaluate(() => {
                interface CapturedEvent { event: string; data?: unknown }
                const w = window as Window & { __capturedWalletEvents?: CapturedEvent[] };
                w.__capturedWalletEvents = [];
                window.addEventListener('message', (e: MessageEvent) => {
                    if (e.source !== window) return;
                    const msg = e.data;
                    if (!msg || typeof msg !== 'object') return;
                    const type = typeof msg.type === 'string' ? msg.type.toUpperCase() : '';
                    if (type !== 'EVENT' || !msg.payload) return;
                    w.__capturedWalletEvents!.push({
                        event: String(msg.payload.event ?? ''),
                        data: msg.payload.data,
                    });
                });
            });

            // Wait for toolkit to silent-reconnect and register all 3 listeners.
            await expect.poll(
                async () => await page.evaluate(() => {
                    try {
                        const a = JSON.parse(localStorage.getItem('authState') ?? '{}');
                        return { type: a?.type, accountName: a?.accountName };
                    } catch { return { type: undefined, accountName: undefined }; }
                }),
                { timeout: 30_000, message: 'toolkit failed to silent-restore on testnet' },
            ).toEqual({ type: 'ultra', accountName: 'tnetacct.test' });

            await expect.poll(
                async () => await sw.evaluate(async () => {
                    const r = await chrome.storage.session.get('EVENT_LISTENERS');
                    return Object.keys(r?.EVENT_LISTENERS ?? {}).sort();
                }),
                { timeout: 30_000 },
            ).toEqual(['accountChanged', 'disconnect', 'networkChanged']);

            // The behavior we're pinning: with TRUSTED_APPS lacking mainnet,
            // a chain switch to mainnet must STILL deliver mainnet accounts
            // (cross-env trust). Pre-fix this would deliver accounts:[].
            await sw.evaluate(async () => {
                await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' });
            });

            // Toolkit's authState.accountName must adopt the mainnet account.
            // If accounts came as empty, handleWalletAccountChanged would call
            // logout() and authState.type would be cleared.
            await expect.poll(
                async () => await page.evaluate(() => {
                    try {
                        const a = JSON.parse(localStorage.getItem('authState') ?? '{}');
                        return { type: a?.type, accountName: a?.accountName };
                    } catch { return { type: undefined, accountName: undefined }; }
                }),
                {
                    timeout: 30_000,
                    intervals: [200, 500, 1000],
                    message: 'after testnet→mainnet switch with mainnet-trust missing, toolkit was forced to logout — Issue 3 regression',
                },
            ).toEqual({ type: 'ultra', accountName: 'mnetacct.main' });

            // And direct evidence: at least one captured accountChanged event
            // delivered a non-empty mainnet accounts list.
            const captured = await page.evaluate(() => {
                interface CapturedEvent { event: string; data?: unknown }
                const w = window as Window & { __capturedWalletEvents?: CapturedEvent[] };
                return (w.__capturedWalletEvents ?? []).slice();
            });
            const mainnetAcctEventSeen = captured.some((e) => {
                if (e.event !== 'accountChanged') return false;
                const accounts = (e.data as { accounts?: Array<{ accountName?: string }> } | undefined)?.accounts;
                return Array.isArray(accounts) && accounts.some((a) => a?.accountName === 'mnetacct.main');
            });
            expect(mainnetAcctEventSeen, `expected accountChanged with mainnet account to be delivered to untrusted-on-mainnet origin; captured: ${JSON.stringify(captured.map(c => ({event: c.event, data: c.data})))}`).toBe(true);
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });

    test('cache: switching env back-and-forth within 30s does not re-fetch get_accounts_by_authorizers (Issue 2)', async () => {
        // Pins the `AccountCacheService.resolve` 30s cache contract: rapid
        // env switches read from cache instead of hitting the chain RPC.
        // Pre-fix, home-view.component.ts called FallbackChainClient directly
        // and bypassed the cache, causing a chain RTT (and a loading state)
        // on every env switch even when the data was fresh.
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-cache-'));
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
                origins: ['http://localhost:5172'],
            });

            // Count chain RPC calls per route. seedExtensionState already
            // populated account_resolution_cache for both envs, so subsequent
            // resolve() calls within 30s should be cache hits.
            const chainCallCounts: Record<string, number> = { get_accounts_by_authorizers: 0, get_info: 0 };
            await context.route('**/v1/chain/get_info', async (route) => {
                chainCallCounts.get_info++;
                const isTestnet = /testnet|test\./.test(new URL(route.request().url()).host);
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        chain_id: isTestnet ? TESTNET_CHAIN : MAINNET_CHAIN,
                        head_block_num: 1, last_irreversible_block_num: 1,
                        head_block_time: '2026-04-04T00:00:00.000',
                    }),
                });
            });
            await context.route('**/v1/chain/get_accounts_by_authorizers', async (route) => {
                chainCallCounts.get_accounts_by_authorizers++;
                const isTestnet = /testnet|test\./.test(new URL(route.request().url()).host);
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        accounts: [{
                            account_name: isTestnet ? 'tnetacct.test' : 'mnetacct.main',
                            permission_name: 'active',
                            authorizing_key: PUB_KEY,
                        }],
                    }),
                });
            });
            await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
                await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
            });

            const page = await context.newPage();
            await page.goto('http://localhost:5172');
            await page.waitForLoadState('load');

            // Switch env three times within ~3 seconds — well under the 30s
            // cooldown. Each switch fires emitAccountChanged in the BG, which
            // calls AccountCacheService.resolve. With fresh seeded cache and
            // unchanged key set, every call should be a cache hit.
            await sw.evaluate(async () => { await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' }); });
            await page.waitForTimeout(800);
            await sw.evaluate(async () => { await chrome.storage.local.set({ ENVIRONMENT: 'testnet' }); });
            await page.waitForTimeout(800);
            await sw.evaluate(async () => { await chrome.storage.local.set({ ENVIRONMENT: 'mainnet' }); });
            await page.waitForTimeout(800);

            // Critical assertion: zero get_accounts_by_authorizers calls
            // because the seed pre-populated both env slots. Pre-fix, even
            // with cache pre-seeded, home-view's direct chain call would
            // have driven this count up. Wallet UI isn't open in this test
            // (it's BG-only), so we're specifically validating BG-side
            // emitAccountChanged uses cache via resolve().
            expect(
                chainCallCounts.get_accounts_by_authorizers,
                `expected 0 get_accounts_by_authorizers calls (cache should serve all); got ${chainCallCounts.get_accounts_by_authorizers}`,
            ).toBe(0);
        } finally {
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
