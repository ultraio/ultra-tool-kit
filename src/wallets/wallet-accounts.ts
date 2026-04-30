import { ref, computed } from 'vue';
import type { ConnectResult, AccountInfo } from '@ultraos/wallet-sdk';
import { fetchWithTimeout } from '../utilities/networks';

export interface AuthOption {
    actor: string;
    permission: string;
    label: string;
}

const accounts = ref<AccountInfo[]>([]);
const selectedAccountName = ref<string | null>(null);
const validAccountNames = ref<Set<string>>(new Set());
let lastValidatedEndpoint: string | null = null;

export function populateWalletAccountsFromConnectResult(result: ConnectResult | undefined): void {
    if (!result) return;
    if (Array.isArray(result.accounts) && result.accounts.length > 0) {
        accounts.value = result.accounts.map((a) => ({
            accountName: a.accountName,
            permissions: (a.permissions ?? []).map((p) => ({
                name: p.name,
                publicKeys: Array.isArray(p.publicKeys) ? [...p.publicKeys] : [],
            })),
        }));
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
    validAccountNames.value = new Set();
    lastValidatedEndpoint = null;
}

/**
 * Verify which of the wallet's accounts actually exist on the given endpoint.
 *
 * The wallet returns every account the user has across all networks (e.g. a
 * testnet-only account shows up alongside mainnet ones). We hit
 * /v1/chain/get_account on the active endpoint to drop accounts that don't
 * exist on the current network. Cached per-endpoint so repeated calls don't
 * re-query.
 */
export async function validateAccountsAgainstEndpoint(endpoint: string): Promise<void> {
    if (!endpoint) return;
    if (accounts.value.length === 0) {
        validAccountNames.value = new Set();
        lastValidatedEndpoint = endpoint;
        return;
    }
    if (lastValidatedEndpoint === endpoint && validAccountNames.value.size > 0) return;

    const names = Array.from(new Set(accounts.value.map((a) => a.accountName)));
    const valid = new Set<string>();
    await Promise.all(
        names.map(async (name) => {
            try {
                const res = await fetchWithTimeout(`${endpoint}/v1/chain/get_account`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_name: name }),
                });
                if (res?.ok) valid.add(name);
            } catch {
                // Treat fetch errors as "unknown" — leave out of the valid set
            }
        })
    );
    validAccountNames.value = valid;
    lastValidatedEndpoint = endpoint;
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
 * Deduplicated list of accounts the wallet exposes that also exist on the
 * current endpoint. Each entry has the account name and a "best" permission
 * (active when available, otherwise the first permission listed).
 *
 * Falls back to the unfiltered list while validation is pending so we don't
 * show an empty dropdown immediately after login.
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
    let entries = Array.from(byAccount.values());
    if (validAccountNames.value.size > 0) {
        entries = entries.filter((e) => validAccountNames.value.has(e.accountName));
    }
    return entries;
});

export function useWalletAccounts() {
    return {
        accounts,
        selectedAccountName,
        authOptions,
        validAccountNames,
        validatedAccounts,
    };
}
