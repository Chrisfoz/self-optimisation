#!/usr/bin/env node

/**
 * Guard rail for autonomous changes — the bounded-authority enforcement
 * that runs in CI against a branch an agent owns. Ported from carrotgame's
 * scripts/check-guarded-paths.mjs (the reference implementation).
 *
 * An agent that can edit its own test suite, its own workflow, or its own
 * scope file has no constraints at all — the cheapest way to make a
 * failing build pass is to delete the test. Four kinds of rule, checked
 * against a git diff:
 *
 *   frozen        the path may not change at all
 *   appendOnly    new files may be added; existing ones may not be edited
 *                 or removed
 *   frozenFields  named top-level JSON fields in a given file must be
 *                 byte-identical even if the rest of the file changes
 *   churn ceiling a file-count/line-count backstop against a run that has
 *                 lost the plot — not a design constraint
 *
 * Genericised in the same way as everything else in this harness: the
 * reference implementation hardcoded its own paths as module-level regex
 * literals; here every rule is a parameter, sourced by the CLI wrapper
 * (harness/scripts/check-guarded-paths.mjs) from a project's
 * project-adapter.yml. The mechanism — how a diff gets checked — is what's
 * portable; which paths are frozen is always project-specific.
 *
 * Humans are not subject to this by convention, not by anything this
 * function itself enforces: the CLI wrapper only runs it in CI against
 * branches an agent owns (see that file's own doc for the exact condition).
 */

import { execFileSync } from 'node:child_process';

/** Default git command runner — shells out for real. Injectable (see checkGuardedPaths's `git` option) so tests never need a real git process. */
function defaultGit(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function changedFiles(git, baseRef) {
  // status<TAB>path, with a second path for renames.
  const raw = git('diff', '--name-status', '--find-renames', `${baseRef}...HEAD`);
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const parts = line.split('\t');
    return { status: parts[0][0], path: parts[parts.length - 1], from: parts.length > 2 ? parts[1] : null };
  });
}

function jsonAt(git, ref, path) {
  try {
    return JSON.parse(git('show', `${ref}:${path}`));
  } catch {
    return null;
  }
}

/**
 * Check a git diff against a project's guard rules.
 *
 * @param {object} opts
 * @param {string} opts.baseRef  The ref to diff HEAD against, e.g. `origin/main`.
 * @param {RegExp[]} [opts.frozenPaths]  Paths that may not change at all.
 * @param {RegExp[]} [opts.appendOnlyPaths]  Paths where only new files (status 'A') are allowed.
 * @param {Record<string, string[]>} [opts.frozenFields]  File path -> field names that must be byte-identical.
 * @param {number} [opts.maxFiles]  Default 50 — a backstop, not a design constraint.
 * @param {number} [opts.maxLines]  Default 10000.
 * @param {(...args: string[]) => string} [opts.git]  Injectable git command runner, for tests.
 * @returns {{violations: string[], filesChanged: number, linesChanged: number, pass: boolean}}
 */
export function checkGuardedPaths({
  baseRef,
  frozenPaths = [],
  appendOnlyPaths = [],
  frozenFields = {},
  maxFiles = 50,
  maxLines = 10000,
  git = defaultGit,
} = {}) {
  if (!baseRef) throw new Error('checkGuardedPaths requires a baseRef.');

  const violations = [];
  const files = changedFiles(git, baseRef);

  for (const { status, path, from } of files) {
    // A rename must be checked under both its old and new name — freezing
    // a path is meaningless if renaming out of it, or into it, is a way
    // around the rule.
    const candidates = from ? [path, from] : [path];

    for (const candidate of candidates) {
      if (frozenPaths.some((re) => re.test(candidate))) {
        violations.push(`${candidate} is frozen — autonomous changes may not touch it (${status})`);
      }
    }

    if (appendOnlyPaths.some((re) => re.test(path)) && status !== 'A') {
      violations.push(`${path} is append-only — existing files may not be modified or removed (${status})`);
    }
  }

  for (const [path, fields] of Object.entries(frozenFields)) {
    if (!files.some((f) => f.path === path)) continue;
    const before = jsonAt(git, baseRef, path);
    const after = jsonAt(git, 'HEAD', path);
    if (!before || !after) continue;

    for (const field of fields) {
      if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
        violations.push(`${path}: the "${field}" field is frozen and was changed`);
      }
    }
  }

  if (files.length > maxFiles) {
    violations.push(`${files.length} files changed, over the ${maxFiles} allowed for one run`);
  }

  const churn = git('diff', '--shortstat', `${baseRef}...HEAD`);
  const linesChanged = [...churn.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0);
  if (linesChanged > maxLines) {
    violations.push(`${linesChanged} lines changed, over the ${maxLines} allowed for one run`);
  }

  return { violations, filesChanged: files.length, linesChanged, pass: violations.length === 0 };
}
