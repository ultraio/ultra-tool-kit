// `get_action_schema` tool — local catalog read, no RPC.
//
// Source of truth: docs/00-ai-global-guidelines.md §4.2 row 5 ("local
// catalog read ... known contracts only ... one entry"). The LLM uses a
// `null` return to discover an uncatalogued contract — that's the signal
// to call `get_abi` for the ABI fallback path (§4.3 gate 2 second clause).

import { z } from 'zod';

import type { ToolCtx, ToolSpec } from './types.js';

const NAME_RE = /^[a-z][a-z1-5.]{0,11}[a-j1-5]?$/;

const InputSchema = z.object({
    contract: z.string().regex(NAME_RE, 'invalid contract name'),
    action: z.string().regex(NAME_RE, 'invalid action name'),
});

export const getActionSchemaSpec: ToolSpec = {
    name: 'get_action_schema',
    description:
        "Return one catalog action's params/auths/preconditions/recipients/notes, or null if uncatalogued.",
    inputSchema: InputSchema,
    async call(input: unknown, ctx: ToolCtx): Promise<unknown> {
        const { contract, action } = InputSchema.parse(input);
        const entry = ctx.catalog.byKey.get(`${contract}::${action}`);
        if (!entry) return null;
        return entry.rules;
    },
};
