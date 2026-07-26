// Regression test for the warm-ollama.mjs prewarm script.
//
// Bug: the script read process.env.LLM_PROVIDER without loading backend/.env,
// so a .env-configured LLM_PROVIDER=anthropic was invisible and the script
// warmed qwen3:14b anyway.
//
// Fix: `import 'dotenv/config'` as the first line of the script so .env is
// loaded before the LLM_PROVIDER guard runs.
//
// Test strategy: spawn the script as a child process with a crafted temp .env
// and a MINIMAL env (PATH only), so the only source of LLM_PROVIDER and
// OLLAMA_* is the temp .env — no parent-env bleed.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/warm-ollama.mjs', import.meta.url));

// Minimal env: only PATH so node can resolve itself; no LLM_PROVIDER leak.
const MINIMAL_ENV = { PATH: process.env.PATH ?? '' };

let tempDir: string | null = null;

afterEach(() => {
    if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
        tempDir = null;
    }
});

function makeTempDir(envContents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'warm-ollama-test-'));
    writeFileSync(join(dir, '.env'), envContents, 'utf8');
    tempDir = dir;
    return dir;
}

describe('warm-ollama.mjs — respects .env (regression for dotenv/config missing)', () => {
    it('case 1: LLM_PROVIDER=anthropic in .env → guard exits 0 without printing [prewarm] loading', () => {
        // The guard `if (provider !== 'ollama') process.exit(0)` should fire
        // before the prewarm log line. Without `import 'dotenv/config'`, the
        // clean env has no LLM_PROVIDER, defaults to 'ollama', and prints the
        // loading line — this case FAILS before the fix.
        const cwd = makeTempDir('LLM_PROVIDER=anthropic\n');

        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            cwd,
            env: MINIMAL_ENV,
            encoding: 'utf8',
            timeout: 30_000,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain('[prewarm] loading');
    });

    it('case 2: LLM_PROVIDER=ollama in .env → reads .env values and prints model name, then skips (ECONNREFUSED)', () => {
        // Port 1 is reserved and closed → fetch fails fast with ECONNREFUSED.
        // The script should still exit 0 (errors are swallowed) and stdout
        // must contain the model name read from .env (qwen3:14b) AND 'skipped'
        // from the catch branch.
        // This proves the script loaded .env for all three vars (provider,
        // base url, model).
        const cwd = makeTempDir(
            'LLM_PROVIDER=ollama\nOLLAMA_BASE_URL=http://127.0.0.1:1\nOLLAMA_CHAT_MODEL=qwen3:14b\n',
        );

        const result = spawnSync(process.execPath, [SCRIPT_PATH], {
            cwd,
            env: MINIMAL_ENV,
            encoding: 'utf8',
            timeout: 30_000,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('[prewarm] loading qwen3:14b');
        expect(result.stdout).toContain('skipped');
    });
});
