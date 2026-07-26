import { ref, computed } from 'vue';
import type { ConnectResult, AccountInfo, ConnectAttestation } from '@ultraos/wallet-sdk';

export interface AuthOption {
    actor: string;
    permission: string;
    label: string;
}

const accounts = ref<AccountInfo[]>([]);
const selectedAccountName = ref<string | null>(null);

// W9: the wallet-issued connect-time attestation (RFC §2.1), surfaced for the
// AI backend's identity path (docs/00 §3.7). Undefined when the wallet doesn't
// provide one (older wallet, Anchor, Ledger). Single reactive source — ultra.ts
// feeds it; consumers read it via useWalletAccounts().
const attestation = ref<ConnectAttestation | undefined>(undefined);

/**
 * Populate from a ConnectResult. The wallet's `accounts` array is now
 * authoritative for the dapp's active chain — chain-resolved server-side
 * via `get_accounts_by_authorizers` — so the toolkit no longer needs to
 * probe individual accounts to filter out cross-chain entries. Mainnet
 * accounts will not appear in a testnet connect result, and vice versa.
 */
export function populateWalletAccountsFromConnectResult(result: ConnectResult | undefined): void {
    if (!result) return;
    // W9: surface the connect-time attestation (undefined clears it).
    attestation.value = result.attestation;
    if (Array.isArray(result.accounts) && result.accounts.length > 0) {
        accounts.value = result.accounts.map((a) => ({
            accountName: a.accountName,
            permissions: (a.permissions ?? []).map((p) => ({
                name: p.name,
                publicKeys: Array.isArray(p.publicKeys) ? [...p.publicKeys] : [],
            })),
        }));
    } else {
        accounts.value = [];
    }
    if (result.selectedAccount) {
        selectedAccountName.value = result.selectedAccount.accountName;
    } else {
        // Legacy ConnectResult shape — older wallet versions used `blockchainid`.
        const legacy = (result as ConnectResult & { blockchainid?: string }).blockchainid;
        if (legacy) selectedAccountName.value = legacy;
    }
}

export function clearWalletAccounts(): void {
    accounts.value = [];
    selectedAccountName.value = null;
    attestation.value = undefined;
}

/**
 * W9: overwrite the stored attestation when the wallet reissues one (e.g. on a
 * wallet `accountChanged` event — RFC §6.5). Pass `undefined` to clear.
 */
export function setAttestation(att: ConnectAttestation | undefined): void {
    attestation.value = att;
}

/**
 * Update the available accounts list from a wallet `accountChanged` event
 * payload. The wallet's event shape is denormalized (one row per
 * account+permission combo: `{accountName, permission, publicKey}[]`) so
 * this regroups into the `AccountInfo` shape (`{accountName, permissions:
 * [{name, publicKeys}]}`).
 *
 * Touches `accounts` only — `selectedAccountName` is the toolkit's local
 * override (multi-action authorization affordance) and is owned by the
 * caller. If the override is no longer in the new available list, it's
 * the caller's responsibility to fall back to a valid choice.
 */
export function setAvailableAccountsFromEvent(
    eventAccounts: Array<{ accountName: string; permission?: string; publicKey?: string }>
): void {
    if (!Array.isArray(eventAccounts) || eventAccounts.length === 0) {
        accounts.value = [];
        return;
    }
    const byName = new Map<string, AccountInfo>();
    for (const e of eventAccounts) {
        if (!e?.accountName) continue;
        let entry = byName.get(e.accountName);
        if (!entry) {
            entry = { accountName: e.accountName, permissions: [] };
            byName.set(e.accountName, entry);
        }
        const permName = e.permission ?? 'active';
        let perm = entry.permissions.find((p) => p.name === permName);
        if (!perm) {
            perm = { name: permName, publicKeys: [] };
            entry.permissions.push(perm);
        }
        if (e.publicKey && !perm.publicKeys.includes(e.publicKey)) {
            perm.publicKeys.push(e.publicKey);
        }
    }
    accounts.value = Array.from(byName.values());
}

const authOptions = computed<AuthOption[]>(() => {
    const out: AuthOption[] = [];
    for (const a of accounts.value) {
        for (const p of a.permissions ?? []) {
            out.push({
                actor: a.accountName,
                permission: p.name,
                label: `${a.accountName}@${p.name}`,
            });
        }
    }
    return out;
});

/**
 * Deduplicated list of (account, permission) pairs the wallet exposes for
 * the current chain. `active` permission preferred, otherwise the first
 * permission listed.
 */
const validatedAccounts = computed<Array<{ accountName: string; permission: string }>>(() => {
    const byAccount = new Map<string, { accountName: string; permission: string }>();
    const sorted = [...authOptions.value].sort((a, b) => {
        if (a.permission === 'active' && b.permission !== 'active') return -1;
        if (b.permission === 'active' && a.permission !== 'active') return 1;
        return 0;
    });
    for (const opt of sorted) {
        if (byAccount.has(opt.actor)) continue;
        byAccount.set(opt.actor, { accountName: opt.actor, permission: opt.permission });
    }
    return Array.from(byAccount.values());
});

export function useWalletAccounts() {
    return {
        accounts,
        selectedAccountName,
        authOptions,
        validatedAccounts,
        attestation,
    };
}
