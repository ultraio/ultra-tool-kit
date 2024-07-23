import { BlockchainService } from "./blockchain";

export const defaultNetworks = [
    {
        name: 'Mainnet',
        urls: [
            //'https://api.mainnet.ultra.io', - does not support get_accounts_by_authorizer
            'https://ultra.api.eosnation.io',
            //'https://ultra.eosrio.io', - CORS error
            'https://api.ultra.cryptolions.io',
            'https://ultra.eosusa.io',
            'https://api.ultra.eossweden.org',
            'https://ultra-api.eoseoul.io',
        ],
        isPublic: true,
    },
    {
        name: 'Testnet',
        urls: [
            //'https://api.testnet.ultra.io/', - get_accounts_by_authorizer
            'https://ultratest.api.eosnation.io',
            //'https://testnet.ultra.eosrio.io', - CORS error
            'https://api.ultra-testnet.cryptolions.io',
            'https://test.ultra.eosusa.io',
            'https://api.testnet.ultra.eossweden.org',
            'https://ultratest-api.eoseoul.io',
        ],
        isPublic: true,
    },
    { name: 'Diablo', urls: ['https://api-diablo.dfuse.ultra.io'], isPublic: false },
    { name: 'Preprod', urls: ['https://api-preprod.dfuse.ultra.io'], isPublic: false },
    { name: 'Dev', urls: ['https://api-dev.dfuse.ultra.io'], isPublic: false },
    { name: 'QA', urls: ['https://api-qa.dfuse.ultra.io'], isPublic: false },
    { name: 'Local:8888', urls: ['http://localhost:8888'], isPublic: true },
];

export const defaultExplorers = {
    Mainnet: 'https://explorer.mainnet.ultra.io',
    Testnet: 'https://explorer.testnet.ultra.io',
    Diablo: 'https://eosq-diablo.dfuse.ultra.io',
    Preprod: 'https://eosq-preprod.dfuse.ultra.io',
    Dev: 'https://eosq-dev.dfuse.ultra.io',
    QA: 'https://eosq-qa.dfuse.ultra.io',
};

export function getTransactionLink(env: string, hash: string) {
    if (!defaultExplorers[env]) {
        return undefined;
    }

    return `${defaultExplorers[env]}/tx/${hash}`;
}

export function getEnvironmentName(endpoint: string): string {
    let env = defaultNetworks.find((net) => {
        return net.urls.includes(endpoint);
    });

    if (env) {
        return env.name;
    }
    return defaultNetworks[defaultNetworks.length - 1].name;
}

export function getEnvironmentEndpoint(name: string): string {
    let env = defaultNetworks.find((net) => {
        return net.name === name;
    });

    if (env) {
        return env.urls[0];
    }
    return defaultNetworks[defaultNetworks.length - 1].urls[0];
}

export function routePageEnvironment(emits: any, route: any) {
    if (route.query.env && route.query.env != BlockchainService.environment) {
        emits('set-endpoint', getEnvironmentEndpoint(route.query.env as string), false);
    }
}

export async function fetchWithTimeout(resource, options: any = {}) {
    const { timeout = 3000 } = options;

    const controller = new AbortController();
    const id = setTimeout(() => {
        console.error(`Request to ${resource} timed out`);
        controller.abort();
    }, timeout);

    const response = await fetch(resource, {
        ...options,
        signal: controller.signal,
    });
    clearTimeout(id);

    return response;
}
