import { UltraWalletSDK } from '@ultraos/wallet-sdk';
import type {
    UltraResponse,
    ConnectResult,
    SignTransactionResult,
    BlockchainTransaction,
} from '@ultraos/wallet-sdk';

/**
 * Ultra Web Wallet integration.
 *
 * Opens a popup window to the hosted wallet (web-wallet.ultra.io for mainnet,
 * web-wallet.staging.ultra.io for testnet). The SDK's WebProvider requires the
 * environment at construction time; each environment is a separate origin with
 * its own vault. We keep one SDK instance per env and recreate it whenever the
 * user switches between Mainnet and Testnet.
 *
 * Unlike the Extension provider:
 *   - No live events (accountChanged / networkChanged / disconnect are no-ops).
 *   - `switchNetwork` throws — reconnect on a new SDK instance instead.
 *   - Every transaction/sign opens a fresh popup.
 */

type WebEnvironment = 'mainnet' | 'testnet';

let sdk: UltraWalletSDK | null = null;
let currentEnv: WebEnvironment | null = null;

function toWebEnv(environment: string | undefined): WebEnvironment | null {
    if (environment === 'Mainnet') return 'mainnet';
    if (environment === 'Testnet') return 'testnet';
    return null;
}

/**
 * Web wallet is only supported on Mainnet and Testnet.
 */
export function isSupportedEnvironment(environment: string | undefined): boolean {
    return toWebEnv(environment) !== null;
}

/**
 * Build (or reuse) an SDK instance bound to the given environment.
 * If the env differs from the cached instance, the old one is discarded.
 */
function getSDK(environment: string | undefined): UltraWalletSDK {
    const env = toWebEnv(environment);
    if (!env) {
        throw new Error('Ultra Web Wallet only supports Mainnet and Testnet');
    }
    if (!sdk || currentEnv !== env) {
        sdk = new UltraWalletSDK({ provider: 'web', environment: env });
        currentEnv = env;
    }
    return sdk;
}

/**
 * Drop the cached SDK so the next call reconstructs it.
 * Use this when the user switches env or logs out.
 */
export function reset(): void {
    sdk = null;
    currentEnv = null;
}

export function getCurrentEnvironment(): WebEnvironment | null {
    return currentEnv;
}

export async function connect(environment: string | undefined): Promise<UltraResponse<ConnectResult>> {
    return getSDK(environment).connect();
}

export async function disconnect(): Promise<void> {
    if (!sdk) return;
    try {
        await sdk.disconnect();
    } catch {
        // The popup may already be closed — ignore.
    } finally {
        reset();
    }
}

export async function signTransaction(
    actions: Array<{
        contract: string;
        action: string;
        data: any;
        authorization?: Array<{ actor: string; permission: string }>;
    }>,
    actor: string,
    permission: string,
    environment: string | undefined
): Promise<UltraResponse<SignTransactionResult>> {
    const wallet = getSDK(environment);
    // Deep plain-clone each action: action.data may be a Vue reactive Proxy
    // (AI chat replies live in a ref), and the SDK postMessages this argument —
    // structuredClone rejects proxies ("#<Object> could not be cloned"). The
    // JSON round-trip matches getProposalTxData's existing idiom; chat/modal
    // action data is plain JSON (no BigInt/Date).
    const sdkActions: BlockchainTransaction[] = actions.map((a) => ({
        contract: a.contract,
        action: a.action,
        data: a.data === undefined ? a.data : JSON.parse(JSON.stringify(a.data)),
        authorization: a.authorization
            ? JSON.parse(JSON.stringify(a.authorization))
            : [{ actor, permission }],
    }));
    return wallet.signTransaction(sdkActions);
}

export async function getChainId(environment: string | undefined): Promise<UltraResponse<string>> {
    return getSDK(environment).getChainId();
}

export function extractAccountInfo(result: ConnectResult): {
    accountName: string;
    permission: string;
} {
    if (result.selectedAccount) {
        const activePermission = result.selectedAccount.permissions.find((p) => p.name === 'active');
        return {
            accountName: result.selectedAccount.accountName,
            permission: activePermission ? 'active' : (result.selectedAccount.permissions[0]?.name ?? 'active'),
        };
    }
    return {
        accountName: result.blockchainid,
        permission: 'active',
    };
}

export function extractChainId(result: ConnectResult): string | undefined {
    return result.network?.chainId;
}
