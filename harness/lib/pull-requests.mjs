#!/usr/bin/env node

/**
 * Read the fate of a generation's pull request back into its record.
 *
 * In the default merge model (human-approval-required) the workflow opens
 * a pull request and stops; a person merges it or closes it. That decision
 * is the best outcome signal the harness has — it is the only judgement in
 * the whole loop that is not the harness grading itself — and until this
 * file existed it was discarded: record-pull-request.mjs wrote the URL and
 * nothing ever asked what became of it. `recommendScope()` counted a
 * closed-unmerged generation as a clean success, and the next prompt's
 * history said MERGED about a change a person had rejected.
 *
 * Pure apart from the injectable `exec` (which runs `gh`) and the record
 * files it reads and writes. The workflow runs the sync at the top of
 * every cycle, on the default branch, before the agent branch is created.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** States a record can carry. `open` is re-checked next cycle; the other two are final. */
export const PR_STATES = ['open', 'merged', 'closed'];

/** @returns {{owner: string, repo: string, number: number}|null} */
export function parsePullRequestUrl(url) {
  const m = typeof url === 'string' ? url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/) : null;
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

/** Default `gh` runner. Returns the parsed JSON `gh pr view` prints. */
function defaultExec(url) {
  const raw = execFileSync('gh', ['pr', 'view', url, '--json', 'state,mergedAt,closedAt,mergeCommit'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

/**
 * Normalise `gh pr view`'s answer into the record's shape.
 * gh reports state as OPEN | MERGED | CLOSED.
 */
export function normalizePullRequest(raw, { now = new Date() } = {}) {
  const state = String(raw?.state ?? '').toLowerCase();
  if (!PR_STATES.includes(state)) return null;
  return {
    state,
    mergedAt: raw.mergedAt ?? null,
    closedAt: raw.closedAt ?? null,
    mergeCommit: raw.mergeCommit?.oid ?? raw.mergeCommit ?? null,
    syncedAt: now.toISOString().slice(0, 10),
  };
}

function readRecord(absolute) {
  try {
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Every generation whose pull request still needs asking about: it has a
 * URL, and its recorded state is absent or `open`.
 *
 * @returns {Array<{genNumber: string, relative: string, pullRequestUrl: string, previousState: string|null}>}
 */
export function findUnsynced({ repoRoot = process.cwd(), generationsDir = 'docs/generations' } = {}) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(repoRoot, generationsDir)).filter((d) => /^gen-\d+$/.test(d)).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const dir of dirs) {
    const relative = `${generationsDir}/${dir}/attempts.json`;
    const record = readRecord(path.join(repoRoot, relative));
    if (!record?.pullRequestUrl) continue;
    const previousState = record.pullRequest?.state ?? null;
    if (previousState === 'merged' || previousState === 'closed') continue;
    out.push({ genNumber: dir.replace('gen-', ''), relative, pullRequestUrl: record.pullRequestUrl, previousState });
  }
  return out;
}

/** Write one generation's pull-request state into its record. Touches nothing else. */
export function recordPullRequestState({ repoRoot = process.cwd(), generationsDir = 'docs/generations', genNumber, pullRequest }) {
  const relative = `${generationsDir}/gen-${genNumber}/attempts.json`;
  const absolute = path.join(repoRoot, relative);
  const record = readRecord(absolute);
  if (!record) throw new Error(`Cannot record a pull request state for generation ${genNumber}: ${relative} is missing or not valid JSON.`);
  record.pullRequest = pullRequest;
  fs.writeFileSync(absolute, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return relative;
}

/**
 * Ask about every unsynced pull request and write back what came back.
 * One failing `gh` call is logged and skipped — this is bookkeeping, and a
 * transient error must not stop the cycle or the other records.
 *
 * @returns {{checked: number, updated: Array<{genNumber: string, state: string}>, failed: Array<{genNumber: string, reason: string}>}}
 */
export function syncPullRequests({ repoRoot = process.cwd(), generationsDir = 'docs/generations', exec = defaultExec, log = () => {}, now = new Date() } = {}) {
  const pending = findUnsynced({ repoRoot, generationsDir });
  const updated = [];
  const failed = [];
  for (const item of pending) {
    let normalized;
    try {
      normalized = normalizePullRequest(exec(item.pullRequestUrl), { now });
    } catch (err) {
      failed.push({ genNumber: item.genNumber, reason: err.message });
      log(`   ⚠️  gen-${item.genNumber}: could not read ${item.pullRequestUrl} — ${err.message}`);
      continue;
    }
    if (!normalized) {
      failed.push({ genNumber: item.genNumber, reason: 'unrecognised state' });
      continue;
    }
    if (normalized.state === item.previousState) continue;
    recordPullRequestState({ repoRoot, generationsDir, genNumber: item.genNumber, pullRequest: normalized });
    updated.push({ genNumber: item.genNumber, state: normalized.state });
    log(`   gen-${item.genNumber}: pull request is ${normalized.state}`);
  }
  return { checked: pending.length, updated, failed };
}
