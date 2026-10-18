#!/usr/bin/env node

/**
 * The npx entry point: copies this package's harness/ into the project you
 * run it from, then hands over to the harness's own CLIs there. Everything
 * after the copy is the same code a hand-copied install runs.
 *
 *   npx self-optimisation-harness init [--quick | --detector-only | ...]
 *       copy harness/ in (unless it is already there), then run init
 *   npx self-optimisation-harness upgrade
 *       replace harness/ with this version — keeping harness/.env.harness.local —
 *       then regenerate the workflow from project-adapter.yml
 *   npx self-optimisation-harness doctor [--offline]
 *   npx self-optimisation-harness --version
 *
 * Upgrading is then a version bump rather than re-cloning and re-copying a
 * folder by hand.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packaged = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'harness');
const project = process.cwd();
const target = path.join(project, 'harness');
const ENV_FILE = '.env.harness.local';
const version = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch { return null; }
};

/** Copy the packaged harness/ into the project, never carrying a key file or installed packages. */
function copyHarness() {
  fs.cpSync(packaged, target, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== ENV_FILE && name !== 'node_modules';
    },
  });
}

/** Run one of the copied harness's own scripts in the project, and exit with its status. */
function run(script, args) {
  const r = spawnSync(process.execPath, [path.join('harness', script), ...args], { cwd: project, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const [command, ...args] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  console.log(version(packaged));
  process.exit(0);
}

if (command === 'init') {
  if (fs.existsSync(target)) {
    const here = version(target);
    console.log(`harness/ is already here (${here ?? 'unknown version'}); using it as it is.${here !== version(packaged) ? ` This package is ${version(packaged)} — \`upgrade\` replaces it.` : ''}\n`);
  } else {
    copyHarness();
    console.log(`Copied harness/ ${version(packaged)} into ${project}. Nothing else is installed.\n`);
  }
  run('cli/init.mjs', args);
} else if (command === 'upgrade') {
  if (!fs.existsSync(target)) {
    console.error('No harness/ here to upgrade. Run `init` first.');
    process.exit(1);
  }
  const envPath = path.join(target, ENV_FILE);
  const keys = fs.existsSync(envPath) ? fs.readFileSync(envPath) : null;
  const from = version(target);
  fs.rmSync(target, { recursive: true, force: true });
  copyHarness();
  if (keys) fs.writeFileSync(envPath, keys);
  console.log(`Replaced harness/ ${from ?? '(unknown)'} with ${version(packaged)}${keys ? `, keeping ${ENV_FILE}` : ''}. Local edits inside harness/ are not kept — the upgrade is the package.\n`);
  run('cli/init.mjs', ['--from-adapter', '--force', ...args]);
} else if (command === 'doctor') {
  if (!fs.existsSync(target)) {
    console.error('No harness/ here. Run `init` first.');
    process.exit(1);
  }
  run('scripts/doctor.mjs', args);
} else {
  console.log(`Usage: npx self-optimisation-harness <command>

  init [--quick | --detector-only | ...]   copy harness/ into this project, then set it up
  upgrade                                  replace harness/ with this version, keep your keys,
                                           and regenerate the workflow from project-adapter.yml
  doctor [--offline]                       check the installation end to end
  --version                                this package's harness version`);
  process.exit(command ? 1 : 0);
}
