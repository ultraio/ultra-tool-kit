import { BrowserContext, Worker } from '@playwright/test';

export const PASSWORD = 'TestPass123!';
export const PRIVATE_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
export const PUBLIC_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
export const ACCOUNT = 'ti1wr2sn3wb4';
export const RECIPIENT = 'bob';
export const NODE_URL = 'https://api.mainnet.ultra.io';
export const MAINNET_CHAIN = 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097';
export const NFT_CONTRACT = 'eosio.nft.ft';
export const CONTROLLER_CONTRACT = 'ultra.cntmgr';
export const TOKEN_ID = '18446744073709551615';
export const FACTORY_ID = '18446744073709551615';
export const FAKE_TX_ID = 'deadbeefcafe1234' + '0'.repeat(48);

export interface RpcCall {
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

export interface PushRequest {
    body: Record<string, unknown>;
    headers: Record<string, string>;
}

export interface OwnerChainRpcFixture {
    calls: RpcCall[];
    pushRequests: PushRequest[];
    requiredSigningCalls: RpcCall[];
    prohibitedUrls: string[];
    unexpectedRequiredCalls: string[];
    metadataCalls: RpcCall[];
}

export interface OwnerChainRpcOptions {
    listing?: boolean;
    push?: 'success' | 'failure';
    recipient?: string;
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

/** Seed the production authenticator vault and account cache used by owner actions. */
export async function seedOwnerWalletState(sw: Worker): Promise<void> {
    await sw.evaluate(
        async ({ password, publicKey, privateKey, account, chainId }) => {
            const simpleHash = (value: string): string => {
                let hash = 5381;
                for (let index = 0; index < value.length; index++)
                    hash = ((hash << 5) + hash + value.charCodeAt(index)) & 0xffffffff;
                return Math.abs(hash).toString(16).padStart(8, '0');
            };
            const vaultFile = `${simpleHash('ultra-extension-wallet')}.json`;
            const encoder = new TextEncoder();
            const salt = crypto.getRandomValues(new Uint8Array(32));
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const iterations = 900_000;
            const baseKey = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, [
                'deriveKey',
            ]);
            const aesKey = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
                baseKey,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt']
            );
            const plaintext = JSON.stringify({
                keys: {
                    [publicKey]: { publicKey, privateKey, addedAt: Date.now(), source: 'import' },
                },
                accounts: [{ accountName: account, permission: 'active', publicKeys: [publicKey], addedVia: 'import' }],
            });
            const ciphertext = new Uint8Array(
                await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, encoder.encode(plaintext))
            );
            const toHex = (bytes: Uint8Array): string =>
                Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
            await chrome.storage.local.set({
                [vaultFile]: JSON.stringify({
                    salt: toHex(salt),
                    iv: toHex(iv),
                    ciphertext: toHex(ciphertext),
                    iterations,
                    publicKeys: [publicKey],
                }),
                ENVIRONMENT: 'mainnet',
                TRUSTED_APPS: { mainnet: [], testnet: [] },
                SELECTED_ACCOUNTS_BY_CHAIN: { [chainId]: account },
            });
            await chrome.storage.session.set({
                vault_session: password,
                account_resolution_cache: {
                    mainnet: {
                        entries: [{ account, permission: 'active', authorizing_key: publicKey }],
                        timestamp: Date.now(),
                        publicKeys: [publicKey],
                    },
                },
            });
        },
        {
            password: PASSWORD,
            publicKey: PUBLIC_KEY,
            privateKey: PRIVATE_KEY,
            account: ACCOUNT,
            chainId: MAINNET_CHAIN,
        }
    );
}

function currentFactoryRow(): Record<string, unknown> {
    return {
        id: FACTORY_ID,
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
        factory_uri: 'https://metadata.example/factory/max.json',
        factory_hash: '0'.repeat(64),
        default_token_uri: `${NODE_URL}/test-metadata/{id}.json`,
    };
}

function tokenRow(): Record<string, unknown> {
    return {
        id: TOKEN_ID,
        token_factory_id: FACTORY_ID,
        serial_number: TOKEN_ID,
        mint_date: '2026-08-09T00:00:00Z',
        uri: `${NODE_URL}/test-metadata/${TOKEN_ID}.json`,
    };
}

function wrapperAbi(): Record<string, unknown> {
    return {
        version: 'eosio::abi/1.2',
        types: [{ new_type_name: 'uint64_t_vector', type: 'uint64[]' }],
        structs: [
            {
                name: 'transfer_wrap',
                base: '',
                fields: [
                    { name: 'from', type: 'name?' },
                    { name: 'to', type: 'name?' },
                    { name: 'token_ids', type: 'uint64_t_vector?' },
                    { name: 'memo', type: 'string?' },
                ],
            },
            {
                name: 'resell_wrap',
                base: '',
                fields: [
                    { name: 'seller', type: 'name?' },
                    { name: 'token_id', type: 'uint64?' },
                    { name: 'price', type: 'asset?' },
                    { name: 'promoter_basis_point', type: 'uint16?' },
                    { name: 'memo', type: 'string?' },
                ],
            },
            {
                name: 'cancelresell_wrap',
                base: '',
                fields: [
                    { name: 'token_id', type: 'uint64?' },
                    { name: 'memo', type: 'string?' },
                ],
            },
            {
                name: 'transfer',
                base: '',
                fields: [{ name: 'transfer', type: 'transfer_wrap' }],
            },
            {
                name: 'resell',
                base: '',
                fields: [{ name: 'resell', type: 'resell_wrap' }],
            },
            {
                name: 'cancelresell',
                base: '',
                fields: [{ name: 'cancelresell', type: 'cancelresell_wrap' }],
            },
        ],
        actions: [
            { name: 'transfer', type: 'transfer', ricardian_contract: '' },
            { name: 'resell', type: 'resell', ricardian_contract: '' },
            { name: 'cancelresell', type: 'cancelresell', ricardian_contract: '' },
        ],
        tables: [],
        ricardian_clauses: [],
        error_messages: [],
        abi_extensions: [],
    };
}

function chainInfo(): Record<string, unknown> {
    return {
        server_version: '0',
        chain_id: MAINNET_CHAIN,
        head_block_num: 1,
        last_irreversible_block_num: 1,
        last_irreversible_block_id: '0'.repeat(64),
        head_block_id: '0'.repeat(64),
        // nodeos emits time_point_sec without a trailing timezone marker;
        // WharfKit rejects the otherwise ISO-equivalent `...Z` form.
        head_block_time: '2026-08-10T00:00:00.000',
        head_block_producer: 'eosio',
        virtual_block_cpu_limit: 200000,
        virtual_block_net_limit: 1048576000,
        block_cpu_limit: 200000,
        block_net_limit: 1048576,
        server_version_string: '0.0.0',
    };
}

function pushSuccessBody(): Record<string, unknown> {
    return {
        transaction_id: FAKE_TX_ID,
        processed: {
            id: FAKE_TX_ID,
            block_num: 2,
            block_time: '2026-08-10T00:00:01Z',
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
    };
}

export async function mockOwnerChainRPC(
    context: BrowserContext,
    options: OwnerChainRpcOptions = {}
): Promise<OwnerChainRpcFixture> {
    const fixture: OwnerChainRpcFixture = {
        calls: [],
        pushRequests: [],
        requiredSigningCalls: [],
        prohibitedUrls: [],
        unexpectedRequiredCalls: [],
        metadataCalls: [],
    };
    const recipient = options.recipient ?? RECIPIENT;

    context.on('request', (request) => {
        const url = request.url();
        if (
            /^https?:/i.test(url) &&
            !url.startsWith(NODE_URL) &&
            !/sentry\.io\//i.test(url) &&
            !/auth\.ultra\.io\//i.test(url)
        ) {
            fixture.prohibitedUrls.push(url);
        }
    });

    // This fallback is deliberately not allowed to satisfy any signing endpoint.
    // The exact handlers below are registered later and therefore take precedence.
    await context.route(/\/v1\/(chain|history|state)\//, async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        fixture.calls.push({
            url: request.url(),
            body: parseBody(request.postData()),
            headers: request.headers(),
        });
        if (
            pathname.endsWith('/get_info') ||
            pathname.endsWith('/get_account') ||
            pathname.endsWith('/get_accounts_by_authorizers') ||
            pathname.endsWith('/get_required_keys') ||
            pathname.endsWith('/get_abi') ||
            pathname.endsWith('/push_transaction')
        ) {
            fixture.unexpectedRequiredCalls.push(pathname);
            await route.fulfill({
                status: 599,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'unexpected required endpoint' }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ rows: [], more: false }),
        });
    });

    await context.route('**/v1/chain/get_info', async (route) => {
        const call: RpcCall = {
            url: route.request().url(),
            body: parseBody(route.request().postData()),
            headers: route.request().headers(),
        };
        fixture.calls.push(call);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(chainInfo()) });
    });

    await context.route('**/v1/chain/get_table_rows', async (route) => {
        const call: RpcCall = {
            url: route.request().url(),
            body: parseBody(route.request().postData()),
            headers: route.request().headers(),
        };
        fixture.calls.push(call);
        const { code, scope, table, lower_bound: lowerBound } = call.body;

        if (code === NFT_CONTRACT && scope === ACCOUNT && (table === 'token.a' || table === 'token.b')) {
            if (table === 'token.b' && (!lowerBound || lowerBound === TOKEN_ID)) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: [tokenRow()], more: false }),
                });
            } else {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ rows: [], more: false }),
                });
            }
            return;
        }
        if (code === NFT_CONTRACT && scope === NFT_CONTRACT && table === 'factory.b') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ rows: [currentFactoryRow()] }),
            });
            return;
        }
        if (code === NFT_CONTRACT && scope === NFT_CONTRACT && table === 'factory.a') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) });
            return;
        }
        if (code === NFT_CONTRACT && scope === NFT_CONTRACT && table === 'resale.a') {
            const rows = options.listing
                ? [{ token_id: TOKEN_ID, owner: ACCOUNT, price: '2.00000000 UOS', promoter_basis_point: '250' }]
                : [];
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows }) });
            return;
        }
        if (code === NFT_CONTRACT && scope === NFT_CONTRACT && table === 'auction.a') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) });
            return;
        }
        if (code === CONTROLLER_CONTRACT && scope === NFT_CONTRACT && table === 'disabledact') {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rows: [] }) });
            return;
        }
        if (code === NFT_CONTRACT && scope === '1' && table === 'saleshrlmcfg') {
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
        if (code === NFT_CONTRACT && scope === NFT_CONTRACT && table === 'migration') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ rows: [{ active_nft_version: '1', table_migration_stats: '0' }] }),
            });
            return;
        }
        if (code === 'eosio' && scope === 'eosio' && table === 'rammarket') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ rows: [{ core_reserve: '0.00000000 UOS' }] }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ rows: [], more: false }),
        });
    });

    await context.route('**/test-metadata/*.json', async (route) => {
        const request = route.request();
        const call: RpcCall = { url: request.url(), body: {}, headers: request.headers() };
        fixture.metadataCalls.push(call);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ name: `Fixture UNIQ #${TOKEN_ID}` }),
        });
    });

    await context.route('**/v1/chain/get_account', async (route) => {
        const call: RpcCall = {
            url: route.request().url(),
            body: parseBody(route.request().postData()),
            headers: route.request().headers(),
        };
        fixture.requiredSigningCalls.push(call);
        if (call.body.account_name !== recipient) {
            fixture.unexpectedRequiredCalls.push('get_account:unexpected-body');
            await route.fulfill({
                status: 400,
                contentType: 'application/json',
                body: JSON.stringify({ error: 'unexpected recipient' }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ account_name: recipient }),
        });
    });

    await context.route('**/v1/chain/get_accounts_by_authorizers', async (route) => {
        const call: RpcCall = {
            url: route.request().url(),
            body: parseBody(route.request().postData()),
            headers: route.request().headers(),
        };
        fixture.requiredSigningCalls.push(call);
        const keys = call.body.keys;
        if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string'))
            fixture.unexpectedRequiredCalls.push('get_accounts_by_authorizers:unexpected-body');
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                accounts: [{ account_name: ACCOUNT, permission_name: 'active', authorizing_key: PUBLIC_KEY }],
            }),
        });
    });

    await context.route('**/v1/chain/get_required_keys', async (route) => {
        const call: RpcCall = {
            url: route.request().url(),
            body: parseBody(route.request().postData()),
            headers: route.request().headers(),
        };
        fixture.requiredSigningCalls.push(call);
        if (!Array.isArray(call.body.available_keys) || !call.body.transaction)
            fixture.unexpectedRequiredCalls.push('get_required_keys:unexpected-body');
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ required_keys: [PUBLIC_KEY] }),
        });
    });

    await context.route('**/v1/chain/get_abi', async (route) => {
        const call: RpcCall = {
            url: route.request().url(),
            body: parseBody(route.request().postData()),
            headers: route.request().headers(),
        };
        fixture.requiredSigningCalls.push(call);
        if (call.body.account_name !== NFT_CONTRACT) fixture.unexpectedRequiredCalls.push('get_abi:unexpected-account');
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ account_name: NFT_CONTRACT, abi: wrapperAbi() }),
        });
    });

    await context.route('**/v1/chain/push_transaction', async (route) => {
        const call: PushRequest = { body: parseBody(route.request().postData()), headers: route.request().headers() };
        fixture.pushRequests.push(call);
        const signatures = call.body.signatures;
        const packed = call.body.packed_trx;
        if (
            !Array.isArray(signatures) ||
            signatures.length === 0 ||
            typeof packed !== 'string' ||
            packed.length === 0
        ) {
            fixture.unexpectedRequiredCalls.push('push_transaction:missing-envelope');
        }
        if (options.push === 'failure') {
            await route.fulfill({
                status: 500,
                contentType: 'application/json',
                body: JSON.stringify({
                    code: 3050003,
                    error: {
                        code: 3050003,
                        name: 'eosio_assert_message_exception',
                        what: 'UNIQ action rejected',
                        details: [],
                    },
                }),
            });
            return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pushSuccessBody()) });
    });

    return fixture;
}

export function assertNoAuthOrProhibitedTraffic(fixture: OwnerChainRpcFixture): void {
    const allCalls = [
        ...fixture.calls,
        ...fixture.requiredSigningCalls,
        ...fixture.metadataCalls,
        ...fixture.pushRequests,
    ];
    if (fixture.prohibitedUrls.length)
        throw new Error(`prohibited external URLs observed: ${fixture.prohibitedUrls.join(', ')}`);
    if (allCalls.some((call) => call.headers.authorization))
        throw new Error('authorization header observed on a credentialless test request');
    if (fixture.unexpectedRequiredCalls.length)
        throw new Error(`required endpoint contract violation: ${fixture.unexpectedRequiredCalls.join(', ')}`);
}
