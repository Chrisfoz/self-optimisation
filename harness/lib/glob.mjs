import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal glob-to-regex for adapter-supplied path patterns
 * (project-adapter.yml's `constitution.create_only_paths`, and similar).
 * Not a general-purpose glob library — just enough to turn
 * "tests/game-logic/*.test.js" into the equivalent of what carrotgame wrote
 * by hand as a raw regex, without asking every adapter author to write
 * regex literals in YAML.
 *
 * Supported: `*` (any run of characters except `/`), `**` (any run of
 * characters including `/`), everything else is escaped literally.
 */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Does this adapter path use a pattern, or name one exact file? */
export function isGlob(p) {
  return typeof p === 'string' && p.includes('*');
}

/**
 * Every existing file under `repoRoot` matching `pattern`, relative and
 * forward-slashed, sorted for a stable prompt.
 *
 * Walks from the pattern's own literal prefix rather than the repository
 * root: `game/**` descends into `game/`, never into `node_modules/` or
 * `.git/`. A pattern whose prefix does not exist yields nothing rather than
 * throwing, because "no files yet" and "wrong path" are the caller's
 * distinction to make, not this function's.
 *
 * @param {string} pattern   e.g. "game/**" or "src/levels/*.mjs"
 * @param {{repoRoot?: string, limit?: number}} [opts]
 * @returns {string[]}
 */
export function expandGlob(pattern, { repoRoot = process.cwd(), limit = 500 } = {}) {
  const re = globToRegExp(pattern);
  const prefix = pattern.slice(0, pattern.indexOf('*')).replace(/[^/]*$/, '');
  const start = path.join(repoRoot, prefix);
  const out = [];

  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable or absent — nothing to contribute
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, full).split(path.sep).join('/');
      // Never walk into these, whatever a pattern says: they are large,
      // machine-managed, and nothing in them is a project's own source.
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (re.test(rel)) {
        out.push(rel);
      }
    }
  };

  walk(start);
  return out.sort();
}
