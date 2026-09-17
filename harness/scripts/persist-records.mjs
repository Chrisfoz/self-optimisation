#!/usr/bin/env node

/**
 * Commit this generation's record to the default branch, on every outcome.
 * See harness/lib/persist-records.mjs for why records no longer ride the
 * agent branch.
 *
 * Usage: node harness/scripts/persist-records.mjs [--base <branch>] [--remote origin | --no-push] [--adapter <path>]
 *
 * Required environment: GEN_NUMBER.
 *
 * What it persists, from project-adapter.yml: the generation's own
 * directory (attempts.json, proposal.md, every fan-out proposal, evaluator
 * metrics), the escalation ledger, the themes directory and the runtime
 * evidence directory — each only where this run actually changed something.
 *
 * GITHUB_OUTPUT: persisted (true|false), sha. Exits 1 if the record could
 * not be written — a lost record is the failure this exists to prevent, so
 * it is reported as one rather than swallowed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAdapter, contextConfig, memoryConfig } from '../lib/adapter.mjs';
import { persistRecords } from '../lib/persist-records.mjs';
import { writeReports } from '../lib/run-history.mjs';
import { setOutput } from '../lib/gh-output.mjs';

function parseArgs(argv) {
  const out = { remote: 'origin' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--remote') out.remote = argv[++i];
    else if (argv[i] === '--no-push') out.remote = null;
    else if (argv[i] === '--adapter') out.adapter = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();
const genNumber = process.env.GEN_NUMBER;
if (!genNumber) {
  console.error('GEN_NUMBER is required.');
  process.exit(1);
}

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
const adapter = await loadAdapter(adapterPath);
const ctx = adapter ? contextConfig(adapter) : {};
const memory = adapter ? memoryConfig(adapter) : {};
const base = args.base || process.env.BASE_BRANCH || adapter?.project?.default_branch || 'main';

const generationsDir = ctx.generationsDir || 'docs/generations';
const genDir = `${generationsDir}/gen-${genNumber}`;
// The run history and REPORT.md, rebuilt from the records now on disk, which
// include this generation's, so the page is current the moment the record
// lands. A failure here must never cost the record itself, so it is logged
// and the record is persisted without them.
let reportFiles = [];
try {
  reportFiles = writeReports({
    repoRoot,
    generationsDir,
    ledgerPath: memory.ledgerPath || 'docs/escalations/ledger.json',
    projectName: adapter?.project?.id || 'This project',
  });
} catch (err) {
  console.error(`⚠️  Could not rebuild the run history: ${err.message}. Persisting the record without it.`);
}

const roots = [...new Set([
  genDir,
  ...reportFiles,
  memory.ledgerPath || 'docs/escalations/ledger.json',
  memory.themesDir || 'docs/themes',
  ctx.runtimeEvidenceDir || 'docs/runtime',
])];

let outcome = 'unknown';
try { outcome = JSON.parse(fs.readFileSync(path.join(repoRoot, genDir, 'attempts.json'), 'utf8')).outcome ?? outcome; } catch { /* no record: the message says so */ }

try {
  const result = persistRecords({
    repoRoot,
    roots,
    baseBranch: base,
    remote: args.remote,
    message: `Generation ${genNumber}: record (${outcome})`,
    log: (msg) => console.error(msg),
  });
  if (result.committed) console.error(`📓 Generation ${genNumber}'s record (${outcome}) is on ${base}: ${result.files.join(', ')}`);
  setOutput('persisted', String(result.committed || result.files.length > 0));
  setOutput('sha', result.sha ?? '');
} catch (err) {
  console.error(`❌ ${err.message}`);
  setOutput('persisted', 'false');
  process.exit(1);
}
