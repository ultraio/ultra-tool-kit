#!/usr/bin/env bash
# AI-enhancement CI greps — block PRs that bypass the rules in
# docs/00-ai-global-guidelines.md §5.
#
# W1: greps #1 + #2 enforced (provider isolation). Remaining greps land in
# their owning waves; rules listed below as TODO so the wave that needs them
# can pick up where this leaves off.
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
# TODO — remaining greps land in their owning waves:
#   #3 (W1.5): localStorage/sessionStorage writes containing jwt/bearer/pubkey
#   #4 (W1.5): 0.0.0.0 bind in backend/src/** outside backend/test/
#   #5 (W1.5): DEV_AUTH_BYPASS=true in .env* at repo root
#   #6 (W3+):  dangerouslySetInnerHTML / v-html in src/components/ai/**
#   #7 (W3+):  `cast(.*as.*)` chained off LLM responses in TS (schema gate first)
#   #8 (W4):   new tool name in pipeline/tools/ without doc row in §4.2
#   #9 (W1.5): `*` CORS origin in backend/src/** outside test fixtures
# ----------------------------------------------------------------------------

exit "$FAILED"
