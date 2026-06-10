// Per-identity daily + per-session spend counters, in micro-USD (docs/00 §3.8).
// In-memory only: process-lifetime, single-instance v1 (roadmap decision 1, §9).
// The interface is the seam a future Redis-backed impl drops into without
// touching the gate.
//
// Both maps are BOUNDED (spec §5.1 "bounded LRU-ish") — sessionId and the ip:
// key are attacker-influenced, so unbounded maps would be a memory-growth
// vector. Sessions evict oldest-inserted past maxSessions; the daily map drops
// stale-day entries past maxDailyKeys.

export interface UsageStore {
    getSpentMicroUsd(key: string, dayUtc: string): number;
    addSpentMicroUsd(key: string, dayUtc: string, deltaMicroUsd: number): number;
    getSessionMicroUsd(sessionId: string): number;
    addSessionMicroUsd(sessionId: string, deltaMicroUsd: number): number;
}

type DayEntry = { day: string; micro: number };

export type UsageStoreOpts = {
    maxSessions?: number; // default 10_000
    maxDailyKeys?: number; // default 50_000
};

export class InMemoryUsageStore implements UsageStore {
    // identity key → {day, micro}. A single slot per key: when the stored day
    // differs from the queried day the slot is treated as empty (lazy rollover).
    private daily = new Map<string, DayEntry>();
    private sessions = new Map<string, number>();
    private maxSessions: number;
    private maxDailyKeys: number;

    constructor(opts: UsageStoreOpts = {}) {
        this.maxSessions = opts.maxSessions ?? 10_000;
        this.maxDailyKeys = opts.maxDailyKeys ?? 50_000;
    }

    getSpentMicroUsd(key: string, dayUtc: string): number {
        const e = this.daily.get(key);
        return e && e.day === dayUtc ? e.micro : 0;
    }

    addSpentMicroUsd(key: string, dayUtc: string, deltaMicroUsd: number): number {
        const e = this.daily.get(key);
        const base = e && e.day === dayUtc ? e.micro : 0;
        const micro = base + deltaMicroUsd;
        this.daily.set(key, { day: dayUtc, micro });
        if (this.daily.size > this.maxDailyKeys) {
            // Stale-day entries are dead weight after rollover — sweep them.
            for (const [k, v] of this.daily) {
                if (v.day !== dayUtc) this.daily.delete(k);
            }
        }
        return micro;
    }

    getSessionMicroUsd(sessionId: string): number {
        return this.sessions.get(sessionId) ?? 0;
    }

    addSessionMicroUsd(sessionId: string, deltaMicroUsd: number): number {
        const micro = (this.sessions.get(sessionId) ?? 0) + deltaMicroUsd;
        if (!this.sessions.has(sessionId) && this.sessions.size >= this.maxSessions) {
            const oldest = this.sessions.keys().next().value;
            if (oldest !== undefined) this.sessions.delete(oldest);
        }
        this.sessions.set(sessionId, micro);
        return micro;
    }
}
