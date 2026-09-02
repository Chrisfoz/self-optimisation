#!/usr/bin/env node

/**
 * Rollback — take a shipped generation back, and write down that a person
 * did.
 *
 * Every gate in this loop is a prediction: review predicts the change is
 * what the proposal said, the tests predict the project still works, the
 * guard predicts nothing frozen moved. None of them can predict that the
 * owner wanted the project to work THAT way. The ambition dial
 * (docs/Ambition-Control.md) lets an unattended run attempt more, so the
 * correction has to be as easy as the dial: one command, on either merge
 * model, that reverts the merge and records it where the next run reads.
 *
 * What it does not do: rewrite history (a revert is a new commit, like the
 * harness's own promotions), delete the branch or the tag, or touch any
 * other generation.
 *
 * Same shape as promote.mjs: real git, injectable for tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function defaultGit(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Default `gh` runner: the merge commit of a pull request, or null. */
function defaultGh(url) {
  const raw = execFileSync('gh', ['pr', 'view', url, '--json', 'mergeCommit'], { encoding: 'utf8' });
  return JSON.parse(raw)?.mergeCommit?.oid ?? null;
}

function readRecord(absolute) {
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The commit that shipped generation NNN, found in this order:
 *   1. the `gen-NNN` tag (autonomous merge — promote.mjs tags every merge)
 *   2. `pullRequest.mergeCommit` in attempts.json (read back by
 *      harness/lib/pull-requests.mjs)
 *   3. `pullRequestUrl` in attempts.json, asked of gh now
 *
 * @returns {{commit: string, via: 'tag'|'record'|'gh'}}
 */
export function findShippedCommit({ repoRoot, genNumber, generationsDir = 'docs/generations', git, gh = defaultGh }) {
  const tag = `gen-${genNumber}`;
  try {
    const commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`);
    if (commit) return { commit, via: 'tag' };
  } catch {
    // No tag: the pull-request path.
  }

  const record = readRecord(path.join(repoRoot, generationsDir, `gen-${genNumber}`, 'attempts.json'));
  if (record?.pullRequest?.mergeCommit) return { commit: record.pullRequest.mergeCommit, via: 'record' };
  if (record?.pullRequest?.state === 'closed') {
    throw new Error(`Generation ${genNumber}'s pull request was closed without merging; there is nothing to revert.`);
  }
  if (record?.pullRequestUrl) {
    const commit = gh(record.pullRequestUrl);
    if (commit) return { commit, via: 'gh' };
    throw new Error(`Generation ${genNumber}'s pull request (${record.pullRequestUrl}) has not been merged; there is nothing to revert.`);
  }

  throw new Error(`Generation ${genNumber} has no gen-${genNumber} tag and no pull request on record — nothing shipped, or it shipped outside this harness.`);
}

/**
 * Revert a shipped generation on the base branch, push, and record it.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.genNumber          e.g. "007".
 * @param {string} [opts.generationsDir]
 * @param {string} [opts.baseBranch]       Default 'main'.
 * @param {string} [opts.reason]           Written into the record and the commit message.
 * @param {{name: string, email: string}} [opts.identity]
 * @param {(cwd: string) => (...args: string[]) => string} [opts.gitFactory]
 * @param {(url: string) => string|null} [opts.gh]
 * @param {Date} [opts.now]
 * @returns {{reverted: true, genNumber: string, commit: string, revertCommit: string, via: string, recordPath: string|null}}
 */
export function revertGeneration({
  repoRoot,
  genNumber,
  generationsDir = 'docs/generations',
  baseBranch = 'main',
  reason = '',
  identity = { name: 'self-optimisation-bot', email: 'bot@self-optimisation.local' },
  gitFactory = defaultGit,
  gh = defaultGh,
  now = new Date(),
}) {
  if (!genNumber) throw new Error('revertGeneration() requires a generation number.');
  const git = gitFactory(repoRoot);

  git('config', 'user.email', identity.email);
  git('config', 'user.name', identity.name);
  git('fetch', 'origin', baseBranch);
  git('checkout', baseBranch);
  git('merge', '--ff-only', `origin/${baseBranch}`);

  const alreadyReverted = readRecord(path.join(repoRoot, generationsDir, `gen-${genNumber}`, 'attempts.json'))?.reverted;
  if (alreadyReverted) {
    throw new Error(`Generation ${genNumber} was already reverted on ${alreadyReverted.date} (${alreadyReverted.revertCommit}).`);
  }

  const { commit, via } = findShippedCommit({ repoRoot, genNumber, generationsDir, git, gh });

  // A merge commit needs -m 1 (keep the base branch's side); a squash or
  // rebase merge is an ordinary commit and must not get it.
  const parents = git('rev-list', '--parents', '-n', '1', commit).split(/\s+/).slice(1);
  const args = parents.length > 1 ? ['revert', '--no-edit', '-m', '1', commit] : ['revert', '--no-edit', commit];
  git(...args);
  const revertCommit = git('rev-parse', 'HEAD');

  // Record it where the next run reads: the generation's own attempts.json.
  // Its absence (a generation shipped before records existed) is not
  // fatal — the revert already happened and is what mattered.
  let recordPath = null;
  const relative = `${generationsDir}/gen-${genNumber}/attempts.json`;
  const absolute = path.join(repoRoot, relative);
  const record = readRecord(absolute);
  if (record) {
    record.reverted = {
      date: now.toISOString().slice(0, 10),
      reason: reason || null,
      commit,
      revertCommit,
      via,
    };
    fs.writeFileSync(absolute, JSON.stringify(record, null, 2) + '\n', 'utf8');
    git('add', '--', relative);
    git('commit', '-m', `Record the revert of generation ${genNumber}${reason ? `: ${reason}` : ''}`);
    recordPath = relative;
  }

  git('push', 'origin', baseBranch);

  return { reverted: true, genNumber, commit, revertCommit, via, recordPath };
}
