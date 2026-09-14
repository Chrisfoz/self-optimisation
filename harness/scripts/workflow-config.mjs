#!/usr/bin/env node

/**
 * The shared workflow's first project step: read project-adapter.yml once,
 * from the default branch, and save what later steps need. See
 * harness/lib/workflow-config.mjs for why the saved copy, and never the
 * adapter itself, is what the rest of the run reads.
 *
 * Usage: node <harness>/scripts/workflow-config.mjs [--adapter <path>] [--out <dir>]
 *
 * Writes, into --out (default $RUNNER_TEMP):
 *   project-config.json   every value, for run-project-commands.mjs
 *   editable-paths        one editable path per line, for the commit step
 * and appends DEFAULT_BRANCH, PROVIDERS_CSV, SNAPSHOT_PATH, GENERATIONS_DIR,
 * APPROVAL_CLASS and NOTIFY_CONFIGURED to $GITHUB_ENV when it is set.
 *
 * Exits 1 when the adapter is missing, unparseable or unsafe. The workflow
 * runs this with continue-on-error and gates everything on the validate step
 * after it, which reports the same problem in the words a person can act on.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadAdapter } from '../lib/adapter.mjs';
import { workflowConfig, githubEnvLines } from '../lib/workflow-config.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--out') out.out = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(process.cwd(), 'project-adapter.yml');
const outDir = args.out || process.env.RUNNER_TEMP;
if (!outDir) {
  console.error('Pass --out, or run inside GitHub Actions where RUNNER_TEMP is set.');
  process.exit(1);
}

let config;
try {
  config = workflowConfig(await loadAdapter(adapterPath));
} catch (err) {
  console.error(`Could not read this project's configuration from ${adapterPath}: ${err.message}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'project-config.json'), JSON.stringify(config, null, 2) + '\n');
fs.writeFileSync(path.join(outDir, 'editable-paths'), config.editablePaths.map((p) => p + '\n').join(''));
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, githubEnvLines(config));

console.log(`Read ${adapterPath}: default branch ${config.defaultBranch}, ${config.approvalClass}, ` +
  `${config.testCommands.length} test command(s), ${config.setupCommands.length} setup command(s), ` +
  `${config.editablePaths.length} editable path(s).`);
