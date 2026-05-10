import type { ActionRules } from '../extractor/types.js';
import type { EosioTypeRules, EosioTypesFile } from '../extractor/eosio-types.js';

function renderTypeRules(rules: EosioTypeRules): string {
    const lines = [`  ${rules.description}`];
    if (rules.pattern) lines.push(`    pattern: ${rules.pattern}`);
    for (const c of rules.constraints) lines.push(`    - ${c}`);
    return lines.join('\n');
}

export function renderRulesChunk(rules: ActionRules, types: EosioTypesFile): string {
    const lines: string[] = [];
    lines.push(`Action: ${rules.contract}::${rules.action}`);

    if (rules.auths.length > 0) {
        lines.push('Authorizations:');
        for (const a of rules.auths) lines.push(`  - ${a.actor}@${a.permission}`);
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
        lines.push(`Recipients: ${rules.recipients.join(', ')}`);
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
