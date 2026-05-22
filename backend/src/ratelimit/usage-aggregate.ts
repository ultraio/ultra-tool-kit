// Read-only daily aggregate of logs/usage.jsonl for tier 5 (per-pubkey
// budget) and tier 6 (global $50 cap) rate-limit checks.
//
// W8 owns the write path (guidelines §7); this module ONLY reads. If the
// file is missing — common during local dev and in CI — we treat the
// aggregate as zero per W1.5 prompt ("if the file is missing, treat tier
// 5/6 consumed = $0").
//
// Wrapped at this boundary so middleware/ratelimit.ts can be unit-tested
// via `vi.mock` without touching real fs.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type DailyAggregate = {
    tokensIn: number; // total input tokens billed to `sub` today (UTC)
    tokensOut: number;
    costUsdSub: number; // cumulative cost (USD) billed to `sub` today
    costUsdGlobal: number; // cumulative cost (USD) across all subs today
};

const ZERO: DailyAggregate = { tokensIn: 0, tokensOut: 0, costUsdSub: 0, costUsdGlobal: 0 };

export type ReadUsageOpts = {
    sub: string;
    now?: Date;
    logPath?: string;
};

function utcDayPrefix(d: Date): string {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function defaultUsageLogPath(): string {
    return path.resolve(process.cwd(), 'logs/usage.jsonl');
}

// Each row matches guidelines §7. We read just the four fields we care about
// (`ts`, `sub`, `tokens_in`, `tokens_out`, `cost_usd`); unknown rows / bad
// JSON / malformed numbers are skipped — the log file is append-only and a
// partial line during rotation is normal.
export function readDailyAggregate(opts: ReadUsageOpts): DailyAggregate {
    const logPath = opts.logPath ?? defaultUsageLogPath();
    if (!existsSync(logPath)) return ZERO;

    let raw: string;
    try {
        raw = readFileSync(logPath, 'utf8');
    } catch {
        return ZERO;
    }

    const today = utcDayPrefix(opts.now ?? new Date());
    let tokensIn = 0;
    let tokensOut = 0;
    let costUsdSub = 0;
    let costUsdGlobal = 0;

    for (const line of raw.split('\n')) {
        if (!line) continue;
        let row: Record<string, unknown>;
        try {
            row = JSON.parse(line) as Record<string, unknown>;
        } catch {
            continue;
        }
        const ts = row.ts;
        if (typeof ts !== 'string' || !ts.startsWith(today)) continue;

        const cost = typeof row.cost_usd === 'number' ? row.cost_usd : 0;
        costUsdGlobal += cost;

        if (row.sub === opts.sub) {
            tokensIn += typeof row.tokens_in === 'number' ? row.tokens_in : 0;
            tokensOut += typeof row.tokens_out === 'number' ? row.tokens_out : 0;
            costUsdSub += cost;
        }
    }

    return { tokensIn, tokensOut, costUsdSub, costUsdGlobal };
}
