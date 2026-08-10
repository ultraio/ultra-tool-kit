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
        mint_date: '2026-08-10T00:00:00.000',
        uri: `${NODE_URL}/test-metadata/${id}.json`,
    }));
}

/**
 * Register the broad nodeos fallback first and the feature-specific routes
 * afterwards. Playwright evaluates the newest matching route first, so the
 * final get_table_rows handler owns the NFT fixture while all other chain
 * calls remain harmless and observable.
 */
async function mockHomeRPC(context: BrowserContext): Promise<HomeRpcFixture> {
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
                head_block_time: '2026-08-10T00:00:00.000',
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
            if (table === 'token.a') {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: [], more: false }),
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

async function launchWallet(): Promise<WalletHarness> {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-home-tabs-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
        const sw = await getServiceWorker(context);
        await seedExtensionState(sw);
        const rpc = await mockHomeRPC(context);
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
            const featureRequestStart = rpc.httpRequests.length;
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
            const featureRequests = rpc.httpRequests.slice(featureRequestStart);
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
                'https://bridge.ultra.io/',
                'https://chatroom.ultra.io/',
                'https://toolkit.ultra.io/',
            ];
            await expect(page.locator('button.utility-action')).toHaveCount(3);
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
