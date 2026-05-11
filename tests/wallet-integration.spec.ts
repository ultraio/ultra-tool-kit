import { test, expect, Page } from '@playwright/test';

// --- Constants ---

const TESTNET_CHAIN_ID = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN_ID = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';
const TEST_ACCOUNT = 'testaccount1';
const TEST_ACCOUNT_2 = 'otheraccount';
const TEST_PUBKEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const TEST_TX_HASH = 'abc123def456789abcdef0123456789abcdef0123456789abcdef0123456789a';

const SCREENSHOT_DIR = 'test-results/screenshots';

// --- Wallet Mock ---

function walletMockScript(overrides: Record<string, any> = {}) {
    const config = {
        accountName: TEST_ACCOUNT,
        permission: 'active',
        publicKey: TEST_PUBKEY,
        chainId: TESTNET_CHAIN_ID,
        networkName: 'Testnet',
        txHash: TEST_TX_HASH,
        connectShouldFail: false,
        ...overrides,
    };

    return `
        window.__walletTrusted = false;
        window.__walletConfig = ${JSON.stringify(config)};
        window.__signCalls = [];

        window.ultra = {
            connect: async (params) => {
                const cfg = window.__walletConfig;
                if (cfg.connectShouldFail) {
                    return { status: 'fail', data: null, message: 'Connection rejected' };
                }
                if (params && params.onlyIfTrusted && !window.__walletTrusted) {
                    throw new Error('Not trusted');
                }
                window.__walletTrusted = true;
                return {
                    status: 'success',
                    data: {
                        blockchainid: cfg.accountName,
                        publicKey: cfg.publicKey,
                        selectedAccount: {
                            accountName: cfg.accountName,
                            permissions: [{ name: cfg.permission, publicKeys: [cfg.publicKey] }]
                        },
                        network: { name: cfg.networkName, chainId: cfg.chainId }
                    }
                };
            },
            disconnect: async () => {
                window.__walletTrusted = false;
                return { status: 'success', data: true };
            },
            signTransaction: async (tx, opts) => {
                const cfg = window.__walletConfig;
                window.__signCalls.push({ tx, opts });
                return {
                    status: 'success',
                    data: { transactionHash: cfg.txHash }
                };
            },
            getChainId: async () => {
                const cfg = window.__walletConfig;
                return { status: 'success', data: cfg.chainId };
            },
            getAccounts: async () => {
                const cfg = window.__walletConfig;
                return {
                    status: 'success',
                    data: [{
                        accountName: cfg.accountName,
                        permissions: [{ name: cfg.permission, publicKeys: [cfg.publicKey] }]
                    }]
                };
            },
            getSelectedAccount: async () => {
                const cfg = window.__walletConfig;
                return {
                    status: 'success',
                    data: {
                        accountName: cfg.accountName,
                        permissions: [{ name: cfg.permission, publicKeys: [cfg.publicKey] }]
                    }
                };
            },
            getAvailableAuthorizations: async () => {
                const cfg = window.__walletConfig;
                return {
                    status: 'success',
                    data: [{ accountName: cfg.accountName, permission: cfg.permission, publicKey: cfg.publicKey }]
                };
            },
            on: (event, cb) => {
                if (!window.__walletCallbacks) window.__walletCallbacks = {};
                if (!window.__walletCallbacks[event]) window.__walletCallbacks[event] = [];
                window.__walletCallbacks[event].push(cb);
            },
            // Mirror the real extension's addExtensionListener: tracks which events
            // the dApp wants. Events only fire for registered listeners.
            addExtensionListener: async (eventName, listenerId) => {
                if (!window.__registeredListeners) window.__registeredListeners = {};
                window.__registeredListeners[eventName] = listenerId;
                return { status: 'success', data: null };
            },
            removeExtensionListener: async (eventName, listenerId) => {
                if (window.__registeredListeners && window.__registeredListeners[eventName] === listenerId) {
                    delete window.__registeredListeners[eventName];
                }
                return { status: 'success', data: null };
            },
            signMessage: async (msg) => ({ status: 'success', data: { signature: 'SIG_K1_mock123' } }),
            purchaseItem: async () => ({ status: 'success', data: { orderHash: '', items: [] } }),
        };
    `;
}

// --- Helpers ---

async function mockChainAPI(page: Page, chainId: string = TESTNET_CHAIN_ID) {
    await page.route('**/v1/chain/get_account', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                account_name: body.account_name || TEST_ACCOUNT,
                head_block_num: 100000,
                head_block_time: '2026-04-04T00:00:00.000',
                privileged: false,
                last_code_update: '1970-01-01T00:00:00.000',
                created: '2024-01-01T00:00:00.000',
                ram_quota: 100000,
                net_weight: 1000,
                cpu_weight: 1000,
                net_limit: { used: 0, available: 100000, max: 100000 },
                cpu_limit: { used: 0, available: 100000, max: 100000 },
                ram_usage: 3000,
                permissions: [
                    {
                        perm_name: 'active',
                        parent: 'owner',
                        required_auth: { threshold: 1, keys: [{ key: TEST_PUBKEY, weight: 1 }], accounts: [], waits: [] },
                    },
                    {
                        perm_name: 'owner',
                        parent: '',
                        required_auth: { threshold: 1, keys: [{ key: TEST_PUBKEY, weight: 1 }], accounts: [], waits: [] },
                    },
                ],
                total_resources: null,
                self_delegated_bandwidth: null,
                refund_request: null,
                voter_info: null,
            }),
        });
    });

    await page.route('**/v1/chain/get_info', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                server_version: 'mock',
                chain_id: chainId,
                head_block_num: 100000,
                head_block_time: '2026-04-04T00:00:00.000',
                head_block_producer: 'ultra',
                last_irreversible_block_num: 99999,
                last_irreversible_block_id: '0'.repeat(64),
                head_block_id: '0'.repeat(63) + '1',
                server_version_string: 'mock-v1',
                fork_db_head_block_num: 100000,
                fork_db_head_block_id: '0'.repeat(63) + '1',
            }),
        });
    });
}

/**
 * Fire a wallet event using the REAL extension message format.
 * The extension's MessageType.EVENT enum value is the uppercase string 'EVENT';
 * the content script forwards the Message object as-is via postMessage. Mock
 * this faithfully so handlers that mistakenly compare lowercase are caught.
 * Only fires if the dApp has registered a listener for this event (matches real behavior).
 */
async function fireWalletEvent(page: Page, eventName: string, data: any) {
    await page.evaluate(({ eventName, data }) => {
        // Check if the dApp registered a listener for this event (real extension gates this)
        if (!(window as any).__registeredListeners || !(window as any).__registeredListeners[eventName]) {
            console.warn(`No listener registered for ${eventName}, skipping`);
            return;
        }
        window.postMessage({
            type: 'EVENT',
            from: 'content_script',
            to: 'external_page',
            payload: {
                event: eventName,
                origin: window.location.origin,
                data: data,
            },
            id: 'test-' + Date.now(),
        }, window.location.origin);
    }, { eventName, data });
}

async function connectWallet(page: Page) {
    await page.click('text=Login to Tool Kit');
    await page.click('button:has-text("Ultra Wallet (Extension)")');
    await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible({ timeout: 5000 });
}

async function screenshot(page: Page, name: string) {
    await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: false });
}

async function getAuthState(page: Page): Promise<any> {
    return page.evaluate(() => {
        const raw = localStorage.getItem('authState');
        return raw ? JSON.parse(raw) : null;
    });
}

// --- Tests ---

test.describe('Wallet SDK Integration', () => {

    // ============================================================
    // 1. CONNECT FLOW — full walkthrough with screenshots
    // ============================================================
    test.describe('Connect Flow', () => {

        test('full connect flow: initial → login modal → connected', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            // Step 1: Initial state — login button visible, no account
            await expect(page.locator('text=Login to Tool Kit')).toBeVisible();
            await expect(page.locator('text=Logout')).not.toBeVisible();
            await screenshot(page, '01-initial-state');

            // Step 2: Open login modal
            await page.click('text=Login to Tool Kit');
            await expect(page.locator('text=Select a Wallet Provider')).toBeVisible();

            // All 4 wallet provider buttons present (Extension, Web, Anchor, Ledger).
            // Use the (Extension) suffix to disambiguate from the Web wallet entry.
            const extensionBtn = page.locator('button:has-text("Ultra Wallet (Extension)")');
            await expect(extensionBtn).toBeVisible();
            await expect(page.locator('button:has-text("Ultra Wallet (Web)")')).toBeVisible();
            await expect(page.locator('button:has-text("Anchor")')).toBeVisible();
            await expect(page.locator('button:has-text("Ledger")')).toBeVisible();

            // Extension button enabled when window.ultra is injected
            await expect(extensionBtn).toBeEnabled();

            // One Help button per provider
            const helpButtons = page.locator('button:has-text("Help")');
            expect(await helpButtons.count()).toBe(4);
            await screenshot(page, '02-login-modal-open');

            // Step 3: Click the Extension button → connecting → connected
            await extensionBtn.click();

            // Wait for account to appear
            await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible({ timeout: 5000 });
            await expect(page.locator('text=Logout')).toBeVisible();

            // Login modal should be closed
            await expect(page.locator('text=Select a Wallet Provider')).not.toBeVisible();
            await screenshot(page, '03-connected');

            // Step 4: Verify localStorage was set correctly
            const authState = await getAuthState(page);
            expect(authState).toBeTruthy();
            expect(authState.accountName).toBe(TEST_ACCOUNT);
            expect(authState.accountPerm).toBe('active');
            expect(authState.type).toBe('ultra');
            expect(authState.chainId).toBe(TESTNET_CHAIN_ID);

            // Step 5: No network mismatch warning (chains match)
            await expect(page.locator('text=Wallet network differs from endpoint')).not.toBeVisible();

            // Step 6: Active network name is displayed in the top bar selector.
            // The toolkit shows the human-readable network name ("Testnet" /
            // "Mainnet"), not the raw URL.
            await expect(page.locator('button', { hasText: /^(Mainnet|Testnet|Local:8888|Custom)$/ }).first()).toBeVisible();
        });

        test('connect with non-active permission shows account@permission', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript({ permission: 'owner' }) });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Should show "testaccount1@owner"
            await expect(page.locator(`text=${TEST_ACCOUNT}@owner`).first()).toBeVisible();
            await screenshot(page, '04-non-active-permission');

            // Verify localStorage has correct permission
            const authState = await getAuthState(page);
            expect(authState.accountPerm).toBe('owner');
        });

        test('connect failure shows alert and returns to wallet selection', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript({ connectShouldFail: true }) });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            let alertMessage = '';
            page.on('dialog', async (dialog) => {
                alertMessage = dialog.message();
                await dialog.accept();
            });

            await page.click('text=Login to Tool Kit');
            await screenshot(page, '05-connect-fail-modal');

            await page.click('button:has-text("Ultra Wallet (Extension)")');

            // Wait for alert to fire
            await page.waitForTimeout(500);
            expect(alertMessage).toContain('canceled');

            // Should return to wallet selection
            await expect(page.locator('text=Select a Wallet Provider')).toBeVisible();
            await screenshot(page, '06-connect-fail-back-to-selection');

            // No authState stored
            const authState = await getAuthState(page);
            expect(authState?.accountName).toBeFalsy();
        });
    });

    // ============================================================
    // 2. ULTRA WALLET NOT AVAILABLE
    // ============================================================
    test.describe('Extension Not Available', () => {

        test('Ultra Wallet button is disabled when extension is not installed', async ({ page }) => {
            // Do NOT inject window.ultra
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            await page.click('text=Login to Tool Kit');

            // Only the Extension button is disabled when window.ultra is missing.
            // The Web wallet, Anchor, and Ledger remain clickable — they don't
            // depend on the extension being installed.
            const extensionBtn = page.locator('button:has-text("Ultra Wallet (Extension)")');
            await expect(extensionBtn).toHaveClass(/cursor-default/);
            await expect(extensionBtn).not.toHaveClass(/cursor-pointer/);

            await expect(page.locator('button:has-text("Ultra Wallet (Web)")')).toHaveClass(/cursor-pointer/);
            await expect(page.locator('button:has-text("Anchor")')).toHaveClass(/cursor-pointer/);
            await expect(page.locator('button:has-text("Ledger")')).toHaveClass(/cursor-pointer/);

            await screenshot(page, '07-extension-not-available');
        });
    });

    // ============================================================
    // 3. SESSION RESTORE
    // ============================================================
    test.describe('Session Restore', () => {

        test('restores session from localStorage without popup', async ({ page }) => {
            const preTrustedMock = walletMockScript().replace(
                'window.__walletTrusted = false;',
                'window.__walletTrusted = true;'
            );
            await page.addInitScript({ content: preTrustedMock });
            await mockChainAPI(page);

            // Set localStorage with saved session
            await page.goto('/');
            await page.evaluate(({ account }) => {
                localStorage.setItem('authState', JSON.stringify({
                    accountName: account,
                    accountPerm: 'active',
                    endpoint: 'https://ultra.eosphere.io',
                    environment: 'Mainnet',
                    type: 'ultra',
                    isAdmin: false,
                }));
            }, { account: TEST_ACCOUNT });

            // Reload
            await page.reload();
            await page.waitForLoadState('networkidle');

            // Auto-reconnected
            await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible({ timeout: 5000 });
            await expect(page.locator('text=Select a Wallet Provider')).not.toBeVisible();
            await screenshot(page, '08-session-restored');

            // chainId was captured during restore
            const authState = await getAuthState(page);
            expect(authState.chainId).toBe(TESTNET_CHAIN_ID);
        });

        test('failed restore shows login button without popup', async ({ page }) => {
            // NOT pre-trusted — onlyIfTrusted will throw
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);

            await page.goto('/');
            await page.evaluate(({ account }) => {
                localStorage.setItem('authState', JSON.stringify({
                    accountName: account,
                    accountPerm: 'active',
                    endpoint: 'https://ultra.eosphere.io',
                    environment: 'Mainnet',
                    type: 'ultra',
                    isAdmin: false,
                }));
            }, { account: TEST_ACCOUNT });

            // Reload — restore fails silently
            await page.reload();
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(1000);

            // No popup — just login button
            await expect(page.locator('text=Select a Wallet Provider')).not.toBeVisible();
            await screenshot(page, '09-session-restore-failed');

            // User can still login manually
            await connectWallet(page);
            await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible();
            await screenshot(page, '10-manual-login-after-failed-restore');
        });
    });

    // ============================================================
    // 4. WALLET EVENTS
    // ============================================================
    test.describe('Wallet Events', () => {

        test('accountChanged updates displayed account and localStorage', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Verify initial state
            await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible();
            await screenshot(page, '11-events-before-account-change');

            // Update mock for new account
            await page.evaluate(({ newAccount }) => {
                (window as any).__walletConfig.accountName = newAccount;
            }, { newAccount: TEST_ACCOUNT_2 });

            // Fire accountChanged. The BG emits the denormalized shape
            // (one row per account+permission, with a singular `permission`
            // field) — see `background.ts:emitAccountChanged`. This mock
            // mirrors that contract so the toolkit handler decodes it
            // correctly via `setAvailableAccountsFromEvent`.
            await fireWalletEvent(page, 'accountChanged', {
                accounts: [{ accountName: TEST_ACCOUNT_2, permission: 'active', publicKey: TEST_PUBKEY }],
                selected: { accountName: TEST_ACCOUNT_2, permission: 'active', publicKey: TEST_PUBKEY },
            });

            // UI updates
            await expect(page.locator(`text=${TEST_ACCOUNT_2}`).first()).toBeVisible({ timeout: 5000 });
            // Old account name gone from sidebar
            const sidebar = page.locator('.sticky');
            await expect(sidebar.locator(`text=${TEST_ACCOUNT}`)).not.toBeVisible();
            await screenshot(page, '12-events-after-account-change');

            // localStorage updated
            const authState = await getAuthState(page);
            expect(authState.accountName).toBe(TEST_ACCOUNT_2);
        });

        test('accountChanged with non-active permission resolves correctly', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Update mock: new account with 'owner' permission
            await page.evaluate(({ newAccount }) => {
                (window as any).__walletConfig.accountName = newAccount;
                (window as any).__walletConfig.permission = 'owner';
            }, { newAccount: TEST_ACCOUNT_2 });

            // Singular `permission` per row matches the BG's emitAccountChanged
            // contract; the toolkit's setAvailableAccountsFromEvent + fallback
            // both read `permission` (not the legacy plural `permissions[]`).
            await fireWalletEvent(page, 'accountChanged', {
                accounts: [{ accountName: TEST_ACCOUNT_2, permission: 'owner', publicKey: TEST_PUBKEY }],
                selected: { accountName: TEST_ACCOUNT_2, permission: 'owner', publicKey: TEST_PUBKEY },
            });

            // Should show "otheraccount@owner" since permission is non-active
            await expect(page.locator(`text=${TEST_ACCOUNT_2}@owner`).first()).toBeVisible({ timeout: 5000 });
            await screenshot(page, '13-events-account-change-owner-perm');
        });

        test('disconnect event triggers logout and clears state', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Verify logged in
            await expect(page.locator('text=Logout')).toBeVisible();
            await screenshot(page, '14-events-before-disconnect');

            // Fire disconnect
            await fireWalletEvent(page, 'disconnect', {});

            // Logged out
            await expect(page.locator('text=Login to Tool Kit')).toBeVisible({ timeout: 5000 });
            await expect(page.locator('text=Logout')).not.toBeVisible();
            await screenshot(page, '15-events-after-disconnect');

            // localStorage cleared
            const authState = await getAuthState(page);
            expect(authState.accountName).toBeFalsy();
            expect(authState.type).toBeFalsy();
            expect(authState.chainId).toBeFalsy();
        });

        test('accountChanged with empty accounts does NOT trigger logout (Issue 3b regression guard)', async ({
            page,
        }) => {
            // PINS the deliberate 2026-05-07 Issue-3b fix.
            //
            // Production behavior:
            //   - When the wallet's vault is locked, the BG explicitly does
            //     NOT broadcast `accountChanged{accounts:[]}` (see web-app
            //     `background.ts emitAccountChanged` — "Issue 3: do NOT
            //     broadcast accounts:[] when the vault is locked").
            //   - Lock is communicated to dapps via the explicit `disconnect`
            //     event (covered by the test above), or via RPC failure on
            //     the next sign attempt.
            //   - An `accountChanged{accounts:[]}` event is treated as a
            //     transient signal (e.g. a misbehaving wallet, an MV3 SW
            //     mid-restore that slipped through the BG guard, or a
            //     network with zero resolved accounts). The toolkit must
            //     NOT log out on it — pre-Issue-3b that race fired once
            //     every ~10 chain switches and forced a reconnect popup.
            //
            // This test fires the empty-accounts event AND asserts the
            // toolkit stays logged in. If a future change makes empty
            // accounts trigger logout, this test fails and the regression
            // is caught at PR time, not at the user's keyboard.
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Sanity: logged in.
            await expect(page.locator('text=Logout')).toBeVisible();
            const stateBefore = await getAuthState(page);
            expect(stateBefore.accountName).toBeTruthy();
            await screenshot(page, '16a-before-empty-accountChanged');

            // Fire the transient empty-accounts event the BG would NEVER
            // emit on lock, but a buggy/older wallet might. The toolkit
            // must absorb it without logging out.
            await fireWalletEvent(page, 'accountChanged', {
                accounts: [],
                selected: null,
            });
            await page.waitForTimeout(500);

            // Still logged in. Login screen NOT visible.
            await expect(page.locator('text=Logout')).toBeVisible();
            await expect(page.locator('text=Login to Tool Kit')).not.toBeVisible();
            await screenshot(page, '16b-after-empty-accountChanged-still-logged-in');

            const stateAfter = await getAuthState(page);
            expect(stateAfter.accountName).toBe(stateBefore.accountName);
            expect(stateAfter.type).toBe(stateBefore.type);
        });

        test('networkChanged updates chainId in localStorage', async ({ page }) => {
            const UNKNOWN_CHAIN = 'abcd1234'.repeat(8);
            await page.addInitScript({ content: walletMockScript({ chainId: TESTNET_CHAIN_ID }) });
            await mockChainAPI(page, TESTNET_CHAIN_ID);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Initial chainId
            let authState = await getAuthState(page);
            expect(authState.chainId).toBe(TESTNET_CHAIN_ID);

            // Fire networkChanged to an unknown chain (won't trigger auto-switch)
            await fireWalletEvent(page, 'networkChanged', {
                chainId: UNKNOWN_CHAIN,
                name: 'CustomNet',
                nodeUrl: 'https://custom.example.com',
                accounts: [],
            });
            await page.waitForTimeout(500);

            // chainId updated
            authState = await getAuthState(page);
            expect(authState.chainId).toBe(UNKNOWN_CHAIN);
            await screenshot(page, '17-events-network-changed');
        });

        test('compound events: networkChanged then accountChanged', async ({ page }) => {
            const UNKNOWN_CHAIN = 'abcd1234'.repeat(8);
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page, TESTNET_CHAIN_ID);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);
            await screenshot(page, '18-compound-initial');

            // Network switch (unknown chain — no auto-sync, just updates chainId)
            await fireWalletEvent(page, 'networkChanged', {
                chainId: UNKNOWN_CHAIN,
                name: 'CustomNet',
                nodeUrl: 'https://custom.example.com',
                accounts: [],
            });
            await page.waitForTimeout(300);

            // Account switch
            await page.evaluate(() => {
                (window as any).__walletConfig.accountName = 'otheraccount';
            });
            await fireWalletEvent(page, 'accountChanged', {
                accounts: [{ accountName: TEST_ACCOUNT_2, permissions: [{ name: 'active', publicKeys: [TEST_PUBKEY] }] }],
                selected: { accountName: TEST_ACCOUNT_2, permissions: [{ name: 'active', publicKeys: [TEST_PUBKEY] }] },
            });

            // Both reflected
            await expect(page.locator(`text=${TEST_ACCOUNT_2}`).first()).toBeVisible({ timeout: 5000 });
            const authState = await getAuthState(page);
            expect(authState.chainId).toBe(UNKNOWN_CHAIN);
            expect(authState.accountName).toBe(TEST_ACCOUNT_2);
            await screenshot(page, '19-compound-both-changed');
        });
    });

    // ============================================================
    // 5. NETWORK MISMATCH WARNING
    // ============================================================
    test.describe('Network Mismatch Warning', () => {

        test('shows amber warning when wallet chain differs from endpoint', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript({ chainId: MAINNET_CHAIN_ID }) });
            await mockChainAPI(page, TESTNET_CHAIN_ID);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            const warning = page.locator('text=Wallet network differs from endpoint');
            await expect(warning).toBeVisible({ timeout: 5000 });
            await screenshot(page, '20-mismatch-warning-visible');

            // Verify amber styling (the element has specific tailwind classes)
            const warningEl = page.locator('[class*="bg-amber"]');
            await expect(warningEl).toBeVisible();
        });

        test('no warning when chains match', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript({ chainId: TESTNET_CHAIN_ID }) });
            await mockChainAPI(page, TESTNET_CHAIN_ID);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            await expect(page.locator('text=Wallet network differs from endpoint')).not.toBeVisible();
            await screenshot(page, '21-mismatch-no-warning');
        });

        test('wallet networkChanged to known chain auto-switches toolkit endpoint', async ({ page }) => {
            // Start with wallet on MAINNET (matching the default endpoint ultra.eosphere.io)
            await page.addInitScript({ content: walletMockScript({ chainId: MAINNET_CHAIN_ID, networkName: 'Mainnet' }) });
            // Smart get_info: return chainId based on which endpoint URL is called.
            // The toolkit auto-switches to the FIRST URL of the matched network
            // (testnet.ultra.eosrio.io as of writing); the pattern must cover
            // every testnet host in defaultNetworks or the post-switch /get_info
            // returns mainnet's chainId and the mismatch warning re-fires.
            await page.route('**/v1/chain/get_info', async (route) => {
                const url = route.request().url();
                const isTestnet =
                    url.includes('testnet.ultra') ||
                    url.includes('ultratest') ||
                    url.includes('ultra-testnet') ||
                    url.includes('api.testnet') ||
                    url.includes('test.ultra');
                const chainId = isTestnet ? TESTNET_CHAIN_ID : MAINNET_CHAIN_ID;
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                    server_version: 'mock', chain_id: chainId, head_block_num: 100000,
                    head_block_time: '2026-04-04T00:00:00.000', head_block_producer: 'ultra',
                    last_irreversible_block_num: 99999, last_irreversible_block_id: '0'.repeat(64),
                    head_block_id: '0'.repeat(63) + '1', server_version_string: 'mock-v1',
                    fork_db_head_block_num: 100000, fork_db_head_block_id: '0'.repeat(63) + '1',
                })});
            });
            await page.route('**/v1/chain/get_account', async (route) => {
                const body = JSON.parse(route.request().postData() || '{}');
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
                    account_name: body.account_name || TEST_ACCOUNT,
                    head_block_num: 100000, head_block_time: '2026-04-04T00:00:00.000',
                    privileged: false, last_code_update: '1970-01-01T00:00:00.000',
                    created: '2024-01-01T00:00:00.000', ram_quota: 100000, net_weight: 1000, cpu_weight: 1000,
                    net_limit: { used: 0, available: 100000, max: 100000 },
                    cpu_limit: { used: 0, available: 100000, max: 100000 }, ram_usage: 3000,
                    permissions: [
                        { perm_name: 'active', parent: 'owner', required_auth: { threshold: 1, keys: [{ key: TEST_PUBKEY, weight: 1 }], accounts: [], waits: [] } },
                    ],
                    total_resources: null, self_delegated_bandwidth: null, refund_request: null, voter_info: null,
                })});
            });

            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Initially wallet=mainnet, endpoint=mainnet — no warning
            await expect(page.locator('text=Wallet network differs from endpoint')).not.toBeVisible();
            await screenshot(page, '22-sync-before-switch');

            // Wallet switches to TESTNET — toolkit should auto-follow
            await page.evaluate(({ chainId }) => {
                (window as any).__walletConfig.chainId = chainId;
            }, { chainId: TESTNET_CHAIN_ID });
            await fireWalletEvent(page, 'networkChanged', {
                chainId: TESTNET_CHAIN_ID,
                name: 'Testnet',
                nodeUrl: 'https://ultra-testnet.eosphere.io',
                accounts: [{ accountName: TEST_ACCOUNT, permissions: [{ name: 'active', publicKeys: [TEST_PUBKEY] }] }],
            });

            // Wait for auto-switch (setEndpoint + re-connect)
            await page.waitForTimeout(3000);
            await screenshot(page, '23-sync-after-switch');

            // Endpoint should have changed to testnet
            const authState = await getAuthState(page);
            expect(authState.environment).toBe('Testnet');

            // No mismatch warning (both on testnet now)
            await expect(page.locator('text=Wallet network differs from endpoint')).not.toBeVisible();
        });

        test('wallet networkChanged to unknown chain shows warning', async ({ page }) => {
            const UNKNOWN_CHAIN_ID = 'deadbeef'.repeat(8); // 64 chars, not in defaultNetworks
            await page.addInitScript({ content: walletMockScript({ chainId: TESTNET_CHAIN_ID }) });
            await mockChainAPI(page, TESTNET_CHAIN_ID);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Fire networkChanged to an unknown chain
            await fireWalletEvent(page, 'networkChanged', {
                chainId: UNKNOWN_CHAIN_ID,
                name: 'CustomDevNet',
                nodeUrl: 'https://custom.node.example.com',
                accounts: [],
            });

            // Can't auto-switch — warning should appear
            await expect(page.locator('text=Wallet network differs from endpoint')).toBeVisible({ timeout: 5000 });
            await screenshot(page, '24-sync-unknown-chain-warning');
        });

        test('warning disappears after logout', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript({ chainId: MAINNET_CHAIN_ID }) });
            await mockChainAPI(page, TESTNET_CHAIN_ID);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Warning visible
            await expect(page.locator('text=Wallet network differs from endpoint')).toBeVisible({ timeout: 5000 });
            await screenshot(page, '24-mismatch-before-logout');

            // Logout
            await page.click('text=Logout');

            // Warning gone (not logged in as ultra anymore)
            await expect(page.locator('text=Wallet network differs from endpoint')).not.toBeVisible();
            await screenshot(page, '25-mismatch-after-logout');
        });
    });

    // ============================================================
    // 6. LOGOUT
    // ============================================================
    test.describe('Logout', () => {

        test('full logout clears all state', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Logged in
            await expect(page.locator('text=Logout')).toBeVisible();
            const preLogout = await getAuthState(page);
            expect(preLogout.accountName).toBe(TEST_ACCOUNT);
            expect(preLogout.chainId).toBe(TESTNET_CHAIN_ID);
            await screenshot(page, '26-logout-before');

            // Click logout
            await page.click('text=Logout');

            // Logged out
            await expect(page.locator('text=Login to Tool Kit')).toBeVisible({ timeout: 5000 });
            await expect(page.locator('text=Logout')).not.toBeVisible();
            await expect(page.locator(`text=${TEST_ACCOUNT}`)).not.toBeVisible();
            await screenshot(page, '27-logout-after');

            // All auth state cleared
            const postLogout = await getAuthState(page);
            expect(postLogout.accountName).toBeFalsy();
            expect(postLogout.type).toBeFalsy();
            expect(postLogout.accountPerm).toBeFalsy();
            expect(postLogout.isAdmin).toBe(false);
            expect(postLogout.chainId).toBeFalsy();
        });

        test('can re-login after logout', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            // Login
            await connectWallet(page);
            await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible();
            await screenshot(page, '28-relogin-first-login');

            // Logout
            await page.click('text=Logout');
            await expect(page.locator('text=Login to Tool Kit')).toBeVisible({ timeout: 5000 });
            await screenshot(page, '29-relogin-logged-out');

            // Re-login
            await connectWallet(page);
            await expect(page.locator(`text=${TEST_ACCOUNT}`).first()).toBeVisible();
            await expect(page.locator('text=Logout')).toBeVisible();
            await screenshot(page, '30-relogin-second-login');

            // State is correct
            const authState = await getAuthState(page);
            expect(authState.accountName).toBe(TEST_ACCOUNT);
            expect(authState.type).toBe('ultra');
        });
    });

    // ============================================================
    // 7. TRANSACTION SIGNING
    // ============================================================
    test.describe('Transaction Signing', () => {

        test('signTransaction mock returns correct hash and accepts structured auth', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Verify signTransaction works with structured authorization
            const result = await page.evaluate(async () => {
                const response = await (window as any).ultra.signTransaction(
                    [{
                        contract: 'eosio.token',
                        action: 'transfer',
                        data: { from: 'testaccount1', to: 'someone', quantity: '1.00000000 UOS', memo: 'test' },
                        authorization: [{ actor: 'testaccount1', permission: 'active' }],
                    }]
                );
                return {
                    status: response.status,
                    hash: response.data?.transactionHash,
                };
            });

            expect(result.status).toBe('success');
            expect(result.hash).toBe(TEST_TX_HASH);

            // Verify the call was recorded
            const signCalls = await page.evaluate(() => (window as any).__signCalls);
            expect(signCalls).toHaveLength(1);
            expect(signCalls[0].tx[0].contract).toBe('eosio.token');
            expect(signCalls[0].tx[0].action).toBe('transfer');
            expect(signCalls[0].tx[0].authorization[0].actor).toBe('testaccount1');
            expect(signCalls[0].tx[0].authorization[0].permission).toBe('active');
        });

        test('signTransaction works with legacy string authorizations', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            const result = await page.evaluate(async () => {
                const response = await (window as any).ultra.signTransaction(
                    [{
                        contract: 'eosio.token',
                        action: 'transfer',
                        data: {},
                        authorizations: ['testaccount1@active'],
                    }]
                );
                return response.status;
            });

            expect(result).toBe('success');
        });

        test('transaction modal opens with correct content and can be dismissed', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Inject actions via the emitter exposed in eventBus.ts
            await page.evaluate(({ account }) => {
                (window as any).__emitter.emit('updateAppActions', [
                    {
                        contract: 'eosio.token',
                        action: 'transfer',
                        data: { from: account, to: 'someaccount1', quantity: '1.00000000 UOS', memo: 'playwright test' },
                        authorization: [{ actor: account, permission: 'active' }],
                    },
                ]);
            }, { account: TEST_ACCOUNT });

            // Step 1: Transaction modal opens with correct title
            await expect(page.locator(`text=Transaction - @${TEST_ACCOUNT}`)).toBeVisible({ timeout: 5000 });
            await screenshot(page, '32-tx-modal-open');

            // Step 2: Action content is correct
            await expect(page.locator('text=Action Overview')).toBeVisible();
            await expect(page.locator('text=eosio.token')).toBeVisible();
            await expect(page.locator('text=transfer')).toBeVisible();

            // Step 3: Buttons present
            await expect(page.locator('button:has-text("Confirm")')).toBeVisible();
            await expect(page.locator('button:has-text("Cancel")')).toBeVisible();

            // Step 4: Expand details shows JSON with action data
            await page.click('text=Details');
            await page.waitForTimeout(300);
            // JSON should contain our action data
            const detailsText = await page.locator('.cm-content, pre, code').first().textContent();
            expect(detailsText).toContain('eosio.token');
            await screenshot(page, '33-tx-modal-details');

            // Step 5: Cancel closes the modal
            await page.click('button:has-text("Cancel")');
            await expect(page.locator(`text=Transaction - @${TEST_ACCOUNT}`)).not.toBeVisible();
            await screenshot(page, '34-tx-modal-cancelled');
        });

        test('transaction modal shows multiple actions', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');
            await connectWallet(page);

            // Inject 2 actions
            await page.evaluate(({ account }) => {
                (window as any).__emitter.emit('updateAppActions', [
                    {
                        contract: 'eosio.token',
                        action: 'transfer',
                        data: { from: account, to: 'someone', quantity: '1.00000000 UOS', memo: 'first' },
                        authorization: [{ actor: account, permission: 'active' }],
                    },
                    {
                        contract: 'eosio.token',
                        action: 'transfer',
                        data: { from: account, to: 'another', quantity: '2.00000000 UOS', memo: 'second' },
                        authorization: [{ actor: account, permission: 'active' }],
                    },
                ]);
            }, { account: TEST_ACCOUNT });

            await expect(page.locator(`text=Transaction - @${TEST_ACCOUNT}`)).toBeVisible({ timeout: 5000 });

            // Both actions shown
            const tokenLabels = page.locator('text=eosio.token');
            expect(await tokenLabels.count()).toBeGreaterThanOrEqual(2);
            await screenshot(page, '35-tx-modal-multi-action');
        });

        // NOTE: The full Confirm → sign → success flow requires real chain endpoints
        // for UltraSignerAPI.buildTransaction() validation (ABI binary encoding, block data).
        // This must be tested manually with the real wallet extension.
        // The signTransaction mock pipeline is verified in the tests above.
    });

    // ============================================================
    // 8. ANCHOR & LEDGER BUTTONS NOT BROKEN
    // ============================================================
    test.describe('Other Wallets Not Broken', () => {

        test('Anchor and Ledger buttons are present and clickable', async ({ page }) => {
            await page.addInitScript({ content: walletMockScript() });
            await mockChainAPI(page);
            await page.goto('/');
            await page.waitForLoadState('networkidle');

            await page.click('text=Login to Tool Kit');

            // Both buttons present and enabled
            const anchorBtn = page.locator('button:has-text("Anchor")');
            const ledgerBtn = page.locator('button:has-text("Ledger")');
            await expect(anchorBtn).toBeVisible();
            await expect(anchorBtn).toBeEnabled();
            await expect(ledgerBtn).toBeVisible();
            await expect(ledgerBtn).toBeEnabled();
            await screenshot(page, '31-other-wallets-available');

            // One Help button per wallet provider (Extension, Web, Anchor, Ledger).
            const helpButtons = page.locator('button:has-text("Help")');
            expect(await helpButtons.count()).toBe(4);
        });
    });
});
