// Shared tool types + typed errors.
//
// Lives in its own file so the individual tool spec modules don't have to
// import from ./index.js (which would close a circular import — the
// dispatcher index.ts imports each spec module at the top of the file).
// Source of truth: docs/00-ai-global-guidelines.md §4.2 + §4.7.

import type { ZodTypeAny } from 'zod';

import type { CatalogIndex } from '../catalog.js';

export type ToolName =
    | 'get_account'
    | 'get_balance'
    | 'get_abi'
    | 'get_table_rows'
    | 'get_action_schema';

export type ToolCtx = {
    endpoint: string;
    allowlist: readonly string[];
    catalog: CatalogIndex;
    fetchImpl?: typeof globalThis.fetch;
};

export type ToolSpec = {
    name: ToolName;
    description: string;
    inputSchema: ZodTypeAny;
    call(input: unknown, ctx: ToolCtx): Promise<unknown>;
};

export type ToolAuditEntry = {
    name: ToolName;
    input: unknown;
    status: 'ok' | 'error';
    durMs: number;
    error?: string;
};

export type DispatchResult = { payload: unknown; audit: ToolAuditEntry };

export class BudgetError extends Error {
    public override readonly name = 'BudgetError';
    public readonly reason: 'tool-budget' | 'tool-budget-session';
    constructor(reason: 'tool-budget' | 'tool-budget-session') {
        super(`tool budget exceeded: ${reason}`);
        this.reason = reason;
    }
}

export class UnknownToolError extends Error {
    public override readonly name = 'UnknownToolError';
    public readonly toolName: string;
    constructor(toolName: string) {
        super(`unknown tool: ${toolName}`);
        this.toolName = toolName;
    }
}

export class EndpointRejectedError extends Error {
    public override readonly name = 'EndpointRejectedError';
    public readonly endpoint: string;
    constructor(endpoint: string) {
        super(`endpoint rejected by host allowlist: ${endpoint}`);
        this.endpoint = endpoint;
    }
}

export class UnknownTableError extends Error {
    public override readonly name = 'UnknownTableError';
    public readonly code: string;
    public readonly table: string;
    constructor(code: string, table: string) {
        super(`table (${code}, ${table}) not in §4.2 allowlist`);
        this.code = code;
        this.table = table;
    }
}
