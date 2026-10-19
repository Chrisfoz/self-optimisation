/**
 * A navigable map of the editable surface: every file with its size, its
 * top-level symbols and the other editable files it imports. Under
 * `context.strategy: scoped` this is what a suggesting model reads first, in
 * place of the full source, to choose which files to read in full (the
 * shape Aider's repository map takes). The same import graph tells the
 * reviewer which unchanged files depend on a change, and tells a lesson
 * which neighbouring files can make it stale.
 *
 * Deliberately lexical: regexes per language, no parser and no dependency.
 * A missed symbol costs one line of the map; the file is still listed and
 * can still be chosen.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMBOLS_PER_FILE = 24;
export const DEFAULT_MAP_MAX_CHARS = 60000;

// One pattern per family; the first capture group is the name.
const SYMBOL_PATTERNS = [
  // JS / TS
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/gm,
  /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*class\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
  /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  // Python
  /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm,
  // Go
  /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm,
  /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm,
  // Rust
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
  // Ruby
  /^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/gm,
  // Java / C# / Kotlin (methods with an access modifier)
  /^\s*(?:public|private|protected|internal)\s+(?:static\s+)?(?:[\w<>\[\],\s]+\s+)?([A-Za-z_]\w*)\s*\([^;]*$/gm,
  /^\s*(?:public\s+|internal\s+)?(?:sealed\s+|abstract\s+|data\s+)?(?:class|interface|record|object)\s+([A-Za-z_]\w*)/gm,
  // HTML/CSS: ids are what other files reach for
  /\bid="([A-Za-z][\w-]*)"/g,
];

const IMPORT_PATTERNS = [
  /\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g, // ES modules
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // CommonJS
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import
  /^\s*from\s+(\.+[\w.]*)\s+import\b/gm, // Python relative
  /<script[^>]+src="([^"]+)"/g, // HTML
  /<link[^>]+href="([^"]+\.css)"/g,
  /@import\s+['"]([^'"]+)['"]/g, // CSS
];

/** Top-level symbol names, in file order, de-duplicated. */
export function extractSymbols(source) {
  const found = [];
  for (const re of SYMBOL_PATTERNS) {
    for (const m of String(source).matchAll(re)) found.push({ name: m[1], index: m.index });
  }
  const seen = new Set();
  return found
    .sort((a, b) => a.index - b.index)
    .map((f) => f.name)
    .filter((n) => n && !['if', 'for', 'while', 'switch', 'return', 'catch'].includes(n) && !seen.has(n) && seen.add(n));
}

/** Relative import specifiers. Bare package names are not part of this project. */
export function extractImports(source) {
  const out = new Set();
  for (const re of IMPORT_PATTERNS) {
    for (const m of String(source).matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) out.add(spec);
    }
  }
  return [...out];
}

/** Resolve a specifier written in `from` to one of `files`, or null. */
export function resolveImport(from, spec, files) {
  const fileSet = files instanceof Set ? files : new Set(files);
  if (!spec.includes('/') && /^\.+[\w.]*$/.test(spec)) {
    // Python relative module: ".utils" or "..pkg.mod"
    const dots = spec.match(/^\.+/)[0].length;
    let base = path.posix.dirname(from);
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    const rest = spec.slice(dots).replace(/\./g, '/');
    const stem = rest ? path.posix.join(base, rest) : base;
    for (const c of [`${stem}.py`, `${stem}/__init__.py`]) if (fileSet.has(c)) return c;
    return null;
  }
  const base = spec.startsWith('/') ? spec.slice(1) : path.posix.join(path.posix.dirname(from), spec);
  const norm = path.posix.normalize(base);
  const candidates = [norm, ...['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css'].map((e) => norm + e), ...['index.js', 'index.ts', 'index.mjs'].map((i) => `${norm}/${i}`)];
  // TS source importing "./x.js" that is really "./x.ts".
  if (/\.js$/.test(norm)) candidates.push(norm.replace(/\.js$/, '.ts'), norm.replace(/\.js$/, '.tsx'));
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

/**
 * @param {string[]} files  Editable (or any tracked) repository-relative paths.
 * @returns {{entries: Array<{file: string, chars: number, symbols: string[], imports: string[]}>, importers: Map<string, string[]>}}
 */
export function buildImportGraph(files, { repoRoot = process.cwd(), read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8') } = {}) {
  const fileSet = new Set(files);
  const entries = [];
  const importers = new Map(files.map((f) => [f, []]));
  for (const file of files) {
    let source;
    try { source = read(file); } catch { continue; }
    const imports = [...new Set(extractImports(source).map((s) => resolveImport(file, s, fileSet)).filter((r) => r && r !== file))];
    for (const target of imports) importers.get(target)?.push(file);
    entries.push({ file, chars: source.length, symbols: extractSymbols(source), imports });
  }
  return { entries, importers };
}

/**
 * The map as prompt text, capped at `maxChars`. Files beyond the cap are
 * counted, and the prompt says so, rather than silently omitted.
 */
export function renderCodeMap({ entries, importers }, { maxChars = DEFAULT_MAP_MAX_CHARS } = {}) {
  if (!entries.length) return null;
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const e of entries) {
    const used_by = importers.get(e.file) ?? [];
    const symbols = e.symbols.slice(0, MAX_SYMBOLS_PER_FILE);
    const block = [
      `${e.file} (${e.chars.toLocaleString('en-US')} chars)` +
        (e.imports.length ? ` — imports ${e.imports.join(', ')}` : '') +
        (used_by.length ? ` — used by ${used_by.join(', ')}` : ''),
      ...(symbols.length ? [`  ${symbols.join(', ')}${e.symbols.length > symbols.length ? `, … ${e.symbols.length - symbols.length} more` : ''}`] : []),
    ].join('\n');
    if (used + block.length > maxChars) { omitted += 1; continue; }
    lines.push(block);
    used += block.length + 1;
  }
  if (omitted) lines.push(`(${omitted} more editable file(s) not listed: the map hit its ${maxChars.toLocaleString('en-US')}-character cap. They can still be named by path.)`);
  return lines.join('\n');
}

/** Every file that imports any of `changed`, directly — the unchanged callers a reviewer should see. */
export function dependentsOf(changed, importers) {
  const out = new Set();
  for (const f of changed) for (const d of importers.get(f) ?? []) if (!changed.includes(d)) out.add(d);
  return [...out];
}
