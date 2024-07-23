import { schema as UniqSchema_Prod } from './uniq';
import { schema as UniqsOfWalletSchema_Prod } from './uniqsOfWallet';
import { schema as UniqFactoriesSchema_Prod } from './uniqFactories';
import { schema as UniqFactorySchema_Prod } from './uniqFactory';
import { schema as UniqsOfFactorySchema_Prod } from './uniqsOfFactory';

import { schema as UniqSchema_Staging } from './uniq';
import { schema as UniqsOfWalletSchema_Staging } from './uniqsOfWallet';
import { schema as UniqFactoriesSchema_Staging } from './uniqFactories';
import { schema as UniqFactorySchema_Staging } from './uniqFactory';
import { schema as UniqsOfFactorySchema_Staging } from './uniqsOfFactory';

import { schema as UniqSchema_Preprod } from './uniq';
import { schema as UniqsOfWalletSchema_Preprod } from './uniqsOfWallet';
import { schema as UniqFactoriesSchema_Preprod } from './uniqFactories';
import { schema as UniqFactorySchema_Preprod } from './uniqFactory';
import { schema as UniqsOfFactorySchema_Preprod } from './uniqsOfFactory';

import { schema as UniqSchema_QA } from './uniq';
import { schema as UniqsOfWalletSchema_QA } from './uniqsOfWallet';
import { schema as UniqFactoriesSchema_QA } from './uniqFactories';
import { schema as UniqFactorySchema_QA } from './uniqFactory';
import { schema as UniqsOfFactorySchema_QA } from './uniqsOfFactory';

import { schema as UniqSchema_Dev } from './uniq';
import { schema as UniqsOfWalletSchema_Dev } from './uniqsOfWallet';
import { schema as UniqFactoriesSchema_Dev } from './uniqFactories';
import { schema as UniqFactorySchema_Dev } from './uniqFactory';
import { schema as UniqsOfFactorySchema_Dev } from './uniqsOfFactory';

import { receivedOffersSchema, sentOffersSchema } from './buyOffer';

export function GetUniqSchema(env: string) {
    if (env == 'dev') return UniqSchema_Dev;
    if (env == 'qa') return UniqSchema_QA;
    if (env == 'preprod') return UniqSchema_Preprod;
    if (env == 'staging') return UniqSchema_Staging;
    return UniqSchema_Prod;
}

export function GetUniqsOfWalletSchema(env: string) {
    if (env == 'dev') return UniqsOfWalletSchema_Dev;
    if (env == 'qa') return UniqsOfWalletSchema_QA;
    if (env == 'preprod') return UniqsOfWalletSchema_Preprod;
    if (env == 'staging') return UniqsOfWalletSchema_Staging;
    return UniqsOfWalletSchema_Prod;
}

export function GetUniqFactoriesSchema(env: string) {
    if (env == 'dev') return UniqFactoriesSchema_Dev;
    if (env == 'qa') return UniqFactoriesSchema_QA;
    if (env == 'preprod') return UniqFactoriesSchema_Preprod;
    if (env == 'staging') return UniqFactoriesSchema_Staging;
    return UniqFactoriesSchema_Prod;
}

export function GetUniqsOfFactorySchema(env: string) {
    if (env == 'dev') return UniqsOfFactorySchema_Dev;
    if (env == 'qa') return UniqsOfFactorySchema_QA;
    if (env == 'preprod') return UniqsOfFactorySchema_Preprod;
    if (env == 'staging') return UniqsOfFactorySchema_Staging;
    return UniqsOfFactorySchema_Prod;
}

export function GetUniqFactorySchema(env: string) {
    if (env == 'dev') return UniqFactorySchema_Dev;
    if (env == 'qa') return UniqFactorySchema_QA;
    if (env == 'preprod') return UniqFactorySchema_Preprod;
    if (env == 'staging') return UniqFactorySchema_Staging;
    return UniqFactorySchema_Prod;
}

export function GetReceivedOffersSchema() {
    return receivedOffersSchema;
}

export function GetSentOffersSchema() {
    return sentOffersSchema;
}
