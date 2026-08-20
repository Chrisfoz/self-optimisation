#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/promote.mjs. Merges an agent branch to
 * the default branch and tags the generation — run only after every other
 * gate (guard, the project's own tests) has already passed against that
 * branch. This script does not check any of that itself; it trusts the
 * caller, the same way the reference implementation's "merge" job only
 * runs after "guard" and "test" already succeeded.
 *
 * Usage: node harness/scripts/promote.mjs [--adapter <path>] [--no-cleanup]
 *
 * Required environment:
 *   GEN_NUMBER   e.g. "001" — used to derive the branch (`agent/gen-001`)
 *                and tag (`gen-001`) unless overridden below.
 *
 * Optional overrides (env, or project-adapter.yml where noted):
 *   BRANCH               default `agent/gen-${GEN_NUMBER}`
 *   TAG                  default `gen-${GEN_NUMBER}`
 *   BASE_BRANCH          default `project.default_branch`, then `main`
 *   COMMIT_NAME / COMMIT_EMAIL   default a generic bot identity
 */

import path from 'path';
import { loadAdapter } from '../lib/adapter.mjs';
import { promote, cleanupBranch } from '../lib/promote.mjs';

function parseArgs(argv) {
  const out = { cleanup: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--no-cleanup') out.cleanup = false;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
const adapter = await loadAdapter(adapterPath);

const genNumber = process.env.GEN_NUMBER;
if (!genNumber) {
  console.error('GEN_NUMBER is required.');
  process.exit(1);
}

const branch = process.env.BRANCH || `agent/gen-${genNumber}`;
const tag = process.env.TAG || `gen-${genNumber}`;
const baseBranch = process.env.BASE_BRANCH || adapter?.project?.default_branch || 'main';
const identity = process.env.COMMIT_NAME
  ? { name: process.env.COMMIT_NAME, email: process.env.COMMIT_EMAIL || 'bot@self-optimisation.local' }
  : undefined;

console.error(`Merging ${branch} -> ${baseBranch}, tagging ${tag}...`);

try {
  const result = promote({ repoRoot, branch, tag, baseBranch, ...(identity ? { identity } : {}) });
  console.error(`✅ Merged and tagged: ${JSON.stringify(result)}`);

  if (args.cleanup) {
    const cleaned = cleanupBranch({ repoRoot, branch });
    console.error(cleaned.deleted ? `   deleted ${branch}` : `   ⚠️  could not delete ${branch}: ${cleaned.reason}`);
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
