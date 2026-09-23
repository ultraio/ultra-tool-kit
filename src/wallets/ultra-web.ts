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
 * Opens a popup window to the hosted wallet at web-wallet.ultra.io. The Web
 * Wallet exists for Mainnet only — there is no testnet Web Wallet (the SDK
 * rejects `environment: 'testnet'` with WEB_WALLET_UNAVAILABLE, 4302), so
 * Testnet users must use the Ultra Wallet extension. The SDK's WebProvider
 * binds the environment at construction time; we keep one cached instance.
 *
 * Unlike the Extension provider:
 *   - No live events (accountChanged / networkChanged / disconnect are no-ops).
 *   - `switchNetwork` throws — the Web Wallet only exists on Mainnet.
 *   - Every transaction/sign opens a fresh popup.
 */

type WebEnvironment = 'mainnet';

export const WEB_WALLET_MAINNET_ONLY_MESSAGE =
    'Web Wallet is available on Mainnet only — use the Ultra Wallet extension on other networks.';

let sdk: UltraWalletSDK | null = null;
let currentEnv: WebEnvironment | null = null;

function toWebEnv(environment: string | undefined): WebEnvironment | null {
    return environment === 'Mainnet' ? 'mainnet' : null;
}

/**
 * Web wallet is only supported on Mainnet.
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
        throw new Error(WEB_WALLET_MAINNET_ONLY_MESSAGE);
    }
    if (!sdk || currentEnv !== env) {
        sdk = new UltraWalletSDK({ provider: 'web', environment: env });
        currentEnv = env;
    }
    return sdk;
}

/**
 * Drop the cached SDK so the next call reconstructs it.
 * Use this when the user logs out.
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
    const sdkActions: BlockchainTransaction[] = actions.map((a) => ({
        contract: a.contract,
        action: a.action,
        data: a.data,
        authorization: a.authorization ? a.authorization : [{ actor, permission }],
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

/**
 * Since wallet-sdk 0.6.1 Web Wallet failures reject with the wallet's
 * `{ status: 'error', code, message }` (e.g. popup blocked, user rejected)
 * instead of `undefined`. Surface that message, else fall back.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
    const message = (error as { message?: unknown } | null | undefined)?.message;
    return typeof message === 'string' && message ? message : fallback;
}
