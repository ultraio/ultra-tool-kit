// Pre-warm the Ollama chat model so the FIRST /api/ai-chat turn doesn't pay the
// ~10-20s cold-load latency (which would blow the harness's 15s per-attempt
// budget → `retries-exhausted`). Runs automatically via the `predev` npm hook.
//
// Loads backend/.env (via dotenv/config, which reads ${cwd}/.env; predev runs
// with cwd=backend/) so that LLM_PROVIDER, OLLAMA_BASE_URL, OLLAMA_CHAT_MODEL,
// and OLLAMA_KEEP_ALIVE reflect the configured values. Shell-exported vars still
// take precedence over .env (dotenv/config does NOT use override mode).
//
// No-op unless LLM_PROVIDER=ollama. Never blocks dev startup: any failure
// (Ollama down, model not pulled, timeout) is swallowed and exits 0. Loads with
// keep_alive so the model stays resident for the session (set OLLAMA_KEEP_ALIVE,
// e.g. 2h) and with think:false to mirror the provider's request shape.
import 'dotenv/config';

const provider = process.env.LLM_PROVIDER ?? 'ollama';
if (provider !== 'ollama') process.exit(0);

const base = process.env.OLLAMA_BASE_URL ?? process.env.OLLAMA_URL ?? 'http://localhost:11434';
const model = process.env.OLLAMA_CHAT_MODEL ?? 'qwen3:14b';
const keepAlive = process.env.OLLAMA_KEEP_ALIVE ?? '2h';

process.stdout.write(`[prewarm] loading ${model} (keep_alive=${keepAlive})... `);
try {
    const res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            model,
            stream: false,
            think: false,
            keep_alive: keepAlive,
            messages: [{ role: 'user', content: 'warmup' }],
        }),
        signal: AbortSignal.timeout(120_000),
    });
    process.stdout.write(res.ok ? 'ready\n' : `skipped (HTTP ${res.status})\n`);
} catch (e) {
    process.stdout.write(`skipped (${e instanceof Error ? e.message : String(e)})\n`);
}
process.exit(0);
