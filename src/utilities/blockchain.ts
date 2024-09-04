import { UltraAPI, connect } from '@ultraos/ultra-api-lib';
import { API as UltraSignerAPI } from '@ultraos/ultra-signer-lib';
import * as Wharfkit from '@wharfkit/antelope';
import { Action, BlacklistedAccount, GetAccountsByAuthorizersResponse, Proposal } from '../interfaces';
import { ABI } from '../utilities/abi';
import { getContractDescriptor } from './abiRender';
import { defaultNetworks, fetchWithTimeout } from './networks';
import * as I from '../interfaces/index';

export abstract class BlockchainService {
    static isInit: Boolean = false;
    static endpoint: string;
    static environment: string;
    static api: UltraAPI;
    static signerApi: UltraSignerAPI;
    static authState: I.AuthState;
    private static abiCache: { [key: string]: { ABI: ABI; wharfkitAbi: Wharfkit.ABI } } = {};
    private static availableEndpoints: string[] = [];
    private static lastApiNodeIndex: number;
    private static maxApiRetries: number;

    /**
     * Initializes the BlockchainService.
     *
     * Call the init method after login.
     * By the time this method is called, we'd have already connected to the ultra wallet/ledger,
     * and we would have the authState object available.
     */
    static async init(authState: I.AuthState) {
        if (BlockchainService.isInit && BlockchainService.endpoint == authState.endpoint) {
            console.log(`BlockchainService: Already init'd for env ${authState.environment}(${authState.endpoint})`);
            return;
        }

        if (!authState.endpoint) {
            throw new Error('Failed to initialize BlockchainService. No endpoint provided');
        }

        BlockchainService.availableEndpoints = defaultNetworks.find((network) => network.name == authState.environment)
            ?.urls || [authState.endpoint];
        BlockchainService.maxApiRetries = BlockchainService.availableEndpoints.length;
        BlockchainService.lastApiNodeIndex = 0;
        BlockchainService.endpoint = authState.endpoint;
        BlockchainService.environment = authState.environment;
        BlockchainService.authState = authState;
        BlockchainService.api = await connect(BlockchainService.endpoint, 3);
        BlockchainService.signerApi = new UltraSignerAPI(BlockchainService.endpoint, {
            signingMode: 'PRIVATE_KEY',
            privateKeys: [],
        });
        BlockchainService.isInit = true;
        console.log(`BlockchainService: Successfully init'd for endpoint ${BlockchainService.endpoint}`);
    }


    static async waitForInit(timeout: number = 5000) {
        const recheckEvery = 100;
        if (timeout <= 0) return;
        if (BlockchainService.isInit) return;
        while (timeout > 0) {
            timeout -= recheckEvery;
            await new Promise(r => setTimeout(r, recheckEvery));
            if (BlockchainService.isInit) return;
        }
        return;
    }

    static async updateEndpoint() {
        const endpoint = BlockchainService.availableEndpoints[BlockchainService.lastApiNodeIndex];
        BlockchainService.endpoint = endpoint;
        try {
            BlockchainService.api = await connect(endpoint, 3);
            BlockchainService.signerApi = new UltraSignerAPI(endpoint, { signingMode: 'PRIVATE_KEY', privateKeys: [] });
            BlockchainService.authState.endpoint = endpoint;
        } catch (err) {
            console.error(`Failed to switch to endpoint: ${err}`);
            return false;
        }
        return true;
    }

    static roundRobinRequest = async <T = any>(callback: () => Promise<T>): Promise<T> => {
        await BlockchainService.waitForInit();
        
        let requestErrors: any[] = [];
        for (let i = 0; i < BlockchainService.maxApiRetries + 1; i++) {
            let newLastApiNodeIndex = BlockchainService.lastApiNodeIndex;
            let result: any;
            try {
                result = await callback().catch((err) => {
                    requestErrors.push(err);
                    console.error(`Failed to make request because of error: ${err}`);
                    return null;
                });
            } catch (err) {
                requestErrors.push(err);
                console.error(`Failed to make request because of error: ${err}`);
            }
            if (result) return result;
            newLastApiNodeIndex++;

            if (newLastApiNodeIndex >= BlockchainService.maxApiRetries) newLastApiNodeIndex = 0;

            // Parallel requests may try to independently increment the counter
            // To combat that we only increment it up (or to 0 in case it loops back)
            if (newLastApiNodeIndex > BlockchainService.lastApiNodeIndex || newLastApiNodeIndex == 0) {
                BlockchainService.lastApiNodeIndex = newLastApiNodeIndex;
                console.log(
                    `Switching to API ${BlockchainService.availableEndpoints[BlockchainService.lastApiNodeIndex]}`
                );
                await BlockchainService.updateEndpoint();
            }
        }
        console.log(`Failed to make blockchain API request: ${requestErrors}`);
        return null;
    };

    /**
     * Retrieves data from a specified table in a smart contract on the blockchain.
     *
     * @param {string} code The contract to call
     * @param {string} scope The scope of the table
     * @param {string} table The name of the table
     * @param {number | null} lowerBound Specifies the lower bound of the primary key value of the table rows to be retrieved.
     * @param {number | null} upperBound Specifies the upper bound of the primary key value of the table rows to be retrieved.
     */
    static getTableData = async <T = any>(
        code: string,
        scope: string,
        table: string,
        lowerBound: number | string | null = null,
        upperBound: number | string | null = null,
        limit: number = 10
    ) =>
        BlockchainService.roundRobinRequest(() =>
            BlockchainService.api.contract(code).getTableLimited<T>(table, scope, lowerBound, upperBound, limit)
        );

    /**
     * This function retrieves all data from a specified table in a blockchain and returns it as an array.
     *
     * @param {string} code The contract to call
     * @param {string} scope The scope of the table
     * @param {string} table The name of the table
     * @param {number | null} [lowerBound=null] Used to identify where to fetch rows from a table.
     * @returns An array of objects which can be specified as a generic type.
     */
    static getAllTableData = async <T = any>(
        code: string,
        scope: string,
        table: string,
        lowerBound: any = null
    ): Promise<T[]> =>
        BlockchainService.roundRobinRequest(() =>
            BlockchainService.api.contract(code).getTable<T>(table, scope, lowerBound)
        );

    /***
     * Reads proposals from the `requests` table.
     * @param signingAccount
     * @returns {Promise<Array>}
     */
    static getProposals = async (signingAccount: string) => {
        if (!signingAccount) return [];
        const requests = await BlockchainService.roundRobinRequest(
            async () => await BlockchainService.getAllTableData('eosio.msig', signingAccount, 'requests')
        );
        const proposals: Proposal[] = [];

        for (let request of requests) {
            const proposer = request.proposer;
            for (let ri_entry of request.request_infos.entries()) {
                const proposal = await BlockchainService.roundRobinRequest(
                    async () =>
                        await BlockchainService.getAllTableData(
                            'eosio.msig',
                            proposer,
                            'proposal',
                            ri_entry[1].proposal_name
                        )
                );

                if (!proposal) {
                    continue;
                }

                if (proposal.length < 1) {
                    continue;
                }
                if (proposal[0].proposal_name != ri_entry[1].proposal_name) {
                    continue;
                }

                const readable = await BlockchainService.packedTransactionToJSON(proposal[0].packed_transaction);
                const signed = request.request_infos[ri_entry[0]].required_approvals_no == 0;
                const result: Proposal = {
                    name: ri_entry[1].proposal_name,
                    proposer,
                    readable,
                    approved: signed,
                };

                proposals.push(result);
            }
        }
        return proposals;
    };

    /***
     * Reads black/grey listed accounts from the `blcklstultra` table.
     * @returns {Promise<Array>}
     */
    static getBlackList = async () => {
        const blacklistedAccounts = await BlockchainService.roundRobinRequest(() =>
            BlockchainService.getAllTableData<BlacklistedAccount>('eosio', 'eosio', 'blcklstultra')
        );
        return blacklistedAccounts;
    };

    /**
     * Converts a packed transaction to a readable transaction.
     *
     * @param packed_transaction
     * @returns
     */
    public static packedTransactionToJSON = async (packed_transaction: string) => {
        const trx = Wharfkit.PackedTransaction.from({ packed_trx: packed_transaction });
        const readable_trx = JSON.parse(JSON.stringify(trx.getTransaction().toJSON()));
        for (let i = 0; i < readable_trx.actions.length; i++) {
            const contract = readable_trx.actions[i].account;
            const abi: Wharfkit.ABI = (await BlockchainService.getAbi(contract)).wharfkitAbi;
            try {
                const deserialized = trx.getTransaction().actions[i].decodeData(abi);
                readable_trx.actions[i].data = JSON.parse(JSON.stringify(deserialized));
            } catch {
                readable_trx.actions[i].data = trx.getTransaction().actions[i].data.toString();
            }
        }

        return readable_trx;
    };

    public static getAbi = async (account: string, withMetadata: boolean = false) => {
        // Check abi cache for abi, if not available in the cache then get abi from chain
        if (BlockchainService.abiCache[account]) {
            console.log(`${account} abi found in abiCache`);
            return BlockchainService.abiCache[account];
        }

        const data = await BlockchainService.roundRobinRequest(() => BlockchainService.api.chain.getAbi(account));
        if (!data || !data.abi) {
            console.log(`failed to get ABI for ${account}`);
            return undefined;
        }

        try {
            BlockchainService.abiCache[account] = { ABI: new ABI(data.abi), wharfkitAbi: Wharfkit.ABI.from(data.abi) };

            // try to get contract metadata
            if (withMetadata) {
                try {
                    let meta = await getContractDescriptor(account, BlockchainService.environment);
                    BlockchainService.abiCache[account].ABI.metadata = meta;
                } catch (err) {
                    // no metadata
                }
            }

            return BlockchainService.abiCache[account];
        } catch (err) {
            console.error('getAbi error:', err);
            return undefined;
        }
    };

    public static getAccountData = async (name: string) => {
        try {
            const acc = await BlockchainService.roundRobinRequest(() => BlockchainService.api.account(name).get());
            return acc;
        } catch (error) {
            console.error('getAccountData error:', error);
            return undefined;
        }
    };

    public static getAccountsByKey = async (key: string) => {
        try {
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keys: [key] }),
            };

            const response = await BlockchainService.roundRobinRequest(() =>
                fetchWithTimeout(`${BlockchainService.endpoint}/v1/chain/get_accounts_by_authorizers`, options)
            );

            if (!response || !response.ok) {
                return null;
            }

            return <GetAccountsByAuthorizersResponse>await response.json();
        } catch (error) {
            console.error('getAccountsByKey error:', error);
            return undefined;
        }
    };

    public static getTableByScope = async (code: string, table: string, limit = 100, lower_bound: any = undefined) => {
        try {
            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: code,
                    table: table,
                    limit: limit,
                    lower_bound: lower_bound
                }),
            };

            const response = await BlockchainService.roundRobinRequest(() =>
                fetchWithTimeout(`${BlockchainService.endpoint}/v1/chain/get_table_by_scope`, options)
            );

            if (!response || !response.ok) {
                return null;
            }

            return <I.GetTableByScopeResponse>await response.json();
        } catch (error) {
            console.error('getTableByScope error:', error);
            return undefined;
        }
    };

    public static getProposalTxData = async (
        proposer: string,
        proposal_name: string,
        requested: Array<{ actor: string; permission: string }>,
        actions: Action[],
        expiration: string
    ) => {
        const formattedActions = actions.map((action) => {
            return {
                account: action.contract,
                name: action.action,
                authorization: action.authorization,
                data: action.data,
            };
        });

        const transaction = await BlockchainService.signerApi.buildTransaction(formattedActions);
        transaction.ref_block_num = Wharfkit.UInt16.from(0);
        transaction.ref_block_prefix = Wharfkit.UInt32.from(0);

        if (expiration === '') {
            // default proposal expiration - 30 days
            expiration = new Date(+new Date() + 60 * 60 * 24 * 30 * 1000).toISOString().split('.')[0];
        }
        // Date string like 2023-12-31T12:34:56 includes '-', 'T' and ':'. Checking for one of them is enough
        // Otherwise it should throw
        if (!expiration.includes('-')) {
            expiration = new Date(+new Date() + parseInt(expiration) * 1000).toISOString().split('.')[0];
        }
        transaction.expiration = Wharfkit.TimePointSec.from(expiration);

        return {
            proposer,
            proposal_name,
            requested,
            trx: transaction,
        };
    };
}
