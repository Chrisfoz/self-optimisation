#!/usr/bin/env node

/**
 * The one shipped evaluator plugin — an example of the interface in
 * ../README.md, and a dimension that happens to be genuinely worth watching
 * on a codebase that edits itself every month.
 *
 * **What it measures:** how much editable source there is, and how it is
 * distributed. A loop improving a project one generation at a time has a
 * standing tendency nobody explicitly asked for: every generation adds, few
 * remove, and after twenty of them the largest file is twice the size it was
 * and nothing in the record says when that happened. Tests do not catch it —
 * the code works. A review does not catch it — each individual diff is
 * small. It is exactly the kind of thing a measured, non-gating dimension
 * exists for.
 *
 * **What it deliberately does not do:** fail anything. Growth is often
 * correct. This plugin has no threshold, no budget, and no opinion — see
 * ../README.md's fourth rule. A project that wants a real ceiling already has
 * one in `constitution.churn_ceiling`, which is a gate and is enforced as
 * one.
 *
 * The dimension is an example. The shape is the point: read the tree, read
 * the generation record, return named numbers, never throw at the caller.
 */

import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp } from '../../../lib/glob.mjs';

/** Walk a directory tree, returning repo-relative POSIX paths. Skips the places nobody means to measure. */
function walk(root, relative = '', skip = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__'])) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel, skip));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object|null} opts.generation  This generation's attempts.json.
 * @param {{paths?: string[], largeFileLines?: number}} opts.config
 *   `paths` are globs — default `['**']`, i.e. the whole tree minus the skip
 *   list. A project usually points this at its own
 *   `constitution.allowed_paths`, since that is the surface the loop can
 *   actually inflate.
 */
export async function evaluate({ repoRoot, generation, config = {} }) {
  const patterns = (config.paths?.length ? config.paths : ['**']).map(globToRegExp);
  const largeFileLines = Number.isFinite(config.largeFileLines) ? config.largeFileLines : 500;

  const files = walk(repoRoot).filter((f) => patterns.some((re) => re.test(f)));

  let totalLines = 0;
  let largest = { file: null, lines: 0 };
  let overThreshold = 0;

  for (const file of files) {
    let lines;
    try {
      const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      // A file with no trailing newline still has a last line; one that is
      // empty has none. Counting split('\n').length would report 1 for both.
      lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    } catch {
      continue; // a binary or unreadable file is not a source-weight question
    }
    totalLines += lines;
    if (lines > largest.lines) largest = { file, lines };
    if (lines >= largeFileLines) overThreshold += 1;
  }

  if (files.length === 0) {
    // Honest empty result rather than a row of zeros implying a measurement
    // happened. Almost always a misconfigured `paths`.
    return [];
  }

  const changed = Array.isArray(generation?.filesChanged) ? generation.filesChanged.length : null;

  return [
    {
      name: 'source lines',
      value: totalLines,
      unit: 'lines',
      direction: 'lower',
      detail: `across ${files.length} measured file(s)${changed === null ? '' : `; this generation touched ${changed}`}`,
    },
    {
      name: 'largest file',
      value: largest.lines,
      unit: 'lines',
      direction: 'lower',
      detail: largest.file ? `${largest.file}` : null,
    },
    {
      name: `files over ${largeFileLines} lines`,
      value: overThreshold,
      direction: 'lower',
      detail: overThreshold === 0 ? 'none — nothing has grown past the threshold yet' : null,
    },
  ];
}

export default { name: 'source-weight', evaluate };
