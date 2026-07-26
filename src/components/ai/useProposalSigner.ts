// In-card multisig proposal signer for AI `propose` replies. Mirrors
// useActionSigner: only `ultra` / `ultra-web` sign here; anchor/ledger keep
// the <Transaction> modal. Reuses BlockchainService.getProposalTxData (the
// same standalone builder the modal uses) so the inner trx is serialized
// identically. Validation is CLIENT-SIDE: a successful getProposalTxData build
// (ABIs resolve, data encodes) proves the proposal is well-formed. (An earlier
// on-chain eosio.msig::validatetrx dry-run was removed — it abused the signing
// wallet, which broadcasts and re-prompts on validatetrx's intentional on-chain
// abort, hanging the UI.)

import { ref } from 'vue';
import type { Action, AuthState } from '../../interfaces';
import * as Ultra from '../../wallets/ultra';
import * as UltraWeb from '../../wallets/ultra-web';
import { BlockchainService } from '../../utilities/blockchain';

export type ApproverCheck = { actor: string; exists: boolean };

// Debounce window for the per-keystroke approver existence check.
const APPROVER_CHECK_DEBOUNCE_MS = 300;

export function useProposalSigner() {
    const signing = ref<boolean>(false);
    const validating = ref<boolean>(false);
    const txHash = ref<string | null>(null);
    const error = ref<string | null>(null);
    // null = not validated yet; otherwise the client-side build outcome.
    const validation = ref<{ ok: boolean; message: string } | null>(null);
    // F3: per-approver on-chain existence (empty until checkApprovers runs).
    const approverChecks = ref<ApproverCheck[]>([]);

    function extractError(err: any): string {
        if (err?.data?.error?.details?.length > 0) return err.data.error.details[0].message;
        return err?.message ?? 'Transaction failed';
    }

    // Build the eosio.msig::proposex data via the shared, standalone builder.
    // Serializes the inner transaction against on-chain ABIs. `requested`/
    // `actions` are deep-cloned to plain JSON (they arrive as reactive proxies).
    async function buildProposeData(
        proposer: string,
        proposalName: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ) {
        const plainRequested = JSON.parse(JSON.stringify(requested));
        const plainActions = JSON.parse(JSON.stringify(actions));
        return BlockchainService.getProposalTxData(proposer, proposalName, plainRequested, plainActions, expiration);
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

    // F3: debounced + sequence-guarded approver existence check. Rapid typing
    // fires many calls; we debounce the trailing one, and a monotonic seq drops
    // out-of-order resolutions so the displayed warnings always reflect the
    // latest input (no truncated/stale account names). Non-blocking — a missing
    // account is a warning, not an error (the proposer may intend a not-yet-
    // created account).
    let checkSeq = 0;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    function checkApprovers(requested: Array<{ actor: string; permission: string }>): void {
        if (checkTimer) clearTimeout(checkTimer);
        const snapshot = requested.map((r) => r.actor);
        checkTimer = setTimeout(() => {
            const seq = ++checkSeq;
            const unique = [...new Set(snapshot.filter((a) => a.length > 0))];
            void Promise.all(
                unique.map(async (actor) => ({ actor, exists: !!(await BlockchainService.getAccountData(actor)) }))
            ).then((results) => {
                // Drop stale results: only apply if no newer check has started.
                if (seq === checkSeq) approverChecks.value = results;
            });
        }, APPROVER_CHECK_DEBOUNCE_MS);
    }

    // Client-side validation: build/serialize the proposal. No wallet, no
    // broadcast — replaces the removed on-chain validatetrx path. A successful
    // build means ABIs resolved and the data encoded; the proposal is ready to
    // sign. Always resets `validating` (cannot hang).
    async function validate(
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
            validation.value = { ok: false, message: 'Connect a wallet account first.' };
            return;
        }
        if (!proposalName || requested.length === 0) {
            validation.value = { ok: false, message: 'Enter a proposal name and at least one approver.' };
            return;
        }
        validating.value = true;
        try {
            await buildProposeData(state.accountName, proposalName, requested, actions, expiration);
            validation.value = {
                ok: true,
                message: 'Looks valid — the proposal transaction serialized successfully.',
            };
        } catch (err) {
            validation.value = { ok: false, message: extractError(err) };
        } finally {
            validating.value = false;
        }
    }

    // Build + sign the proposex action. buildProposeData also serves as the
    // implicit build validation here (its throw surfaces as the sign error).
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
            const proposeData = await buildProposeData(state.accountName, proposalName, requested, actions, expiration);
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
        validate,
        sign,
    };
}
