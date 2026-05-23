// Read-only RPC tool dispatcher.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 (allowlist of five
// tools; "Tool dispatcher rejects unknown tool names — no dynamic dispatch")
// and §4.7 (per-turn / per-session tool budget). Roadmap §6 row W4.
//
// Hard rules:
//   - TOOL_REGISTRY has EXACTLY 5 entries. Adding a sixth is a docs PR.
//   - Unknown tool name → throw UnknownToolError (no fuzzy match, no log+continue).
//   - dispatch() never throws from a spec's call(); spec errors are wrapped
//     in an audit entry with status: 'error'. The audit's `error` field
//     carries the message only — no stack, no response body (the W8 logger
//     writes names only per backend/CLAUDE.md).
//   - dispatch() does NOT re-parse the input; each spec owns its Zod schema.
//
// Types + typed errors live in ./types.ts so the spec modules can import
// them without closing a circular import on this file.

import { getAbiSpec } from './get_abi.js';
import { getAccountSpec } from './get_account.js';
import { getActionSchemaSpec } from './get_action_schema.js';
import { getBalanceSpec } from './get_balance.js';
import { getTableRowsSpec } from './get_table_rows.js';
import {
    BudgetError,
    UnknownToolError,
    type DispatchResult,
    type ToolCtx,
    type ToolName,
    type ToolSpec,
} from './types.js';

export {
    BudgetError,
    EchoedTokenRequiredError,
    EndpointRejectedError,
    UnknownTableError,
    UnknownToolError,
    type DispatchResult,
    type ToolAuditEntry,
    type ToolCtx,
    type ToolName,
    type ToolSpec,
} from './types.js';

export const TOOL_REGISTRY: Record<ToolName, ToolSpec> = {
    get_account: getAccountSpec,
    get_balance: getBalanceSpec,
    get_abi: getAbiSpec,
    get_table_rows: getTableRowsSpec,
    get_action_schema: getActionSchemaSpec,
};

// Inclusive ceilings per §4.2 ("max 3 tool calls per LLM turn, max 6 across
// a session"). The "4th call this turn" semantic is enforced by checking
// `usedThisTurn >= perTurn` BEFORE the next call.
export function enforceBudget(
    usedThisTurn: number,
    usedThisSession: number,
    perTurn = 3,
    perSession = 6
): void {
    if (usedThisTurn >= perTurn) throw new BudgetError('tool-budget');
    if (usedThisSession >= perSession) throw new BudgetError('tool-budget-session');
}

function isToolName(name: string): name is ToolName {
    return Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name);
}

export async function dispatch(
    name: string,
    input: unknown,
    ctx: ToolCtx
): Promise<DispatchResult> {
    if (!isToolName(name)) {
        // Hard-fail per §4.2: no fuzzy match, no log-and-continue. The chat
        // route catches this and surfaces a refuse.
        throw new UnknownToolError(name);
    }
    const spec = TOOL_REGISTRY[name];
    const start = performance.now();
    try {
        const payload = await spec.call(input, ctx);
        return {
            payload,
            audit: {
                name,
                input,
                status: 'ok',
                durMs: performance.now() - start,
            },
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            // Payload on error is null — the caller branches on audit.status.
            payload: null,
            audit: {
                name,
                input,
                status: 'error',
                durMs: performance.now() - start,
                // One-line message only. Stack + response body are NEVER
                // included here (backend/CLAUDE.md hard rule 4 — logs do not
                // carry tool response bodies).
                error: message.split('\n')[0] ?? message,
            },
        };
    }
}
