/**
 * Audit verification: C-N7
 *
 * Claim under verification (original P2): A dapp controls `message.id`
 * (the messageId stored against a request). `RequestService.storeRequest`
 * upserts by `messageId`, and the wallet popup's `requests$` subscription
 * re-emits when REQUESTS storage changes. Therefore — the claim goes — a
 * dapp can issue a second `signTransaction` with the same messageId while
 * the popup is rendered, swap the stored payload, and the wallet signs the
 * swapped (malicious) payload.
 *
 * Counter-claim (Info demotion proposed):
 *   `wallet-transaction.service.ts:49-78` builds `transaction$` from a
 *   one-shot `fetchTransaction(externalId)` RPC, then `shareReplay(1)`s the
 *   resolved value. `signTransaction()` does `withLatestFrom(this.options$)`
 *   + `take(1)` on the cached observable. The route params don't change
 *   on a same-messageId overwrite, so `transactionExternalId$` never
 *   re-emits, the upstream `fetchTransaction` never re-runs, and the cached
 *   benign snapshot is the value that reaches `walletService.signTransaction`.
 *
 * What this test does:
 *   1. Seed an unlocked vault + trust the test dapp origin.
 *   2. Pre-register a `page.route` for `/v1/chain/push_transaction` that
 *      captures the *packed* transaction blob — that's the on-the-wire
 *      payload that was actually signed.
 *   3. Open the dapp tab; bypass `window.ultra` (which auto-generates a
 *      fresh uuidv4 per request) and instead `window.postMessage` two
 *      handcrafted `Message`s into the content script with the SAME id —
 *      first carrying a BENIGN transfer (memo="BENIGN"), then a MALICIOUS
 *      transfer (memo="MALICIOUS") sent before the user clicks Confirm.
 *   4. Wait for the wallet UI to land on the sign-transaction route. The
 *      popup loads the BENIGN payload via `fetchTransaction` and caches
 *      it via `shareReplay(1)`.
 *   5. Dispatch the malicious overwrite.
 *   6. Click Confirm in the wallet.
 *   7. Inspect the captured `push_transaction` body. Decode the packed
 *      `data` field of each action and check whether the on-wire memo is
 *      BENIGN (counter-claim correct — keep Info) or MALICIOUS (P2).
 *
 * Run from /home/adam/ultra.repos/ultra-tool-kit (Playwright lives there):
 *   npx playwright test /tmp/audit-verify-c-n7.mjs --headed --timeout=180000
 *
 * Pre-req: extension built at
 *   /home/adam/ultra.repos/web-app/dist/browser-extension-wallet
 */

import { test, expect, chromium } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EXTENSION_PATH = '/home/adam/ultra.repos/web-app/dist/browser-extension-wallet';

const PASSWORD = 'TestPass123!';
const PRIV_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const PUB_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

const ACCOUNT_1 = 'tnetacct.test';
const ACCOUNT_2 = '1aa2aa3aa4bl';

const TESTNET_CHAIN = '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9';
const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';

const FAKE_TX_ID = 'deadbeefcafe1234' + '0'.repeat(48);

const DAPP_PORT = 17893;
const DAPP_ORIGIN = `http://localhost:${DAPP_PORT}`;

// The fixed messageId we use for BOTH signTransaction calls. The first call
// stores the benign payload; the second overwrites it under the same key.
const FIXED_MESSAGE_ID = 'c-n7-fixed-message-id-0000-0000-000000000000';

async function getServiceWorker(context, timeoutMs = 10_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const workers = context.serviceWorkers();
        if (workers.length > 0) return workers[0];
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Extension service worker did not start within ' + timeoutMs + 'ms');
}

async function seedExtensionState(sw, cfg) {
    await sw.evaluate(async (cfg) => {
        const simpleHash = (s) => {
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
            accounts: [
                {
                    accountName: cfg.account,
                    permission: 'active',
                    publicKeys: [cfg.pubKey],
                    addedVia: 'import',
                },
            ],
        };
        const ciphertext = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(JSON.stringify(vaultPlaintext))),
        );
        const toHex = (b) =>
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
        const trustedApps = {};
        for (const env of ['testnet', 'mainnet']) trustedApps[env] = [...cfg.origins];
        await chrome.storage.local.set({
            [VAULT_FILE]: JSON.stringify(encryptedVault),
            ENVIRONMENT: cfg.env,
            TRUSTED_APPS: trustedApps,
            SELECTED_ACCOUNTS_BY_CHAIN: {},
        });
        const now = Date.now();
        const cacheEntries = [{ account: cfg.account, permission: 'active', authorizing_key: cfg.pubKey }];
        await chrome.storage.session.set({
            vault_session: cfg.password,
            account_resolution_cache: {
                testnet: { entries: cacheEntries, timestamp: now, publicKeys: [cfg.pubKey] },
                mainnet: { entries: cacheEntries, timestamp: now, publicKeys: [cfg.pubKey] },
            },
        });
    }, cfg);
}

async function mockChainRPC(context, opts) {
    const isTestnetHost = (url) => /testnet|test\./.test(new URL(url).host);
    await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
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
        const accounts = [];
        for (const [pk, ap] of Object.entries(opts.publicKeysToAccounts)) {
            accounts.push({ account_name: ap.account, permission_name: ap.permission, authorizing_key: pk });
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accounts }) });
    });
    await context.route('**/v1/chain/get_required_keys', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ required_keys: Object.keys(opts.publicKeysToAccounts) }),
        });
    });
    await context.route('**/v1/chain/get_abi', async (route) => {
        const body = (() => {
            try { return route.request().postDataJSON() ?? {}; } catch { return {}; }
        })();
        const accountName = body?.account_name || '';
        const abi =
            accountName === 'eosio.token'
                ? {
                      version: 'eosio::abi/1.2',
                      types: [],
                      structs: [
                          {
                              name: 'transfer',
                              base: '',
                              fields: [
                                  { name: 'from', type: 'name' },
                                  { name: 'to', type: 'name' },
                                  { name: 'quantity', type: 'asset' },
                                  { name: 'memo', type: 'string' },
                              ],
                          },
                      ],
                      actions: [{ name: 'transfer', type: 'transfer', ricardian_contract: '' }],
                      tables: [],
                      ricardian_clauses: [],
                      error_messages: [],
                      abi_extensions: [],
                  }
                : {
                      version: 'eosio::abi/1.2',
                      types: [],
                      structs: [],
                      actions: [],
                      tables: [],
                      ricardian_clauses: [],
                      error_messages: [],
                      abi_extensions: [],
                  };
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ account_name: accountName, abi }),
        });
    });
}

/**
 * Decode the packed `data` hex blob of an eosio.token::transfer action.
 * Format: name (8 bytes LE encoded) | name (8 bytes) | asset (16 bytes) |
 *         memo length (varint) | memo (utf8 bytes).
 *
 * We only need the memo here — that's our signal for benign vs malicious.
 * Everything before the memo is fixed-size: 8+8+16 = 32 bytes = 64 hex.
 */
function extractMemoFromPackedTransferData(hex) {
    if (!hex || hex.length < 64) return null;
    // After 64 hex chars (32 bytes of from+to+quantity), next byte(s) are
    // the memo length varint. Standard ASCII memos < 128 fit in one byte.
    let cursor = 64;
    let memoLen = parseInt(hex.slice(cursor, cursor + 2), 16);
    cursor += 2;
    // Handle 1-byte varint only — sufficient for short test memos.
    if (memoLen >= 0x80) {
        // multi-byte varint not handled for this test
        return null;
    }
    const memoHex = hex.slice(cursor, cursor + memoLen * 2);
    const bytes = [];
    for (let i = 0; i < memoHex.length; i += 2) bytes.push(parseInt(memoHex.slice(i, i + 2), 16));
    return new TextDecoder().decode(new Uint8Array(bytes));
}

import http from 'node:http';
import zlib from 'node:zlib';

/**
 * Decompress a zlib-compressed packed_trx hex string to a raw hex string.
 * `compression: 1` in push_transaction = zlib (deflate). Returns the hex
 * of the inflated bytes so we can grep for memo signatures.
 */
function inflatePackedTrx(hex, compression) {
    if (compression !== 1) return hex;
    const buf = Buffer.from(hex, 'hex');
    try {
        const out = zlib.inflateSync(buf);
        return out.toString('hex');
    } catch (e) {
        return hex;
    }
}
function startDappServer() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html><body><h1>dapp</h1></body></html>`);
    });
    return new Promise((resolve) => server.listen(DAPP_PORT, '127.0.0.1', () => resolve(server)));
}

test.describe.configure({ timeout: 180_000 });

test.describe('Audit C-N7: storage-swap before Approve', () => {
    test.beforeAll(() => {
        if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
            throw new Error(`Extension not built at ${EXTENSION_PATH}`);
        }
    });

    test('benign then malicious overwrite — what gets signed?', async () => {
        const dappServer = await startDappServer();
        const userDataDir = fs.mkdtempSync(path.join('/tmp', 'pw-audit-c-n7-'));
        const context = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            args: [
                `--disable-extensions-except=${EXTENSION_PATH}`,
                `--load-extension=${EXTENSION_PATH}`,
                '--no-first-run',
                '--no-default-browser-check',
            ],
        });

        await mockChainRPC(context, {
            publicKeysToAccounts: { [PUB_KEY]: { account: ACCOUNT_1, permission: 'active' } },
        });

        // Capture the push_transaction body so we can inspect what was signed.
        // Registered AFTER mockChainRPC so it takes precedence (Playwright's
        // route chain runs latest-registered-first when fulfill() is used).
        let capturedPushBody = null;
        await context.route('**/v1/chain/push_transaction', async (route) => {
            try {
                capturedPushBody = route.request().postDataJSON();
            } catch (e) {
                capturedPushBody = { raw: route.request().postData() };
            }
            console.log('[test] >>>>> push_transaction intercepted, body keys=', Object.keys(capturedPushBody || {}));
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    transaction_id: FAKE_TX_ID,
                    processed: {
                        id: FAKE_TX_ID,
                        block_num: 2,
                        block_time: '2026-04-04T00:00:01.000',
                        producer_block_id: null,
                        receipt: { status: 'executed', cpu_usage_us: 0, net_usage_words: 0 },
                        elapsed: 0,
                        net_usage: 0,
                        scheduled: false,
                        action_traces: [],
                        account_ram_delta: null,
                        except: null,
                        error_code: null,
                    },
                }),
            });
        });

        try {
            const sw = await getServiceWorker(context);
            const extId = await sw.evaluate(() => chrome.runtime.id);
            sw.on('console', (m) => console.log(`[sw ${m.type()}]`, m.text()));

            await seedExtensionState(sw, {
                password: PASSWORD,
                pubKey: PUB_KEY,
                privKey: PRIV_KEY,
                account: ACCOUNT_1,
                env: 'testnet',
                origins: [DAPP_ORIGIN],
            });

            // Open dapp page first (content + inject scripts auto-loaded per manifest)
            const dapp = await context.newPage();
            dapp.on('console', (m) => console.log(`[dapp ${m.type()}]`, m.text()));
            await dapp.goto(DAPP_ORIGIN);
            await dapp.waitForLoadState('domcontentloaded');
            await dapp.waitForFunction(() => typeof window.ultra === 'object', { timeout: 15_000 });

            // Open wallet UI as a tab so popup goes inline
            const wallet = await context.newPage();
            wallet.on('console', (m) => console.log(`[wallet ${m.type()}]`, m.text()));
            await wallet.goto(`chrome-extension://${extId}/index.html#/home`);
            await wallet.waitForLoadState('load');

            // STEP 1: dispatch the BENIGN signTransaction via a hand-crafted
            // Message with our FIXED_MESSAGE_ID. We post directly into the
            // content script's listener (bypassing `window.ultra` proxy which
            // would generate a fresh uuidv4).
            //
            // The content script forwards verbatim to BG, BG's
            // signTransactionHandler stores the request keyed by message.id.
            const benignDispatch = await dapp.evaluate(
                async ({ id, account1, account2 }) => {
                    // Build a message envelope that mirrors what ClientMessenger
                    // would emit. Resolution is keyed by id, so we ALSO have to
                    // register a custom listener that completes when the BG
                    // posts a RESPONSE back with the same id.
                    const w = window;
                    w.__benignResult = null;
                    w.__benignDone = new Promise((resolve) => {
                        const handler = (event) => {
                            if (event.source !== window || event.origin !== window.origin) return;
                            const m = event.data;
                            if (!m || m.id !== id || m.type !== 'RESPONSE') return;
                            window.removeEventListener('message', handler);
                            w.__benignResult = m.payload;
                            resolve(m.payload);
                        };
                        window.addEventListener('message', handler);
                    });
                    const benignMessage = {
                        type: 'REQUEST',
                        from: 'EXTERNAL_PAGE',
                        to: 'CONTENT_SCRIPT',
                        id,
                        payload: {
                            action: 'signTransaction',
                            data: [
                                [
                                    {
                                        contract: 'eosio.token',
                                        action: 'transfer',
                                        data: {
                                            from: account1,
                                            to: account2,
                                            quantity: '1.0000 UOS',
                                            memo: 'BENIGN',
                                        },
                                        authorizations: [`${account1}@active`],
                                    },
                                ],
                            ],
                        },
                    };
                    window.postMessage(benignMessage, location.origin);
                    return { dispatched: true };
                },
                { id: FIXED_MESSAGE_ID, account1: ACCOUNT_1, account2: ACCOUNT_2 },
            );
            console.log('[test] benign dispatched', benignDispatch);

            // STEP 2: wait for wallet to land on sign-transaction route. This
            // proves the BG stored the benign payload and the popup loaded it
            // (loadTransaction subscribed, fetchTransaction emitted, shareReplay
            // cached the benign snapshot).
            let landed = false;
            const benignLandStart = Date.now();
            while (Date.now() - benignLandStart < 30_000) {
                const hash = await wallet.evaluate(() => window.location.hash);
                if (hash.includes('/sign-transaction/')) {
                    landed = true;
                    break;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            expect(landed, 'wallet must navigate to sign-transaction route with benign payload').toBe(true);

            // Give the UI another beat to render the body and bind the
            // shareReplay subscription. (template uses async pipe on
            // transaction$ — first emission caches.)
            await new Promise((r) => setTimeout(r, 1500));

            // Read the popup-visible memo to confirm the benign payload is
            // what the user would see. The default-transaction-view (or
            // token-transfer-confirm depending on registry) renders the
            // body; we just check the DOM for the BENIGN memo string.
            const popupBodyText = await wallet.evaluate(() => document.body.innerText);
            console.log('[test] popup body (first 400 chars):', popupBodyText.slice(0, 400));

            // STEP 3: now overwrite with MALICIOUS using the same messageId.
            await dapp.evaluate(
                async ({ id, account1, account2 }) => {
                    const maliciousMessage = {
                        type: 'REQUEST',
                        from: 'EXTERNAL_PAGE',
                        to: 'CONTENT_SCRIPT',
                        id,
                        payload: {
                            action: 'signTransaction',
                            data: [
                                [
                                    {
                                        contract: 'eosio.token',
                                        action: 'transfer',
                                        data: {
                                            from: account1,
                                            to: account2,
                                            quantity: '9999.0000 UOS',
                                            memo: 'MALICIOUS',
                                        },
                                        authorizations: [`${account1}@active`],
                                    },
                                ],
                            ],
                        },
                    };
                    window.postMessage(maliciousMessage, location.origin);
                },
                { id: FIXED_MESSAGE_ID, account1: ACCOUNT_1, account2: ACCOUNT_2 },
            );
            console.log('[test] malicious dispatched (overwrite)');

            // Wait for the storage write to settle.
            await new Promise((r) => setTimeout(r, 1500));

            // Read REQUESTS to confirm the on-disk payload is now malicious.
            const storedRequest = await sw.evaluate(async () => {
                const r = await chrome.storage.local.get('REQUESTS');
                return r.REQUESTS;
            });
            console.log('[test] REQUESTS after overwrite:', JSON.stringify(storedRequest, null, 2));

            // STEP 4: click Confirm in the wallet. The popup should sign the
            // CACHED snapshot (benign), not re-read storage.
            const confirmBtn = wallet.locator('button:has-text("Confirm"), button:has-text("Sign")').first();
            await confirmBtn.click({ timeout: 10_000 });

            // Wait until push_transaction body has been captured.
            const pushStart = Date.now();
            while (capturedPushBody === null && Date.now() - pushStart < 20_000) {
                await new Promise((r) => setTimeout(r, 200));
            }
            console.log('[test] capturedPushBody:', JSON.stringify(capturedPushBody, null, 2));

            // STEP 5: Inspect the signed transaction. The packed transaction
            // is in `capturedPushBody.transaction.packed_trx` (Wharfkit shape)
            // OR `capturedPushBody.packed_trx` depending on the version.
            let packed =
                capturedPushBody?.transaction?.packed_trx ||
                capturedPushBody?.packed_trx ||
                capturedPushBody?.transaction?.packed_transaction ||
                null;
            const compression =
                capturedPushBody?.compression ?? capturedPushBody?.transaction?.compression ?? 0;
            console.log('[test] packed_trx (raw):', packed, 'compression:', compression);
            if (packed && compression === 1) {
                packed = inflatePackedTrx(packed, compression);
                console.log('[test] packed_trx (inflated):', packed);
            }

            // The packed trx is a serialized transaction. The first part
            // contains tx header bytes (expiration, ref_block_num, ref_block_prefix,
            // max_net_usage_words, max_cpu_usage_ms, delay_sec, ctx_free_actions,
            // then actions array). Parsing a full transaction is non-trivial,
            // so we instead look for the *signature* of the memo string in the
            // packed hex: 'BENIGN' hex = '42454e49474e', 'MALICIOUS' hex =
            // '4d414c4943494f5553'.
            const benignHex = '42454e49474e';
            const maliciousHex = Buffer.from('MALICIOUS', 'utf8').toString('hex');
            const containsBenign = packed && packed.includes(benignHex);
            const containsMalicious = packed && packed.includes(maliciousHex);
            console.log(
                `[test] packed contains BENIGN hex (${benignHex})? ${containsBenign}; contains MALICIOUS hex (${maliciousHex})? ${containsMalicious}`,
            );

            // ── VERDICT ──
            // If the popup signed the cached benign snapshot, packed_trx
            // contains 'BENIGN' bytes. If the swap succeeded, packed_trx
            // contains 'MALICIOUS' bytes.
            if (containsBenign && !containsMalicious) {
                console.log('[test] VERDICT: popup signed BENIGN (cached snapshot). Counter-claim is CORRECT.');
            } else if (containsMalicious) {
                console.log('[test] VERDICT: popup signed MALICIOUS. Finding goes BACK TO P2.');
            } else {
                console.log('[test] VERDICT: ambiguous — could not locate either memo in packed_trx.');
            }

            expect(containsBenign, 'signed packed_trx must contain BENIGN memo bytes').toBe(true);
            expect(containsMalicious, 'signed packed_trx must NOT contain MALICIOUS memo bytes').toBe(false);
        } finally {
            try { dappServer.close(); } catch {}
            await context.close();
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    });
});
