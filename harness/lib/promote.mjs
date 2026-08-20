#!/usr/bin/env node

/**
 * Staging & promotion — merge an approved agent branch to the default
 * branch and tag the generation. Ported from the reference
 * implementation's workflow YAML (the "merge" job's two `git` steps),
 * which is the one piece of Bucket B that was never its own script —
 * carrotgame's version is inline bash in `.github/workflows/self-improvement.yml`.
 * Made into real, tested code here for the same reason `guard.mjs` is
 * real code rather than inline bash: git operations are exactly the kind
 * of thing worth a test against a real repository rather than trusting a
 * shell script by inspection — see this file's own test suite for the
 * real-git-repo tests that would have caught a wrong flag or argument
 * order.
 *
 * Every generation is a tag (`gen-001`, `gen-002`, …) specifically so it's
 * reversible — `git revert gen-NNN` or a bisect between tags — without
 * needing anything from this harness to undo a bad promotion.
 */

import { execFileSync } from 'node:child_process';

/** Default git command runner — shells out for real. Injectable for tests, same convention as guard.mjs. */
function defaultGit(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/**
 * Merge an agent branch into the default branch and tag it.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.branch       e.g. "agent/gen-001".
 * @param {string} opts.tag          e.g. "gen-001".
 * @param {string} [opts.baseBranch] Default 'main'.
 * @param {{name: string, email: string}} [opts.identity]  Committer
 *   identity for the merge commit. Default is a generic, harmless bot
 *   identity — a project should usually override this via its own adapter
 *   or CI config rather than accept the default silently.
 * @param {(cwd: string) => (...args: string[]) => string} [opts.gitFactory]
 *   Injectable git runner factory, for tests.
 * @returns {{merged: boolean, branch: string, tag: string, baseBranch: string}}
 */
export function promote({
  repoRoot,
  branch,
  tag,
  baseBranch = 'main',
  identity = { name: 'self-optimisation-bot', email: 'bot@self-optimisation.local' },
  gitFactory = defaultGit,
}) {
  if (!branch) throw new Error('promote() requires a branch to merge.');
  if (!tag) throw new Error('promote() requires a tag to apply.');

  const git = gitFactory(repoRoot);

  git('config', 'user.email', identity.email);
  git('config', 'user.name', identity.name);

  git('fetch', 'origin', branch);
  git('checkout', baseBranch);
  // --no-edit: an unattended merge must never open an editor and hang.
  git('merge', `origin/${branch}`, '--no-edit');
  git('push', 'origin', baseBranch);

  git('tag', tag);
  git('push', 'origin', tag);

  return { merged: true, branch, tag, baseBranch };
}

/**
 * Delete the agent branch after a successful merge — only ever called
 * post-merge; a failed run leaves its branch in place deliberately, for a
 * human to inspect.
 */
export function cleanupBranch({ repoRoot, branch, gitFactory = defaultGit }) {
  const git = gitFactory(repoRoot);
  try {
    git('push', 'origin', '--delete', branch);
    return { deleted: true, branch };
  } catch (err) {
    // Best-effort: a branch that's already gone, or a permissions hiccup,
    // must not fail a run that already succeeded at the part that matters.
    return { deleted: false, branch, reason: err.message };
  }
}
