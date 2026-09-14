#!/usr/bin/env node

/**
 * Run the project's own test or setup commands, as saved by
 * workflow-config.mjs at the start of the run — the shared workflow's
 * equivalent of the command lines a copied-in workflow has baked into its
 * preflight, post-change test and dependency setup steps.
 *
 * Usage: node <harness>/scripts/run-project-commands.mjs test|setup [--config <file>]
 *
 * Each command runs in order from the project root, under bash where bash is
 * the shell (as a generated workflow's `shell: bash` step would), with its
 * output streamed. The first failure stops the list and becomes this
 * script's exit code. No test commands is a failure — a gate with nothing to
 * run cannot pass — and no setup commands is nothing to do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const kind = process.argv[2];
const configIndex = process.argv.indexOf('--config');
const configPath = configIndex > -1
  ? process.argv[configIndex + 1]
  : path.join(process.env.RUNNER_TEMP || '', 'project-config.json');

if (kind !== 'test' && kind !== 'setup') {
  console.error('Usage: run-project-commands.mjs test|setup [--config <file>]');
  process.exit(2);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Could not read the saved project configuration at ${configPath}: ${err.message}`);
  process.exit(1);
}

const commands = kind === 'test' ? config.testCommands : config.setupCommands;
if (!Array.isArray(commands) || commands.some((c) => typeof c !== 'string')) {
  console.error(`The saved project configuration has no valid ${kind} command list.`);
  process.exit(1);
}
if (commands.length === 0) {
  if (kind === 'setup') {
    console.log('No dependency setup commands configured.');
    process.exit(0);
  }
  console.error('No test commands configured (evaluation.test_commands) — there is nothing to prove a change with.');
  process.exit(1);
}

const shell = process.platform === 'win32' ? true : 'bash';
for (const command of commands) {
  console.log(`$ ${command}`);
  const result = spawnSync(command, { shell, stdio: 'inherit' });
  const status = result.status ?? 1;
  if (status !== 0) {
    console.error(`"${command}" exited ${status}${result.signal ? ` (${result.signal})` : ''}.`);
    process.exit(status);
  }
}
