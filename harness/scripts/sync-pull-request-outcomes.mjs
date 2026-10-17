#!/usr/bin/env node

/**
 * CLI for harness/lib/pull-requests.mjs's syncPullRequests(): for every
 * generation whose pull request is recorded but not yet known to be merged
 * or closed, ask GitHub (via `gh`, authenticated from GH_TOKEN) and write
 * the answer into that generation's attempts.json.
 *
 * Usage: node harness/scripts/sync-pull-request-outcomes.mjs [--generations-dir <dir>]
 *
 * Always exits 0. This is bookkeeping run at the top of every cycle; a
 * transient GitHub error is logged per record and must not stop the run.
 * Emits `updated=<n>` and `closed-unmerged=<comma-separated gens>` to
 * GITHUB_OUTPUT so the workflow and the digest can say what changed.
 */

import { syncPullRequests } from '../lib/pull-requests.mjs';
import { setOutput } from '../lib/gh-output.mjs';
import { refreshLessons } from '../lib/lessons.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--generations-dir') out.generationsDir = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const generationsDir = args.generationsDir || process.env.GENERATIONS_DIR || 'docs/generations';

const result = syncPullRequests({ repoRoot, generationsDir, log: (msg) => console.error(msg) });
console.error(`Checked ${result.checked} pull request(s); ${result.updated.length} updated, ${result.failed.length} could not be read.`);
// A merge, a close or a revert is the verdict that verifies a lesson, so the
// ledger is re-derived after every read-back (harness/lib/lessons.mjs).
try {
  const ledger = refreshLessons({ repoRoot, generationsDir });
  if (ledger.lessons.length) console.error(`Lessons: ${ledger.lessons.filter((l) => l.status === 'verified').length} verified, ${ledger.lessons.filter((l) => l.status === 'candidate').length} candidate, ${ledger.lessons.filter((l) => l.status === 'stale').length} stale.`);
} catch (err) {
  console.error(`Could not update the lessons: ${err.message}`);
}
setOutput('updated', String(result.updated.length));
setOutput('closed-unmerged', result.updated.filter((u) => u.state === 'closed').map((u) => u.genNumber).join(','));
process.exit(0);
