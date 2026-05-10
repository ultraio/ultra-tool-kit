// GET /api/ai-usage — aggregates the caller's usage_log rows. projectedUsd is
// recomputed at read time via computeCost() so historical rows reflect the
// current PRICING table (per docs/02-cost-and-ops.md).

import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { usageLog } from '../db/schema.js';
import { computeCost } from '../pipeline/cost.js';

type CallTotals = { calls: number; actualUsd: number; projectedUsd: number };

type UsagePerModel = CallTotals & {
    modelTag: string;
    inputTokens: number;
    outputTokens: number;
};

type UsageResponse = {
    lifetime: CallTotals;
    today: CallTotals;
    lastRequest: { at: string; modelTag: string; actualUsd: number; projectedUsd: number } | null;
    perModel: UsagePerModel[];
};

function startOfUtcDay(now = new Date()): number {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

// Drizzle's pg `timestamp` column maps to a JS `Date` on read. No defensive
// string-coercion needed.
function asMs(v: Date): number {
    return v.getTime();
}

const app = new Hono();

app.get('/', async (c) => {
    const userId = c.get('userId');
    const db = getDb();

    const rows = await db
        .select({
            model: usageLog.model,
            inputTokens: usageLog.inputTokens,
            outputTokens: usageLog.outputTokens,
            cacheRead: usageLog.cacheRead,
            createdAt: usageLog.createdAt,
        })
        .from(usageLog)
        .where(eq(usageLog.userId, userId))
        .orderBy(desc(usageLog.createdAt));

    const todayCutoff = startOfUtcDay();
    const lifetime: CallTotals = { calls: 0, actualUsd: 0, projectedUsd: 0 };
    const today: CallTotals = { calls: 0, actualUsd: 0, projectedUsd: 0 };
    const perModelMap = new Map<string, UsagePerModel>();
    let lastRequest: UsageResponse['lastRequest'] = null;

    for (const r of rows) {
        const modelTag = r.model ?? 'unknown';
        const usage = {
            input: r.inputTokens ?? 0,
            output: r.outputTokens ?? 0,
            cached: r.cacheRead ?? 0,
        };
        const { actualUsd, projectedUsd } = computeCost(modelTag, usage);

        lifetime.calls += 1;
        lifetime.actualUsd += actualUsd;
        lifetime.projectedUsd += projectedUsd;

        if (asMs(r.createdAt) >= todayCutoff) {
            today.calls += 1;
            today.actualUsd += actualUsd;
            today.projectedUsd += projectedUsd;
        }

        const existing = perModelMap.get(modelTag);
        if (existing) {
            existing.calls += 1;
            existing.inputTokens += usage.input;
            existing.outputTokens += usage.output;
            existing.actualUsd += actualUsd;
            existing.projectedUsd += projectedUsd;
        } else {
            perModelMap.set(modelTag, {
                modelTag,
                calls: 1,
                inputTokens: usage.input,
                outputTokens: usage.output,
                actualUsd,
                projectedUsd,
            });
        }

        if (!lastRequest) {
            lastRequest = {
                at: r.createdAt.toISOString(),
                modelTag,
                actualUsd,
                projectedUsd,
            };
        }
    }

    const body: UsageResponse = {
        lifetime,
        today,
        lastRequest,
        perModel: Array.from(perModelMap.values()),
    };
    return c.json(body);
});

export default app;
