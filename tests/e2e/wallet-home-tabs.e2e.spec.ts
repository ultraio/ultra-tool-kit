/**
 * Real-extension coverage for the wallet home tabs.
 *
 * Prerequisite: build the extension at
 * /home/adam/ultra.repos/web-app/dist/browser-extension-wallet.
 *
 * The test deliberately exercises UNIQ ownership through the standard
 * nodeos get_table_rows endpoint. It does not use dfuse, GraphQL, an NFT
 * service, or a local transaction-history cache.
 */

import { test, expect, chromium, BrowserContext, Page, Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');
const PASSWORD = 'TestPass123!';
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const ACCOUNT = 'ti1wr2sn3wb4';
const NODE_URL = 'https://api.mainnet.ultra.io';
const EXPLORER_URL = `https://explorer.mainnet.ultra.io/account/${ACCOUNT}`;
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';
const NFT_CONTRACT = 'eosio.nft.ft';
const CONTROLLER_CONTRACT = 'ultra.cntmgr';
const SEARCH_TOKEN_ID = '57761';
const LEGACY_TOKEN_ID = '57762';
const NEIGHBOR_TOKEN_ID = '57763';
const LEGACY_FACTORY_ID = '2002';
const CAPTURE_DIR = path.resolve(process.cwd(), 'output/playwright');

interface RpcCall {
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

interface HomeRpcFixture {
    calls: RpcCall[];
    nftCalls: RpcCall[];
    metadataCalls: RpcCall[];
    httpRequests: Array<{ url: string; headers: Record<string, string> }>;
}

type DetailMode = 'ready' | 'listed' | 'auction' | 'unknown';

interface HomeRpcOptions {
    detailMode?: DetailMode;
}

interface WalletHarness {
    context: BrowserContext;
    page: Page;
    rpc: HomeRpcFixture;
    userDataDir: string;
}

async function getServiceWorker(context: BrowserContext, timeoutMs = 10_000): Promise<Worker> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const workers = context.serviceWorkers();
        if (workers.length > 0) return workers[0];
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Extension service worker did not start within ${timeoutMs}ms`);
}

/** Seed the same encrypted vault/session shape used by the existing e2e suite. */
async function seedExtensionState(sw: Worker): Promise<void> {
    await sw.evaluate(
        async ({ password, pubKey, privKey, account, chainId }) => {
            const simpleHash = (s: string): string => {
                let h = 5381;
                for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) & 0xffffffff;
                return Math.abs(h).toString(16).padStart(8, '0');
            };
            const vaultFile = `${simpleHash('ultra-extension-wallet')}.json`;
            const enc = new TextEncoder();
            const salt = crypto.getRandomValues(new Uint8Array(32));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const iterations = 900_000;
            const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
            const aesKey = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
                baseKey,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt']
            );
            const plaintext = JSON.stringify({
                keys: {
                    [pubKey]: { publicKey: pubKey, privateKey: privKey, addedAt: Date.now(), source: 'import' },
                },
                accounts: [],
            });
            const ciphertext = new Uint8Array(
                await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintext))
            );
            const toHex = (bytes: Uint8Array): string =>
                Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
            const encryptedVault = {
                salt: toHex(salt),
                iv: toHex(iv),
                ciphertext: toHex(ciphertext),
                iterations,
                publicKeys: [pubKey],
            };

            await chrome.storage.local.set({
                [vaultFile]: JSON.stringify(encryptedVault),
                ENVIRONMENT: 'mainnet',
                TRUSTED_APPS: { mainnet: [], testnet: [] },
                SELECTED_ACCOUNTS_BY_CHAIN: { [chainId]: account },
            });
            await chrome.storage.session.set({
                vault_session: password,
                account_resolution_cache: {
                    mainnet: {
                        entries: [{ account, permission: 'active', authorizing_key: pubKey }],
                        timestamp: Date.now(),
                        publicKeys: [pubKey],
                    },
                },
            });
        },
        { password: PASSWORD, pubKey: PUB_KEY, privKey: PRIV_KEY, account: ACCOUNT, chainId: MAINNET_CHAIN }
    );
}

function parseBody(postData: string | null): Record<string, unknown> {
    try {
        const parsed: unknown = JSON.parse(postData ?? '{}');
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function uniqRows(ids: number[]): Record<string, unknown>[] {
    return ids.map((id) => ({
        id: String(id),
        token_factory_id: '1001',
        serial_number: String(id),
        mint_date: '2026-08-10T00:00:00Z',
        uri: `${NODE_URL}/test-metadata/${id}.json`,
    }));
}

function currentFactoryRow(): Record<string, unknown> {
    return {
        id: '1001',
        asset_manager: 'ultra',
        asset_creator: 'ultra',
        minimum_resell_price: '1.00000000 UOS',
        trading_window_start: '0',
        trading_window_end: '4294967295',
        transfer_window_start: '0',
        transfer_window_end: '4294967295',
        lockup_time: '0',
        conditionless_receivers: [],
        stat: '0',
        factory_uri: 'https://metadata.example/factory/1001.json',
        factory_hash: '0'.repeat(64),
        default_token_uri: `${NODE_URL}/test-metadata/{id}.json`,
    };
}

function legacyFactoryRow(): Record<string, unknown> {
    return {
        id: LEGACY_FACTORY_ID,
        asset_manager: 'ultra',
        asset_creator: 'ultra',
        minimum_resell_price: '0.00000000 UOS',
        trading_window_start: '0',
        trading_window_end: '4294967295',
        lockup_time: '0',
        conditionless_receivers: [],
        stat: '0',
        meta_uris: [`${NODE_URL}/legacy-metadata/{id}.json`],
        meta_hash: '3717aaff51517194af5719a76660ac57414bc071d266c03c4b109b814627660b',
    };
}

function detailTokenRow(id: string, tableVersion: 'a' | 'b' = 'b'): Record<string, unknown> {
    return {
        id,
        token_factory_id: tableVersion === 'a' ? LEGACY_FACTORY_ID : '1001',
        serial_number: tableVersion === 'a' ? '2' : '1',
        mint_date: '2026-08-09T00:00:00Z',
        ...(tableVersion === 'b' ? { uri: `${NODE_URL}/test-metadata/${id}.json` } : {}),
    };
}

/**
 * Register the broad nodeos fallback first and the feature-specific routes
 * afterwards. Playwright evaluates the newest matching route first, so the
 * final get_table_rows handler owns the NFT fixture while all other chain
 * calls remain harmless and observable.
 */
async function mockHomeRPC(context: BrowserContext, options: HomeRpcOptions = {}): Promise<HomeRpcFixture> {
    const fixture: HomeRpcFixture = { calls: [], nftCalls: [], metadataCalls: [], httpRequests: [] };

    context.on('request', (request) => {
        const url = request.url();
        if (url.startsWith('http://') || url.startsWith('https://')) {
            fixture.httpRequests.push({ url, headers: request.headers() });
        }
    });

    await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
        const request = route.request();
        fixture.calls.push({
            url: request.url(),
            body: parseBody(request.postData()),
            headers: request.headers(),
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) });
    });

    await context.route('**/v1/chain/get_info', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                server_version: '0',
                chain_id: MAINNET_CHAIN,
                head_block_num: 1,
                last_irreversible_block_num: 1,
                last_irreversible_block_id: '0'.repeat(64),
                head_block_id: '0'.repeat(64),
                head_block_time: '2026-08-10T00:00:00Z',
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
            body: JSON.stringify({
                accounts: [{ account_name: ACCOUNT, permission_name: 'active', authorizing_key: PUB_KEY }],
            }),
        });
    });

    await context.route('**/test-metadata/*.json', async (route) => {
        const request = route.request();
        fixture.metadataCalls.push({ url: request.url(), body: {}, headers: request.headers() });
        const id = request.url().match(/test-metadata\/(\d+)\.json/)?.[1];
        if (id === '20') {
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ name: `Fixture UNIQ #${id}` }),
        });
    });

    await context.route('**/legacy-metadata/*.json', async (route) => {
        const request = route.request();
        fixture.metadataCalls.push({ url: request.url(), body: {}, headers: request.headers() });
        const id = request.url().match(/legacy-metadata\/(\d+)\.json/)?.[1];
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ name: `Legacy Fixture UNIQ #${id}` }),
        });
    });

    // Keep this route last: it distinguishes NFT ownership from the existing
    // eosio.token balance/metadata table reads without changing those reads.
    await context.route('**/v1/chain/get_table_rows', async (route) => {
        const request = route.request();
        const body = parseBody(request.postData());
        const call: RpcCall = { url: request.url(), body, headers: request.headers() };
        fixture.calls.push(call);

        if (
            body.code === NFT_CONTRACT &&
            body.scope === ACCOUNT &&
            (body.table === 'token.a' || body.table === 'token.b')
        ) {
            fixture.nftCalls.push(call);
            const table = body.table as string;
            const upperBound = typeof body.upper_bound === 'string' ? body.upper_bound : undefined;
            const lowerBound = typeof body.lower_bound === 'string' ? body.lower_bound : undefined;
            if (table === 'token.a') {
                if (lowerBound === LEGACY_TOKEN_ID) {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({ rows: [detailTokenRow(LEGACY_TOKEN_ID, 'a')], more: false }),
                    });
                    return;
                }
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: [], more: false }),
                });
                return;
            }
            if (lowerBound === SEARCH_TOKEN_ID) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: [detailTokenRow(SEARCH_TOKEN_ID)], more: false }),
                });
                return;
            }
            if (lowerBound === NEIGHBOR_TOKEN_ID) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: [detailTokenRow(SEARCH_TOKEN_ID)], more: false }),
                });
                return;
            }
            const rows =
                upperBound === '10'
                    ? uniqRows([10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
                    : uniqRows([20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify(
                    upperBound === '10' ? { rows, more: false } : { rows, more: true, next_key: '10' }
                ),
            });
            return;
        }

        if (body.code === NFT_CONTRACT && body.scope === NFT_CONTRACT) {
            const table = typeof body.table === 'string' ? body.table : '';
            const lowerBound = typeof body.lower_bound === 'string' ? body.lower_bound : '';

            if (table === 'factory.b') {
                const row = lowerBound === LEGACY_FACTORY_ID ? null : currentFactoryRow();
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: row ? [row] : [] }),
                });
                return;
            }
            if (table === 'factory.a') {
                const row = lowerBound === LEGACY_FACTORY_ID ? legacyFactoryRow() : null;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: row ? [row] : [] }),
                });
                return;
            }
            if (table === 'resale.a') {
                const row =
                    options.detailMode === 'listed' && lowerBound === SEARCH_TOKEN_ID
                        ? {
                              token_id: SEARCH_TOKEN_ID,
                              owner: ACCOUNT,
                              price: '2.00000000 UOS',
                              promoter_basis_point: '250',
                          }
                        : null;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: row ? [row] : [] }),
                });
                return;
            }
            if (table === 'auction.a') {
                const row =
                    options.detailMode === 'auction' && lowerBound === SEARCH_TOKEN_ID
                        ? {
                              token_id: SEARCH_TOKEN_ID,
                              auction_id: '9001',
                              owner: ACCOUNT,
                              bid: '3.00000000 UOS',
                              promoter_basis_point: '250',
                              start_date: '2026-08-09T00:00:00Z',
                              expiry_date: '2026-08-12T00:00:00Z',
                          }
                        : null;
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: row ? [row] : [] }),
                });
                return;
            }
            if (table === 'migration') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body:
                        options.detailMode === 'unknown'
                            ? JSON.stringify({ rows: [{ active_nft_version: 'bad', table_migration_stats: '0' }] })
                            : JSON.stringify({ rows: [{ active_nft_version: '1', table_migration_stats: '0' }] }),
                });
                return;
            }
        }

        if (body.code === NFT_CONTRACT && body.scope === '1' && body.table === 'saleshrlmcfg') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    rows: [
                        {
                            max_ultra_share_bp: '1000',
                            max_factory_share_bp: '1000',
                            min_promoter_share_bp: '200',
                            max_promoter_share_bp: '2500',
                            default_promoter: 'ultra',
                            promoter_payments_enabled: 1,
                        },
                    ],
                }),
            });
            return;
        }

        if (body.code === CONTROLLER_CONTRACT && body.scope === NFT_CONTRACT && body.table === 'disabledact') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ rows: [] }),
            });
            return;
        }

        if (body.code === 'eosio' && body.scope === 'eosio' && body.table === 'rammarket') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ rows: [{ core_reserve: '0.00000000 UOS' }] }),
            });
            return;
        }

        // Existing token balance/oracle reads are deliberately distinguished
        // from the UNIQ fixture and receive an empty, valid nodeos response.
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ rows: [], more: false }),
        });
    });

    return fixture;
}

async function launchWallet(options: HomeRpcOptions = {}): Promise<WalletHarness> {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-home-tabs-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
        const sw = await getServiceWorker(context);
        await seedExtensionState(sw);
        const rpc = await mockHomeRPC(context, options);
        const extensionId = await sw.evaluate(() => chrome.runtime.id);
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/index.html#/home`);
        await page.waitForLoadState('load');
        await expect(page.locator('.home-container')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('tab')).toHaveCount(4, { timeout: 30_000 });
        return { context, page, rpc, userDataDir };
    } catch (error) {
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
        throw error;
    }
}

async function closeWallet(harness: WalletHarness): Promise<void> {
    await harness.context.close();
    fs.rmSync(harness.userDataDir, { recursive: true, force: true });
}

async function captureWallet(page: Page, filename: string): Promise<void> {
    if (process.env.WALLET_TABS_CAPTURE !== '1') return;
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(CAPTURE_DIR, filename), fullPage: true });
}

test.describe.configure({ timeout: 180_000 });

test.describe('Wallet home tabs (real extension)', () => {
    test.beforeAll(() => {
        if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
            throw new Error(
                `Extension build not found at ${EXTENSION_PATH}. Run the browser-extension-wallet production build first.`
            );
        }
    });

    test('renders four semantic tabs with keyboard navigation and no narrow-layout overflow', async () => {
        const harness = await launchWallet();
        try {
            await harness.page.setViewportSize({ width: 320, height: 700 });
            const tabs = harness.page.getByRole('tab');
            await expect(tabs).toHaveText(['Tokens', 'UNIQs', 'Activities', 'Utilities']);
            await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
            await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
            await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
            await expect(harness.page.locator('#home-panel-tokens')).toBeVisible();

            const overflow = await harness.page.evaluate(() =>
                Math.max(
                    document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    document.body.scrollWidth - document.body.clientWidth
                )
            );
            expect(overflow, 'wallet home should fit a 320px viewport').toBeLessThanOrEqual(1);
            await captureWallet(harness.page, 'wallet-tabs-tokens-320.png');

            await tabs.nth(0).press('ArrowRight');
            await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
            await expect(tabs.nth(1)).toBeFocused();

            await tabs.nth(1).press('End');
            await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
            await expect(tabs.nth(3)).toBeFocused();

            await tabs.nth(3).press('Home');
            await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
            await expect(tabs.nth(0)).toBeFocused();
        } finally {
            await closeWallet(harness);
        }
    });

    test('loads UNIQs lazily from standard nodeos, caps pages at ten, and paginates without duplicates', async () => {
        const harness = await launchWallet();
        try {
            const { page, rpc } = harness;
            await page.setViewportSize({ width: 320, height: 700 });
            // Let one-time wallet boot traffic (OIDC discovery, if enabled by
            // the production environment) settle before the feature window.
            await page.waitForTimeout(750);
            expect(rpc.nftCalls).toHaveLength(0);

            await page.getByRole('tab', { name: 'UNIQs' }).click();
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(10);

            const firstIds = await page
                .locator('.uniq-card')
                .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-uniq-id')));
            expect(firstIds).toEqual(['20', '19', '18', '17', '16', '15', '14', '13', '12', '11']);
            await expect(page.locator('[data-uniq-id="20"] .s2-bold')).toHaveText('UNIQ #20');
            await expect(page.locator('[data-uniq-id="19"] .s2-bold')).toHaveText('Fixture UNIQ #19');
            await expect(page.locator('[data-uniq-id="19"] .uniq-card__date')).toHaveText('Minted Aug 10, 2026');
            await captureWallet(page, 'wallet-tabs-uniqs-320.png');

            expect(rpc.nftCalls.every((call) => call.body.code === NFT_CONTRACT)).toBe(true);
            expect(rpc.nftCalls.every((call) => call.body.scope === ACCOUNT)).toBe(true);
            expect(rpc.nftCalls.every((call) => call.body.json === true)).toBe(true);
            expect(rpc.nftCalls.every((call) => call.body.reverse === true)).toBe(true);
            expect(rpc.nftCalls.every((call) => !call.headers.authorization)).toBe(true);
            expect(new Set(rpc.nftCalls.map((call) => new URL(call.url).pathname))).toEqual(
                new Set(['/v1/chain/get_table_rows'])
            );
            expect(rpc.nftCalls.every((call) => call.body.limit === 10)).toBe(true);
            expect(rpc.nftCalls.every((call) => !('lower_bound' in call.body))).toBe(true);
            expect(rpc.nftCalls.some((call) => call.body.table === 'token.a')).toBe(true);
            expect(rpc.nftCalls.some((call) => call.body.table === 'token.b')).toBe(true);

            const homeScroll = page.locator('.home-scroll');
            await homeScroll.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
                element.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(20);

            const allIds = await page
                .locator('.uniq-card')
                .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-uniq-id')));
            expect(allIds).toEqual([
                '20',
                '19',
                '18',
                '17',
                '16',
                '15',
                '14',
                '13',
                '12',
                '11',
                '10',
                '9',
                '8',
                '7',
                '6',
                '5',
                '4',
                '3',
                '2',
                '1',
            ]);
            expect(new Set(allIds).size).toBe(20);
            expect(
                rpc.nftCalls.filter((call) => call.body.table === 'token.b' && call.body.upper_bound === '10')
            ).toHaveLength(1);
            expect(
                rpc.nftCalls.some((call) => call.body.table === 'factory.a' || call.body.table === 'factory.b')
            ).toBe(false);

            const allUrls = rpc.calls.map((call) => call.url).join('\n');
            expect(allUrls).not.toMatch(/graphql|dfuse|history\//i);
            const featureRequests = [...rpc.nftCalls, ...rpc.metadataCalls];
            expect(featureRequests.length).toBeGreaterThan(0);
            expect(new Set(featureRequests.map((request) => new URL(request.url).origin))).toEqual(
                new Set([new URL(NODE_URL).origin])
            );
            expect(featureRequests.every((request) => !request.headers.authorization)).toBe(true);
            expect(rpc.metadataCalls.every((call) => !call.headers.authorization)).toBe(true);
        } finally {
            await closeWallet(harness);
        }
    });

    test('filters a loaded UNIQ locally without an additional RPC request', async () => {
        const harness = await launchWallet();
        try {
            const { page, rpc } = harness;
            await page.setViewportSize({ width: 320, height: 700 });
            await page.getByRole('tab', { name: 'UNIQs' }).click();
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(10);

            const callsBeforeTyping = rpc.calls.length;
            const nftCallsBeforeTyping = rpc.nftCalls.length;
            const search = page.locator('#uniq-id-search');
            await search.fill('19');

            await expect(page.locator('.uniq-card')).toHaveCount(1);
            await expect(page.locator('[data-uniq-id="19"] .s2-bold')).toHaveText('Fixture UNIQ #19');
            expect(rpc.calls.length).toBe(callsBeforeTyping);
            expect(rpc.nftCalls.length).toBe(nftCallsBeforeTyping);
        } finally {
            await closeWallet(harness);
        }
    });

    test('searches an unloaded current token, resolves metadata, and preserves detail Back/forward state', async () => {
        const harness = await launchWallet();
        try {
            const { page, rpc } = harness;
            await page.setViewportSize({ width: 320, height: 700 });
            await page.getByRole('tab', { name: 'UNIQs' }).click();
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(10);

            await page.locator('#uniq-id-search').fill(SEARCH_TOKEN_ID);
            await page.getByRole('button', { name: 'Search UNIQ ID' }).click();
            await expect(page.locator('.uniq-search__result-heading')).toBeVisible({ timeout: 30_000 });
            await expect(page.locator(`[data-uniq-id="${SEARCH_TOKEN_ID}"] .s2-bold`)).toHaveText(
                `Fixture UNIQ #${SEARCH_TOKEN_ID}`
            );
            expect(
                rpc.nftCalls.some((call) => call.body.table === 'token.b' && call.body.lower_bound === SEARCH_TOKEN_ID)
            ).toBe(true);
            expect(rpc.metadataCalls.some((call) => call.url.endsWith(`/test-metadata/${SEARCH_TOKEN_ID}.json`))).toBe(
                true
            );

            await page.locator(`[data-uniq-id="${SEARCH_TOKEN_ID}"]`).click();
            await expect(page.locator('#uniq-detail-title')).toHaveText(`Fixture UNIQ #${SEARCH_TOKEN_ID}`, {
                timeout: 30_000,
            });
            await expect(page.locator('section[aria-labelledby="uniq-factory-heading"]')).toContainText(
                'Minimum resale price'
            );
            await expect(page.locator('.uniq-detail__actions')).toContainText('Transfer');
            await expect(page.locator('.uniq-detail__actions')).toContainText('Resell');

            const back = page.getByRole('button', { name: 'Back to UNIQ list' });
            await back.click();
            await expect(page.locator('#uniq-id-search')).toHaveValue(SEARCH_TOKEN_ID);
            await expect(page.locator(`[data-uniq-id="${SEARCH_TOKEN_ID}"]`)).toBeVisible();
            await expect(page.locator(`[data-uniq-id="${SEARCH_TOKEN_ID}"]`)).toBeFocused();

            await page.locator(`[data-uniq-id="${SEARCH_TOKEN_ID}"]`).click();
            await expect(page.locator('#uniq-detail-title')).toHaveText(`Fixture UNIQ #${SEARCH_TOKEN_ID}`, {
                timeout: 30_000,
            });
            await captureWallet(page, 'wallet-uniq-current-detail-320.png');
        } finally {
            await closeWallet(harness);
        }
    });

    test('searches a legacy token and uses the exact legacy factory metadata fallback', async () => {
        const harness = await launchWallet();
        try {
            const { page, rpc } = harness;
            await page.setViewportSize({ width: 320, height: 700 });
            await page.getByRole('tab', { name: 'UNIQs' }).click();
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(10);

            await page.locator('#uniq-id-search').fill(LEGACY_TOKEN_ID);
            await page.getByRole('button', { name: 'Search UNIQ ID' }).click();
            await expect(page.locator('.uniq-search__result-heading')).toBeVisible({ timeout: 30_000 });
            await expect(page.locator(`[data-uniq-id="${LEGACY_TOKEN_ID}"] .s2-bold`)).toHaveText(
                `Legacy Fixture UNIQ #${LEGACY_TOKEN_ID}`
            );

            const ownerCalls = rpc.nftCalls.filter((call) => call.body.lower_bound === LEGACY_TOKEN_ID);
            expect(ownerCalls.map((call) => call.body.table).sort()).toEqual(['token.a', 'token.b']);
            await page.locator(`[data-uniq-id="${LEGACY_TOKEN_ID}"]`).click();
            await expect(page.locator('#uniq-detail-title')).toHaveText(`Legacy Fixture UNIQ #${LEGACY_TOKEN_ID}`, {
                timeout: 30_000,
            });
            await expect(page.locator('section[aria-labelledby="uniq-factory-heading"]')).toContainText(
                'Factory table'
            );
            await expect(page.locator('section[aria-labelledby="uniq-factory-heading"]')).toContainText('Legacy');

            const factoryCalls = rpc.calls.filter(
                (call) => call.body.scope === NFT_CONTRACT && call.body.lower_bound === LEGACY_FACTORY_ID
            );
            expect([...new Set(factoryCalls.map((call) => call.body.table).sort())]).toEqual([
                'factory.a',
                'factory.b',
            ]);
            expect(
                rpc.metadataCalls.some((call) => call.url.endsWith(`/legacy-metadata/${LEGACY_TOKEN_ID}.json`))
            ).toBe(true);
        } finally {
            await closeWallet(harness);
        }
    });

    test('rejects a neighbor exact response and clear preserves the paged 10-to-20 list', async () => {
        const harness = await launchWallet();
        try {
            const { page, rpc } = harness;
            await page.setViewportSize({ width: 320, height: 700 });
            await page.getByRole('tab', { name: 'UNIQs' }).click();
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(10);
            const homeScroll = page.locator('.home-scroll');
            await homeScroll.evaluate((element) => {
                element.scrollTop = element.scrollHeight;
                element.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
            await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(20);
            const pageTwoRequestCount = rpc.nftCalls.filter(
                (call) => call.body.table === 'token.b' && call.body.upper_bound === '10'
            ).length;

            await page.locator('#uniq-id-search').fill(NEIGHBOR_TOKEN_ID);
            await page.getByRole('button', { name: 'Search UNIQ ID' }).click();
            await expect(page.locator('#uniq-search-status')).toContainText('not owned', { timeout: 30_000 });
            expect(rpc.nftCalls.some((call) => call.body.lower_bound === NEIGHBOR_TOKEN_ID)).toBe(true);

            await page.getByRole('button', { name: 'Clear UNIQ search' }).click();
            await expect(page.locator('.uniq-card')).toHaveCount(20);
            expect(
                rpc.nftCalls.filter((call) => call.body.table === 'token.b' && call.body.upper_bound === '10')
            ).toHaveLength(pageTwoRequestCount);
        } finally {
            await closeWallet(harness);
        }
    });

    for (const [mode, expected] of [
        ['ready', { text: 'Restricted', action: 'Transfer' }],
        ['listed', { text: 'Listed for resale', action: 'Cancel resale' }],
        ['auction', { text: 'Listed in auction', action: null }],
        ['unknown', { text: 'Required chain state is unavailable. Retry before continuing.', action: null }],
    ] as const) {
        test(`renders ${mode} detail state and fails closed for unavailable owner actions`, async () => {
            const harness = await launchWallet({ detailMode: mode });
            try {
                const { page } = harness;
                await page.setViewportSize({ width: 320, height: 700 });
                await page.getByRole('tab', { name: 'UNIQs' }).click();
                await expect.poll(() => page.locator('.uniq-card').count(), { timeout: 30_000 }).toBe(10);
                await page.locator('#uniq-id-search').fill(SEARCH_TOKEN_ID);
                await page.getByRole('button', { name: 'Search UNIQ ID' }).click();
                await expect(page.locator('.uniq-search__result-heading')).toBeVisible({ timeout: 30_000 });
                await page.locator(`[data-uniq-id="${SEARCH_TOKEN_ID}"]`).click();
                await expect(page.locator('#uniq-detail-title')).toBeVisible({ timeout: 30_000 });
                await expect(page.locator('.uniq-detail')).toContainText(expected.text);
                if (expected.action) {
                    await expect(page.locator('.uniq-detail__actions')).toContainText(expected.action);
                } else {
                    await expect(page.locator('.uniq-detail__actions button')).toHaveCount(0);
                }
            } finally {
                await closeWallet(harness);
            }
        });
    }

    test('keeps activities link-only and opens the exact Explorer/utilities destinations', async () => {
        const harness = await launchWallet();
        try {
            const { context, page, rpc } = harness;
            await page.setViewportSize({ width: 320, height: 700 });
            await page.getByRole('tab', { name: 'Activities' }).click();
            const activityLink = page.getByRole('link', { name: /View account activity on Explorer/i });
            await expect(activityLink).toHaveAttribute('href', EXPLORER_URL);
            const historyCallsBefore = rpc.calls.filter((call) => /\/history\//.test(call.url)).length;
            await page.waitForTimeout(300);
            expect(rpc.calls.filter((call) => /\/history\//.test(call.url))).toHaveLength(historyCallsBefore);
            await captureWallet(page, 'wallet-tabs-activities-320.png');

            const activityPagePromise = context.waitForEvent('page');
            await activityLink.click();
            const activityPage = await activityPagePromise;
            await expect.poll(() => activityPage.url(), { timeout: 10_000 }).toBe(EXPLORER_URL);
            await activityPage.close();

            await page.getByRole('tab', { name: 'Utilities' }).click();
            await captureWallet(page, 'wallet-tabs-utilities-320.png');
            const utilityDestinations = [
                'https://bridge.ultra.io/?connect=extension',
                'https://toolkit.ultra.io/?connect=extension',
            ];
            await expect(page.locator('button.utility-action')).toHaveCount(2);
            for (let index = 0; index < utilityDestinations.length; index++) {
                const utilityPagePromise = context.waitForEvent('page');
                await page.locator('button.utility-action').nth(index).click();
                const utilityPage = await utilityPagePromise;
                await expect.poll(() => utilityPage.url(), { timeout: 10_000 }).toBe(utilityDestinations[index]);
                await utilityPage.close();
            }
        } finally {
            await closeWallet(harness);
        }
    });
});
