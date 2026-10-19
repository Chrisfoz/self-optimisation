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

// Credential-shaped CONTENT, for a secret committed under an innocent name
// (config/database.yml, src/config.js). A file containing one is never sent
// to a lab, whatever its path. Shapes, not a scanner: the provider keys this
// harness itself handles, cloud and VCS tokens, and private-key blocks.
const SECRET_CONTENT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-)?[A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|xox[abpr]-[A-Za-z0-9-]{10,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})\b/;

/** True for a path the reviewer may be shown. */
export function servable(file) {
  return typeof file === 'string' && !file.startsWith('/') && !file.split('/').includes('..') && !SECRET_PATH.test(file) && TEXT_FILE.test(file);
}

/** True when the text carries something credential-shaped. */
export function looksSecret(text) {
  return SECRET_CONTENT.test(String(text ?? ''));
}

/**
 * The file's size when it is a regular file that resolves inside the
 * repository, else null. A tracked symlink is refused outright, and so is
 * any path whose real location (a symlinked directory on the way) is
 * outside the root: either could point the reviewer at /proc/self/environ
 * or a key file, and send it to a lab with the review.
 */
function regularFileSize(realRoot, repoRoot, file) {
  try {
    const abs = path.join(repoRoot, file);
    if (fs.lstatSync(abs).isSymbolicLink()) return null;
    const real = fs.realpathSync(abs);
    if (!real.startsWith(realRoot + path.sep)) return null;
    const stat = fs.statSync(real);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
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
  let realRoot;
  try { realRoot = fs.realpathSync(repoRoot); } catch { realRoot = path.resolve(repoRoot); }
  const inRepo = (f) => regularFileSize(realRoot, repoRoot, f);
  const indexed = files.filter(servable).filter((f) => {
    const size = inRepo(f);
    return size !== null && size <= MAX_FILE_BYTES;
  }).slice(0, MAX_INDEXED_FILES);
  let graph = null;
  // Every attempt in a run asks again. Cached content is only ever used for
  // files OUTSIDE the attempt's changes (dependents exclude the changed
  // files, and the tree is restored to pristine between attempts), so a
  // cached copy is the file as it is. Files the reviewer asks for are read
  // fresh, since one may be a file this attempt changed.
  const cache = new Map();
  const read = (f) => {
    if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(repoRoot, f), 'utf8'));
    return cache.get(f);
  };

  return {
    /**
     * Excerpts from every unchanged file that imports a changed file, or
     * mentions a symbol whose definition the edits touched. Null when there
     * are none, which drops the section from the review request.
     */
    dependents(changedFiles, edits = []) {
      graph ??= buildImportGraph(indexed, { repoRoot, read });
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
        if (looksSecret(source)) continue;
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
        if (!servable(f) || !files.includes(f) || inRepo(f) === null) { refused.push(`${f} (not a tracked, readable source file)`); continue; }
        let source;
        try { source = fs.readFileSync(path.join(repoRoot, f), 'utf8'); } catch { refused.push(`${f} (unreadable)`); continue; }
        if (looksSecret(source)) { refused.push(`${f} (contains something credential-shaped)`); continue; }
        if (used + source.length > maxChars) { refused.push(`${f} (over the ${maxChars.toLocaleString('en-US')}-character cap)`); continue; }
        blocks.push(`#### ${f}\n\`\`\`\n${source}\n\`\`\``);
        served.push(f);
        used += source.length;
      }
      return { text: blocks.join('\n\n') || null, served, refused };
    },
  };
}
