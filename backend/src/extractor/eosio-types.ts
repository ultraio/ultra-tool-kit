import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EosioTypeRules = {
    description: string;
    pattern?: string;
    constraints: string[];
    examples: string[];
};

export type EosioTypesFile = Record<string, EosioTypeRules>;

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(here, '..', '..', 'catalog', 'eosio-types.json');

let cached: EosioTypesFile | null = null;

export async function loadEosioTypes(): Promise<EosioTypesFile> {
    if (cached) return cached;
    const raw = await readFile(CATALOG_PATH, 'utf8');
    cached = JSON.parse(raw) as EosioTypesFile;
    return cached;
}

export function eosioTypesPath(): string {
    return CATALOG_PATH;
}
