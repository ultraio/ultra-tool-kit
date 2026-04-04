import { UltraWalletSDK } from '@ultraos/wallet-sdk';
import type {
    UltraResponse,
    ConnectResult,
    SignTransactionResult,
    AccountInfo,
    AvailableAuth,
    BlockchainTransaction,
    WalletEventType,
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
 * Returns the full ConnectResult with multi-account data.
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
 * Passes structured authorizations to the SDK.
 */
export async function signTransaction(
    actions: Array<{
        contract: string;
        action: string;
        data: any;
        authorization?: Array<{ actor: string; permission: string }>;
    }>,
    actor: string,
    permission: string
): Promise<UltraResponse<SignTransactionResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');

    const sdkActions: BlockchainTransaction[] = actions.map((a) => ({
        contract: a.contract,
        action: a.action,
        data: a.data,
        authorization: a.authorization ? a.authorization : [{ actor, permission }],
    }));

    return wallet.signTransaction(sdkActions);
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
 * Get all accounts the wallet controls on the current network.
 */
export async function getAccounts(): Promise<UltraResponse<AccountInfo[]>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.getAccounts();
}

/**
 * Get the currently selected account.
 */
export async function getSelectedAccount(): Promise<UltraResponse<AccountInfo>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.getSelectedAccount();
}

/**
 * Get all authorizations the wallet can sign for.
 */
export async function getAvailableAuthorizations(): Promise<UltraResponse<AvailableAuth[]>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.getAvailableAuthorizations();
}

/**
 * Register a wallet event listener.
 * Events: 'accountChanged', 'networkChanged', 'disconnect'
 */
export function on(event: WalletEventType, callback: (data: any) => void): void {
    const wallet = getSDK();
    if (!wallet) return;
    wallet.on(event, callback);
}

/**
 * Extract account name and permission from a ConnectResult.
 * Falls back to legacy fields for old wallet versions.
 */
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
    // Legacy fallback
    return {
        accountName: result.blockchainid,
        permission: 'active',
    };
}

/**
 * Extract chain ID from ConnectResult.
 * Returns undefined if not available (old wallet version).
 */
export function extractChainId(result: ConnectResult): string | undefined {
    return result.network?.chainId;
}
