/**
 * Real-extension owner-action coverage for UNIQ transfer, resale, and resale
 * cancellation. Every chain and signer endpoint is intercepted with an
 * explicit standard nodeos fixture; the suite never sends a live write.
 */

import { test, expect, chromium, BrowserContext, Page, Worker } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { assertLocalDappExtensionBuild } from './helpers/extension-build';
import {
    ACCOUNT,
    NFT_CONTRACT,
    RECIPIENT,
    TOKEN_ID,
    OwnerChainRpcFixture,
    assertNoAuthOrProhibitedTraffic,
    mockOwnerChainRPC,
    seedOwnerWalletState,
} from './helpers/uniq-owner-chain-rpc';

const EXTENSION_PATH = path.resolve(process.cwd(), '../web-app/dist/browser-extension-wallet');
const CAPTURE_DIR = path.resolve(process.cwd(), 'output/playwright');

interface OwnerWalletHarness {
    context: BrowserContext;
    page: Page;
    sw: Worker;
    rpc: OwnerChainRpcFixture;
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

async function launchOwnerWallet(options: Parameters<typeof mockOwnerChainRPC>[1] = {}): Promise<OwnerWalletHarness> {
    const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-wallet-uniq-owner-actions-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`, '--no-first-run'],
    });
    try {
        const sw = await getServiceWorker(context);
        await seedOwnerWalletState(sw);
        const rpc = await mockOwnerChainRPC(context, options);
        const extensionId = await sw.evaluate(() => chrome.runtime.id);
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/index.html#/home`);
        await page.waitForLoadState('load');
        await expect(page.locator('.home-container')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('tab')).toHaveCount(4, { timeout: 30_000 });
        return { context, page, sw, rpc, userDataDir };
    } catch (error) {
        await context.close();
        fs.rmSync(userDataDir, { recursive: true, force: true });
        throw error;
    }
}

async function closeOwnerWallet(harness: OwnerWalletHarness): Promise<void> {
    await harness.context.close();
    fs.rmSync(harness.userDataDir, { recursive: true, force: true });
}

async function openOwnerDetail(page: Page): Promise<void> {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.getByRole('tab', { name: 'UNIQs' }).click();
    await expect(page.locator('.uniq-card')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator(`[data-uniq-id="${TOKEN_ID}"]`)).toBeVisible();
    await page.locator(`[data-uniq-id="${TOKEN_ID}"]`).click();
    await expect(page.locator('#uniq-detail-title')).toBeVisible({ timeout: 30_000 });
}

async function openActionForm(page: Page, action: 'Transfer' | 'Resell' | 'Cancel resale'): Promise<void> {
    await expect(page.locator('.uniq-detail__actions')).toContainText(action, { timeout: 30_000 });
    await page.locator('.uniq-detail__actions').getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('ultra-uniq-action-form')).toBeVisible({ timeout: 30_000 });
}

async function submitActionForm(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Continue to confirmation', exact: true }).click();
    await expect(page).toHaveURL(/#\/sign-transaction\/uniq-action\/.+\/confirm/, { timeout: 30_000 });
}

async function confirmAction(page: Page, expectedTitle: string): Promise<void> {
    await expect(page.locator('ultra-uniq-action-confirm')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('ultra-top-nav')).toContainText(expectedTitle);
    await page.locator('ultra-wallet-transaction-footer').getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function capture(page: Page, name: string): Promise<void> {
    if (process.env.WALLET_TABS_CAPTURE !== '1') return;
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(CAPTURE_DIR, name), fullPage: true });
}

test.describe.configure({ timeout: 180_000 });

test.describe('UNIQ owner actions (real extension)', () => {
    test.beforeAll(() => {
        assertLocalDappExtensionBuild(EXTENSION_PATH);
    });

    test('invalid transfer recipient is blocked before any authorization, ABI, or broadcast request', async () => {
        const harness = await launchOwnerWallet();
        try {
            const { page, rpc } = harness;
            await openOwnerDetail(page);
            await openActionForm(page, 'Transfer');

            await page.locator('#uniq-recipient').fill('not valid');
            await expect(page.getByRole('button', { name: 'Continue to confirmation', exact: true })).toBeDisabled();
            await page.waitForTimeout(300);

            expect(rpc.pushRequests).toHaveLength(0);
            expect(rpc.requiredSigningCalls).toHaveLength(0);
            assertNoAuthOrProhibitedTraffic(rpc);
        } finally {
            await closeOwnerWallet(harness);
        }
    });

    test('transfer builds the owner action, confirms, and broadcasts exactly once through mocked nodeos', async () => {
        const harness = await launchOwnerWallet();
        try {
            const { page, rpc } = harness;
            await openOwnerDetail(page);
            await openActionForm(page, 'Transfer');
            await page.locator('#uniq-recipient').fill(RECIPIENT);
            await page.locator('#uniq-transfer-memo').fill('gift');
            await submitActionForm(page);
            await expect(page.locator('ultra-uniq-action-confirm')).toContainText(`UNIQ ID${TOKEN_ID}`);
            await expect(page.locator('ultra-uniq-action-confirm')).toContainText(`Recipient: ${RECIPIENT}`);
            await confirmAction(page, 'Confirm UNIQ transfer');

            await expect(page.locator('ultra-transaction-status')).toContainText('Your UNIQ action', {
                timeout: 30_000,
            });
            expect(rpc.pushRequests).toHaveLength(1);
            expect(rpc.pushRequests[0].body.signatures).toEqual(expect.arrayContaining([expect.any(String)]));
            expect(typeof rpc.pushRequests[0].body.packed_trx).toBe('string');
            expect(String(rpc.pushRequests[0].body.packed_trx).length).toBeGreaterThan(0);
            expect(rpc.requiredSigningCalls.filter((call) => call.url.endsWith('/get_abi'))).toHaveLength(1);
            expect(rpc.requiredSigningCalls.filter((call) => call.body.account_name === NFT_CONTRACT)).toHaveLength(1);
            expect(rpc.calls.some((call) => call.url.endsWith('/get_info'))).toBe(true);
            expect(rpc.pushRequests[0].headers.authorization).toBeUndefined();
            expect(rpc.pushRequests[0].body).toEqual(
                expect.objectContaining({ signatures: expect.any(Array), packed_trx: expect.any(String) })
            );
            await capture(page, 'wallet-uniq-transfer-success-320.png');
            assertNoAuthOrProhibitedTraffic(rpc);
        } finally {
            await closeOwnerWallet(harness);
        }
    });

    test('chain rejection reaches the error route without optimistic ownership mutation and can retry', async () => {
        const harness = await launchOwnerWallet({ push: 'failure' });
        try {
            const { page, rpc } = harness;
            await openOwnerDetail(page);
            await openActionForm(page, 'Transfer');
            await page.locator('#uniq-recipient').fill(RECIPIENT);
            await submitActionForm(page);
            await confirmAction(page, 'Confirm UNIQ transfer');

            await expect(page.locator('ultra-uniq-action-error')).toContainText('UNIQ action failed', {
                timeout: 30_000,
            });
            expect(rpc.pushRequests).toHaveLength(1);
            await page.getByRole('button', { name: 'Try again', exact: true }).click();
            await expect(page).toHaveURL(new RegExp(`#\\/sign-transaction\\/uniq-action\\/transfer\\/${TOKEN_ID}$`), {
                timeout: 30_000,
            });
            await expect(page.locator('ultra-uniq-action-form')).toBeVisible({ timeout: 30_000 });
            await page.goto(page.url().replace(/#.*$/, '#/home'));
            // openOwnerDetail first proves that the owner inventory still
            // contains the exact token, then opens the detail overlay.
            await openOwnerDetail(page);
            await expect(page.locator('.uniq-detail')).toContainText(ACCOUNT);
            expect(rpc.pushRequests).toHaveLength(1);
            assertNoAuthOrProhibitedTraffic(rpc);
        } finally {
            await closeOwnerWallet(harness);
        }
    });

    test('resell uses the selected core precision and current commission range in confirmation', async () => {
        const harness = await launchOwnerWallet();
        try {
            const { page, rpc } = harness;
            await openOwnerDetail(page);
            await openActionForm(page, 'Resell');
            await page.locator('#uniq-resell-price').fill('2.5');
            await page.getByRole('button', { name: 'Advanced resale options', exact: true }).click();
            await expect(page.locator('#uniq-promoter-rate')).toHaveValue('200');
            await page.locator('#uniq-promoter-rate').fill('250');
            await page.locator('#uniq-resell-memo').fill('listing');
            await submitActionForm(page);
            await expect(page.locator('ultra-uniq-action-confirm')).toContainText('Price: 2.50000000 UOS');
            await expect(page.locator('ultra-uniq-action-confirm')).toContainText('Promoter reward: 250 bp');
            await confirmAction(page, 'Confirm UNIQ resale');

            await expect(page.locator('ultra-transaction-status')).toContainText('Your UNIQ action', {
                timeout: 30_000,
            });
            expect(rpc.pushRequests).toHaveLength(1);
            expect(rpc.pushRequests[0].body.signatures).toEqual(expect.arrayContaining([expect.any(String)]));
            expect(String(rpc.pushRequests[0].body.packed_trx).length).toBeGreaterThan(0);
            expect(rpc.requiredSigningCalls.filter((call) => call.url.endsWith('/get_abi'))).toHaveLength(1);
            assertNoAuthOrProhibitedTraffic(rpc);
        } finally {
            await closeOwnerWallet(harness);
        }
    });

    test('cancel-resale confirmation is explicit and Decline performs zero signing or broadcast calls', async () => {
        const harness = await launchOwnerWallet({ listing: true });
        try {
            const { page, rpc } = harness;
            await openOwnerDetail(page);
            await openActionForm(page, 'Cancel resale');
            await expect(page.locator('ultra-uniq-action-form')).toContainText('2.00000000 UOS');
            await page.locator('#uniq-cancel-memo').fill('changed my mind');
            await submitActionForm(page);
            await expect(page.locator('ultra-uniq-action-confirm')).toContainText(`Current listing: 2.00000000 UOS`);
            await expect(page.locator('ultra-top-nav')).toContainText('Confirm resale cancellation');

            await page
                .locator('ultra-wallet-transaction-footer')
                .getByRole('button', { name: 'Decline', exact: true })
                .click();
            expect(rpc.pushRequests).toHaveLength(0);
            expect(rpc.requiredSigningCalls).toHaveLength(0);
            assertNoAuthOrProhibitedTraffic(rpc);
        } finally {
            await closeOwnerWallet(harness);
        }
    });
});
