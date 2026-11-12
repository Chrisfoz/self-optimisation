/**
 * The install record: what `harness/` looked like the moment it was copied in.
 *
 * A copied install is a folder with no package manager behind it, so nothing
 * could say whether a file in it was the release's or somebody's edit. That
 * mattered in practice. Of the first four copied installs, three had drifted
 * within weeks: fixes back-ported by hand ahead of a release, a project that
 * missed one of them, and a local patch that was never sent upstream. The
 * next `upgrade` would have replaced all of it without a word, because
 * "replace the folder" cannot tell a stale file from a deliberate one.
 *
 * `bin/self-optimisation.mjs` writes `harness/INSTALLED.json` after every
 * copy: the version, and a SHA-256 for each file. `upgrade` reads it before
 * replacing anything and refuses when a local edit would be lost; `doctor`
 * reports the same list. An install with no record (copied with `cp -r`, or
 * before 0.4.0) behaves exactly as it always did.
 *
 * Line endings are normalised before hashing, so a Windows checkout with
 * `core.autocrlf` is not reported as edited from top to bottom.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_FILE = 'INSTALLED.json';

/** Never part of a release, so never part of the record: keys, installed packages, the record itself. */
const EXCLUDED = new Set(['.env.harness.local', 'node_modules', MANIFEST_FILE]);

function hashFile(file) {
  const bytes = fs.readFileSync(file);
  // Binary files (a NUL byte) are hashed as they are; text has CRLF folded to LF.
  const data = bytes.includes(0) ? bytes : Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * @param {string} dir  A harness/ directory.
 * @returns {Record<string, string>} posix-style relative path → sha256, sorted by path.
 */
export function hashTree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out[child] = hashFile(path.join(dir, child));
    }
  };
  walk('');
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Record `dir` as it is now. Called straight after a copy, never on a folder that may hold edits. */
export function writeManifest(dir, version) {
  const manifest = { version: version ?? null, files: hashTree(dir) };
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** @returns {{version: string|null, files: Record<string,string>}|null} null when absent or unreadable. */
export function readManifest(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8'));
    return parsed && typeof parsed.files === 'object' && parsed.files ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * How `dir` differs from its own install record.
 *
 * @returns {{version: string|null, modified: string[], added: string[], missing: string[]}|null}
 *   null when there is no record to compare with.
 */
export function localEdits(dir) {
  const manifest = readManifest(dir);
  if (!manifest) return null;
  const now = hashTree(dir);
  return {
    version: manifest.version ?? null,
    modified: Object.keys(now).filter((f) => f in manifest.files && manifest.files[f] !== now[f]),
    added: Object.keys(now).filter((f) => !(f in manifest.files)),
    missing: Object.keys(manifest.files).filter((f) => !(f in now)),
  };
}

/**
 * The local edits a replacement by `incoming` would actually destroy: edited
 * or added files whose content is not what the incoming release holds at the
 * same path. A fix back-ported by hand and then released is not a loss.
 *
 * @returns {string[]|null} null when `dir` has no install record.
 */
export function editsLostBy(dir, incoming) {
  const edits = localEdits(dir);
  if (!edits) return null;
  const now = hashTree(dir);
  const next = hashTree(incoming);
  return [...edits.modified, ...edits.added].filter((f) => next[f] !== now[f]).sort();
}
