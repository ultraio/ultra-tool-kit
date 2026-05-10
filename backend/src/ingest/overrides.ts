import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ActionRules, AuthRef, FieldConstraint, Precondition } from '../extractor/types.js';

export type ActionOverride = Partial<{
    auths: AuthRef[];
    preconditions: Precondition[];
    field_constraints: Record<string, FieldConstraint[]>;
    recipients: string[];
    notes: string;
    unresolved: boolean;
}>;

export async function loadActionOverride(
    catalogDir: string,
    contract: string,
    action: string
): Promise<ActionOverride | null> {
    const path = join(catalogDir, 'overrides', contract, `${action}.yaml`);
    let raw: string;
    try {
        raw = await readFile(path, 'utf8');
    } catch {
        return null;
    }
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    return parsed as ActionOverride;
}

export function applyOverride(rules: ActionRules, override: ActionOverride | null): ActionRules {
    if (!override) return rules;
    const out: ActionRules = { ...rules };
    if (override.auths !== undefined) out.auths = override.auths;
    if (override.preconditions !== undefined) out.preconditions = override.preconditions;
    if (override.field_constraints !== undefined) out.field_constraints = override.field_constraints;
    if (override.recipients !== undefined) out.recipients = override.recipients;
    if (override.notes !== undefined) out.notes = override.notes;
    if (override.unresolved !== undefined) out.unresolved = override.unresolved;
    return out;
}
