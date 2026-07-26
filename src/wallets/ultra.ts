import { UltraWalletSDK } from '@ultraos/wallet-sdk';
import type {
    UltraResponse,
    ConnectResult,
    SignTransactionResult,
    AccountInfo,
    AvailableAuth,
    BlockchainTransaction,
    WalletEventType,
    ConnectAttestation,
} from '@ultraos/wallet-sdk';
import { setAttestation, useWalletAccounts } from './wallet-accounts';

/**
 * Subset of the Ultra extension's window-injected API that this module
 * touches outside of what the SDK exposes. SDK 0.3.0 manages
 * `addExtensionListener` / `removeExtensionListener` internally, so we no
 * longer need them here.
 */
interface UltraExtensionWindow {
    switchNetwork(chainId: string): Promise<UltraResponse<void>>;
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
 * Get or create the SDK singleton. Returns null if extension is not
 * available. SDK 0.3.0 manages its own heartbeat + listener recovery —
 * the previous microtask piggyback in this function is redundant and
 * removed.
 */
export function getSDK(): UltraWalletSDK | null {
    if (!isAvailable()) return null;
    if (!sdk) {
        sdk = new UltraWalletSDK({ provider: 'extension' });
        // W9: capture a reissued attestation from `accountChanged` (RFC §6.5 /
        // §11). Passive, additive listener — it does NOT touch the existing
        // account/selection handling (App.vue keeps its own accountChanged
        // listener for the accounts list). The wallet includes a fresh,
        // origin-bound `attestation` on the event payload when it reissues;
        // we overwrite the stored one so the next AI request uses it.
        sdk.on('accountChanged', (data: { attestation?: ConnectAttestation }) => {
            if (data?.attestation) setAttestation(data.attestation);
        });
    }
    return sdk;
}

/**
 * Connect to the Ultra wallet.
 *
 * SDK 0.3.0's connect() handles the post-success listenerIds.clear() +
 * re-register internally (it observed every workaround had the same
 * dance), so this wrapper is now a thin forward.
 */
export async function connect(
    onlyIfTrusted = false,
    opts: { requireAttestation?: boolean } = {}
): Promise<UltraResponse<ConnectResult>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    // W9: requireAttestation (SDK 0.5.0) asks the wallet to issue a connect-time
    // attestation. Older wallets ignore the flag; existing callers pass nothing
    // and behave exactly as before (RFC §4 — strictly additive).
    return wallet.connect({ onlyIfTrusted, requireAttestation: opts.requireAttestation });
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

    // Deep plain-clone each action: action.data may be a Vue reactive Proxy
    // (AI chat replies live in a ref), and the SDK postMessages this argument —
    // structuredClone rejects proxies ("#<Object> could not be cloned"). The
    // JSON round-trip matches getProposalTxData's existing idiom; chat/modal
    // action data is plain JSON (no BigInt/Date).
    const sdkActions: BlockchainTransaction[] = actions.map((a) => ({
        contract: a.contract,
        action: a.action,
        data: a.data === undefined ? a.data : JSON.parse(JSON.stringify(a.data)),
        authorization: a.authorization ? JSON.parse(JSON.stringify(a.authorization)) : [{ actor, permission }],
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
 */
export async function switchNetwork(chainId: string): Promise<UltraResponse<void>> {
    const wallet = getSDK();
    if (!wallet) throw new Error('Ultra Wallet extension is not installed');
    return wallet.switchNetwork(chainId);
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
 * Register a wallet event listener. Events: 'accountChanged',
 * 'networkChanged', 'disconnect'.
 *
 * `accountChanged` carries the wallet's available-accounts list. The
 * toolkit treats that list as authoritative (chain-resolved by the wallet)
 * but keeps `selected` as a local override — the developer can pick any
 * available account per-action, supporting multi-signer transactions where
 * different actions need different `actor@permission` authorities.
 * App.vue's handler must touch only the available list, never overwrite
 * `authState.accountName` from the event's `selected` field.
 *
 * SDK 0.3.0 internalizes the addExtensionListener round-trip + 2 s
 * heartbeat + uppercase 'EVENT' wire-format parsing. on() is now a thin
 * forward.
 */
export function on(event: WalletEventType, callback: (data: any) => void): void {
    const wallet = getSDK();
    if (!wallet) return;
    wallet.on(event, callback);
}

/**
 * Remove a wallet event listener.
 */
export function off(event: WalletEventType, callback: (data: any) => void): void {
    const wallet = getSDK();
    if (!wallet) return;
    wallet.off(event, callback);
}

/**
 * Release SDK resources (heartbeat timer, window message listener,
 * internal listener maps). Call from a Vue `onUnmounted` hook so the 2 s
 * timer doesn't keep ticking after the page is gone. Safe to call when
 * the SDK was never instantiated.
 */
export function dispose(): void {
    if (sdk) {
        sdk.dispose();
        sdk = null;
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
            permission: activePermission ? 'active' : result.selectedAccount.permissions[0]?.name ?? 'active',
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
 * W9: the wallet's current connect-time attestation (RFC §2.1), or undefined
 * when the wallet didn't issue one. Reads the shared wallet-accounts store —
 * consumers should prefer `useWalletAccounts().attestation` directly; this
 * getter is for non-reactive call sites.
 */
export function getAttestation(): ConnectAttestation | undefined {
    return useWalletAccounts().attestation.value;
}

function attestationExpired(att: ConnectAttestation | undefined): boolean {
    if (!att) return true;
    const skewSec = 60;
    return att.payload.exp <= Math.floor(Date.now() / 1000) + skewSec;
}

// De-dupes concurrent ensureAttestation() callers (e.g. a rapid drawer
// reopen) so the wallet is prompted for an attestation at most once at a time.
let inFlightAttestation: Promise<ConnectAttestation | undefined> | null = null;

/**
 * W9: ensure a fresh connect-time attestation is cached for the AI feature
 * (RFC §2.1 / §5.2).
 *
 * No-op when a cached attestation is still valid (not past `exp`, minus a small
 * skew). When absent OR expired, and the Ultra extension is available, calls
 * `connect({ requireAttestation: true })` — the wallet prompts once for
 * attestation consent via the existing connect dialog (no separate signature
 * popup), then issues silently on subsequent connects — and surfaces the result
 * into the shared store via `setAttestation`. Touches ONLY the attestation ref
 * (not accounts/selection, so a local multi-signer override is preserved).
 *
 * Fail-soft: any failure leaves the attestation unset so the AI request falls
 * back to the anonymous per-IP path (RFC §3 — opportunistic). Returns the cached
 * attestation if one is now present, else undefined.
 */
export async function ensureAttestation(): Promise<ConnectAttestation | undefined> {
    const { attestation } = useWalletAccounts();
    if (!attestationExpired(attestation.value)) return attestation.value;
    if (!isAvailable()) return undefined;
    if (inFlightAttestation) return inFlightAttestation;
    inFlightAttestation = (async () => {
        try {
            const res = await connect(false, { requireAttestation: true });
            if (res?.status === 'success' && res.data?.attestation) {
                setAttestation(res.data.attestation);
            }
        } catch {
            // Opportunistic — stay on the anonymous path on any failure.
        } finally {
            inFlightAttestation = null;
        }
        return attestation.value;
    })();
    return inFlightAttestation;
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
                permission: activePermission ? 'active' : live.data.permissions[0]?.name ?? 'active',
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
