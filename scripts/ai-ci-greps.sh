#!/usr/bin/env bash
# AI-enhancement CI greps — block PRs that bypass the rules in
# docs/00-ai-global-guidelines.md §5.
#
# W1   landed greps #1 + #2 (provider isolation).
# W1.5 lands greps #3 / #4 / #5 / #9 (frontend secret-storage discipline,
#                                     127.0.0.1 bind, no committed
#                                     DEV_AUTH_BYPASS=true, no `*` CORS).
# Remaining greps land in their owning waves; rules listed below as TODO so
# the wave that needs them can pick up where this leaves off.
#
# Usage: scripts/ai-ci-greps.sh
# Exit 0 = all rules pass. Exit non-zero = at least one rule found a
# violation (output names the offending file/line so the dev sees what to
# fix).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAILED=0
fail() {
    echo "AI-CI-GREP FAIL: $*" >&2
    FAILED=1
}

# Only scan files git is willing to track — keeps node_modules / dist /
# generated JSON out of the grep set. macOS ships bash 3.2 (no `mapfile`),
# so we round-trip through a tempfile and read with a while-loop.
TRACKED_FILE="$(mktemp -t ai-ci-greps-XXXXXX)"
trap 'rm -f "$TRACKED_FILE"' EXIT
git ls-files > "$TRACKED_FILE"

# ----------------------------------------------------------------------------
# Grep #1: @anthropic-ai/sdk + ollama imports outside backend/src/llm/.
#
# Guidelines §5 rule 1. The provider SDKs are the harness's exclusive
# dependency. Any other module that imports them is bypassing the schema
# gate, budget caps, and audit log.
# ----------------------------------------------------------------------------
GREP1_PATTERN='from[[:space:]]+['\''"]@anthropic-ai/sdk['\''"]|from[[:space:]]+['\''"]ollama['\''"]'
GREP1_HITS=()
while IFS= read -r f; do
    case "$f" in
        backend/src/llm/*) continue ;;
        scripts/ai-ci-greps.sh) continue ;; # this file documents the pattern
    esac
    case "$f" in
        *.ts|*.tsx|*.js|*.mjs|*.cjs) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -nE "$GREP1_PATTERN" "$f" >/dev/null 2>&1; then
        GREP1_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP1_HITS[@]} > 0 )); then
    fail "Grep #1: @anthropic-ai/sdk or ollama imported outside backend/src/llm/"
    for f in "${GREP1_HITS[@]}"; do
        grep -nE "$GREP1_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# Grep #2: raw fetch against the provider hosts outside backend/src/llm/.
#
# Guidelines §5 rule 2. Same reason as grep #1 — anything that talks
# directly to a provider URL bypasses the wrapper.
# ----------------------------------------------------------------------------
GREP2_PATTERN='fetch[[:space:]]*\([^)]*(api\.anthropic\.com|localhost:11434)'
GREP2_HITS=()
while IFS= read -r f; do
    case "$f" in
        backend/src/llm/*) continue ;;
        scripts/ai-ci-greps.sh) continue ;;
    esac
    case "$f" in
        *.ts|*.tsx|*.js|*.mjs|*.cjs) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -nE "$GREP2_PATTERN" "$f" >/dev/null 2>&1; then
        GREP2_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP2_HITS[@]} > 0 )); then
    fail "Grep #2: raw fetch to api.anthropic.com or localhost:11434 outside backend/src/llm/"
    for f in "${GREP2_HITS[@]}"; do
        grep -nE "$GREP2_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# Grep #3 (W1.5): localStorage/sessionStorage setItem calls whose key
# contains the substrings `jwt`, `bearer`, or `pubkey` under src/.
#
# Guidelines §5 rule 3. Secrets stay in memory; sessionId is the one allowed
# exception (and is a UUID — none of the three banned substrings).
# ----------------------------------------------------------------------------
GREP3_PATTERN='(localStorage|sessionStorage)\.setItem\([^)]*(jwt|bearer|pubkey)'
GREP3_HITS=()
while IFS= read -r f; do
    case "$f" in
        src/*) ;;
        *) continue ;;
    esac
    case "$f" in
        *.ts|*.tsx|*.vue|*.js|*.mjs|*.cjs) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -niE "$GREP3_PATTERN" "$f" >/dev/null 2>&1; then
        GREP3_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP3_HITS[@]} > 0 )); then
    fail "Grep #3: localStorage/sessionStorage write whose key matches jwt|bearer|pubkey under src/"
    for f in "${GREP3_HITS[@]}"; do
        grep -niE "$GREP3_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# Grep #4 (W1.5): `0.0.0.0` bind in backend/src/** (outside backend/test/).
#
# Guidelines §5 rule 4 + §4.6. Local backend binds 127.0.0.1 only.
# ----------------------------------------------------------------------------
GREP4_PATTERN='0\.0\.0\.0'
GREP4_HITS=()
while IFS= read -r f; do
    case "$f" in
        backend/src/*) ;;
        *) continue ;;
    esac
    case "$f" in
        *.ts|*.tsx|*.js|*.mjs|*.cjs) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -nE "$GREP4_PATTERN" "$f" >/dev/null 2>&1; then
        GREP4_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP4_HITS[@]} > 0 )); then
    fail "Grep #4: 0.0.0.0 bind in backend/src/** (use 127.0.0.1; §4.6)"
    for f in "${GREP4_HITS[@]}"; do
        grep -nE "$GREP4_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# Grep #5 (W1.5): `DEV_AUTH_BYPASS=true` in any tracked .env* file.
#
# Guidelines §5 rule 5 + §3.4. Dev-only flag; committing `=true` to any
# .env example is a production foot-gun.
# ----------------------------------------------------------------------------
GREP5_PATTERN='^[[:space:]]*DEV_AUTH_BYPASS=true'
GREP5_HITS=()
while IFS= read -r f; do
    case "$(basename "$f")" in
        .env|.env.*|*.env|*.env.*) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -nE "$GREP5_PATTERN" "$f" >/dev/null 2>&1; then
        GREP5_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP5_HITS[@]} > 0 )); then
    fail "Grep #5: DEV_AUTH_BYPASS=true committed to a .env* file (loopback-only dev flag; §3.4)"
    for f in "${GREP5_HITS[@]}"; do
        grep -nE "$GREP5_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# Grep #9 (W1.5): `*` CORS origin in backend/src/** outside test fixtures.
#
# Guidelines §5 rule 9 + §4.6. CORS allowlist is explicit; never `*`. We
# pattern-match the common shapes — Hono's `cors({ origin: '*' })`,
# `Access-Control-Allow-Origin: *`, and bare `origin = '*'` / `origin: '*'`.
# ----------------------------------------------------------------------------
GREP9_PATTERN='(origin[[:space:]]*[:=][[:space:]]*['\''"]\*['\''"]|Access-Control-Allow-Origin[^A-Za-z0-9]+['\''"]\*['\''"])'
GREP9_HITS=()
while IFS= read -r f; do
    case "$f" in
        backend/src/*) ;;
        *) continue ;;
    esac
    case "$f" in
        *.ts|*.tsx|*.js|*.mjs|*.cjs) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -nE "$GREP9_PATTERN" "$f" >/dev/null 2>&1; then
        GREP9_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP9_HITS[@]} > 0 )); then
    fail "Grep #9: \`*\` CORS origin in backend/src/** (use an explicit allowlist; §4.6)"
    for f in "${GREP9_HITS[@]}"; do
        grep -nE "$GREP9_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# Grep #7 (W3): `... as <CapitalizedType>` cast chained off an LLM response.
#
# Guidelines §5 rule 7. The schema gate (harness Zod parse + validator
# re-parse) is the only sanctioned way to give an LLM response a concrete
# type. A raw `harness.call(...).value as Reply` bypasses the gate.
#
# Pattern: `(harness|provider|chat).<call|chat>(...)` followed by chained
# access and an `as <CapitalizedType>` cast on the same line. Also catches
# the common `.json as Reply` / `.json as <T>` shape. backend/src/llm/** is
# excluded — the provider implementations legitimately cast SDK shapes.
# ----------------------------------------------------------------------------
GREP7_PATTERN='(harness|provider|chat)\.(call|chat)\([^)]*\)[^;]*[[:space:]]+as[[:space:]]+[A-Z]|\.json[[:space:]]+as[[:space:]]+[A-Z]'
GREP7_HITS=()
while IFS= read -r f; do
    case "$f" in
        backend/src/llm/*) continue ;;
        scripts/ai-ci-greps.sh) continue ;;
    esac
    case "$f" in
        *.ts|*.tsx) ;;
        *) continue ;;
    esac
    if [[ -f "$f" ]] && grep -nE "$GREP7_PATTERN" "$f" >/dev/null 2>&1; then
        GREP7_HITS+=("$f")
    fi
done < "$TRACKED_FILE"
if (( ${#GREP7_HITS[@]} > 0 )); then
    fail "Grep #7: \`as <Type>\` cast chained off an LLM response (schema gate must come first; §4.3 gate 1)"
    for f in "${GREP7_HITS[@]}"; do
        grep -nE "$GREP7_PATTERN" "$f" | sed "s|^|  $f:|" >&2
    done
fi

# ----------------------------------------------------------------------------
# TODO — remaining greps land in their owning waves:
#   #6 (W3+):  dangerouslySetInnerHTML / v-html in src/components/ai/**
#   #8 (W4):   new tool name in pipeline/tools/ without doc row in §4.2
# ----------------------------------------------------------------------------

exit "$FAILED"
