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

/**
 * Subset of the Ultra extension's window-injected API that this module uses
 * directly (outside what the SDK exposes). Only the methods we actually call
 * are typed here.
 */
interface UltraExtensionWindow {
    switchNetwork(chainId: string): Promise<UltraResponse<void>>;
    addExtensionListener(eventName: string, listenerId: string): Promise<unknown> | unknown;
    removeExtensionListener(eventName: string, listenerId: string): Promise<unknown> | unknown;
}

function getUltraWindow(): UltraExtensionWindow | undefined {
    return (window as unknown as { ultra?: UltraExtensionWindow }).ultra;
}

let sdk: UltraWalletSDK | null = null;

/**
 * Check if the Ultra wallet extension is installed and injected.
 */
export function isAvailable(): boolean {
    return !!getUltraWindow();
}

/**
 * Get or create the SDK singleton.
 * Returns null if extension is not available.
 */
export function getSDK(): UltraWalletSDK | null {
    if (!isAvailable()) return null;
    if (!sdk) {
        sdk = new UltraWalletSDK({ provider: 'extension' });
    }
    return sdk;
}

/**
 * Connect to the Ultra wallet.
 * Returns the full ConnectResult with multi-account data.
 * After a successful connect, re-registers all event listeners with the extension
 * (the extension only sends events to trusted origins that have registered listeners,
 * and trust is established by connect()).
 */
export async function connect(onlyIfTrusted = false): Promise<UltraResponse<ConnectResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    const result = await wallet.connect({ onlyIfTrusted });
    if (result.status === 'success') {
        registerAllListenersWithExtension();
    }
    return result;
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
 * Request the wallet to switch to a different network.
 * Shows a confirmation popup to the user.
 * Calls window.ultra directly (the SDK class also exposes this, but we
 * standardize on the window method for parity with the listener calls below).
 */
export async function switchNetwork(chainId: string): Promise<UltraResponse<void>> {
    const ultraWindow = getUltraWindow();
    if (!ultraWindow) throw new Error('Ultra Wallet extension is not installed');
    return ultraWindow.switchNetwork(chainId);
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

// ==========================================================================
// Event listener management — workaround for two bugs in the wallet-sdk:
//
// 1. The SDK's on() just stores callbacks locally but never tells the extension
//    to send events. The extension only sends events to trusted origins that
//    registered listeners via `addExtensionListener` (content script → background).
//
// 2. The SDK's initWindowEventListener expects { type: "accountChanged", data }
//    but the extension actually sends { type: "event", payload: { event, data } }.
//
// This module bypasses the SDK's event system and implements it correctly:
// - Stores callbacks in a local registry
// - Installs a single window.postMessage listener that parses the REAL message format
// - Registers listeners with the extension via window.ultra.addExtensionListener
//   (must be done AFTER connect() succeeds — done automatically in connect())
// ==========================================================================

const localListeners = new Map<WalletEventType, Set<(data: any) => void>>();
const listenerIds = new Map<string, string>(); // eventName → listenerId
const SUPPORTED_EVENTS: WalletEventType[] = ['accountChanged', 'networkChanged', 'disconnect'];
let windowListenerInstalled = false;

function installWindowListener(): void {
    if (windowListenerInstalled || typeof window === 'undefined') return;
    window.addEventListener('message', (event: MessageEvent) => {
        if (event.source !== window) return;
        const msg = event.data;
        // Extension sends: { type: "event", from, to, payload: { event, origin, data }, id }
        if (!msg || msg.type !== 'event' || !msg.payload) return;
        const eventName = msg.payload.event as WalletEventType;
        const data = msg.payload.data;
        if (!eventName) return;
        console.log('[ultra-tool-kit] wallet event received:', eventName, data);
        const callbacks = localListeners.get(eventName);
        if (callbacks) callbacks.forEach((cb) => cb(data));
    });
    windowListenerInstalled = true;
}

/**
 * Generate a UUID for listener registration.
 * Uses crypto.randomUUID if available, falls back to a simple random ID.
 */
function generateId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Register all currently-known event types with the extension.
 * Called after connect() succeeds (the extension only accepts listener registration
 * from trusted origins, which is established via connect()).
 */
function registerAllListenersWithExtension(): void {
    if (!isAvailable()) return;
    for (const eventName of SUPPORTED_EVENTS) {
        // Only register if we have local callbacks for this event
        const callbacks = localListeners.get(eventName);
        if (!callbacks || callbacks.size === 0) continue;

        // If already registered, skip (id is cached)
        if (listenerIds.has(eventName)) continue;

        const listenerId = generateId();
        listenerIds.set(eventName, listenerId);
        try {
            const result = (window as any).ultra.addExtensionListener(eventName, listenerId);
            if (result && typeof result.catch === 'function') {
                result.catch(() => {
                    // Registration failed — drop the cached id so a retry is possible
                    listenerIds.delete(eventName);
                });
            }
        } catch {
            listenerIds.delete(eventName);
        }
    }
}

/**
 * Register a wallet event listener.
 * Events: 'accountChanged', 'networkChanged', 'disconnect'
 *
 * Note: The extension only forwards events AFTER connect() succeeds. If on() is
 * called before connect(), the callback is stored but events won't flow until
 * connect() runs and registers the listener with the extension.
 */
export function on(event: WalletEventType, callback: (data: any) => void): void {
    installWindowListener();
    const existing = localListeners.get(event) ?? new Set();
    existing.add(callback);
    localListeners.set(event, existing);

    // If we're already connected (trusted), register immediately
    if (isAvailable() && !listenerIds.has(event)) {
        registerAllListenersWithExtension();
    }
}

/**
 * Remove a wallet event listener.
 * When the last callback for an event is removed, also deregister with the extension.
 */
export function off(event: WalletEventType, callback: (data: any) => void): void {
    const existing = localListeners.get(event);
    if (existing) {
        existing.delete(callback);
        if (existing.size === 0) {
            const listenerId = listenerIds.get(event);
            if (listenerId && isAvailable()) {
                listenerIds.delete(event);
                try {
                    const result = (window as any).ultra.removeExtensionListener(event, listenerId);
                    if (result && typeof result.catch === 'function') {
                        result.catch(() => {});
                    }
                } catch {
                    // Ignore
                }
            }
        }
    }
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

/**
 * Resolve the wallet's authoritative currently-selected account.
 *
 * Lookup order:
 *  1. getSelectedAccount() — live query, most authoritative.
 *  2. ConnectResult.selectedAccount — the account authorized at connect time.
 *  3. getAvailableAuthorizations()[0] — fallback for wallets that report
 *     auths correctly but return null/empty from getSelectedAccount/getAccounts
 *     (observed in current extension when auths exist but no "active" account
 *     has been picked for this origin).
 *  4. extractAccountInfo(connectResult) — legacy blockchainid fallback.
 */
export async function resolveSelectedAccount(connectResult: ConnectResult): Promise<{
    accountName: string;
    permission: string;
}> {
    try {
        const live = await getSelectedAccount();
        if (live?.status === 'success' && live.data) {
            const activePermission = live.data.permissions.find((p) => p.name === 'active');
            return {
                accountName: live.data.accountName,
                permission: activePermission
                    ? 'active'
                    : (live.data.permissions[0]?.name ?? 'active'),
            };
        }
    } catch {
        // fall through
    }
    if (connectResult.selectedAccount) {
        return extractAccountInfo(connectResult);
    }
    try {
        const auths = await getAvailableAuthorizations();
        if (auths?.status === 'success' && Array.isArray(auths.data) && auths.data.length > 0) {
            const active = auths.data.find((a) => a.permission === 'active') ?? auths.data[0];
            return { accountName: active.accountName, permission: active.permission };
        }
    } catch {
        // fall through
    }
    return extractAccountInfo(connectResult);
}
