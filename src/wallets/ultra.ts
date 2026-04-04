import { UltraWalletSDK } from '@ultraos/wallet-sdk';
import type {
    UltraResponse,
    ConnectResult,
    SignTransactionResult,
    BlockchainTransaction,
    SignTransactionOptions,
} from '@ultraos/wallet-sdk';

let sdk: UltraWalletSDK | null = null;

/**
 * Check if the Ultra wallet extension is installed and injected.
 */
export function isAvailable(): boolean {
    return !!(window as any).ultra;
}

/**
 * Get or create the SDK singleton.
 * Returns null if extension is not available.
 */
export function getSDK(): UltraWalletSDK | null {
    if (!isAvailable()) return null;
    if (!sdk) {
        sdk = new UltraWalletSDK();
    }
    return sdk;
}

/**
 * Connect to the Ultra wallet.
 * Returns the full ConnectResult with blockchainid and publicKey.
 */
export async function connect(onlyIfTrusted = false): Promise<UltraResponse<ConnectResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.connect({ onlyIfTrusted });
}

/**
 * Disconnect from the Ultra wallet.
 */
export async function disconnect(): Promise<void> {
    const wallet = getSDK();
    if (!wallet) return;
    await wallet.disconnect();
}

/**
 * Sign a transaction via the Ultra wallet.
 * Accepts actions in the toolkit's format (contract, action, data, authorization).
 * Converts authorization objects to "actor@permission" strings the SDK expects.
 */
export async function signTransaction(
    actions: Array<{
        contract: string;
        action: string;
        data: any;
        authorization?: Array<{ actor: string; permission: string }>;
    }>,
    actor: string,
    permission: string,
    options?: SignTransactionOptions
): Promise<UltraResponse<SignTransactionResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');

    const sdkActions: BlockchainTransaction[] = actions.map((a) => ({
        contract: a.contract,
        action: a.action,
        data: a.data,
        authorizations: a.authorization
            ? a.authorization.map((auth) => `${auth.actor}@${auth.permission}`)
            : [`${actor}@${permission}`],
    }));

    return wallet.signTransaction(sdkActions, options);
}

/**
 * Get the chain ID from the connected wallet.
 */
export async function getChainId(): Promise<UltraResponse<string>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.getChainId();
}

/**
 * Extract account name from a ConnectResult.
 * The SDK's ConnectResult provides blockchainid (account name) and publicKey.
 * Permission defaults to 'active' as the extension always signs with active.
 */
export function extractAccountInfo(result: ConnectResult): {
    accountName: string;
    permission: string;
} {
    return {
        accountName: result.blockchainid,
        permission: 'active',
    };
}
