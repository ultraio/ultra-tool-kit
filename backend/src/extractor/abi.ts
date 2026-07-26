import { createHash } from 'node:crypto';
import { ExtractError } from './types.js';

export type AbiAction = { name: string; type: string };
export type AbiStruct = { name: string; fields: Array<{ name: string; type: string }> };

export type Abi = {
    actions: AbiAction[];
    structs: AbiStruct[];
    [key: string]: unknown;
};

export type AbiFetchResult = {
    abi: Abi;
    chainId: string;
    sourceUrl: string;
};

export type AbiFetchLogger = (msg: string) => void;

const noop: AbiFetchLogger = () => {};

function trimSlash(url: string): string {
    return url.replace(/\/$/, '');
}

export async function fetchAbi(account: string, url: string, log: AbiFetchLogger = noop): Promise<AbiFetchResult> {
    const base = trimSlash(url);
    const endpoint = `${base}/v1/chain/get_abi`;
    log(`[abi] Fetching ABI from ${endpoint} for ${account}`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_name: account }),
    });
    if (!res.ok) {
        throw new ExtractError(`ABI fetch failed: ${res.status} ${res.statusText}`, { endpoint });
    }
    const json = (await res.json()) as { account_name: string; abi?: Abi };
    if (!json.abi || !Array.isArray(json.abi.actions)) {
        throw new ExtractError(`ABI response missing abi.actions for ${account}`, { endpoint });
    }
    let chainId = '';
    try {
        const infoRes = await fetch(`${base}/v1/chain/get_info`);
        if (infoRes.ok) {
            const info = (await infoRes.json()) as { chain_id?: string };
            chainId = info.chain_id ?? '';
        }
    } catch {
        // chain_id is best-effort metadata; missing is non-fatal.
    }
    return { abi: json.abi, chainId, sourceUrl: base };
}

export async function fetchAbiWithFallback(
    account: string,
    mainnetUrl: string,
    testnetUrl: string,
    log: AbiFetchLogger = noop
): Promise<AbiFetchResult> {
    try {
        return await fetchAbi(account, mainnetUrl, log);
    } catch (err) {
        log(`[abi] Mainnet ABI fetch failed (${(err as Error).message}); falling back to testnet`);
        return await fetchAbi(account, testnetUrl, log);
    }
}

export function hashAbi(abi: Abi): string {
    return createHash('sha256').update(JSON.stringify(abi)).digest('hex');
}
