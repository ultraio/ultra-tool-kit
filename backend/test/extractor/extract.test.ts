import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractActionFromSources } from '../../src/extractor/index.js';
import type { ActionRules } from '../../src/extractor/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures');

type Fixture = {
    file: string; // basename of the .cpp
    headers?: string[]; // extra .hpp basenames in fixtures dir
    contract: string;
    action: string;
    params: { name: string; type: string }[];
};

async function loadCase(fix: Fixture): Promise<{ actual: ActionRules; expected: ActionRules }> {
    const cppPath = join(FIX, fix.file);
    const cppSource = await readFile(cppPath, 'utf8');
    const headers = await Promise.all(
        (fix.headers ?? []).map(async (h) => ({ file: join(FIX, h), source: await readFile(join(FIX, h), 'utf8') }))
    );
    const actual = await extractActionFromSources({
        contract: fix.contract,
        action: fix.action,
        params: fix.params,
        sources: [{ file: cppPath, source: cppSource }],
        headers,
        contractRoot: FIX,
    });
    const expectedJson = await readFile(join(FIX, fix.file.replace(/\.cpp$/, '.expected.json')), 'utf8');
    const expected = JSON.parse(expectedJson) as ActionRules;
    return { actual, expected };
}

describe('extractor — fixture round-trip', () => {
    it('simple-transfer: one require_auth + cross-field check + two field constraints', async () => {
        const { actual, expected } = await loadCase({
            file: 'simple-transfer.cpp',
            contract: 'fixture',
            action: 'transfer',
            params: [
                { name: 'from', type: 'name' },
                { name: 'to', type: 'name' },
                { name: 'quantity', type: 'asset' },
                { name: 'memo', type: 'string' },
            ],
        });
        expect(actual).toEqual(expected);
    });

    it('helper-delegate: handler delegates to a helper that performs require_auth', async () => {
        const { actual, expected } = await loadCase({
            file: 'helper-delegate.cpp',
            contract: 'fixture',
            action: 'setconrecv',
            params: [
                { name: 'payer', type: 'name' },
                { name: 'receiver', type: 'name' },
            ],
        });
        expect(actual).toEqual(expected);
    });

    it('assertion-check: ASSERTION_CHECK error code resolves through header', async () => {
        const { actual, expected } = await loadCase({
            file: 'assertion-check.cpp',
            headers: ['assertion-check.hpp'],
            contract: 'fixture',
            action: 'issue',
            params: [
                { name: 'issuer', type: 'name' },
                { name: 'quantity', type: 'asset' },
            ],
        });
        expect(actual).toEqual(expected);
    });

    it('multi-line-check: a check spanning four lines collapses to a single expression', async () => {
        const { actual, expected } = await loadCase({
            file: 'multi-line-check.cpp',
            contract: 'fixture',
            action: 'open',
            params: [
                { name: 'owner', type: 'name' },
                { name: 'sym', type: 'symbol' },
                { name: 'ram_payer', type: 'name' },
            ],
        });
        expect(actual).toEqual(expected);
    });
});
