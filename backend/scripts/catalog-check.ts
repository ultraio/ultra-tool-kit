#!/usr/bin/env -S tsx
import 'dotenv/config';
import { closeDb, getDb } from '../src/db/client.js';
import { contracts } from '../src/db/schema.js';
import { fetchAbiWithFallback, hashAbi } from '../src/extractor/abi.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
    const mainnetUrl = process.env.MAINNET_URL ?? 'https://ultra.eosusa.io';
    const testnetUrl = process.env.TESTNET_URL ?? 'https://test.ultra.eosusa.io';

    const rows = await getDb().select().from(contracts);
    if (rows.length === 0) {
        console.log('catalog-check: no contracts in DB');
        await closeDb();
        return;
    }

    let driftCount = 0;
    for (const row of rows) {
        try {
            const result = await fetchAbiWithFallback(row.account, mainnetUrl, testnetUrl);
            const liveHash = hashAbi(result.abi);
            const stored = row.abiHash ?? '';
            const fetchedAt = row.abiFetchedAt?.getTime() ?? 0;
            const stale = fetchedAt > 0 && Date.now() - fetchedAt > SEVEN_DAYS_MS;
            if (liveHash !== stored) {
                driftCount++;
                console.log(`✗ ${row.account} — drift detected`);
                console.log(`    stored: ${stored}`);
                console.log(`    live  : ${liveHash}`);
            } else if (stale) {
                console.log(`⚠ ${row.account} — hash matches but fetched at ${row.abiFetchedAt?.toISOString()}`);
            } else {
                console.log(`✓ ${row.account}`);
            }
        } catch (err) {
            driftCount++;
            console.log(`✗ ${row.account} — fetch failed: ${(err as Error).message}`);
        }
    }
    await closeDb();
    process.exit(driftCount === 0 ? 0 : 1);
}

main().catch(async (err: unknown) => {
    console.error('catalog-check: fatal', err);
    await closeDb();
    process.exit(1);
});
