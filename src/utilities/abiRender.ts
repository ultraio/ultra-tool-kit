import * as I from '../interfaces/index';

// TODO: fetch URI from on-chain contract table
export async function getContractDescriptor(contract: string, environment: string): Promise<I.SmartContractMetadata> {
    const options = {
        method: 'GET',
    };

    let descriptorSources = environment === 'Local:8888' ? [`http://localhost:5173/descriptors/${contract}-descriptor.json`] : [];
    descriptorSources = descriptorSources.concat([
        `https://developers.ultra.io/descriptors/${contract}-descriptor.json`,
        `https://raw.githubusercontent.com/ultraio/docs-blockchain/main/docs/public/descriptors/${contract}-descriptor.json`,
        `https://raw.githubusercontent.com/ultraio/docs-blockchain/main/descriptors/${contract}-descriptor.json`
    ])

    let response: Response;
    for (let i = 0; i < descriptorSources.length; i++) {
        try {
            response = await fetch(
                descriptorSources[i],
                options
            );
            if (!response || !response.ok) {
                continue;
            }
            const data = await response.json();
            return data;
        } catch (err) {
            console.error(err);
            continue;
        }
    }
    console.log(`failed to get contract descriptor for ${contract}`);
    return undefined;
}
