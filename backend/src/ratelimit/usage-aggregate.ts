// Read-only monthly aggregate of logs/usage.jsonl for tier 5 (global $50/month
// cap) rate-limit check. Single field returned (`costUsdGlobal`) — the
// per-sub & token-bucket fields were dropped in W1.5-redo per docs/00 §3.
//
// W8 owns the write path (guidelines §7); this module ONLY reads. If the
// file is missing — common during local dev and in CI — we treat the
// aggregate as zero per the W1.5-redo design ("file missing → consumed = $0").
//
// Wrapped at this boundary so middleware/ratelimit.ts can be unit-tested
// via `vi.mock` without touching real fs. File may be a month of rows; v1
// reads whole file as single-instance per roadmap §9. A future Redis-backed
// aggregate is out of scope.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type MonthlyAggregate = {
    costUsdGlobal: number; // cumulative cost (USD) across all rows this UTC calendar month
};

const ZERO: MonthlyAggregate = { costUsdGlobal: 0 };

export type ReadUsageOpts = {
    now?: Date;
    logPath?: string;
};

function defaultUsageLogPath(): string {
    return path.resolve(process.cwd(), 'logs/usage.jsonl');
}

// Predicate: ts parses to a Date whose UTCFullYear + UTCMonth match the
// reference (`opts.now`). String-prefix comparison would mis-classify rows
// whose ts straddles a month boundary in local time — parsed-Date comparison
// is the load-bearing correctness check (a row at "2026-04-30T23:59:59Z"
// must NOT count toward May's bucket).
function sameUtcMonth(rowTs: string, ref: Date): boolean {
    const d = new Date(rowTs);
    if (Number.isNaN(d.getTime())) return false;
    return d.getUTCFullYear() === ref.getUTCFullYear() && d.getUTCMonth() === ref.getUTCMonth();
}

export function readMonthlyAggregate(opts: ReadUsageOpts = {}): MonthlyAggregate {
    const logPath = opts.logPath ?? defaultUsageLogPath();
    if (!existsSync(logPath)) return ZERO;

    let raw: string;
    try {
        raw = readFileSync(logPath, 'utf8');
    } catch {
        return ZERO;
    }

    const ref = opts.now ?? new Date();
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
        if (typeof ts !== 'string' || !sameUtcMonth(ts, ref)) continue;
        const cost = typeof row.cost_usd === 'number' ? row.cost_usd : 0;
        costUsdGlobal += cost;
    }

    return { costUsdGlobal };
}
