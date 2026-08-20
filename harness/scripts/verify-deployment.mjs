#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/verify-deployment.mjs. Fetches the live
 * product and fails loudly if it does not carry what was just merged.
 * Every other gate tests a branch; this one tests what a user actually
 * opens — see verify-deployment.mjs's own doc comment for the incident
 * that made this worth having.
 *
 * Usage: node harness/scripts/verify-deployment.mjs [--adapter <path>]
 *
 * Reads deployment.verify_strategy / production_url / watched_files from
 * project-adapter.yml. A project with verify_strategy unset or "none"
 * exits 0 immediately — this is a deliberate no-op, not a skipped check
 * pretending to have run.
 */

import path from 'path';
import { loadAdapter, deploymentConfig } from '../lib/adapter.mjs';
import { verifyDeployment } from '../lib/verify-deployment.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = process.cwd();

const adapterPath = args.adapter || process.env.PROJECT_ADAPTER_PATH || path.join(repoRoot, 'project-adapter.yml');
const adapter = await loadAdapter(adapterPath);
const config = deploymentConfig(adapter);

if (config.strategy === 'none') {
  console.error('deployment.verify_strategy is "none" (or unset) — nothing to check.');
  process.exit(0);
}

if (config.strategy === 'url' && (!config.siteUrl || !config.watchedFiles?.length)) {
  console.error('deployment.verify_strategy is "url" but production_url and/or watched_files is not set in project-adapter.yml.');
  process.exit(1);
}

console.error(`Verifying deployment (${config.strategy})${config.siteUrl ? ` at ${config.siteUrl}` : ''}...\n`);

try {
  const result = await verifyDeployment(
    { strategy: config.strategy, repoRoot, siteUrl: config.siteUrl, watchedFiles: config.watchedFiles },
    { log: (msg) => console.error(msg) }
  );
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
