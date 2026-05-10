import { describe, expect, it } from 'vitest';
import { buildPrompt, proposalSchema, type PromptContext } from '../../src/pipeline/prompt.js';
import type { RetrievedAction } from '../../src/pipeline/retrieve.js';
import type { ActionRules } from '../../src/extractor/types.js';
import { z } from 'zod';

const transferRules: ActionRules = {
    contract: 'eosio.token',
    action: 'transfer',
    params: [
        { name: 'from', type: 'name' },
        { name: 'to', type: 'name' },
        { name: 'quantity', type: 'asset' },
        { name: 'memo', type: 'string' },
    ],
    auths: [{ actor: '$from', permission: 'active' }],
    preconditions: [],
    field_constraints: {},
    recipients: [],
    source: { path: 'src/eosio.token.cpp', lines: [10, 30] },
};

function makeRetrieved(rules: ActionRules): RetrievedAction {
    return {
        actionId: 1n,
        contract: rules.contract,
        action: rules.action,
        rules,
        fields: rules.params,
        defaultAuth: rules.auths[0] ?? null,
        isAdmin: false,
        description: null,
        examples: null,
        bestDistance: 0.1,
    };
}

const baseContext: PromptContext = {
    account: 'alice',
    permission: 'active',
    endpoint: 'https://example.test',
    chainId: 'aabbcc1122',
    isAdmin: false,
    knownAccounts: ['alice', 'bob', 'carol'],
};

describe('buildPrompt', () => {
    it('substitutes context variables and the catalog block into the system template', async () => {
        const retrieved = [makeRetrieved(transferRules)];
        const result = await buildPrompt({ retrieved, context: baseContext, conversation: [] });

        expect(result.system).toContain('alice@active');
        expect(result.system).toContain('aabbcc1122');
        expect(result.system).toContain('alice, bob, carol');
        // Catalog block from renderRulesChunk:
        expect(result.system).toContain('eosio.token::transfer');
    });

    it('keeps only the last 6 turns in the user prompt, with the most recent turn at the end', async () => {
        const retrieved = [makeRetrieved(transferRules)];
        const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        for (let i = 0; i < 5; i++) {
            conversation.push({ role: 'user', content: `user-msg-${i}` });
            conversation.push({ role: 'assistant', content: `assistant-msg-${i}` });
        }
        // 10 turns total; last 6 should be turns 4..9 (user-msg-2, assistant-msg-2, ... user-msg-4, assistant-msg-4).
        const result = await buildPrompt({ retrieved, context: baseContext, conversation });

        const lines = result.user.split('\n');
        expect(lines).toHaveLength(6);
        const userCount = lines.filter((l) => l.startsWith('user:')).length;
        const assistantCount = lines.filter((l) => l.startsWith('assistant:')).length;
        expect(userCount).toBe(3);
        expect(assistantCount).toBe(3);

        // Earliest turns dropped.
        expect(result.user).not.toContain('user-msg-0');
        expect(result.user).not.toContain('user-msg-1');
        // Tail preserved.
        expect(result.user).toContain('user-msg-4');
        expect(result.user).toContain('assistant-msg-4');
        // Most recent turn is at the very end.
        expect(lines[lines.length - 1]).toBe('assistant: assistant-msg-4');
    });

    it('truncates the catalog to the cap, keeping the first candidate and dropping the last', async () => {
        // Build candidates whose rendered text is well over 3 KB so the cap kicks in.
        const bigNotes = 'x'.repeat(1500);
        const candidates: RetrievedAction[] = [];
        for (let i = 0; i < 5; i++) {
            const rules: ActionRules = {
                ...transferRules,
                action: `action${i}`,
                notes: bigNotes,
            };
            candidates.push(makeRetrieved(rules));
        }

        const result = await buildPrompt({ retrieved: candidates, context: baseContext, conversation: [] });

        // First candidate must survive (catalog always keeps at least one block).
        expect(result.system).toContain('eosio.token::action0');
        // Last candidate must have been dropped by the cap.
        expect(result.system).not.toContain('eosio.token::action4');

        // Catalog block lives under the "Catalog (top N candidates):" header. Slice it out
        // and check the size constraint with modest slack for the separator.
        const marker = 'Catalog (top 5 candidates):\n';
        const idx = result.system.indexOf(marker);
        expect(idx).toBeGreaterThan(-1);
        const catalogBlock = result.system.slice(idx + marker.length);
        expect(catalogBlock.length).toBeLessThanOrEqual(3500);
    });

    it('produces a tool schema containing the three discriminator kinds', async () => {
        const result = await buildPrompt({
            retrieved: [makeRetrieved(transferRules)],
            context: baseContext,
            conversation: [],
        });

        // Sanity: schema is a JSON object.
        expect(typeof result.toolSchema).toBe('object');
        const stringified = JSON.stringify(result.toolSchema);
        expect(stringified).toContain('"ask"');
        expect(stringified).toContain('"propose"');
        expect(stringified).toContain('"refuse"');

        // Direct check: round-trip the schema source so the test still catches a regression
        // even if the JSON-schema layout changes.
        const directSchema = z.toJSONSchema(proposalSchema);
        const directStr = JSON.stringify(directSchema);
        expect(directStr).toContain('"ask"');
        expect(directStr).toContain('"propose"');
        expect(directStr).toContain('"refuse"');
    });
});
