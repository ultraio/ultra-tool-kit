import { ABI as UtilityABI } from '../utilities/abi';

export type WalletTypes = 'ultra' | 'anchor' | 'ledger';

export interface AuthState {
    environment?: string;
    endpoint?: string;
    accountName?: string;
    accountPerm?: string;
    type?: WalletTypes;
    isAdmin: boolean;
    ledgerIndex?: number;
}

export interface PageState {
    showTransaction?: boolean;
    showLogin?: boolean;
    showEndpoint?: boolean;
}

export interface Action {
    contract: string;
    action: string;
    data: { [key: string]: any };
    authorization?: Array<{ actor: string; permission: string }>;
}

export interface RuntimeMetadata {
    lastSignedTransactionTimestamp?: number;
    lastSignedActions?: Action[];
}

export interface LedgerAction {
    account: string;
    name: string;
    data: { [key: string]: any };
    authorization: { actor: string; permission: string }[];
}

export interface SharedEmits {
    (e: 'set-endpoint', endpoint: string, userInvoked?: boolean): void;
    (e: 'set-page-state', state: PageState);
}

export interface TransactionBuilderContract {
    account: string;
    status: 'loading' | 'found' | 'not found';
}

export interface NavigationOption {
    name: string;
    link?: string;
    nestedOptions?: NavigationOption[];
    isAdmin?: boolean;
}

export interface Proposal {
    name: string;
    proposer: string;
    approved: boolean;
    readable: {
        actions: LedgerAction[];
        context_free_actions: any[];
        delay_sec: number;
        expiration: string;
        max_net_usage_words: number | string;
        max_cpu_usage_ms: number;
        ref_block_num: number;
        ref_block_prefix: number;
        transaction_extensions: any[];
    };
}

export interface BlacklistedAccount {
    account: string;
    level: string;
}

export interface SmartContractMetadataActionField {
    friendlyName?: string;
    description?: string;
    fields?: { [key: string]: SmartContractMetadataActionField };
}

export interface SmartContractMetadataAction {
    friendlyName?: string;
    description?: string;
    documentation?: string;
    fields?: { [key: string]: SmartContractMetadataActionField };
}

export interface SmartContractMetadata {
    actions: { [key: string]: SmartContractMetadataAction };
}

export interface EosioResponse<T> {
    rows: T[];
    more: boolean;
    next_key: string;
}

export interface GetAccountsByAuthorizersAccount {
    account_name: string;
    permission_name: string;
    authorizing_key: string;
    weight: number;
    threshold: number;
}

export interface GetAccountsByAuthorizersResponse {
    accounts: GetAccountsByAuthorizersAccount[];
}

export interface NFTTokenV1 {
    id: number;
    token_factory_id: number;
    mint_date: string;
    serial_number: number;
    uos_payment: number;
    uri: string | null;
    hash: string | null;
}

export interface NFTFactoryV1 {
    id: number;
    asset_manager: string;
    asset_creator: string;
    minimum_resell_price: string;
    resale_shares: ResaleShare[];
    mintable_window_start: number | null;
    mintable_window_end: number | null;
    trading_window_start: number | null;
    trading_window_end: number | null;
    recall_window_start: number | null;
    recall_window_end: number | null;
    lockup_time: number | null;
    conditionless_receivers: string[];
    stat: number;
    factory_uri: string;
    factory_hash: string;
    max_mintable_tokens: number | null;
    minted_tokens_no: number;
    existing_tokens_no: number;
    authorized_tokens_no: number | null;
    account_minting_limit: number | null;
    transfer_window_start: number | null;
    transfer_window_end: number | null;
    default_token_uri: string;
    default_token_hash: string;
    lock_hash: number;
}

export interface ResaleShare {
    receiver: string;
    basis_point: number;
}

export interface MediaReference {
    name: string;
    uri: string;
}

export interface MetadataTableEntry {
    name?: string;
    value: string | number | MetadataTableEntry[];
    format: string;
    isNested: boolean;
}

// table resale.a
export interface ResaleData {
    token_id: number;
    owner: string;
    price: string;
    promoter_basis_point: number;
}

export interface AbiTypes {
    new_type_name: string;
    type: string;
}

export interface AbiField {
    name: string;
    type: string;
}

export interface AbiStruct {
    name: string;
    base: string;
    fields: AbiField[];
}

export interface AbiAction {
    name: string;
    type: string;
    ricardian_contract: string;
}

export interface AbiTables {
    name: string;
    type: string;
    index_type: string;
    key_names: any[];
    key_types: any[];
}

export interface ABI {
    types: AbiTypes[];
    structs: AbiStruct[];
    actions: AbiAction[];
    tables: AbiTables[];
}

export interface MediaDataWithIntegrity {
    title: string;
    contentType: string;
    integrity: { hash: string; type: string };
    uri: string;
}

export interface AbiRenderAction {
    account: string;
    name: string;
    abi: UtilityABI;
}

// List of admin, proposer, support & marketing accounts
export const ELEVATED_ACCOUNTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    .map((x) => `uad${x}`)
    .concat([1, 2, 3, 4, 5].map((x) => `ultra.prop${x}`))
    .concat(['a', 'b'].map((x) => `ultra.sup${x}`))
    .concat(['a', 'b', 'c'].map((x) => `ultra.mrkt${x}`));

export interface TransactionResponse {
    transaction_id: string;
    processed: {
        id: string;
        block_num: number;
        block_time: string;
        receipt: {
            status: string;
            cpu_usage_us: number;
            net_usage_words: number;
        } | null;
        elapsed: number;
        net_usage: number;
        scheduled: boolean;
        action_traces: ActionTrace[];
        except: ActionTrace;
        account_ram_delta: any;
    };
}

export interface ActionTrace {
    code: number;
    name: string;
    message: string;
    stack: Stack[];
}

export interface Stack {
    context: Context;
    format: string;
    data: Data;
}

export interface Context {
    level: string;
    file: string;
    line: number;
    method: string;
    hostname: string;
    thread_name: string;
    timestamp: string;
}

export interface Data {
    s?: string;
    console?: string;
}

export interface DataTableType {
    dataTable: { headers: { text: string; value: string; sortable?: boolean }[]; rows: any[] };
}

export interface ReceivedOffer {
    id: string;
    type: string;
    expiryDate: string;
    buyer: string;
    uniq: {
        id: string;
        owner: string;
    };
    uniqFactory: {
        id: string;
    };
    price: {
        amount: string;
        currency: {
            code: string;
            symbol: string;
        };
    };
    receiver: string;
}

export interface SentOffer {
    id: string;
    type: string;
    expiryDate: string;
    uniqFactoryId: string;
    uniqId: string;
    buyer: string;
    uniq: {
        owner: string;
    };
    uniqFactory: {
        owner: string;
    };
    price: {
        amount: string;
        currency: {
            code: string;
            symbol: string;
        };
    };
}
