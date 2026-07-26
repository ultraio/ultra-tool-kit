import { describe, expect, it } from 'vitest';
import { InMemoryUsageStore } from '../../src/usage/store.js';

describe('InMemoryUsageStore', () => {
    it('accumulates daily spend per key and returns the new total', () => {
        const s = new InMemoryUsageStore();
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-09')).toBe(0);
        expect(s.addSpentMicroUsd('acct:alice', '2026-06-09', 500)).toBe(500);
        expect(s.addSpentMicroUsd('acct:alice', '2026-06-09', 250)).toBe(750);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-09')).toBe(750);
    });

    it('resets the daily counter when the day rolls over', () => {
        const s = new InMemoryUsageStore();
        s.addSpentMicroUsd('acct:alice', '2026-06-09', 900);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-10')).toBe(0);
        s.addSpentMicroUsd('acct:alice', '2026-06-10', 100);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-10')).toBe(100);
    });

    it('isolates keys from each other', () => {
        const s = new InMemoryUsageStore();
        s.addSpentMicroUsd('acct:alice', '2026-06-09', 500);
        s.addSpentMicroUsd('ip:deadbeef', '2026-06-09', 300);
        expect(s.getSpentMicroUsd('acct:alice', '2026-06-09')).toBe(500);
        expect(s.getSpentMicroUsd('ip:deadbeef', '2026-06-09')).toBe(300);
    });

    it('tracks per-session totals independently of the daily counter', () => {
        const s = new InMemoryUsageStore();
        expect(s.getSessionMicroUsd('sess-1')).toBe(0);
        expect(s.addSessionMicroUsd('sess-1', 400)).toBe(400);
        expect(s.addSessionMicroUsd('sess-1', 100)).toBe(500);
        expect(s.getSessionMicroUsd('sess-2')).toBe(0);
    });

    it('bounds the session map: oldest session is evicted once over the cap (spec §5.1)', () => {
        const s = new InMemoryUsageStore({ maxSessions: 2 });
        s.addSessionMicroUsd('s1', 100);
        s.addSessionMicroUsd('s2', 200);
        s.addSessionMicroUsd('s3', 300); // a 3rd new session evicts s1 (insertion order)
        expect(s.getSessionMicroUsd('s1')).toBe(0);
        expect(s.getSessionMicroUsd('s2')).toBe(200);
        expect(s.getSessionMicroUsd('s3')).toBe(300);
    });

    it('prunes stale-day daily entries once over the key cap', () => {
        const s = new InMemoryUsageStore({ maxDailyKeys: 2 });
        s.addSpentMicroUsd('ip:a', '2026-06-09', 1);
        s.addSpentMicroUsd('ip:b', '2026-06-09', 1);
        s.addSpentMicroUsd('ip:c', '2026-06-10', 1); // over cap → drops the 06-09 keys
        expect(s.getSpentMicroUsd('ip:c', '2026-06-10')).toBe(1);
        expect(s.getSpentMicroUsd('ip:a', '2026-06-09')).toBe(0);
    });
});
