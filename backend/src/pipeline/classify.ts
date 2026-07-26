// Cheap pre-LLM intent classifier per guidelines §4.1 rule 3:
// "The classifier is paranoid. […] Cheap pre-LLM regex; updates live in
// pipeline/classify.ts." Roadmap §6 row W2 acceptance: returns
// `act | propose | ask | refuse | answer`. Pure function — no I/O, no
// network, no LLM (backend/CLAUDE.md hard rule 2 covers this path too).
//
// Tie-breaks (W2 prompt + guidelines §4.1):
//   1. injection-prefix wins over everything (security-first).
//   2. out-of-scope refuses before any verb match.
//   3. `propose` wins over `act` — `proposex` is a superset of `act` for
//      msig flows.

export type ClassifyKind = 'act' | 'propose' | 'ask' | 'refuse' | 'answer';

export type ClassifyResult = {
    kind: ClassifyKind;
    reason?: string;
};

// Each entry is a known prompt-injection prefix or marker. Lowercased
// here so the matcher can lowercase the input once and substring-test.
// The list is intentionally explicit (one entry per attack shape) so a
// future security review can grep for the surface — DO NOT collapse
// into a single regex or trim "redundant" entries.
export const INJECTION_PREFIXES: readonly string[] = [
    'ignore previous instructions',
    'ignore all previous instructions',
    'ignore previous instruction',
    'ignore the above',
    'ignore all instructions',
    'disregard previous instructions',
    'disregard all previous instructions',
    'disregard the above',
    'disregard instructions',
    'reset your role',
    'reset your instructions',
    'forget your instructions',
    'forget previous instructions',
    'system prompt override',
    'override the system prompt',
    'you are now',
    "you're now",
    'new instructions:',
    'new instructions follow',
    '<system>',
    '</system>',
    '<|system|>',
    '<|im_start|>',
    '<|im_end|>',
    '[system]',
];

// Topics outside the Ultra toolkit's surface. Kept small + grep-able;
// W7 (Q&A mode) will expand alongside the answerer's grounding rules.
export const OUT_OF_SCOPE_KEYWORDS: readonly string[] = [
    'weather',
    'news',
    'bitcoin',
    'ethereum',
    'solana',
    'polygon',
    'cardano',
    'avalanche',
];

// Action verbs that signal the user wants the AI to compose an action.
// `set` is a whole word here (the trailing-prefix `setcode`/`setpriv`
// cases ride through retrieve.ts' BM25 match against the action name).
const ACT_VERBS = [
    'transfer',
    'send',
    'create',
    'mint',
    'burn',
    'approve',
    'deposit',
    'withdraw',
    'stake',
    'unstake',
    'delegate',
    'vote',
    'register',
    'update',
    'set',
];

const PROPOSE_VERBS = ['propose', 'msig', 'multisig'];

const ANSWER_WORDS = [
    'what',
    'how',
    'why',
    'explain',
    'define',
    'describe',
    'when',
    'where',
    'which',
    'who',
];

function wordBoundaryRe(words: readonly string[]): RegExp {
    return new RegExp(`\\b(${words.join('|')})\\b`, 'i');
}

const ACT_RE = wordBoundaryRe(ACT_VERBS);
const PROPOSE_RE = wordBoundaryRe(PROPOSE_VERBS);
const ANSWER_RE = wordBoundaryRe(ANSWER_WORDS);
const OUT_OF_SCOPE_RE = wordBoundaryRe(OUT_OF_SCOPE_KEYWORDS);

// W6 defensive narrowing — a sentence that STARTS with a question word is
// a knowledge query, not an action verb, even if the body mentions
// "propose" / "transfer" / etc. ("what does propose mean?" → answer, not
// propose). Narrows propose triggers per the W6 prompt ("Do NOT broaden
// the classifier beyond strict propose-intent triggers"). Trailing-? alone
// still falls through to ANSWER_RE in the bottom branch — this only
// rescues sentences that LEAD with an interrogative.
const STARTS_WITH_QUESTION_RE = new RegExp(`^\\s*(${ANSWER_WORDS.join('|')})\\b`, 'i');

export function classify(text: string): ClassifyResult {
    const trimmed = text.trim();
    if (trimmed.length === 0) return { kind: 'ask' };

    const lowered = trimmed.toLowerCase();

    for (const prefix of INJECTION_PREFIXES) {
        if (lowered.includes(prefix)) {
            return { kind: 'refuse', reason: 'injection-prefix' };
        }
    }

    if (OUT_OF_SCOPE_RE.test(trimmed)) return { kind: 'refuse', reason: 'out-of-scope' };

    // W6: must run above PROPOSE_RE and ACT_RE (see STARTS_WITH_QUESTION_RE).
    if (STARTS_WITH_QUESTION_RE.test(trimmed)) return { kind: 'answer' };

    if (PROPOSE_RE.test(trimmed)) return { kind: 'propose' };
    if (ACT_RE.test(trimmed)) return { kind: 'act' };
    if (ANSWER_RE.test(trimmed) || trimmed.endsWith('?')) return { kind: 'answer' };

    return { kind: 'ask' };
}
