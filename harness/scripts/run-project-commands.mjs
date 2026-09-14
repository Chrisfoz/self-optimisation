#!/usr/bin/env node

/**
 * Run the project's own test or setup commands, as saved by
 * workflow-config.mjs at the start of the run — the shared workflow's
 * equivalent of the command lines a copied-in workflow has baked into its
 * preflight, post-change test and dependency setup steps.
 *
 * Usage: node <harness>/scripts/run-project-commands.mjs test|setup [--config <file>]
 *
 * The commands run the way those steps run them: as the lines of ONE bash
 * script, under GitHub's own `bash --noprofile --norc -eo pipefail`. Both
 * halves of that matter. One script, so a `cd app` or `export CI=1` line
 * carries into the next one, as it does in a copied-in workflow. And
 * pipefail, so `npm test | tee "$RUNNER_TEMP/tests.tap"` (the form the
 * workflow suggests for recording TAP) fails when the tests fail, rather
 * than passing on tee's exit code.
 *
 * No test commands is a failure — a gate with nothing to run cannot pass —
 * and no setup commands is nothing to do. The bash used is `bash` on PATH,
 * or RUN_PROJECT_COMMANDS_BASH (a Windows machine's Git bash, say).
 */

import fs from 'node:fs';
import os from 'node:os';
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
if (!Array.isArray(commands) || commands.some((c) => typeof c !== 'string' || /[\r\n\0]/.test(c))) {
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `project-${kind}-`));
const script = path.join(dir, `${kind}.sh`);
fs.writeFileSync(script, commands.join('\n') + '\n');
console.log(`Running this project's ${kind} commands:\n${commands.map((c) => `  ${c}`).join('\n')}`);

const bash = process.env.RUN_PROJECT_COMMANDS_BASH || 'bash';
const result = spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', script.replace(/\\/g, '/')], { stdio: 'inherit' });
fs.rmSync(dir, { recursive: true, force: true });

if (result.error) {
  console.error(`Could not start bash (${bash}): ${result.error.message}`);
  process.exit(1);
}
const status = result.status ?? 1;
if (status !== 0) console.error(`This project's ${kind} commands exited ${status}${result.signal ? ` (${result.signal})` : ''}.`);
process.exit(status);
