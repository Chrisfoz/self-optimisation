/**
 * Which branch is this repository's default: the one generations are cut
 * from, pull requests target, and a deploy (Railway, Vercel, Pages) usually
 * builds from.
 *
 * init.mjs used to offer `git branch --show-current`, the branch you happen
 * to be on. The walkthrough has you create `self-optimisation-setup` before
 * running init, so every install that followed it proposed the setup branch
 * as the default, and `init --yes` wrote it. The first external install
 * (docs/campaigns/2026-09-17-networkinai-install.md) shipped an adapter
 * saying `default_branch: self-optimisation-setup` until it was corrected by
 * hand.
 *
 * Zero dependencies, and `git` is injected so tests can drive it without
 * spawning processes they don't control.
 */

import { execFileSync } from 'node:child_process';

/** A `git` runner for `cwd`: returns trimmed stdout, or null when git exits non-zero. */
export function gitRunner(cwd) {
  return (...args) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
}

/**
 * The remote's own answer: `refs/remotes/origin/HEAD`, which `git clone`
 * sets to the hosting provider's default branch. Null when there is no
 * remote, or the ref was never set. A shallow CI checkout, or a repository
 * that was `git init`-ed and then given a remote, has none, and that is
 * "unknown", not "wrong".
 *
 * @param {(…args: string[]) => string|null} git
 * @returns {string|null}
 */
export function remoteDefaultBranch(git) {
  const ref = git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  if (!ref) return null;
  return ref.replace(/^origin\//, '') || null;
}

/**
 * The best guess to offer as the default. The remote's answer first; then
 * `main` or `master` if either exists locally or on origin; otherwise null,
 * and the caller decides. Never the current branch: that is the bug this
 * module exists to fix.
 *
 * @param {(…args: string[]) => string|null} git
 * @returns {string|null}
 */
export function detectDefaultBranch(git) {
  const remote = remoteDefaultBranch(git);
  if (remote) return remote;
  for (const name of ['main', 'master']) {
    if (git('show-ref', '--verify', '--quiet', `refs/heads/${name}`) !== null) return name;
    if (git('show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`) !== null) return name;
  }
  return null;
}
