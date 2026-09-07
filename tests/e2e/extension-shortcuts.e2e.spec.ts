// Prerequisites: build ../web-app's production extension, this toolkit, and
// ../ultra-bridge-dapp with VITE_ULTRA_BRIDGE_ENV=testnet. Requires openssl.
// Run: npx playwright test tests/e2e/extension-shortcuts.e2e.spec.ts --workers=1
// Real extension and dapp bundles; chain responses are deterministic fixtures.
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const EXTENSION_PATH = path.resolve('../web-app/dist/browser-extension-wallet');
const PASSWORD = 'TestPass123!';
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';
const apps = [
    { name: 'toolkit', label: 'Ultra Toolkit', origin: 'https://toolkit.ultra.io', dist: path.resolve('dist') },
    { name: 'bridge', label: 'Ultra Bridge', origin: 'https://bridge.ultra.io', dist: path.resolve('../ultra-bridge-dapp/dist') },
] as const;
type App = typeof apps[number];

test.describe.configure({ timeout: 60_000 });

// A local TLS server preserves the real Utilities URLs even for Chrome's
// initial tabs.create navigation, which bypasses Playwright route interception.
let server: https.Server;
let serverPort: number;
let certificateDir: string;
test.beforeAll(async () => {
    certificateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortcut-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-keyout', path.join(certificateDir, 'key.pem'),
        '-out', path.join(certificateDir, 'cert.pem')], { stdio: 'ignore' });
    server = https.createServer({
        key: fs.readFileSync(path.join(certificateDir, 'key.pem')),
        cert: fs.readFileSync(path.join(certificateDir, 'cert.pem')),
    }, (request, response) => {
        const app = apps.find(item => new URL(item.origin).hostname === request.headers.host?.split(':')[0]);
        if (!app) { response.writeHead(404).end(); return; }
        const candidate = path.resolve(app.dist, '.' + new URL(request.url!, app.origin).pathname);
        const file = candidate.startsWith(app.dist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
            ? candidate : path.join(app.dist, 'index.html');
        response.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
        fs.createReadStream(file).pipe(response);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    serverPort = (server.address() as AddressInfo).port;
});
test.afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (certificateDir) fs.rmSync(certificateDir, { recursive: true, force: true });
});

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
          entries: [{ account: 'otheraccount', permission: 'active', authorizing_key: cfg.pubKey }],
          timestamp: now,
          publicKeys: [cfg.pubKey],
        },
        testnet: {
          entries: [{ account: 'testaccount1', permission: 'active', authorizing_key: cfg.pubKey }],
          timestamp: now,
          publicKeys: [cfg.pubKey],
        },
      },
    });
  }, cfg);
}

async function launch(env: 'testnet' | 'mainnet' = 'testnet') {
    const context = await chromium.launchPersistentContext('', {
        headless: false,
        ignoreHTTPSErrors: true,
        viewport: { width: 800, height: 600 },
        args: ['--headless=new', '--window-size=800,600', '--ignore-certificate-errors', `--host-resolver-rules=MAP toolkit.ultra.io 127.0.0.1:${serverPort}, MAP bridge.ultra.io 127.0.0.1:${serverPort}`, '--no-sandbox', `--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    await context.route('**/v1/chain/**', async route => {
        const url = new URL(route.request().url());
        const testnet = /testnet|test\./.test(url.hostname);
        const account = testnet ? 'testaccount1' : 'otheraccount';
        const method = url.pathname.split('/').pop();
        const body = route.request().postDataJSON() || {};
        let data: unknown = {};
        if (method === 'get_info') data = { chain_id: testnet ? TESTNET_CHAIN : MAINNET_CHAIN, head_block_num: 1, last_irreversible_block_num: 1, head_block_time: '2026-09-07T00:00:00.000' };
        if (method === 'get_accounts_by_authorizers') data = { accounts: [{ account_name: account, permission_name: 'active', authorizing_key: PUB_KEY, weight: 1, threshold: 1 }] };
        if (method === 'get_currency_balance') data = ['100.00000000 UOS'];
        if (method === 'get_account') data = { account_name: body.account_name, permissions: [{ perm_name: 'active', parent: 'owner', required_auth: { threshold: 1, keys: [{ key: PUB_KEY, weight: 1 }], accounts: [], waits: [] } }] };
        if (method === 'get_table_rows') data = { rows: body.code === 'eosio.oracle' ? [{ average: { price: '0.03000000 USD' } }] : [], more: false };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    worker.on('console', message => { if (message.type() === 'error') console.error('Extension worker:', message.text()); });
    await seedExtensionState(worker, { password: PASSWORD, pubKey: PUB_KEY, privKey: PRIV_KEY, env, trustedOnEnvs: [], origins: [], uiMode: 'popup' });
    await worker.evaluate(() => chrome.storage.local.set({ REQUESTS: [] }));
    const wallet = await context.newPage();
    await wallet.setViewportSize({ width: 380, height: 700 });
    await wallet.goto(`chrome-extension://${worker.url().split('/')[2]}/index.html#/home`);
    await expect(wallet.getByRole('tab', { name: 'Utilities' })).toBeVisible();
    return { context, wallet, worker };
}

async function openUtility(context: BrowserContext, wallet: Page, app: App) {
    await wallet.getByRole('tab', { name: 'Utilities' }).click();
    const opened = context.waitForEvent('page');
    await wallet.locator('button.utility-action').filter({ hasText: app.label }).click();
    const dapp = await opened;
    dapp.on('dialog', dialog => dialog.dismiss());
    await expect(dapp).toHaveURL(new RegExp(app.origin.replaceAll('.', '\\.')));
    return dapp;
}

async function permission(context: BrowserContext) {
    let page: Page | undefined;
    await expect.poll(async () => {
        page = context.pages().find(p => p.url().includes('/permission-request/'));
        return !!page && await page.locator('ultra-connect-confirm').isVisible();
    }, { timeout: 30_000 }).toBe(true);
    return page!;
}

async function connected(dapp: Page, app: App, account = 'testaccount1') {
    if (app.name === 'toolkit') {
        await expect.poll(() => dapp.evaluate(() => JSON.parse(localStorage.getItem('authState') || '{}').accountName)).toBe(account);
    } else {
        await expect(dapp.getByTestId('bridge-from-network').getByTestId('wallet-address')).toContainText(account);
    }
    await expect.poll(() => new URL(dapp.url()).searchParams.has('connect')).toBe(false);
}

for (const app of apps) {
    test(`${app.name}: utility click connects, reload restores, disconnect and shortcut reconnect work`, async () => {
        const { context, wallet, worker } = await launch();
        try {
            const dapp = await openUtility(context, wallet, app);
            await (await permission(context)).locator('ultra-block-button[title="Connect"]').click();
            await connected(dapp, app);
            await dapp.reload();
            await connected(dapp, app);
            expect(context.pages().filter(p => p.url().includes('/permission-request/'))).toHaveLength(0);
            if (app.name === 'toolkit') {
                await dapp.getByText('Logout', { exact: true }).click();
                await expect(dapp.getByText('Login to Tool Kit', { exact: true })).toBeVisible();
            } else {
                await dapp.getByTestId('bridge-from-network').getByTestId('wallet-disconnect').click();
                await dapp.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
            }
            await expect.poll(() => worker.evaluate(async () => Object.values((await chrome.storage.local.get('TRUSTED_APPS')).TRUSTED_APPS || {}).flat())).not.toContain(app.origin);
            await dapp.goto(app.origin + '/?connect=extension');
            await (await permission(context)).locator('ultra-block-button[title="Connect"]').click();
            await connected(dapp, app);
        } finally { await context.close(); }
    });

    test(`${app.name}: cancellation does not retry on refresh and manual login still works`, async () => {
        const { context, wallet } = await launch();
        try {
            const dapp = await openUtility(context, wallet, app);
            await (await permission(context)).locator('ultra-block-button[title="Cancel"]').click();
            if (app.name === 'toolkit') {
                // Wait for the rejection alert to be dismissed and the SDK
                // cancellation to settle before navigating away.
                await expect(dapp.locator('button').filter({ hasText: 'Ultra Wallet (Extension)' })).toBeVisible();
            }
            await expect.poll(() => new URL(dapp.url()).searchParams.has('connect')).toBe(false);
            await dapp.reload();
            if (app.name === 'toolkit') {
                await dapp.getByText('Login to Tool Kit', { exact: true }).click();
                await dapp.locator('button').filter({ hasText: 'Ultra Wallet (Extension)' }).click();
            } else {
                await dapp.getByTestId('bridge-from-network').getByTestId('wallet-connect').click();
            }
            await (await permission(context)).locator('ultra-block-button[title="Connect"]').click();
            await connected(dapp, app);
        } finally { await context.close(); }
    });

    test(`${app.name}: wallet network is respected on shortcut connection`, async () => {
        const { context, wallet } = await launch('mainnet');
        try {
            const dapp = await openUtility(context, wallet, app);
            await (await permission(context)).locator('ultra-block-button[title="Connect"]').click();
            await connected(dapp, app, 'otheraccount');
            if (app.name === 'toolkit') {
                await expect.poll(() => dapp.evaluate(() => JSON.parse(localStorage.getItem('authState') || '{}').chainId)).toBe(MAINNET_CHAIN);
            } else {
                await expect(dapp.getByText('Your Ultra wallet is on', { exact: false })).toBeVisible();
                await expect(dapp.getByTestId('bridge-submit')).toBeDisabled();
            }
        } finally { await context.close(); }
    });
}
