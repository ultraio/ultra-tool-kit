import * as Schemas from './schemas';
import credentials from './credentials';
import { UniqResponse } from './schemas/uniqResponse';
import { UniqFactoryResponse } from './schemas/uniqFactoryResponse';
import { PaginationResponse } from './schemas/paginationResponse';
import * as I from '../../interfaces/index';
import { BlockchainService } from '../blockchain';

let ENV: keyof typeof credentials = 'dev';

/**
 * Set the environment to use for queries.
 *
 * @export
 * @param {keyof typeof credentials} env
 */
export function setEnvironment(state: I.AuthState) {
    switch (state.environment) {
        case 'Dev': {
            ENV = 'dev';
            break;
        }
        case 'QA': {
            ENV = 'qa';
            break;
        }
        case 'Preprod': {
            ENV = 'preprod';
            break;
        }
        case 'Testnet': {
            ENV = 'staging';
            break;
        }
        case 'Mainnet': {
            ENV = 'prod';
            break;
        }
        default: {
            console.error(`Unrecognized NFT API environment: ${state.environment}`);
            ENV = undefined;
        }
    }

    console.log(`NFTAPI init'd for environment: ${state.environment}`);
}

export function getEnvironment(): string {
    return ENV;
}

/**
 * Performs an authentication and then builds a GraphQL query and returns results.
 *
 * @template QueryResponse
 * @param {{ query: string; variables: Object }} data
 * @return {Promise<QueryResponse>}
 */
async function queryData<QueryResponse = any>(data: { query: string; variables: Object }): Promise<QueryResponse> {
    // Ensure that NFT API and blockchain service are initialized by the toolkit before doing the request
    await BlockchainService.waitForInit();

    try {
        const urlToUse = credentials[ENV].url;
        const rawResponse = await fetch(urlToUse, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${credentials[ENV].token}`,
                ...(credentials[ENV].headers ? credentials[ENV].headers : {}),
            },
            body: JSON.stringify(data),
        });

        if (rawResponse.status === 400) {
            const jsonResponse = await rawResponse.json();
            console.log(jsonResponse);
            throw new Error('Bad Request');
        }

        if (rawResponse.status === 401) {
            const jsonResponse = await rawResponse.json();
            console.log(jsonResponse);
            throw new Error('Unauthorized');
        }

        if (rawResponse.status === 404) {
            throw new Error('Specified data does not exist.');
        }

        if (rawResponse.status !== 200) {
            throw new Error('Failed to query given the query body data.');
        }

        const jsonResponse = await rawResponse.json();
        return jsonResponse;
    } catch (err) {
        throw err;
    }
}

/**
 * Returned `undefined` if the `uniq` does not exist.
 *
 * Otherwise returns the uniq.
 *
 * @export
 * @param {number} uniqId
 * @return {(Promise<UniqResponse | undefined>)}
 */
export async function fetchUniq(uniqId: number): Promise<UniqResponse | undefined> {
    const query: { data: { uniq: UniqResponse } } = await queryData({
        query: Schemas.GetUniqSchema(ENV),
        variables: {
            id: uniqId,
        },
    });

    if (!query || !query.data) {
        console.error(`Uniq does not exist -> ${uniqId}`);
        return undefined;
    }

    return query.data.uniq;
}

/**
 * Returns `undefined` if the `walletId` does not manage any factories
 *
 * Otherwise returns all managed factories
 *
 * @export
 * @param {string} walletId
 * @param {number} [limit=25]
 * @param {number} [skip=0]
 * @return {(Promise<PaginationResponse<UniqFactoryResponse> | undefined>)}
 */
export async function fetchUniqFactoriesManaged(
    walletId: string,
    limit: number = 25,
    skip: number = 0
): Promise<PaginationResponse<UniqFactoryResponse> | undefined> {
    const query: {
        data: {
            uniqFactories: {
                totalCount: number;
                pagination: { limit: number; skip: number };
                data: Array<UniqFactoryResponse>;
            };
        };
    } = await queryData({
        query: Schemas.GetUniqFactoriesSchema(ENV),
        variables: {
            assetManager: walletId,
            pagination: {
                limit: limit,
                skip: skip,
            },
        },
    });

    if (!query || !query.data) {
        console.error(`Blockchain ID does not manage any factories -> ${walletId}`);
        return undefined;
    }

    return query.data.uniqFactories;
}

/**
 * Returns `undefined` if the `uniq factory` does not exist.
 *
 * Otherwise returns the factory.
 *
 * @export
 * @param {number} factoryId
 * @return {(Promise<UniqFactoryResponse | undefined>)}
 */
export async function fetchUniqFactory(factoryId: number): Promise<UniqFactoryResponse | undefined> {
    // https://developers.ultra.io/guides/NFTAPI/queries.html#uniqfactories
    const query: { data: { uniqFactory: UniqFactoryResponse } } = await queryData({
        query: Schemas.GetUniqFactorySchema(ENV),
        variables: {
            id: factoryId,
        },
    });

    if (!query || !query.data) {
        console.error(`Uniq Factory does not exist -> ${factoryId}`);
        return undefined;
    }

    return query.data.uniqFactory;
}

/**
 * Returns `undefined` if the `factory` and given `ids` do not exist
 *
 * Otherwise returns all uniqs for a given factory.
 *
 * @export
 * @param {number} factoryId
 * @param {Array<number>} [ids=null]
 * @param {number} [limit=25]
 * @param {number} [skip=0]
 * @param {{min: number; max: number}} [serialRange=null]
 * @return {Promise<PaginationResponse<UniqResponse> | undefined>}
 */
export async function fetchUniqsOfFactory(
    factoryId: number,
    ids: Array<number> = null,
    limit: number = 25,
    skip: number = 0,
    resale: boolean = undefined,
    serialRange: { min: number; max: number } = null
): Promise<PaginationResponse<UniqResponse> | undefined> {
    const query: { data: { uniqsOfFactory: PaginationResponse<UniqResponse> } } = await queryData({
        query: Schemas.GetUniqsOfFactorySchema(ENV),
        variables: {
            factoryId: factoryId,
            ids: ids,
            pagination: {
                limit: limit,
                skip: skip,
            },
            resale: resale,
            serialRange: serialRange,
        },
    });

    if (!query || !query.data) {
        console.error(`Uniq Factory does not exist -> ${factoryId}`);
        return undefined;
    }

    return query.data.uniqsOfFactory;
}

/**
 * Returns `undefined` if the `wallet` and given `ids` do not exist
 *
 * Otherwise returns all uniqs for a given wallet.
 *
 * @export
 * @param {string} walletId
 * @param {Array<number>} [ids=null]
 * @param {number} [limit=25]
 * @param {number} [skip=0]
 * @param {*} [serialRange=null]
 * @return {Promise<PaginationResponse<UniqResponse> | undefined>}
 */
export async function fetchUniqsOfWallet(
    walletId: string,
    ids: Array<number> = null,
    limit: number = 25,
    skip: number = 0,
    resale: boolean = undefined,
    serialRange = null
): Promise<PaginationResponse<UniqResponse> | undefined> {
    const query: { data: { uniqsOfWallet: PaginationResponse<UniqResponse> } } = await queryData({
        query: Schemas.GetUniqsOfWalletSchema(ENV),
        variables: {
            walletId: walletId,
            ids: ids,
            pagination: {
                limit: limit,
                skip: skip,
            },
            resale: resale,
            serialRange: serialRange,
        },
    });

    if (!query || !query.data) {
        console.error(`Wallet does not exist or has no uniqs -> ${walletId}`);
        return undefined;
    }

    return query.data.uniqsOfWallet;
}

export async function fetchReceivedOffers(
    subject: { owner?: string; uniqId?: number | string },
    limit: number = 25,
    skip: number = 0
): Promise<PaginationResponse<I.ReceivedOffer> | undefined> {
    try {
        const query: { data: { uniqEffectiveBuyOffers: PaginationResponse<I.ReceivedOffer> } } = await queryData({
            query: Schemas.GetReceivedOffersSchema(),
            variables: {
                subject,
                //expired: true,  // Modify based on whether you want expired or active offers
                pagination: {
                    limit: limit,
                    skip: skip,
                },
            },
        });

        if (!query || !query.data) {
            console.error(`Failed to fetch received offers for subject -> ${JSON.stringify(subject, null, 2)}`);
            return undefined;
        }

        return query.data.uniqEffectiveBuyOffers;
    } catch (error) {
        console.error(`Error in fetchReceivedOffers: ${error.message}`);
        throw error;
    }
}

export async function fetchSentOffers(
    walletId: string,
    limit: number = 25,
    skip: number = 0
): Promise<PaginationResponse<I.SentOffer> | undefined> {
    try {
        const query: { data: { uniqBuyOffers: PaginationResponse<I.SentOffer> } } = await queryData({
            query: Schemas.GetSentOffersSchema(),
            variables: {
                buyer: walletId,
                pagination: {
                    limit: limit,
                    skip: skip,
                },
            },
        });

        if (!query || !query.data) {
            console.error(`Failed to fetch sent offers for wallet -> ${walletId}`);
            return undefined;
        }

        return query.data.uniqBuyOffers;
    } catch (error) {
        console.error(`Error in fetchReceivedOffers: ${error.message}`);
        throw error;
    }
}

export async function fetchFactoryOffers(
    uniqFactoryId: string | number,
    limit: number = 25,
    skip: number = 0
): Promise<PaginationResponse<I.SentOffer> | undefined> {
    try {
        const query: { data: { uniqBuyOffers: PaginationResponse<I.SentOffer> } } = await queryData({
            query: Schemas.GetSentOffersSchema(),
            variables: {
                uniqFactoryId: uniqFactoryId,
                pagination: {
                    limit: limit,
                    skip: skip,
                },
            },
        });

        if (!query || !query.data) {
            console.error(`Failed to fetch sent offers for uniqFactoryId -> ${uniqFactoryId}`);
            return undefined;
        }

        return query.data.uniqBuyOffers;
    } catch (error) {
        console.error(`Error in fetchFactoryOffers: ${error.message}`);
        throw error;
    }
}
