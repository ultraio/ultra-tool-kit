import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';

const requireFromHere = createRequire(import.meta.url);

let cachedLanguage: Language | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<Language> {
    if (cachedLanguage) return cachedLanguage;
    if (!initPromise) {
        initPromise = (async () => {
            // web-tree-sitter ships its own runtime WASM next to the JS module.
            // Resolve it through the package's main export rather than the bare
            // `package.json` subpath, which is excluded by its `exports` field.
            const wtsMain = requireFromHere.resolve('web-tree-sitter');
            const wtsRuntime = wtsMain.replace(/\.[cm]?js$/, '.wasm');
            await Parser.init({
                locateFile: () => wtsRuntime,
            });
        })();
    }
    await initPromise;

    const cppWasm = requireFromHere.resolve('tree-sitter-cpp/tree-sitter-cpp.wasm');
    const bytes = await readFile(cppWasm);
    cachedLanguage = await Language.load(bytes);
    return cachedLanguage;
}

export async function parseCpp(source: string): Promise<Tree> {
    const language = await ensureInit();
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(source);
    if (!tree) throw new Error('tree-sitter-cpp parse() returned null');
    return tree;
}

export type Visitor = (node: Node) => void | 'skip';

export function walk(node: Node, visit: Visitor): void {
    const result = visit(node);
    if (result === 'skip') return;
    for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) walk(child, visit);
    }
}

export function nodeText(source: string, node: Node): string {
    return source.slice(node.startIndex, node.endIndex);
}

export function lineRange(node: Node): [number, number] {
    return [node.startPosition.row + 1, node.endPosition.row + 1];
}

export function findFirstByType(node: Node, type: string): Node | null {
    let found: Node | null = null;
    walk(node, (n) => {
        if (found) return 'skip';
        if (n.type === type) {
            found = n;
            return 'skip';
        }
    });
    return found;
}

export function collectByType(node: Node, type: string): Node[] {
    const out: Node[] = [];
    walk(node, (n) => {
        if (n.type === type) out.push(n);
    });
    return out;
}
