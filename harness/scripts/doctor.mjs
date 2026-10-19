#!/usr/bin/env node

/**
 * Is this installation ready to run on a schedule? Checks, in the order you
 * would fix them: Node, the adapter, the generated workflow, the env file
 * (present and git-ignored), the keys (present, and accepted by each lab),
 * the model snapshot, the repository's secrets and pull-request permission
 * (through the GitHub CLI, when it is signed in), and whether this copy of
 * the harness is current. Every failure prints the command that fixes it.
 *
 * Run from a project's root:
 *   node harness/scripts/doctor.mjs
 *   node harness/scripts/doctor.mjs --offline   no lab, GitHub or upstream calls
 *
 * Reads harness/.env.harness.local itself — no --env-file needed. Calls each
 * lab's model listing only (the same check as check-keys.mjs, which it runs),
 * so it costs nothing. Changes nothing. Exit 1 when anything failed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import '../providers/index.mjs';
import { getProvider, resolveProvider } from '../lib/llm-provider.mjs';
import { loadAdapter } from '../lib/adapter.mjs';
import { ghRunner } from '../lib/github-setup.mjs';
import { checkUpgrade } from '../lib/version.mjs';
import { gitRunner, remoteDefaultBranch } from '../lib/git-default-branch.mjs';
import { runChecks, report, ENV_FILE } from '../lib/doctor.mjs';

const repoRoot = process.cwd();
const offline = process.argv.includes('--offline');
const checkKeysScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-keys.mjs');

let adapter = null;
let adapterError = null;
try {
  adapter = await loadAdapter(path.join(repoRoot, 'project-adapter.yml'));
} catch (err) {
  adapterError = err.message;
}

const envPath = path.join(repoRoot, ENV_FILE);
const env = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : null;

const git = (args) => {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '' };
};

/** check-keys.mjs itself, with the env file's keys, so there is one definition of "this key works". */
async function checkKeys(providers) {
  const r = spawnSync(process.execPath, [checkKeysScript, '--json', '--providers', providers.join(',')], {
    cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ...env },
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { results: providers.map((p) => ({ provider: p, envKey: getProvider(p).envKey, state: 'rejected', detail: `check-keys did not run: ${(r.stderr || '').trim().split('\n').pop()}` })) };
  }
}

console.log('Self-optimisation harness — installation check\n');
const checks = await runChecks({
  nodeVersion: process.versions.node,
  repoRoot,
  exists: (p) => fs.existsSync(path.join(repoRoot, p)),
  git,
  gh: ghRunner({ cwd: repoRoot }),
  adapter,
  adapterError,
  env,
  checkKeys,
  checkUpgrade: () => checkUpgrade(),
  providerEnvKey: (name) => getProvider(name)?.envKey ?? `${String(name).toUpperCase()}_API_KEY`,
  modelProvider: (model) => { try { return resolveProvider(model); } catch { return null; } },
  offline,
  remoteDefaultBranch: offline ? null : remoteDefaultBranch(gitRunner(repoRoot)),
});
const { lines, code } = report(checks);
for (const line of lines) console.log(line);
process.exit(code);
