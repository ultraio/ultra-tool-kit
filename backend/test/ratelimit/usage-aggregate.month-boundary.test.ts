// usage-aggregate — UTC calendar-month boundary (W1.5-redo).
//
// Validates that readMonthlyAggregate selects rows whose `ts` parses to a
// Date in the current UTC calendar month relative to `opts.now`. A row with
// `ts: "2026-04-30T23:59:59Z"` MUST NOT count toward May's bucket — the
// predicate compares parsed Date.getUTCFullYear/getUTCMonth, not a
// string-prefix match.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { readMonthlyAggregate } from '../../src/ratelimit/usage-aggregate.js';

let tmpPath: string;

beforeEach(() => {
    tmpPath = join(tmpdir(), `usage-month-${randomUUID()}.jsonl`);
});

afterEach(async () => {
    await rm(tmpPath, { force: true });
});

async function writeJsonl(rows: Array<Record<string, unknown>>): Promise<void> {
    await mkdir(dirname(tmpPath), { recursive: true });
    const lines = rows.map((r) => JSON.stringify(r));
    await writeFile(tmpPath, lines.join('\n') + '\n', 'utf8');
}

describe('readMonthlyAggregate — UTC month-boundary predicate', () => {
    it('returns zero when the log file is missing', () => {
        const agg = readMonthlyAggregate({ now: new Date('2026-05-15T12:00:00Z'), logPath: tmpPath });
        expect(agg).toEqual({ costUsdGlobal: 0 });
    });

    it('counts only May rows when now is mid-May', async () => {
        await writeJsonl([
            // April row — must NOT count for May.
            { ts: '2026-04-30T23:59:00.000Z', cost_usd: 1 },
            // Edge: very start of May — counts.
            { ts: '2026-05-01T00:01:00.000Z', cost_usd: 2 },
            // Mid-May — counts.
            { ts: '2026-05-15T12:00:00.000Z', cost_usd: 4 },
            // Edge: April 30 23:59:59Z — must NOT count.
            { ts: '2026-04-30T23:59:59.000Z', cost_usd: 8 },
            // Date-only `ts` parses as UTC midnight per ECMAScript spec
            // (§20.4.1.15) — counts for May, documents that contract.
            { ts: '2026-05-20', cost_usd: 16 },
        ]);

        const agg = readMonthlyAggregate({
            now: new Date('2026-05-15T13:00:00Z'),
            logPath: tmpPath,
        });
        expect(agg.costUsdGlobal).toBe(2 + 4 + 16); // = 22, April rows excluded
    });

    it('counts only April rows when now is end-April (boundary inverse)', async () => {
        await writeJsonl([
            { ts: '2026-04-30T22:00:00.000Z', cost_usd: 7 },
            { ts: '2026-05-01T00:00:00.000Z', cost_usd: 99 }, // next month — exclude
            { ts: '2026-04-01T00:00:00.000Z', cost_usd: 1 }, // beginning April
        ]);
        const agg = readMonthlyAggregate({
            now: new Date('2026-04-30T22:00:00Z'),
            logPath: tmpPath,
        });
        expect(agg.costUsdGlobal).toBe(7 + 1);
    });

    it('skips rows with malformed/missing ts and bad cost_usd values', async () => {
        await writeJsonl([
            { ts: '2026-05-10T00:00:00.000Z', cost_usd: 3 },
            { ts: 'not-a-date', cost_usd: 100 },
            { cost_usd: 99 }, // missing ts
            { ts: '2026-05-11T00:00:00.000Z', cost_usd: 'not-a-number' },
            { ts: '2026-05-12T00:00:00.000Z', cost_usd: 4 },
        ]);
        const agg = readMonthlyAggregate({
            now: new Date('2026-05-15T12:00:00Z'),
            logPath: tmpPath,
        });
        expect(agg.costUsdGlobal).toBe(7);
    });

    it('uses UTC, not local time — a row at 2026-04-30T23:30:00Z is April even from a UTC+3 perspective', async () => {
        // The string "2026-04-30T23:30:00Z" parses to a Date whose UTCMonth = 3
        // (April). A naive local-time check could mis-classify it as May.
        await writeJsonl([
            { ts: '2026-04-30T23:30:00.000Z', cost_usd: 5 },
            { ts: '2026-05-01T00:30:00.000Z', cost_usd: 10 },
        ]);
        const may = readMonthlyAggregate({ now: new Date('2026-05-01T01:00:00Z'), logPath: tmpPath });
        expect(may.costUsdGlobal).toBe(10);
        const april = readMonthlyAggregate({ now: new Date('2026-04-30T23:00:00Z'), logPath: tmpPath });
        expect(april.costUsdGlobal).toBe(5);
    });
});
