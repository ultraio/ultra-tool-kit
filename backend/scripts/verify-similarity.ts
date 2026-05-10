#!/usr/bin/env -S tsx
// Manual verification: after running `npm run ingest` against the live eosio.token
// catalog with a real embed provider (Ollama or OpenAI), this script embeds a
// natural-language query and prints the top-K matching action chunks. The
// acceptance criterion is that `eosio.token::transfer` appears in the top 3.
//
// Usage:
//   LLM_PROVIDER=ollama EMBED_PROVIDER=ollama npm --prefix backend run verify:similarity
//   LLM_PROVIDER=ollama npm --prefix backend run verify:similarity -- "send 100 UOS to acc2"

import 'dotenv/config';
import { closeDb, getSql } from '../src/db/client.js';
import { getProvider } from '../src/llm/router.js';

const DEFAULT_QUERY = 'send 100 UOS to acc2';
const TOP_K = 5;

async function main(): Promise<void> {
    const query = process.argv.slice(2).join(' ').trim() || DEFAULT_QUERY;
    const embed = getProvider('embed');
    const dim = embed.vectorDim();
    const result = await embed.embed(query);
    const literal = `[${result.vector.join(',')}]`;
    const column = dim === 768 ? 'embedding_768' : 'embedding_1536';

    const sql = getSql();
    const rows = await sql<
        Array<{ contract: string; action: string; kind: string; distance: number }>
    >`
        select c.account as contract,
               a.name    as action,
               ac.kind   as kind,
               ac.${sql(column)} <=> ${literal}::vector as distance
        from action_chunks ac
        join actions a    on a.id = ac.action_id
        join contracts c  on c.id = a.contract_id
        where a.unresolved = false
        order by ac.${sql(column)} <=> ${literal}::vector
        limit ${TOP_K};
    `;

    console.log(`Query: "${query}"`);
    console.log(`Provider: ${embed.modelTag()} (dim=${dim})`);
    console.log(`Top ${TOP_K}:`);
    for (const r of rows) {
        console.log(`  ${r.distance.toFixed(4)}  ${r.contract}::${r.action} [${r.kind}]`);
    }
    const top3 = rows.slice(0, 3).map((r) => `${r.contract}::${r.action}`);
    const found = top3.includes('eosio.token::transfer');
    console.log(found ? '\n✓ eosio.token::transfer is in the top 3' : '\n✗ eosio.token::transfer is NOT in the top 3');
    await closeDb();
    process.exit(found ? 0 : 1);
}

main().catch(async (err: unknown) => {
    console.error('verify:similarity fatal:', err);
    await closeDb();
    process.exit(1);
});
