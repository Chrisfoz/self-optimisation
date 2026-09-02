#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/verify-deployment.mjs. Confirms the thing
 * that was just merged actually shipped, however "shipped" means for this
 * project — a live site (`url`), a package registry (`registry`), or a
 * built output (`artifact`) — and fails loudly if it does not. Every other
 * gate tests a branch; this one tests the real, external result — see
 * verify-deployment.mjs's own doc comment for the incident that made this
 * worth having.
 *
 * Usage: node harness/scripts/verify-deployment.mjs [--adapter <path>] [--version <v>] [--evidence <path>]
 *
 * Reads deployment.verify_strategy and its strategy-specific fields from
 * project-adapter.yml (via harness/lib/adapter.mjs's deploymentConfig()). A
 * project with verify_strategy unset or "none" exits 0 immediately — this
 * is a deliberate no-op, not a skipped check pretending to have run.
 *
 * The `registry` strategy needs a version to look for. In order of
 * precedence: --version, the VERSION env var, deployment.registry.version
 * in the adapter, then — only for the npm ecosystem, since it's the one
 * case a sensible default exists — the "version" field of
 * deployment.registry.version_file (package.json by convention) read off
 * disk. Every other ecosystem must be given one explicitly, since there is
 * no equivalent file this script can assume.
 */

import fs from 'fs';
import path from 'path';
import { loadAdapter, deploymentConfig } from '../lib/adapter.mjs';
import { verifyDeployment } from '../lib/verify-deployment.mjs';
import { deployFragment } from '../lib/runtime-evidence.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--adapter') out.adapter = argv[++i];
    else if (argv[i] === '--version') out.version = argv[++i];
    // Where to leave a runtime-evidence fragment describing what this check
    // actually observed — see docs/curiosity/C10-runtime-evidence.md. The
    // verdict already goes to the exit code; this is the observation behind
    // it, which is the part a later generation can learn something from.
    else if (argv[i] === '--evidence') out.evidence = argv[++i];
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

if (config.strategy === 'registry') {
  if (!config.registry.ecosystem) {
    console.error('deployment.verify_strategy is "registry" but deployment.registry.ecosystem is not set in project-adapter.yml.');
    process.exit(1);
  }

  config.registry.version = args.version || process.env.VERSION || config.registry.version;
  if (!config.registry.version && config.registry.ecosystem === 'npm') {
    const versionFile = path.join(repoRoot, config.registry.versionFile || 'package.json');
    try {
      config.registry.version = JSON.parse(fs.readFileSync(versionFile, 'utf8')).version;
      console.error(`No version given — read "${config.registry.version}" from ${versionFile}.`);
    } catch (err) {
      console.error(`No version given, and could not read one from ${versionFile}: ${err.message}`);
      process.exit(1);
    }
  }
  if (!config.registry.version) {
    console.error('deployment.verify_strategy is "registry" but no version was given (--version, VERSION, deployment.registry.version) and none could be inferred.');
    process.exit(1);
  }
}

if (config.strategy === 'artifact' && !config.artifact.buildCommand && !config.artifact.path && !config.artifact.smokeCommand) {
  console.error('deployment.verify_strategy is "artifact" but none of build_command / path / smoke_command is set in project-adapter.yml — nothing to check.');
  process.exit(1);
}

console.error(`Verifying deployment (${config.strategy})${config.siteUrl ? ` at ${config.siteUrl}` : ''}...\n`);

try {
  const result = await verifyDeployment(
    { strategy: config.strategy, repoRoot, siteUrl: config.siteUrl, watchedFiles: config.watchedFiles, registry: config.registry, artifact: config.artifact },
    { log: (msg) => console.error(msg) }
  );
  if (args.evidence) {
    const fragment = deployFragment(result, { url: config.siteUrl });
    try {
      fs.mkdirSync(path.dirname(args.evidence), { recursive: true });
      fs.writeFileSync(args.evidence, JSON.stringify(fragment, null, 2) + '\n', 'utf8');
    } catch (err) {
      // Never the reason a deployment check fails: the check's own verdict
      // is what this script is for, and a note about it is a bonus.
      console.error(`(could not write the evidence fragment: ${err.message})`);
    }
  }
  process.exit(result.ok ? 0 : 1);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
