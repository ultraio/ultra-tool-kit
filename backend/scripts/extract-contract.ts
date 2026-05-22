#!/usr/bin/env -S tsx
import 'dotenv/config';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractContract } from '../src/extractor/index.js';
import { ExtractError } from '../src/extractor/types.js';

type Argv = {
    contracts: string[];
    sourceRoot: string | null; // dir that contains `contracts/<name>`
    sourceDir: string | null; // direct path to a contract directory
};

function parseArgv(args: string[]): Argv {
    const out: Argv = { contracts: [], sourceRoot: null, sourceDir: null };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--source') {
            const next = args[++i];
            if (!next) throw new Error('--source requires a path argument');
            out.sourceRoot = resolve(next);
        } else if (a === '--source-dir') {
            const next = args[++i];
            if (!next) throw new Error('--source-dir requires a path argument');
            out.sourceDir = resolve(next);
        } else if (a && !a.startsWith('-')) {
            out.contracts.push(a);
        } else {
            throw new Error(`Unknown argument: ${a}`);
        }
    }
    return out;
}

async function isDir(p: string): Promise<boolean> {
    try {
        return (await stat(p)).isDirectory();
    } catch {
        return false;
    }
}

type ResolvedSource = { path: string; reason: string };

async function resolveSource(name: string, argv: Argv): Promise<ResolvedSource> {
    if (argv.sourceDir) {
        if (!(await isDir(argv.sourceDir))) {
            throw new ExtractError(`--source-dir does not exist: ${argv.sourceDir}`);
        }
        return { path: argv.sourceDir, reason: '--source-dir' };
    }
    if (argv.sourceRoot) {
        if (!(await isDir(join(argv.sourceRoot, 'contracts', name)))) {
            throw new ExtractError(
                `--source ${argv.sourceRoot} does not contain contracts/${name}/`
            );
        }
        return { path: argv.sourceRoot, reason: '--source' };
    }
    if (process.env.ULTRA_CONTRACTS_PATH) {
        const p = resolve(process.env.ULTRA_CONTRACTS_PATH);
        if (await isDir(join(p, 'contracts', name))) {
            return { path: p, reason: 'ULTRA_CONTRACTS_PATH env var' };
        }
    }
    const tried: string[] = [];
    const candidates = [
        resolve(process.cwd(), '..', 'eosio.contracts'),
        join(homedir(), 'ultra', 'eosio.contracts'),
        join(homedir(), 'eosio.contracts'),
    ];
    for (const candidate of candidates) {
        tried.push(candidate);
        if (await isDir(join(candidate, 'contracts', name))) {
            return { path: candidate, reason: 'auto-discovery' };
        }
    }
    const msg = [
        `Could not find an eosio.contracts checkout containing contracts/${name}/.`,
        '',
        'Tried:',
        ...(argv.sourceRoot ? [`  --source: ${argv.sourceRoot}`] : []),
        ...(process.env.ULTRA_CONTRACTS_PATH ? [`  $ULTRA_CONTRACTS_PATH: ${process.env.ULTRA_CONTRACTS_PATH}`] : []),
        ...tried.map((t) => `  auto: ${t}`),
        '',
        'Set ULTRA_CONTRACTS_PATH in backend/.env or pass --source <path-to-eosio.contracts>.',
    ].join('\n');
    throw new ExtractError(msg);
}

async function main(): Promise<void> {
    const argv = parseArgv(process.argv.slice(2));
    if (argv.contracts.length === 0) {
        throw new ExtractError('Usage: tsx scripts/extract-contract.ts <contract-name>… [--source <root>] [--source-dir <dir>]');
    }

    const mainnetUrl = process.env.MAINNET_URL ?? 'https://ultra.eosusa.io';
    const testnetUrl = process.env.TESTNET_URL ?? 'https://test.ultra.eosusa.io';

    const here = dirname(fileURLToPath(import.meta.url));
    const catalogDir = resolve(here, '..', 'catalog');
    await mkdir(catalogDir, { recursive: true });

    const log = (msg: string): void => {
        console.log(msg);
    };

    const succeeded: string[] = [];
    const failed: { contract: string; reason: string }[] = [];

    for (const contract of argv.contracts) {
        log(`\n[extract] === ${contract} ===`);
        try {
            const resolved = await resolveSource(contract, argv);
            log(`[extract] Source: ${resolved.path} (from ${resolved.reason})`);

            // If --source-dir was used, treat that as the contract dir directly.
            const sourceRoot = argv.sourceDir ?? resolved.path;

            const catalog = await extractContract({
                name: contract,
                sourceRoot,
                mainnetUrl,
                testnetUrl,
                log,
            });

            const unresolvedCount = Object.values(catalog.actions).filter((a) => a.unresolved).length;
            const totalActions = Object.keys(catalog.actions).length;
            log(`[extract] Actions extracted: ${totalActions} (unresolved: ${unresolvedCount})`);

            const outPath = join(catalogDir, `${contract}.json`);
            await writeFile(outPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
            log(`[extract] Wrote ${outPath}`);
            succeeded.push(contract);
        } catch (err: unknown) {
            const reason = err instanceof ExtractError ? err.message : err instanceof Error ? err.message : String(err);
            console.error(`[extract] FAIL ${contract}: ${reason}`);
            if (err instanceof ExtractError && Object.keys(err.context).length > 0) {
                console.error('[extract] Context:', err.context);
            }
            failed.push({ contract, reason });
        }
    }

    // Per-batch summary — useful when the script is invoked with many contracts
    // (e.g. extracting the full ~/ultra/eosio.contracts tree at once).
    if (argv.contracts.length > 1) {
        log(`\n[extract] === summary ===`);
        log(`[extract] OK:   ${succeeded.length} (${succeeded.join(', ') || '-'})`);
        if (failed.length > 0) {
            log(`[extract] FAIL: ${failed.length}`);
            for (const f of failed) log(`  - ${f.contract}: ${f.reason}`);
        }
    }

    // Exit non-zero if any contract failed, so CI / shell-callers can detect
    // regressions. A single-contract run preserves the prior "fail = exit 1"
    // behavior; a batch run only fails if at least one contract failed.
    if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
    if (err instanceof ExtractError) {
        console.error(`\n[extract] ERROR: ${err.message}`);
        if (Object.keys(err.context).length > 0) {
            console.error('[extract] Context:', err.context);
        }
    } else {
        console.error('\n[extract] ERROR:', err);
    }
    process.exit(1);
});
