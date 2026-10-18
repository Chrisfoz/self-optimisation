/**
 * Run a generated workflow step's `run:` block the way GitHub Actions does,
 * so a test can prove the step works rather than that its YAML parses.
 *
 * GitHub runs `shell: bash` as `bash --noprofile --norc -eo pipefail {0}`
 * (docs: "Workflow syntax — jobs.<job_id>.steps[*].shell"). Those two flags
 * are the whole reason this file exists: the gate-summary helper once
 * passed every YAML-level test while failing on every real run, because
 * `-e` killed it on a helper that returned 1 for a merge path that wasn't
 * rendered.
 *
 * `${{ }}` expressions are GitHub's to evaluate, not ours — a test supplies
 * the env values a scenario would have produced instead.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import { renderWorkflowTemplate } from '../../harness/lib/scaffold.mjs';

export const GITHUB_BASH_ARGS = ['--noprofile', '--norc', '-eo', 'pipefail'];

const TEMPLATE_PATH = path.join(import.meta.dirname, '../../harness/templates/workflow.yml.tmpl');

/**
 * The bash to use. On Windows `bash` on PATH can be WSL's, which cannot see
 * a Windows temp path the way the test hands it one — Git for Windows'
 * bash, found next to the git on PATH, can.
 */
export function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const gitExe = execFileSync('where', ['git'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    const gitRoot = path.resolve(path.dirname(gitExe), '..');
    for (const candidate of [path.join(gitRoot, 'bin', 'bash.exe'), path.join(gitRoot, 'usr', 'bin', 'bash.exe')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* fall through */ }
  return 'bash';
}

/** {ok, reason} — whether bash and jq are both runnable here. */
export function shellAvailable() {
  const bash = findBash();
  const b = spawnSync(bash, ['-c', 'jq --version'], { encoding: 'utf8' });
  if (b.error) return { ok: false, reason: `bash not runnable (${b.error.message})` };
  if (b.status !== 0) return { ok: false, reason: `jq not found by ${bash}` };
  return { ok: true, bash };
}

/**
 * Skip when the tools are missing — unless REQUIRE_SHELL_TESTS=true (CI sets
 * it), where a missing tool must be a failure rather than a quiet skip.
 */
export function shellTestOptions() {
  const avail = shellAvailable();
  if (avail.ok) return {};
  if (process.env.REQUIRE_SHELL_TESTS === 'true') throw new Error(`Shell tests are required here but cannot run: ${avail.reason}`);
  return { skip: avail.reason };
}

export function renderSteps(answers) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const doc = loadYaml(renderWorkflowTemplate(template, answers));
  return { doc, steps: doc.jobs['self-improve'].steps };
}

export function findStep(steps, idOrName) {
  const found = steps.find((s) => s.id === idOrName || s.name === idOrName);
  if (!found) throw new Error(`No step with id or name "${idOrName}"`);
  return found;
}

/**
 * Parse a GITHUB_OUTPUT file with GitHub's own two forms — `key=value` and
 * `key<<DELIM ... DELIM` — and throw on any line that is neither, which is
 * what GitHub does ("Invalid format").
 */
export function parseGithubOutput(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;
    const heredoc = line.match(/^([^=<]+)<<(.+)$/);
    if (heredoc) {
      const [, key, delim] = heredoc;
      const body = [];
      i++;
      while (i < lines.length && lines[i] !== delim) body.push(lines[i++]);
      if (i >= lines.length) throw new Error(`Invalid format: unterminated heredoc for "${key}"`);
      out[key] = body.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid format '${line}'`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

const posix = (p) => p.replace(/\\/g, '/');

/**
 * @param {object} step            A parsed step from renderSteps().
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.env]  Scenario env, replacing the step's `${{ }}` values.
 * @param {string} [opts.cwd]
 * @param {string[]} [opts.pathPrepend]       Directories of fake tools (gh, node...) to put first on PATH.
 * @returns {{status: number, stdout: string, stderr: string, outputs: object, runnerTemp: string}}
 */
export function runStep(step, { env = {}, cwd = process.cwd(), pathPrepend = [] } = {}) {
  if (!step.run) throw new Error(`Step "${step.name ?? step.id}" has no run block`);
  const bash = findBash();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-step-'));
  const script = path.join(work, 'step.sh');
  const outputFile = path.join(work, 'github_output');
  const runnerTemp = path.join(work, 'runner_temp');
  fs.mkdirSync(runnerTemp);
  fs.writeFileSync(script, step.run);
  fs.writeFileSync(outputFile, '');

  const sep = process.platform === 'win32' ? ';' : ':';
  const result = spawnSync(bash, [...GITHUB_BASH_ARGS, posix(script)], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [...pathPrepend, process.env.PATH].join(sep),
      GITHUB_OUTPUT: posix(outputFile),
      RUNNER_TEMP: posix(runnerTemp),
      ...env,
    },
  });
  const outputs = parseGithubOutput(fs.readFileSync(outputFile, 'utf8'));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs, runnerTemp, work };
}

/** Write an executable bash script called `name` into a fresh directory, for pathPrepend. */
export function fakeTool(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fake-${name}-`));
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return { dir, file };
}
