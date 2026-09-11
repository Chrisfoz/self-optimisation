#!/usr/bin/env node

/**
 * Pick, claim and check out the next generation — the workflow's numbering
 * step, and the one rehearse.mjs uses. See harness/lib/generation-id.mjs.
 *
 * Usage:
 *   node harness/scripts/next-generation.mjs [--base <branch>] [--remote origin]
 *     [--generations-dir <dir>] [--no-checkout]
 *
 * --remote claims the branch on that remote (the workflow); without it the
 * claim is a local branch (a rehearsal). Either way the branch is created
 * only if it does not exist, and the number moves up past any that do.
 *
 * GITHUB_OUTPUT: number, branch, run-id, run-url.
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadAdapter, contextConfig } from '../lib/adapter.mjs';
import { nextGenerationNumber, reserveGeneration, runIdentity } from '../lib/generation-id.mjs';
import { setOutput } from '../lib/gh-output.mjs';

function parseArgs(argv) {
  const out = { checkout: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--remote') out.remote = argv[++i];
    else if (argv[i] === '--generations-dir') out.generationsDir = argv[++i];
    else if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--no-checkout') out.checkout = false;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
let adapter = null;
try { adapter = await loadAdapter(adapterPath); } catch { /* flags and defaults still work */ }

const base = args.base || adapter?.project?.default_branch || 'main';
const generationsDir = args.generationsDir || (adapter ? contextConfig(adapter).generationsDir : null) || 'docs/generations';
const remote = args.remote || null;
const baseRef = remote ? `${remote}/${base}` : base;

try {
  const run = runIdentity();
  const start = nextGenerationNumber(git, { generationsDir, baseRef });
  const { number, branch, collisions } = reserveGeneration(git, { start, remote, runId: run.id });
  if (collisions.length) console.error(`⚠️  gen-${collisions.join(', gen-')} already claimed by another run; took ${number}.`);
  if (args.checkout) git('checkout', '--quiet', branch);
  console.error(`🔢 Generation ${number} on ${branch}${remote ? ` (claimed on ${remote})` : ''} — run ${run.id}`);
  setOutput('number', number);
  setOutput('branch', branch);
  setOutput('run-id', run.id);
  setOutput('run-url', run.url ?? '');
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
