import type { ActionRules } from '../extractor/types.js';
import type { EosioTypeRules, EosioTypesFile } from '../extractor/eosio-types.js';

function renderTypeRules(rules: EosioTypeRules): string {
    const lines = [`  ${rules.description}`];
    if (rules.pattern) lines.push(`    pattern: ${rules.pattern}`);
    for (const c of rules.constraints) lines.push(`    - ${c}`);
    return lines.join('\n');
}

// Translate extractor placeholders into prose. The C++-source extractor records
// `$from`, `$to`, etc. for actor references that map to action params, and
// `"acc"_n` for hard-coded accounts. Showing the raw placeholder confuses small
// instruct models (qwen / llama at 7B-14B occasionally produce `{"$from": true}`
// in the data block when they see `$from` in the auth/recipients lines).
function explainActor(actor: string): string {
    if (actor.startsWith('$')) {
        const fieldName = actor.slice(1);
        return `the account in data.${fieldName}`;
    }
    const literal = actor.match(/^"([^"]+)"_n$/);
    if (literal && literal[1]) return `${literal[1]} (literal account)`;
    return actor;
}

export function renderRulesChunk(rules: ActionRules, types: EosioTypesFile): string {
    const lines: string[] = [];
    lines.push(`Action: ${rules.contract}::${rules.action}`);

    if (rules.auths.length > 0) {
        lines.push('Authorizations (signers required for this action):');
        for (const a of rules.auths) lines.push(`  - ${explainActor(a.actor)} signing with ${a.permission} permission`);
    } else {
        lines.push('Authorizations: (unresolved — no require_auth captured)');
    }

    if (rules.preconditions.length > 0) {
        lines.push('Preconditions:');
        for (const p of rules.preconditions) lines.push(`  - [${p.kind}] ${p.expr} — ${p.message}`);
    }

    const fieldKeys = Object.keys(rules.field_constraints);
    if (fieldKeys.length > 0) {
        lines.push('Field constraints:');
        for (const k of fieldKeys) {
            for (const fc of rules.field_constraints[k] ?? []) {
                lines.push(`  - ${k}${fc.expr} — ${fc.message}`);
            }
        }
    }

    if (rules.recipients.length > 0) {
        lines.push(`Recipients (notified by require_recipient): ${rules.recipients.map(explainActor).join(', ')}`);
    }

    if (rules.params.length > 0) {
        lines.push('Parameters:');
        for (const p of rules.params) lines.push(`  - ${p.name}: ${p.type}`);

        const seenTypes = new Set<string>();
        const typedLines: string[] = [];
        for (const p of rules.params) {
            const baseType = p.type.replace(/\?$|\[\]$/, '');
            if (seenTypes.has(baseType)) continue;
            const tr = types[baseType];
            if (!tr) continue;
            seenTypes.add(baseType);
            typedLines.push(`- ${baseType}:`);
            typedLines.push(renderTypeRules(tr));
        }
        if (typedLines.length > 0) {
            lines.push('Type rules:', ...typedLines);
        }
    }

    if (rules.notes) lines.push(`Notes: ${rules.notes}`);

    return lines.join('\n');
}

export function renderSummaryChunk(rules: ActionRules, description: string | null, firstExample: string | null): string {
    const lines = [`${rules.contract}::${rules.action}`];
    if (description) lines.push(description);
    if (firstExample) lines.push(`Example: ${firstExample}`);
    if (!description && !firstExample) {
        const paramList = rules.params.map((p) => `${p.name}: ${p.type}`).join(', ');
        lines.push(`Params: ${paramList || '(none)'}`);
    }
    return lines.join('\n');
}
