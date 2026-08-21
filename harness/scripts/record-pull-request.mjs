#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/orchestrator.mjs's recordPullRequestUrl().
 *
 * Run as a workflow step AFTER the step that opens the pull request for an
 * approved generation (e.g. right after peter-evans/create-pull-request),
 * never before — the PR doesn't have a URL until that step returns one,
 * and run-generation.mjs has already exited by then, which is why this is
 * a second small write rather than something run-generation.mjs does
 * itself. A generation that didn't ship (no-proposal / abandoned / crashed)
 * has no PR and this script is simply not called for it.
 *
 * Usage: node harness/scripts/record-pull-request.mjs <genNumber> <pullRequestUrl> [--generations-dir <dir>]
 *
 * Exits 1 if the generation's attempts.json doesn't exist yet — that means
 * this ran out of order, against the wrong generation number, or
 * generationsDir doesn't match what run-generation.mjs used.
 */

import path from 'path';
import { recordPullRequestUrl } from '../lib/orchestrator.mjs';

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--generations-dir') out.generationsDir = argv[++i];
    else out.positional.push(argv[i]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [genNumber, pullRequestUrl] = args.positional;

if (!genNumber || !pullRequestUrl) {
  console.error('Usage: node harness/scripts/record-pull-request.mjs <genNumber> <pullRequestUrl> [--generations-dir <dir>]');
  process.exit(1);
}

const repoRoot = process.env.GITHUB_WORKSPACE || process.cwd();
const generationsDir = args.generationsDir || process.env.GENERATIONS_DIR || 'docs/generations';

try {
  const relative = recordPullRequestUrl({ repoRoot, generationsDir, genNumber, pullRequestUrl });
  console.error(`Recorded ${pullRequestUrl} in ${relative}`);
  process.exit(0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
