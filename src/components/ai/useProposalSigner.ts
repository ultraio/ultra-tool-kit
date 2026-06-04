// In-card multisig proposal signer for AI `propose` replies. Mirrors
// useActionSigner: only `ultra` / `ultra-web` sign here; anchor/ledger keep
// the <Transaction> modal. Reuses BlockchainService.getProposalTxData (the
// same standalone builder the modal uses) so the inner trx is serialized
// identically. The validate-on-chain path mirrors ultra.proposer's
// --validate-trx (eosio.msig::validatetrx — chain validates then aborts).

import { ref } from 'vue';
import type { Action, AuthState } from '../../interfaces';
import * as Ultra from '../../wallets/ultra';
import * as UltraWeb from '../../wallets/ultra-web';
import { BlockchainService } from '../../utilities/blockchain';

export type ApproverCheck = { actor: string; exists: boolean };

export function useProposalSigner() {
    const signing = ref<boolean>(false);
    const validating = ref<boolean>(false);
    const txHash = ref<string | null>(null);
    const error = ref<string | null>(null);
    const validation = ref<{ ok: boolean; message: string } | null>(null);
    const approverChecks = ref<ApproverCheck[]>([]);

    function extractError(err: any): string {
        if (err?.data?.error?.details?.length > 0) return err.data.error.details[0].message;
        return err?.message ?? 'Transaction failed';
    }

    async function buildData(
        proposer: string,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ) {
        const plainRequested = JSON.parse(JSON.stringify(requested));
        const plainActions = JSON.parse(JSON.stringify(actions));
        const proposeData = await BlockchainService.getProposalTxData(
            proposer,
            proposalName,
            plainRequested,
            plainActions,
            expiration
        );
        const validateData = {
            account: proposer,
            requested: proposeData.requested,
            trx: proposeData.trx,
        };
        return { proposeData, validateData };
    }

    async function signWallet(action: Action, state: AuthState) {
        return state.type === 'ultra'
            ? await Ultra.signTransaction([action], state.accountName, state.accountPerm ?? 'active')
            : await UltraWeb.signTransaction(
                  [action],
                  state.accountName,
                  state.accountPerm ?? 'active',
                  state.environment ?? ''
              );
    }

    async function checkApprovers(requested: Array<{ actor: string; permission: string }>): Promise<void> {
        const unique = [...new Set(requested.map((r) => r.actor).filter((a) => a.length > 0))];
        const results = await Promise.all(
            unique.map(async (actor) => ({ actor, exists: !!(await BlockchainService.getAccountData(actor)) }))
        );
        approverChecks.value = results;
    }

    function abortIsSuccess(msg: string): boolean {
        return /validated transaction and aborted it/i.test(msg);
    }

    async function validateOnChain(
        state: AuthState,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ): Promise<void> {
        if (validating.value) return;
        error.value = null;
        validation.value = null;
        if (!state.accountName) {
            error.value = 'Connect a wallet account to validate.';
            return;
        }
        if (state.type !== 'ultra' && state.type !== 'ultra-web') {
            error.value = 'This wallet type validates in the transaction modal.';
            return;
        }
        if (requested.length === 0) {
            error.value = 'Add at least one approver before validating.';
            return;
        }
        validating.value = true;
        try {
            const { validateData } = await buildData(state.accountName, proposalName, requested, actions, expiration);
            const action: Action = {
                contract: 'eosio.msig',
                action: 'validatetrx',
                data: validateData,
                authorization: [{ actor: state.accountName, permission: state.accountPerm ?? 'active' }],
            };
            // eosio.msig::validatetrx always aborts on-chain (it calls failtrx),
            // so a valid trx surfaces as the "validated transaction and aborted it"
            // abort message — never a wallet success. Both the failed-result and
            // thrown-error forms route through abortIsSuccess.
            const result = await signWallet(action, state);
            const msg = result?.status === 'success' ? '' : result?.message ?? '';
            validation.value = abortIsSuccess(msg)
                ? { ok: true, message: 'Validation passed (chain validated and aborted).' }
                : { ok: false, message: msg || 'Validation failed.' };
        } catch (err) {
            const msg = extractError(err);
            validation.value = abortIsSuccess(msg)
                ? { ok: true, message: 'Validation passed (chain validated and aborted).' }
                : { ok: false, message: msg };
        } finally {
            validating.value = false;
        }
    }

    async function sign(
        state: AuthState,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ): Promise<void> {
        if (signing.value || txHash.value) return;
        error.value = null;
        if (!state.accountName) {
            error.value = 'Connect a wallet account to sign.';
            return;
        }
        if (state.type !== 'ultra' && state.type !== 'ultra-web') {
            error.value = 'This wallet type signs in the transaction modal.';
            return;
        }
        if (!proposalName || requested.length === 0) {
            error.value = 'Enter a proposal name and at least one approver.';
            return;
        }
        signing.value = true;
        try {
            const { proposeData } = await buildData(state.accountName, proposalName, requested, actions, expiration);
            const action: Action = {
                contract: 'eosio.msig',
                action: 'proposex',
                data: proposeData,
                authorization: [{ actor: state.accountName, permission: state.accountPerm ?? 'active' }],
            };
            const result = await signWallet(action, state);
            if (!result || result.status !== 'success' || !result.data) {
                error.value = result?.message ?? 'Proposal signing failed';
                return;
            }
            txHash.value = result.data.transactionHash ?? null;
        } catch (err) {
            error.value = extractError(err);
        } finally {
            signing.value = false;
        }
    }

    return {
        signing,
        validating,
        txHash,
        error,
        validation,
        approverChecks,
        checkApprovers,
        validateOnChain,
        sign,
    };
}
