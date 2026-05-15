import * as I from '../interfaces/index';

/**
 * Allowlist of contracts whose human-readable descriptors are published in
 * `ultraio/docs-blockchain`. Skipping the fetch for everything else avoids
 * noisy 404s in the browser console — the docs site doesn't publish
 * descriptors for arbitrary contracts (`eosio.token`, custom user contracts,
 * etc.). Add an entry here when a new descriptor lands in the docs repo
 * under `docs/public/descriptors/`.
 *
 * TODO: replace with an on-chain descriptor URI lookup (the contract itself
 * declares where its metadata lives) so the toolkit isn't coupled to the
 * docs repo's set.
 */
const PUBLISHED_DESCRIPTORS: ReadonlySet<string> = new Set(['eosio.nft.ft']);

export async function getContractDescriptor(
    contract: string,
    environment: string,
): Promise<I.SmartContractMetadata> {
    const localOverride =
        window.origin.includes('localhost:5172') && environment === 'Local:8888'
            ? [`http://localhost:5173/experimental/descriptors/${contract}-descriptor.json`]
            : [];

    const remote = PUBLISHED_DESCRIPTORS.has(contract)
        ? [
              `https://developers.ultra.io/descriptors/${contract}-descriptor.json`,
              `https://raw.githubusercontent.com/ultraio/docs-blockchain/main/docs/public/descriptors/${contract}-descriptor.json`,
          ]
        : [];

    const sources = [...localOverride, ...remote];
    if (sources.length === 0) return undefined;

    for (const url of sources) {
        try {
            const response = await fetch(url, { method: 'GET' });
            if (response?.ok) return await response.json();
        } catch {
            // network failure (offline / DNS) — try next source silently
        }
    }
    return undefined;
}
