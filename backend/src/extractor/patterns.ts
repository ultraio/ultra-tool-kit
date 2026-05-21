import type { Node } from 'web-tree-sitter';
import { collectByType, nodeText } from './cpp-parser.js';

export type RequireAuthCapture = {
    kind: 'require_auth';
    actor: string;
    permission: string; // 'active' for require_auth, custom for require_auth2
    line: number;
};

export type CheckCapture = {
    kind: 'check';
    expr: string;
    message: string;
    line: number;
};

export type AssertionCheckCapture = {
    kind: 'assertion_check';
    expr: string;
    errorCode: string;
    line: number;
};

export type RequireRecipientCapture = {
    kind: 'require_recipient';
    actor: string;
    line: number;
};

export type Capture = RequireAuthCapture | CheckCapture | AssertionCheckCapture | RequireRecipientCapture;

/** Strip leading qualifiers from a call's function expression. */
function calleeName(node: Node, source: string): string | null {
    // call_expression has a `function` field that may be:
    //   identifier — `check`
    //   qualified_identifier — `eosio::check`
    //   field_expression — `obj.foo()` (not us)
    const fn = node.childForFieldName('function');
    if (!fn) return null;
    if (fn.type === 'identifier') return nodeText(source, fn);
    if (fn.type === 'qualified_identifier') {
        const text = nodeText(source, fn);
        // Take the last `::` segment.
        const idx = text.lastIndexOf('::');
        return idx >= 0 ? text.slice(idx + 2) : text;
    }
    return null;
}

/** Get arguments as raw text snippets, preserving order, stripping outer parens. */
function callArgs(node: Node, source: string): { texts: string[]; nodes: Node[] } {
    const args = node.childForFieldName('arguments');
    if (!args) return { texts: [], nodes: [] };
    const texts: string[] = [];
    const nodes: Node[] = [];
    for (let i = 0; i < args.namedChildCount; i++) {
        const child = args.namedChild(i);
        if (!child) continue;
        if (child.type === 'comment') continue;
        nodes.push(child);
        texts.push(nodeText(source, child).trim());
    }
    return { texts, nodes };
}

/** Strip a string literal node down to its raw inner text. */
function stringLiteralValue(node: Node, source: string): string | null {
    if (node.type !== 'string_literal' && node.type !== 'raw_string_literal' && node.type !== 'concatenated_string') {
        return null;
    }
    if (node.type === 'concatenated_string') {
        // Concatenation of adjacent string literals — collapse them.
        let out = '';
        for (let i = 0; i < node.namedChildCount; i++) {
            const c = node.namedChild(i);
            if (!c) continue;
            const v = stringLiteralValue(c, source);
            if (v === null) return null;
            out += v;
        }
        return out;
    }
    // string_literal: contains a `string_content` child.
    const text = nodeText(source, node);
    // Strip the outer quote-and-prefix wrapping; the content child is more reliable.
    const content = node.childForFieldName('content') ?? null;
    if (content) {
        return nodeText(source, content);
    }
    // Fallback: drop leading prefix + quote and trailing quote.
    const m = text.match(/^[uUL]?R?"(.*)"$/s);
    return m ? (m[1] ?? '') : text;
}

export function matchCall(node: Node, source: string): Capture | null {
    if (node.type !== 'call_expression') return null;
    const name = calleeName(node, source);
    if (!name) return null;
    const line = node.startPosition.row + 1;
    const { texts, nodes } = callArgs(node, source);

    if (name === 'require_auth' && texts.length === 1 && texts[0] !== undefined) {
        return { kind: 'require_auth', actor: texts[0], permission: 'active', line };
    }
    if (name === 'require_auth2' && texts.length === 2 && texts[0] !== undefined && texts[1] !== undefined) {
        return {
            kind: 'require_auth',
            actor: texts[0],
            permission: texts[1],
            line,
        };
    }

    if (name === 'check' && texts.length === 2) {
        const exprText = texts[0];
        const msgNode = nodes[1];
        if (exprText === undefined || !msgNode) return null;
        const msg = stringLiteralValue(msgNode, source);
        // `check( …, "literal" )` — only capture if the message is a static string.
        if (msg !== null) {
            return {
                kind: 'check',
                expr: collapseWhitespace(exprText),
                message: msg,
                line,
            };
        }
    }

    if (name === 'ASSERTION_CHECK' && texts.length === 2 && texts[0] !== undefined && texts[1] !== undefined) {
        return {
            kind: 'assertion_check',
            expr: collapseWhitespace(texts[0]),
            errorCode: texts[1],
            line,
        };
    }

    if (name === 'require_recipient' && texts.length === 1 && texts[0] !== undefined) {
        return { kind: 'require_recipient', actor: texts[0], line };
    }

    if (name === 'has_auth' && texts.length === 1 && texts[0] !== undefined) {
        // `has_auth(X)` inside a `check(...)` is a soft auth gate. Record it as
        // a require_auth-equivalent so the catalog's `auths` array reflects who
        // can call this action.
        return { kind: 'require_auth', actor: texts[0], permission: 'active', line };
    }

    return null;
}

export function collapseWhitespace(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
}

export function collectCaptures(body: Node, source: string): Capture[] {
    const out: Capture[] = [];
    for (const call of collectByType(body, 'call_expression')) {
        const cap = matchCall(call, source);
        if (cap) out.push(cap);
    }
    return out;
}

/** Helper-call discovery: find direct calls to other member functions or free functions. */
export function findHelperCalls(body: Node, source: string): { name: string; line: number }[] {
    const out: { name: string; line: number }[] = [];
    const skip = new Set([
        'require_auth',
        'require_auth2',
        'check',
        'eosio::check',
        'ASSERTION_CHECK',
        'require_recipient',
        'has_auth',
        'is_account',
        'get_self',
        'get_sender',
    ]);
    for (const call of collectByType(body, 'call_expression')) {
        const fn = call.childForFieldName('function');
        if (!fn) continue;
        let name: string | null = null;
        if (fn.type === 'identifier') name = nodeText(source, fn);
        else if (fn.type === 'qualified_identifier') {
            const text = nodeText(source, fn);
            const idx = text.lastIndexOf('::');
            name = idx >= 0 ? text.slice(idx + 2) : text;
        } else if (fn.type === 'field_expression') {
            const f = fn.childForFieldName('field');
            if (f) name = nodeText(source, f);
        }
        if (!name || skip.has(name)) continue;
        out.push({ name, line: call.startPosition.row + 1 });
    }
    return out;
}
