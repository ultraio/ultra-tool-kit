#!/usr/bin/env -S tsx
// Idempotent one-shot bootstrap for the Phase-1 demo. Runs:
//   1. db:migrate   — applies any pending Drizzle migrations
//   2. extract      — re-walks the eosio.token C++ source → backend/catalog/eosio.token.json
//   3. ingest       — embeds + upserts the catalog into Postgres
//
// Each step's stdout/stderr passes through so the live progress is visible.
// Re-running is safe: migrations are no-ops once applied, extract overwrites
// the JSON atomically, ingest upserts and cleans up orphan actions.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT = 'eosio.token';
const here = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(here, '..');

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(cmd, args, { cwd: backendDir, stdio: 'inherit', shell: false });
        child.on('exit', (code) => {
            if (code === 0) resolvePromise();
            else rejectPromise(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
        });
        child.on('error', rejectPromise);
    });
}

async function countActions(): Promise<number> {
    const path = resolve(backendDir, 'catalog', `${CONTRACT}.json`);
    const raw = await readFile(path, 'utf8');
    const json = JSON.parse(raw) as { actions?: Record<string, unknown> };
    return Object.keys(json.actions ?? {}).length;
}

async function main(): Promise<void> {
    console.log(`[seed-demo] 1/3 migrate`);
    await run('npm', ['run', 'db:migrate']);

    console.log(`[seed-demo] 2/3 extract ${CONTRACT}`);
    await run('npm', ['run', 'extract', '--', CONTRACT]);

    console.log(`[seed-demo] 3/3 ingest ${CONTRACT}`);
    await run('npm', ['run', 'ingest', '--', CONTRACT]);

    const n = await countActions();
    console.log(`[seed-demo] Demo data ready (${n} actions in catalog).`);
}

main().catch((err: unknown) => {
    console.error('[seed-demo] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
});
