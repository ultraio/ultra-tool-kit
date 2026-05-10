#!/usr/bin/env -S tsx
import 'dotenv/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { closeDb, getDb } from '../src/db/client.js';
import { runIngest } from '../src/ingest/index.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { OpenAIProvider } from '../src/llm/openai.js';
import { getProvider } from '../src/llm/router.js';

type Argv = {
    contracts: string[];
    enrich: boolean;
    dual: boolean;
};

function parseArgv(args: string[]): Argv {
    const out: Argv = { contracts: [], enrich: false, dual: false };
    for (const a of args) {
        if (a === '--enrich') out.enrich = true;
        else if (a === '--dual') out.dual = true;
        else if (a.startsWith('-')) throw new Error(`Unknown flag: ${a}`);
        else out.contracts.push(a);
    }
    return out;
}

async function main(): Promise<void> {
    const argv = parseArgv(process.argv.slice(2));
    const log = pino();

    const here = dirname(fileURLToPath(import.meta.url));
    const catalogDir = resolve(here, '..', 'catalog');

    const primaryEmbed = getProvider('embed');
    const embedProviders = [primaryEmbed];
    if (argv.dual) {
        const primaryDim = primaryEmbed.vectorDim();
        const secondary = primaryDim === 768 ? new OpenAIProvider() : new OllamaProvider();
        if (secondary.vectorDim() === primaryDim) {
            throw new Error('--dual requires the primary embed provider and secondary to have different vectorDim() values');
        }
        embedProviders.push(secondary);
        log.info({ dims: embedProviders.map((p) => p.vectorDim()) }, '[ingest] dual embedding enabled');
    }

    const summary = await runIngest({
        db: getDb(),
        catalogDir,
        contractNames: argv.contracts.length > 0 ? argv.contracts : undefined,
        embedProviders,
        chatProvider: getProvider('chat'),
        enrich: argv.enrich,
        log,
    });

    log.info(summary, '[ingest] complete');
    await closeDb();
}

main().catch(async (err: unknown) => {
    console.error('[ingest] fatal:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) console.error(err.stack);
    await closeDb();
    process.exit(1);
});
