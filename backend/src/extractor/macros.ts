import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Build a constant-string symbol table by scanning all `*.hpp` headers under a directory.
 *
 * Captures a few common idioms used in eosio contracts to declare error messages:
 *   constexpr static const char* ERR_X = "msg";
 *   constexpr const char* ERR_X = "msg";
 *   static const char* ERR_X = "msg";
 *   #define ERR_X "msg"
 *
 * The map keys are the constant identifiers; values are the literal string contents.
 */
export type MacroTable = Map<string, string>;

const PATTERNS: RegExp[] = [
    // constexpr [static] [const] char* NAME = "..."
    /(?:constexpr\s+)?(?:static\s+)?(?:const\s+)?(?:const\s+)?char\s*\*\s*([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;?/g,
    // constexpr static auto NAME = "..."
    /(?:constexpr\s+)?(?:static\s+)?auto\s+([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;?/g,
    // #define NAME "..."
    /^[ \t]*#define[ \t]+([A-Za-z_]\w*)[ \t]+"((?:[^"\\]|\\.)*)"/gm,
];

function unescape(literal: string): string {
    return literal.replace(/\\(["\\nrt])/g, (_m, c: string) => {
        switch (c) {
            case 'n':
                return '\n';
            case 'r':
                return '\r';
            case 't':
                return '\t';
            case '"':
                return '"';
            case '\\':
                return '\\';
            default:
                return c;
        }
    });
}

export function collectMacrosFromSource(source: string, table: MacroTable): void {
    for (const re of PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(source)) !== null) {
            const name = m[1];
            const value = m[2];
            if (!name || value === undefined) continue;
            // Don't overwrite a name we've already mapped — first definition wins.
            if (!table.has(name)) table.set(name, unescape(value));
        }
    }
}

async function* walkHeaders(root: string): AsyncGenerator<string> {
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' });
    } catch {
        return;
    }
    for (const entry of entries) {
        const name = String(entry.name);
        const full = join(root, name);
        if (entry.isDirectory()) {
            yield* walkHeaders(full);
        } else if (entry.isFile() && (name.endsWith('.hpp') || name.endsWith('.h'))) {
            yield full;
        }
    }
}

export async function buildMacroTable(headerRoot: string): Promise<MacroTable> {
    const table: MacroTable = new Map();
    for await (const file of walkHeaders(headerRoot)) {
        const src = await readFile(file, 'utf8');
        collectMacrosFromSource(src, table);
    }
    return table;
}
