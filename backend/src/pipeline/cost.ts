// Pricing table + cost computation + usage logging.
// Source of truth: docs/02-cost-and-ops.md §3.3.
//
// projectedUsd is recomputed in ai-usage; storing only actual_usd here.

import type { Db } from '../db/client.js';
import { usageLog } from '../db/schema.js';

export const PRICING = {
    'claude-haiku-4-5-20251001': {
        input: 1.0 / 1_000_000,
        output: 5.0 / 1_000_000,
        cache_read: 0.1 / 1_000_000,
        cache_write: 1.25 / 1_000_000,
    },
    'gpt-4o-mini': {
        input: 0.15 / 1_000_000,
        output: 0.6 / 1_000_000,
    },
    'text-embedding-3-small': {
        input: 0.02 / 1_000_000,
    },
} as const;

export type Usage = {
    input: number;
    output: number;
    cached?: number;
};

type RateRow = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
};

// Model used to project a notional USD cost for free local providers (Ollama),
// so the usage UI shows what the same workload would have cost on a paid model.
const PROJECTED_COMPARATOR_RATES = PRICING['claude-haiku-4-5-20251001'];

function stripProvider(modelTag: string): { provider: string; model: string } {
    const idx = modelTag.indexOf(':');
    if (idx === -1) return { provider: '', model: modelTag };
    return { provider: modelTag.slice(0, idx), model: modelTag.slice(idx + 1) };
}

function applyRates(rates: RateRow, usage: Usage): number {
    const inputRate = rates.input ?? 0;
    const outputRate = rates.output ?? 0;
    const cachedRate = rates.cache_read ?? 0;
    const input = usage.input * inputRate;
    const output = usage.output * outputRate;
    const cached = (usage.cached ?? 0) * cachedRate;
    return input + output + cached;
}

export function computeCost(modelTag: string, usage: Usage): { actualUsd: number; projectedUsd: number } {
    const { provider, model } = stripProvider(modelTag);

    if (provider === 'ollama') {
        const projected = applyRates(PROJECTED_COMPARATOR_RATES, usage);
        return { actualUsd: 0, projectedUsd: projected };
    }

    const rates = (PRICING as Record<string, RateRow>)[model];
    if (!rates) {
        return { actualUsd: 0, projectedUsd: 0 };
    }
    const cost = applyRates(rates, usage);
    return { actualUsd: cost, projectedUsd: cost };
}

export type RecordUsageDeps = { db: Db };

export type RecordUsageRow = {
    sessionId: string | null;
    userId: string | null;
    modelTag: string;
    usage: Usage;
    requestKind: 'chat' | 'embed' | 'classify';
};

export async function recordUsage(deps: RecordUsageDeps, row: RecordUsageRow): Promise<void> {
    const { actualUsd } = computeCost(row.modelTag, row.usage);
    await deps.db.insert(usageLog).values({
        sessionId: row.sessionId,
        userId: row.userId,
        model: row.modelTag,
        inputTokens: row.usage.input,
        outputTokens: row.usage.output,
        cacheRead: row.usage.cached ?? 0,
        cacheWrite: 0,
        costUsd: actualUsd.toFixed(8),
        requestKind: row.requestKind,
    });
}
