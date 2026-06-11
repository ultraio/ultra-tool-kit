import { BlockchainService } from './blockchain';

export const defaultNetworks = [
    {
        name: 'Mainnet',
        chainId: 'a9c481dfbc7d9506dc7e87e9a137c931b0a9303f64fd7a1d08b8230133920097',
        // eosusa first — eosrio's gateway has broken CORS preflight
        // (doesn't echo `Access-Control-Allow-Headers: content-type`),
        // which makes the toolkit fail to talk to it from a browser dapp.
        urls: [
            'https://ultra.eosusa.io',
            'https://api.ultra.cryptolions.io',
            'https://api.ultra.eossweden.org',
            'https://ultra-api.eoseoul.io',
            'https://ultra.eosphere.io',
            'https://ultra.eosrio.io',
        ],
        isPublic: true,
    },
    {
        name: 'Testnet',
        chainId: '7fc56be645bb76ab9d747b53089f132dcb7681db06f0852cfa03eaf6f7ac80e9',
        urls: [
            'https://test.ultra.eosusa.io',
            'https://api.ultra-testnet.cryptolions.io',
            'https://api.testnet.ultra.eossweden.org',
            'https://ultra-testnet.eosphere.io',
            'https://testnet.ultra.eosrio.io',
        ],
        isPublic: true,
    },
    { name: 'Local:8888', urls: ['http://localhost:8888'], isPublic: true },
];

/**
 * Find a network config by its chain ID.
 * Returns undefined if no known network matches (custom/internal networks).
 */
export function getNetworkByChainId(chainId: string) {
    return defaultNetworks.find((net) => (net as any).chainId === chainId);
}

export const defaultExplorers = {
    Mainnet: 'https://explorer.mainnet.ultra.io',
    Testnet: 'https://explorer.testnet.ultra.io',
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
