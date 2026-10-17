/**
 * What the reviewer can see besides the diff: the unchanged files that
 * depend on the change, and any file it asks for. The diff and the touched
 * files alone cannot show a caller that the change just broke, and on a
 * large repository that is the regression most likely to get through — the
 * implementer saw only the files the proposal named, and the in-loop tests
 * only catch what they cover.
 *
 * Read-only by construction: nothing here is ever an edit target, and a file
 * the reviewer asks for grants no permission to change it. Credentials are
 * never served: secret-shaped paths are refused whatever is asked.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildImportGraph, dependentsOf, extractSymbols } from './code-map.mjs';

export const DEFAULT_EVIDENCE_MAX_CHARS = 30000;
const PER_FILE_MAX_CHARS = 3000;
const MAX_FILE_BYTES = 300000;
const MAX_INDEXED_FILES = 5000;

const SECRET_PATH = /(^|\/)(\.env(\.|$)|\.npmrc$|\.pypirc$|\.netrc$|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx|keystore|jks)$)|secret|credential|password/i;
const TEXT_FILE = /\.(m?[jt]sx?|cjs|py|go|rs|rb|java|kt|cs|php|swift|c|cc|cpp|h|hpp|html?|css|scss|vue|svelte|json|ya?ml|toml|md|sql|sh)$/i;

/** True for a path the reviewer may be shown. */
export function servable(file) {
  return typeof file === 'string' && !file.startsWith('/') && !file.split('/').includes('..') && !SECRET_PATH.test(file) && TEXT_FILE.test(file);
}

/**
 * Names whose definitions the edits touched: a caller elsewhere is what
 * changing one of these can break.
 */
export function touchedSymbols(edits = []) {
  const names = new Set();
  for (const e of edits) {
    for (const n of extractSymbols(`${e.search ?? ''}\n${e.replace ?? ''}`)) if (n.length >= 3) names.add(n);
  }
  return [...names];
}

function excerpt(source, symbols, importLines) {
  const lines = source.split('\n');
  const hits = new Set();
  const word = symbols.length ? new RegExp(`\\b(${symbols.map((s) => s.replace(/[$]/g, '\\$')).join('|')})\\b`) : null;
  lines.forEach((line, i) => {
    if ((word && word.test(line)) || importLines.some((re) => re.test(line))) {
      for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) hits.add(j);
    }
  });
  if (!hits.size) return null;
  const out = [];
  let prev = -2;
  for (const i of [...hits].sort((a, b) => a - b)) {
    if (i !== prev + 1 && (prev >= 0 || i > 0)) out.push('   ⋮');
    out.push(`${String(i + 1).padStart(5)}  ${lines[i]}`);
    prev = i;
  }
  return out.join('\n').slice(0, PER_FILE_MAX_CHARS);
}

/**
 * @param {{repoRoot: string, files: string[], maxChars?: number}} opts
 *   `files`: tracked, repository-relative paths (git ls-files) — the index
 *   the dependents are found in.
 */
export function createReviewEvidence({ repoRoot, files, maxChars = DEFAULT_EVIDENCE_MAX_CHARS }) {
  const indexed = files.filter(servable).filter((f) => {
    try { return fs.statSync(path.join(repoRoot, f)).size <= MAX_FILE_BYTES; } catch { return false; }
  }).slice(0, MAX_INDEXED_FILES);
  let graph = null;
  const read = (f) => fs.readFileSync(path.join(repoRoot, f), 'utf8');

  return {
    /**
     * Excerpts from every unchanged file that imports a changed file, or
     * mentions a symbol whose definition the edits touched. Null when there
     * are none, which drops the section from the review request.
     */
    dependents(changedFiles, edits = []) {
      graph ??= buildImportGraph(indexed, { repoRoot });
      const symbols = touchedSymbols(edits);
      const byImport = dependentsOf(changedFiles, graph.importers);
      const bySymbol = symbols.length
        ? indexed.filter((f) => !changedFiles.includes(f) && !byImport.includes(f)).filter((f) => {
            try { return new RegExp(`\\b(${symbols.map((s) => s.replace(/[$]/g, '\\$')).join('|')})\\b`).test(read(f)); } catch { return false; }
          })
        : [];
      const blocks = [];
      let used = 0;
      let omitted = 0;
      for (const f of [...byImport, ...bySymbol]) {
        let source;
        try { source = read(f); } catch { continue; }
        const importRes = changedFiles.map((c) => new RegExp(`['"(/]${path.posix.basename(c).replace(/\.\w+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.\\w+)?['")]`));
        const text = excerpt(source, symbols, byImport.includes(f) ? importRes : []);
        if (!text) continue;
        const block = `#### ${f} — ${byImport.includes(f) ? 'imports a changed file' : `mentions ${symbols.filter((s) => new RegExp(`\\b${s.replace(/[$]/g, '\\$')}\\b`).test(source)).join(', ')}`}\n\`\`\`\n${text}\n\`\`\``;
        if (used + block.length > maxChars) { omitted += 1; continue; }
        blocks.push(block);
        used += block.length;
      }
      if (!blocks.length) return null;
      if (omitted) blocks.push(`(${omitted} more dependent file(s) not shown: the evidence hit its ${maxChars.toLocaleString('en-US')}-character cap. Ask for any by name.)`);
      return blocks.join('\n\n');
    },

    /** Files the reviewer asked for, in full, within the cap. Refusals are named, never silent. */
    read(paths) {
      const served = [];
      const refused = [];
      const blocks = [];
      let used = 0;
      for (const f of paths) {
        if (!servable(f) || !files.includes(f)) { refused.push(`${f} (not a tracked, readable source file)`); continue; }
        let source;
        try { source = read(f); } catch { refused.push(`${f} (unreadable)`); continue; }
        if (used + source.length > maxChars) { refused.push(`${f} (over the ${maxChars.toLocaleString('en-US')}-character cap)`); continue; }
        blocks.push(`#### ${f}\n\`\`\`\n${source}\n\`\`\``);
        served.push(f);
        used += source.length;
      }
      return { text: blocks.join('\n\n') || null, served, refused };
    },
  };
}
