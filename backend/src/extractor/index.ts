import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Node, Tree } from 'web-tree-sitter';
import { collectByType, lineRange, nodeText, parseCpp, walk } from './cpp-parser.js';
import { buildMacroTable, type MacroTable } from './macros.js';
import { collapseWhitespace, collectCaptures, findHelperCalls, type Capture } from './patterns.js';
import {
    ExtractError,
    type AbiParam,
    type ActionRules,
    type AuthRef,
    type CatalogFile,
    type FieldConstraint,
    type Precondition,
    type SourceLocation,
} from './types.js';

export type ExtractInput = {
    name: string; // e.g. "eosio.token"
    sourceRoot: string; // dir that contains `contracts/<name>/` OR the contract dir itself
    mainnetUrl: string;
    testnetUrl: string;
    log?: (msg: string) => void;
};

type Logger = (msg: string) => void;

type AbiAction = {
    name: string; // ABI name (may differ from C++ function via [[eosio::action("...")]])
    params: AbiParam[];
};

type AbiResponse = {
    chain_id?: string;
    abi: {
        actions: Array<{ name: string; type: string }>;
        structs: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
    };
};

type FunctionDef = {
    name: string;
    classQualifier: string | null;
    paramNames: string[];
    body: Node;
    file: string;
    source: string; // full file source
    lines: [number, number];
};

type AbiNameMap = Map<string, string>; // ABI action name → C++ function name

// ─── Source resolution ────────────────────────────────────────────────────────

async function dirExists(p: string): Promise<boolean> {
    try {
        return (await stat(p)).isDirectory();
    } catch {
        return false;
    }
}

export async function resolveContractDir(name: string, sourceRoot: string): Promise<string> {
    // sourceRoot can be either an `eosio.contracts` checkout (with `contracts/<name>`)
    // or the contract dir itself.
    const direct = sourceRoot;
    const viaContracts = join(sourceRoot, 'contracts', name);
    if (await dirExists(viaContracts)) return viaContracts;
    const baseName = direct.split('/').pop();
    if (baseName === name && (await dirExists(join(direct, 'src')))) return direct;
    throw new ExtractError(`Contract directory not found for "${name}" under ${sourceRoot}`, {
        tried: [viaContracts, direct],
    });
}

// ─── ABI fetching ─────────────────────────────────────────────────────────────

async function fetchAbi(name: string, url: string, log: Logger): Promise<AbiResponse> {
    const endpoint = `${url.replace(/\/$/, '')}/v1/chain/get_abi`;
    log(`[extract] Fetching ABI from ${endpoint} for ${name}`);
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_name: name }),
    });
    if (!res.ok) throw new ExtractError(`ABI fetch failed: ${res.status} ${res.statusText}`, { endpoint });
    const json = (await res.json()) as { account_name: string; abi?: AbiResponse['abi'] };
    if (!json.abi || !Array.isArray(json.abi.actions)) {
        throw new ExtractError(`ABI response missing abi.actions for ${name}`, { endpoint });
    }
    let chainId = '';
    try {
        const infoRes = await fetch(`${url.replace(/\/$/, '')}/v1/chain/get_info`);
        if (infoRes.ok) {
            const info = (await infoRes.json()) as { chain_id?: string };
            chainId = info.chain_id ?? '';
        }
    } catch {
        // chain_id is best-effort metadata; missing is non-fatal.
    }
    return { chain_id: chainId, abi: json.abi };
}

async function fetchAbiWithFallback(
    name: string,
    mainnetUrl: string,
    testnetUrl: string,
    log: Logger
): Promise<AbiResponse> {
    try {
        return await fetchAbi(name, mainnetUrl, log);
    } catch (err) {
        log(`[extract] Mainnet ABI fetch failed (${(err as Error).message}); falling back to testnet`);
        return await fetchAbi(name, testnetUrl, log);
    }
}

function extractAbiActions(abi: AbiResponse['abi']): AbiAction[] {
    const structByName = new Map(abi.structs.map((s) => [s.name, s] as const));
    return abi.actions.map((a) => {
        const struct = structByName.get(a.type);
        const params: AbiParam[] = struct ? struct.fields.map((f) => ({ name: f.name, type: f.type })) : [];
        return { name: a.name, params };
    });
}

// ─── C++ parsing ──────────────────────────────────────────────────────────────

async function readCppFiles(contractDir: string): Promise<{ file: string; source: string }[]> {
    const out: { file: string; source: string }[] = [];
    async function walkDir(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) await walkDir(full);
            else if (e.isFile() && (e.name.endsWith('.cpp') || e.name.endsWith('.cc'))) {
                out.push({ file: full, source: await readFile(full, 'utf8') });
            }
        }
    }
    await walkDir(contractDir);
    return out;
}

async function readHppFiles(contractDir: string): Promise<{ file: string; source: string }[]> {
    const out: { file: string; source: string }[] = [];
    async function walkDir(dir: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const full = join(dir, e.name);
            if (e.isDirectory()) await walkDir(full);
            else if (e.isFile() && (e.name.endsWith('.hpp') || e.name.endsWith('.h'))) {
                out.push({ file: full, source: await readFile(full, 'utf8') });
            }
        }
    }
    await walkDir(contractDir);
    return out;
}

/**
 * Find every C++ function definition in a parsed translation unit.
 * Captures both free functions (`void foo(...)`) and member definitions (`void Class::foo(...)`).
 */
function collectFunctionDefs(tree: Tree, file: string, source: string): FunctionDef[] {
    const out: FunctionDef[] = [];
    walk(tree.rootNode, (node) => {
        if (node.type !== 'function_definition') return;
        const declarator = node.childForFieldName('declarator');
        if (!declarator) return;
        const fnDecl = findFunctionDeclarator(declarator);
        if (!fnDecl) return;
        const declaratorField = fnDecl.childForFieldName('declarator');
        if (!declaratorField) return;
        const { name, classQualifier } = parseDeclaratorName(declaratorField, source);
        if (!name) return;
        const body = node.childForFieldName('body');
        if (!body) return;
        const params = parseParameterNames(fnDecl.childForFieldName('parameters'), source);
        out.push({
            name,
            classQualifier,
            paramNames: params,
            body,
            file,
            source,
            lines: lineRange(node),
        });
    });
    return out;
}

function findFunctionDeclarator(node: Node): Node | null {
    if (node.type === 'function_declarator') return node;
    // Wrapped in pointer/reference/parenthesized declarators.
    const inner = node.childForFieldName('declarator');
    if (inner) return findFunctionDeclarator(inner);
    // Fallback: scan children for a function_declarator.
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && c.type === 'function_declarator') return c;
    }
    return null;
}

function parseDeclaratorName(node: Node, source: string): { name: string | null; classQualifier: string | null } {
    if (node.type === 'identifier' || node.type === 'field_identifier') {
        return { name: nodeText(source, node), classQualifier: null };
    }
    if (node.type === 'qualified_identifier') {
        const scope = node.childForFieldName('scope');
        const name = node.childForFieldName('name');
        const nameText = name ? parseDeclaratorName(name, source).name : null;
        const scopeText = scope ? nodeText(source, scope) : null;
        return { name: nameText, classQualifier: scopeText };
    }
    if (node.type === 'destructor_name' || node.type === 'operator_name') {
        return { name: nodeText(source, node), classQualifier: null };
    }
    return { name: null, classQualifier: null };
}

function parseParameterNames(params: Node | null, source: string): string[] {
    if (!params) return [];
    const names: string[] = [];
    for (let i = 0; i < params.namedChildCount; i++) {
        const child = params.namedChild(i);
        if (!child) continue;
        if (child.type !== 'parameter_declaration') continue;
        const declarator = child.childForFieldName('declarator');
        if (!declarator) continue;
        const name = pickIdentifier(declarator, source);
        if (name) names.push(name);
    }
    return names;
}

function pickIdentifier(node: Node, source: string): string | null {
    if (node.type === 'identifier') return nodeText(source, node);
    // pointer_declarator / reference_declarator wrap the inner declarator.
    const inner = node.childForFieldName('declarator');
    if (inner) return pickIdentifier(inner, source);
    for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (!c) continue;
        const name = pickIdentifier(c, source);
        if (name) return name;
    }
    return null;
}

// ─── ABI-name → C++ function-name map ────────────────────────────────────────

/**
 * Scan headers for `[[eosio::action("name")]]` attributes. The attribute appears
 * either bare (`[[eosio::action]]`, action name == function name) or with an
 * explicit string argument (`[[eosio::action("foo.b")]]`, action name == "foo.b"
 * but the C++ function may be named differently).
 */
function buildAbiNameMap(hpps: { file: string; source: string }[]): AbiNameMap {
    const map: AbiNameMap = new Map();
    const re = /\[\[\s*eosio\s*::\s*action(?:\s*\(\s*"([^"]+)"\s*\))?\s*\]\]/g;
    for (const { source } of hpps) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const explicitName = m[1] ?? null;
            // Find the next function declaration after the attribute.
            const after = source.slice(re.lastIndex);
            const fnMatch = after.match(/(?:[A-Za-z_][\w:<>,\s\*&]*?)\s+([A-Za-z_]\w*)\s*\(/);
            if (!fnMatch || !fnMatch[1]) continue;
            const fnName = fnMatch[1];
            const abiName = explicitName ?? fnName;
            // First declaration wins.
            if (!map.has(abiName)) map.set(abiName, fnName);
        }
    }
    return map;
}

// ─── Capture → ActionRules mapping ───────────────────────────────────────────

type ResolvedCapture = Capture & { messageResolved?: string };

function resolveAssertionMessages(captures: Capture[], macros: MacroTable): ResolvedCapture[] {
    return captures.map((c) => {
        if (c.kind === 'assertion_check') {
            const msg = macros.get(c.errorCode) ?? `(unresolved: ${c.errorCode})`;
            return { ...c, messageResolved: msg };
        }
        return c;
    });
}

function paramRefFromExpr(expr: string, paramNames: Set<string>): string | null {
    // Treat as a field constraint only if the expression is `param.<rest>` or
    // `param-><rest>`. A bare comparison like `from != to` is a cross-field
    // precondition, not a constraint on `from`.
    const m = expr.match(/^([A-Za-z_]\w*)(\.|->)/);
    if (!m || !m[1]) return null;
    const name = m[1];
    return paramNames.has(name) ? name : null;
}

function classifyCheck(expr: string): 'cross_field' | 'state' | 'invariant' {
    // Heuristics that mirror the doc's table:
    //   `is_account(...)`, `*table*.find(...)` etc. → state
    //   `a != b`, `a == b`, `a > b` involving identifiers on both sides → cross_field
    //   everything else → invariant
    if (/\b(is_account|find|get_self|get_sender|has_auth|exists)\b/.test(expr)) return 'state';
    if (/\w+\s*(!=|==|>=|<=|>|<)\s*\w+/.test(expr)) return 'cross_field';
    return 'invariant';
}

function actorRefFor(rawActor: string, paramNames: Set<string>): string {
    // `from` → `$from`; `st.issuer` stays as-is; `get_self()` → `$self`; literal `"foo"_n` → `"foo"_n`.
    const trimmed = rawActor.trim();
    if (trimmed === 'get_self()') return '$self';
    if (paramNames.has(trimmed)) return `$${trimmed}`;
    return trimmed;
}

function buildActionRules(
    contract: string,
    abiAction: AbiAction,
    fn: FunctionDef | null,
    helperFn: FunctionDef | null,
    captures: ResolvedCapture[],
    contractRoot: string,
    helperCaptures: ResolvedCapture[]
): ActionRules {
    const paramNames = new Set(abiAction.params.map((p) => p.name));
    if (fn) for (const n of fn.paramNames) paramNames.add(n);
    if (helperFn) for (const n of helperFn.paramNames) paramNames.add(n);

    const all = [...captures, ...helperCaptures];
    const auths: AuthRef[] = [];
    const preconditions: Precondition[] = [];
    const fieldConstraints: Record<string, FieldConstraint[]> = {};
    const recipients: string[] = [];

    for (const cap of all) {
        if (cap.kind === 'require_auth') {
            auths.push({
                actor: actorRefFor(cap.actor, paramNames),
                permission: cap.permission === 'active' ? 'active' : actorPermission(cap.permission, paramNames),
            });
        } else if (cap.kind === 'require_recipient') {
            recipients.push(actorRefFor(cap.actor, paramNames));
        } else if (cap.kind === 'check') {
            assignCheck(cap.expr, cap.message, paramNames, fieldConstraints, preconditions);
        } else if (cap.kind === 'assertion_check') {
            const msg = cap.messageResolved ?? cap.errorCode;
            assignCheck(cap.expr, msg, paramNames, fieldConstraints, preconditions);
        }
    }

    const sourcePath = fn ? relativeFromRoot(fn.file, contractRoot) : '';
    const sourceLines: [number, number] = fn ? fn.lines : [0, 0];
    const source: SourceLocation = { path: sourcePath, lines: sourceLines };

    const out: ActionRules = {
        contract,
        action: abiAction.name,
        params: abiAction.params,
        auths: dedupeAuths(auths),
        preconditions,
        field_constraints: fieldConstraints,
        recipients: Array.from(new Set(recipients)),
        source,
    };
    if (!fn) {
        out.unresolved = true;
        out.notes = `Could not locate handler for action "${abiAction.name}" in C++ source.`;
    } else if (auths.length === 0) {
        out.unresolved = true;
        out.notes = `Handler found at ${sourcePath}:${sourceLines[0]} but no require_auth/require_auth2 captured.`;
    }
    return out;
}

function actorPermission(rawPermission: string, paramNames: Set<string>): string {
    const t = rawPermission.trim();
    if (paramNames.has(t)) return `$${t}`;
    return t;
}

function dedupeAuths(auths: AuthRef[]): AuthRef[] {
    const seen = new Set<string>();
    const out: AuthRef[] = [];
    for (const a of auths) {
        const key = `${a.actor}@${a.permission}`;
        if (!seen.has(key)) {
            seen.add(key);
            out.push(a);
        }
    }
    return out;
}

function assignCheck(
    rawExpr: string,
    message: string,
    paramNames: Set<string>,
    fieldConstraints: Record<string, FieldConstraint[]>,
    preconditions: Precondition[]
): void {
    const expr = collapseWhitespace(rawExpr);
    const param = paramRefFromExpr(expr, paramNames);
    if (param) {
        // Strip the leading param name to get a relative expression like ".amount > 0".
        const rest = expr.slice(param.length);
        const fc = fieldConstraints[param] ?? [];
        fc.push({ expr: rest.trim(), message });
        fieldConstraints[param] = fc;
        return;
    }
    preconditions.push({
        kind: classifyCheck(expr),
        expr,
        message,
    });
}

function relativeFromRoot(file: string, root: string): string {
    return file.startsWith(root) ? file.slice(root.length).replace(/^\/+/, '') : file;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function extractContract(input: ExtractInput): Promise<CatalogFile> {
    const log: Logger = input.log ?? (() => {});
    const contractDir = await resolveContractDir(input.name, input.sourceRoot);
    log(`[extract] Contract dir: ${contractDir}`);

    const abiResponse = await fetchAbiWithFallback(input.name, input.mainnetUrl, input.testnetUrl, log);
    const abiHash = createHash('sha256').update(JSON.stringify(abiResponse.abi)).digest('hex');
    const abiActions = extractAbiActions(abiResponse.abi);
    log(`[extract] ABI actions: ${abiActions.map((a) => a.name).join(', ')}`);

    const cpps = await readCppFiles(contractDir);
    const hpps = await readHppFiles(contractDir);
    log(`[extract] Parsed ${cpps.length} .cpp file(s) and ${hpps.length} .hpp file(s)`);

    const macros = await buildMacroTable(contractDir);
    log(`[extract] Macro table size: ${macros.size}`);

    const abiNameMap = buildAbiNameMap(hpps);

    // Collect all function defs across all .cpp files in this contract.
    const allFns: FunctionDef[] = [];
    for (const { file, source } of cpps) {
        const tree = await parseCpp(source);
        for (const fn of collectFunctionDefs(tree, file, source)) allFns.push(fn);
    }

    const fnByName = new Map<string, FunctionDef>();
    for (const fn of allFns) {
        // Last-defined wins; only one definition expected per contract anyway.
        fnByName.set(fn.name, fn);
    }

    const actions: Record<string, ActionRules> = {};
    for (const abiAction of abiActions) {
        const fnName = abiNameMap.get(abiAction.name) ?? abiAction.name;
        const fn = fnByName.get(fnName) ?? null;
        let captures: Capture[] = [];
        let helperFn: FunctionDef | null = null;
        let helperCaptures: Capture[] = [];
        if (fn) {
            captures = collectCaptures(fn.body, fn.source);
            // One-level helper recursion: if the handler's name suggests a *_v* delegation,
            // or if the body calls a same-translation-unit member method that itself does the auth.
            const helpers = findHelperCalls(fn.body, fn.source);
            for (const h of helpers) {
                const candidate = fnByName.get(h.name);
                if (candidate && candidate !== fn) {
                    helperFn = candidate;
                    helperCaptures = collectCaptures(candidate.body, candidate.source);
                    break;
                }
            }
        } else {
            log(`[extract] WARN: no C++ handler found for action "${abiAction.name}" (looked for fn "${fnName}")`);
        }
        const resolved = resolveAssertionMessages(captures, macros);
        const helperResolved = resolveAssertionMessages(helperCaptures, macros);
        actions[abiAction.name] = buildActionRules(
            input.name,
            abiAction,
            fn,
            helperFn,
            resolved,
            contractDir,
            helperResolved
        );
    }

    return {
        contract: input.name,
        abi_hash: abiHash,
        abi_chain_id: abiResponse.chain_id ?? '',
        abi_fetched_at: new Date().toISOString(),
        source_path: contractDir,
        actions,
    };
}

// ─── Local-source extraction (no chain fetch) — used by tests on synthetic fixtures ──

export type LocalExtractInput = {
    contract: string;
    action: string;
    params: AbiParam[];
    sources: { file: string; source: string }[];
    headers?: { file: string; source: string }[];
    contractRoot: string;
};

export async function extractActionFromSources(input: LocalExtractInput): Promise<ActionRules> {
    const macros: MacroTable = new Map();
    for (const h of input.headers ?? []) {
        const { collectMacrosFromSource } = await import('./macros.js');
        collectMacrosFromSource(h.source, macros);
    }

    const abiNameMap = buildAbiNameMap(input.headers ?? []);
    const fnName = abiNameMap.get(input.action) ?? input.action;

    const allFns: FunctionDef[] = [];
    for (const { file, source } of input.sources) {
        const tree = await parseCpp(source);
        for (const fn of collectFunctionDefs(tree, file, source)) allFns.push(fn);
    }
    const fnByName = new Map<string, FunctionDef>();
    for (const fn of allFns) fnByName.set(fn.name, fn);
    const fn = fnByName.get(fnName) ?? null;

    let captures: Capture[] = [];
    let helperFn: FunctionDef | null = null;
    let helperCaptures: Capture[] = [];
    if (fn) {
        captures = collectCaptures(fn.body, fn.source);
        for (const h of findHelperCalls(fn.body, fn.source)) {
            const candidate = fnByName.get(h.name);
            if (candidate && candidate !== fn) {
                helperFn = candidate;
                helperCaptures = collectCaptures(candidate.body, candidate.source);
                break;
            }
        }
    }
    const abiAction: AbiAction = { name: input.action, params: input.params };
    const resolved = resolveAssertionMessages(captures, macros);
    const helperResolved = resolveAssertionMessages(helperCaptures, macros);
    const rules = buildActionRules(input.contract, abiAction, fn, helperFn, resolved, input.contractRoot, helperResolved);
    return rules;
}

// Quiet "unused-import" complaints — kept for future use.
export type { Tree };
void collectByType;
