/**
 * Commit a generation's record to the default branch, whatever the
 * generation's outcome — in a temporary worktree, so the checkout the rest
 * of the job is using is never switched, stashed or touched.
 *
 * Why this exists: records used to ride the agent branch. On the default
 * pull-request path that meant a generation's record reached the default
 * branch only if a person merged its pull request, and on either path a
 * generation that was abandoned, crashed, found no proposal or ran out of
 * budget committed nothing at all — the attempt record was written into the
 * working tree of a throwaway runner and deleted with it. The failures, the
 * part of the history the next generation most needs to read, were exactly
 * the part that never survived. It also blinded the pull-request read-back
 * (harness/lib/pull-requests.mjs), which looks for records on the default
 * branch and so could only ever see the generations that had merged.
 *
 * Now the agent branch carries the code change and nothing else, and the
 * record lands here on every outcome. Keeping the two apart also keeps the
 * pull request mergeable: the read-back writes a PR's state into the
 * default branch's copy of the record while the PR is open, and a second
 * copy on the agent branch would conflict with it.
 *
 * Only files this run actually changed or created are copied (read from
 * `git status` in the job's own checkout), so a record directory shared by
 * many generations is never rolled back to the state it was in when this
 * run started.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Paths (repo-relative, POSIX) under `roots` that `git status` reports as new or modified. Deletions are ignored: a record is never removed by this. */
export function changedFiles(git, roots) {
  const present = roots.filter(Boolean);
  if (!present.length) return [];
  const raw = git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...present);
  const entries = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++; // the next entry is the rename's source
    if (status.includes('D')) continue;
    out.push(file);
  }
  return [...new Set(out)];
}

function makeGit(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot            The job's checkout.
 * @param {string[]} opts.roots             Record paths to consider (a generation dir, the ledger file, the themes dir...).
 * @param {string} opts.baseBranch          The default branch.
 * @param {string|null} [opts.remote]       "origin" to push; null for a local rehearsal, which commits to the local branch only.
 * @param {string} opts.message             Commit message.
 * @param {{name: string, email: string}} [opts.identity]
 * @param {number} [opts.attempts]          Push attempts; each starts from a fresh worktree on the newest tip.
 * @param {(msg: string) => void} [opts.log]
 * @param {(attempt: number) => void} [opts.beforePush]  Test hook, to lose a race on purpose.
 * @returns {{committed: boolean, pushed: boolean, sha: string|null, files: string[], attempts: number}}
 */
export function persistRecords({
  repoRoot, roots, baseBranch, remote = 'origin', message,
  identity = { name: 'Self-Improvement Bot', email: 'self-improvement-bot@github-actions.local' },
  attempts = 3, log = () => {}, beforePush = () => {},
}) {
  const git = makeGit(repoRoot);
  const files = changedFiles(git, roots);
  if (!files.length) {
    log('Nothing to persist — this run changed no record files.');
    return { committed: false, pushed: false, sha: null, files, attempts: 0 };
  }

  // A local rehearsal whose base branch is the checkout itself: commit in
  // place. (A worktree cannot check out a branch that is already checked
  // out, and there is nothing to isolate from.)
  const current = (() => { try { return git('symbolic-ref', '--quiet', '--short', 'HEAD'); } catch { return ''; } })();
  if (!remote && current === baseBranch) {
    git('add', '-A', '--', ...files);
    git('-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--quiet', '-m', message, '--', ...files);
    return { committed: true, pushed: false, sha: git('rev-parse', 'HEAD'), files, attempts: 1 };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let base;
    if (remote) {
      git('fetch', '--quiet', remote, `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`);
      base = `${remote}/${baseBranch}`;
    } else {
      base = baseBranch;
    }
    const oldSha = git('rev-parse', base);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-records-'));
    try {
      git('worktree', 'add', '--quiet', '--detach', tmp, oldSha);
      const wt = makeGit(tmp);
      for (const file of files) {
        const dest = path.join(tmp, file);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, file), dest);
      }
      wt('add', '-A', '--', ...files);
      try {
        wt('diff', '--cached', '--quiet');
        log(`The default branch already holds this record (${files.length} file(s)); nothing to commit.`);
        return { committed: false, pushed: false, sha: oldSha, files, attempts: attempt };
      } catch { /* there is a difference: commit it */ }
      wt('-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, 'commit', '--quiet', '-m', message);
      const sha = wt('rev-parse', 'HEAD');

      if (!remote) {
        // Compare-and-swap, so a concurrent local commit is never clobbered.
        git('update-ref', `refs/heads/${baseBranch}`, sha, oldSha);
        return { committed: true, pushed: false, sha, files, attempts: attempt };
      }
      beforePush(attempt);
      try {
        wt('push', '--quiet', remote, `HEAD:refs/heads/${baseBranch}`);
        log(`Persisted ${files.length} record file(s) to ${baseBranch} (${sha.slice(0, 7)}).`);
        return { committed: true, pushed: true, sha, files, attempts: attempt };
      } catch (err) {
        lastError = err;
        log(`   push to ${baseBranch} was rejected (attempt ${attempt}/${attempts}) — someone pushed first; retrying on the new tip.`);
      }
    } finally {
      try { git('worktree', 'remove', '--force', tmp); } catch { /* best effort */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  throw new Error(`Could not persist the record to ${baseBranch} after ${attempts} attempt(s): ${lastError?.stderr?.toString?.().trim() || lastError?.message}`);
}
