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

export type KnownSymbol = {
    precision: number;
    contract: string;
    core?: boolean;
    notes?: string;
};

export type KnownSymbolsFile = Record<string, KnownSymbol>;

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(here, '..', '..', 'catalog', 'eosio-types.json');
const KNOWN_SYMBOLS_PATH = resolve(here, '..', '..', 'catalog', 'known-symbols.json');

let cached: EosioTypesFile | null = null;
let cachedSymbols: KnownSymbolsFile | null = null;

export async function loadEosioTypes(): Promise<EosioTypesFile> {
    if (cached) return cached;
    const raw = await readFile(CATALOG_PATH, 'utf8');
    cached = JSON.parse(raw) as EosioTypesFile;
    return cached;
}

export async function loadKnownSymbols(): Promise<KnownSymbolsFile> {
    if (cachedSymbols) return cachedSymbols;
    try {
        const raw = await readFile(KNOWN_SYMBOLS_PATH, 'utf8');
        cachedSymbols = JSON.parse(raw) as KnownSymbolsFile;
    } catch {
        // Missing file is fine — Phase-1 demos may run without it. The model is
        // told to ask the user for precision when no Known symbols block is present.
        cachedSymbols = {};
    }
    return cachedSymbols;
}

export function eosioTypesPath(): string {
    return CATALOG_PATH;
}
