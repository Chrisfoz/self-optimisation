#!/usr/bin/env node

/**
 * Take a shipped generation back. See harness/lib/rollback.mjs and
 * docs/Ambition-Control.md §4 for why this exists beside the ambition dial.
 *
 * Usage: node harness/scripts/revert-generation.mjs <NNN> [--reason "..."] [--base <branch>] [--generations-dir <dir>]
 *
 * Works on either merge model: the gen-NNN tag on the autonomous path, the
 * pull request's merge commit on the default path (from attempts.json, or
 * asked of `gh` if the sync has not run since the merge). Reverts on the
 * base branch, pushes, and writes `reverted` into that generation's record
 * so the next run's history says a person took this one back.
 *
 * Run it from the project root with push access to the base branch — a
 * developer checkout, or a workflow_dispatch step with contents: write.
 */

import { revertGeneration } from '../lib/rollback.mjs';
import { loadAdapter, contextConfig } from '../lib/adapter.mjs';

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reason') out.reason = argv[++i];
    else if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--generations-dir') out.generationsDir = argv[++i];
    else out.positional.push(argv[i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const raw = args.positional[0];
if (!raw) {
  console.error('Usage: node harness/scripts/revert-generation.mjs <NNN> [--reason "..."] [--base <branch>] [--generations-dir <dir>]');
  process.exit(1);
}
const genNumber = /^\d+$/.test(raw) ? raw.padStart(3, '0') : raw.replace(/^gen-/, '');

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const adapter = await loadAdapter();
const ctx = contextConfig(adapter);

try {
  const result = revertGeneration({
    repoRoot,
    genNumber,
    generationsDir: args.generationsDir || process.env.GENERATIONS_DIR || ctx.generationsDir || 'docs/generations',
    baseBranch: args.base || process.env.BASE_BRANCH || adapter?.project?.default_branch || 'main',
    reason: args.reason || process.env.REASON || '',
  });
  console.error(`Reverted generation ${result.genNumber} (${result.commit.slice(0, 12)}, found via ${result.via}) in ${result.revertCommit.slice(0, 12)} on ${args.base || 'the base branch'}.`);
  if (result.recordPath) console.error(`Recorded in ${result.recordPath}; the next run will read it as REVERTED.`);
  else console.error('No attempts.json for that generation — the revert happened, but nothing could be recorded.');
  process.exit(0);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
