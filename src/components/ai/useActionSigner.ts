// Direct chat-sign for AI `act` replies. Lets the AI ProposalCard sign a
// backend-validated action list straight through the Ultra wallet — no
// Transaction modal. The result-mapping mirrors Transaction.vue's confirm()
// EXACTLY (decision 10: we CALL the wallet wrappers, never modify them). Only
// `ultra` and `ultra-web` are handled here; anchor/ledger keep the modal flow.

import { ref } from 'vue';
import type { Action, AuthState } from '../../interfaces';
import * as Ultra from '../../wallets/ultra';
import * as UltraWeb from '../../wallets/ultra-web';

export function useActionSigner() {
    const signing = ref<boolean>(false);
    const txHash = ref<string | null>(null);
    const error = ref<string | null>(null);

    // Mirrors confirm()'s catch-block error extraction.
    function extractError(err: any): string {
        if (err?.data?.error?.details?.length > 0) return err.data.error.details[0].message;
        return err?.message ?? 'Transaction signing failed';
    }

    async function sign(actions: Action[], state: AuthState): Promise<void> {
        if (signing.value || txHash.value) return; // re-entry / already submitted
        error.value = null;

        if (!state.accountName) {
            error.value = 'Connect a wallet account to sign.';
            return;
        }
        if (state.type !== 'ultra' && state.type !== 'ultra-web') {
            error.value = 'This wallet type signs in the transaction modal.';
            return;
        }

        signing.value = true;
        try {
            const result =
                state.type === 'ultra'
                    ? await Ultra.signTransaction(actions, state.accountName, state.accountPerm ?? 'active')
                    : await UltraWeb.signTransaction(
                          actions,
                          state.accountName,
                          state.accountPerm ?? 'active',
                          state.environment ?? ''
                      );

            if (!result || result.status !== 'success' || !result.data) {
                error.value = result?.message ?? 'Transaction signing failed';
                return;
            }
            txHash.value = result.data.transactionHash ?? null;
        } catch (err) {
            error.value = extractError(err);
        } finally {
            signing.value = false;
        }
    }

    return { signing, txHash, error, sign };
}
