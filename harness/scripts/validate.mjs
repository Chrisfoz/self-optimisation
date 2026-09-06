#!/usr/bin/env node

/**
 * CLI entry point for harness/lib/validate.mjs. Run from a target
 * project's root, same convention as every other harness CLI. This is the
 * check `harness/cli/init.mjs` runs on what it just wrote, and the one
 * `harness/scripts/rehearse.mjs` and the generated workflow both run
 * before anything else — a bad config should fail here, loudly, before a
 * single model is called.
 *
 * Usage: node harness/scripts/validate.mjs [--adapter <path>]
 *
 * Exits 1 on any error, 0 otherwise (warnings do not fail the check) — the
 * caller's job should fail the build on a non-zero exit, not parse stdout
 * for a verdict.
 */

import path from 'path';
import '../providers/index.mjs';
import { loadAdapter } from '../lib/adapter.mjs';
import { validateAdapter } from '../lib/validate.mjs';

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

let adapter;
try {
  adapter = await loadAdapter(adapterPath);
} catch (err) {
  console.log(`Validating ${adapterPath}\n`);
  console.log(`FAIL — could not be parsed as YAML: ${err.message}`);
  process.exit(1);
}

if (!adapter) {
  console.log(`Validating ${adapterPath}\n`);
  console.log(`FAIL — no project-adapter.yml found there. See harness/project-adapter.example.yml.`);
  process.exit(1);
}

console.log(`Validating ${adapterPath}\n`);

const { errors, warnings } = validateAdapter(adapter, { repoRoot });

if (warnings.length) {
  console.log(`${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  ⚠️  ${w}`);
  console.log();
}

if (errors.length) {
  console.log(`${errors.length} error(s):`);
  for (const e of errors) console.log(`  ❌ ${e}`);
  console.log('\nFAIL — fix the error(s) above before running a generation.');
  process.exit(1);
}

console.log(warnings.length ? 'PASS — with the warning(s) above.' : 'PASS — no issues found.');
process.exit(0);
