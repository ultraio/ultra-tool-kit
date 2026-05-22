// BM25 retrieval over the in-memory catalog (guidelines §4.3 gate 2 — the
// "catalog membership" gate W3 wires up reads its candidates from here).
// Roadmap §3 architecture box: "BM25 over catalog/*.json, top-K=5";
// §6 row W2 acceptance.
//
// Hand-rolled, no new dependency. The catalog is < 100 KB total (roadmap
// §3 "Why no DB"); a real search engine would be cargo. The math is the
// classical BM25 formula — k1 controls term-frequency saturation, b
// controls document-length normalisation. The constants below are the
// canonical defaults and intentionally not parameterised: tuning them
// without a corpus-wide regression baseline is how rankers silently
// regress.

import type { CatalogIndex } from './catalog.js';

const K1 = 1.5;
const B = 0.75;

export type RetrieveHit = {
    contract: string;
    action: string;
    score: number;
};

export type CatalogDoc = {
    contract: string;
    action: string;
    tokens: Map<string, number>;
    length: number;
};

// Lowercase, split on every non-alphanumeric run. EOSIO names are
// lowercase a–z/0–9 with `.` separators, so splitting on `.` falls out
// naturally and we don't need a separate sentence-splitter for the
// English check-messages.
export function tokenize(text: string): string[] {
    const lowered = text.toLowerCase();
    const out: string[] = [];
    for (const raw of lowered.split(/[^a-z0-9]+/)) {
        if (raw.length === 0) continue;
        out.push(raw);
        // EOSIO action variants tend to be `<base><single-char-suffix>` —
        // `proposex` (vs `propose`), `approvals2` (vs `approvals`). Without
        // expansion, the natural-language query "propose msig" misses the
        // intended action because BM25 only matches whole tokens. Restrict
        // to length ≥ 5 so real words like "tax" / "max" / "exec" don't
        // get a spurious prefix emitted.
        if (raw.length >= 5) {
            const last = raw[raw.length - 1]!;
            if (last === 'x' || last === '2') {
                out.push(raw.slice(0, -1));
            }
        }
    }
    return out;
}

export function buildDoc(contract: string, action: string, text: string): CatalogDoc {
    const tokens = new Map<string, number>();
    let length = 0;
    for (const tok of tokenize(text)) {
        tokens.set(tok, (tokens.get(tok) ?? 0) + 1);
        length++;
    }
    return { contract, action, tokens, length };
}

export type Bm25Index = {
    docs: CatalogDoc[];
    docFreq: Map<string, number>;
    avgDocLen: number;
};

export function buildBm25Index(docs: CatalogDoc[]): Bm25Index {
    const docFreq = new Map<string, number>();
    let totalLen = 0;
    for (const d of docs) {
        totalLen += d.length;
        for (const term of d.tokens.keys()) {
            docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
        }
    }
    const avgDocLen = docs.length > 0 ? totalLen / docs.length : 0;
    return { docs, docFreq, avgDocLen };
}

function idf(term: string, index: Bm25Index): number {
    const df = index.docFreq.get(term) ?? 0;
    const n = index.docs.length;
    // Classical BM25 idf. The `+ 1` outside the log keeps the value
    // non-negative when df > n/2 (a query term in most documents is still
    // weakly informative, never negatively so).
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function scoreDoc(queryTerms: string[], doc: CatalogDoc, index: Bm25Index): number {
    let score = 0;
    for (const term of queryTerms) {
        const tf = doc.tokens.get(term);
        if (tf === undefined) continue;
        const norm = 1 - B + B * (doc.length / (index.avgDocLen || 1));
        score += idf(term, index) * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
    return score;
}

export function retrieve(text: string, index: CatalogIndex, k = 5): RetrieveHit[] {
    const queryTerms = Array.from(new Set(tokenize(text)));
    if (queryTerms.length === 0) return [];

    const hits: RetrieveHit[] = [];
    for (const doc of index.bm25.docs) {
        const score = scoreDoc(queryTerms, doc, index.bm25);
        if (score > 0) {
            hits.push({ contract: doc.contract, action: doc.action, score });
        }
    }

    hits.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.contract !== b.contract) return a.contract < b.contract ? -1 : 1;
        return a.action < b.action ? -1 : a.action > b.action ? 1 : 0;
    });

    return hits.slice(0, k);
}
