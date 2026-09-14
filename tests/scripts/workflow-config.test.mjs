import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { shellTestOptions, findBash } from '../helpers/gha-shell.mjs';

// The shared workflow's two project steps, driven as real child processes:
// read the adapter once and save it, then run the saved commands.

const root = path.join(import.meta.dirname, '../..');
const script = (name) => path.join(root, 'harness/scripts', name);
// Running the saved commands needs bash, as the workflow step does; skipped
// where it is missing, unless REQUIRE_SHELL_TESTS says it must not be.
const shellOpts = shellTestOptions();
const bashEnv = shellOpts.skip ? {} : { RUN_PROJECT_COMMANDS_BASH: findBash() };

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const run = (dir, name, args, env = {}) =>
  spawnSync(process.execPath, [script(name), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });

test('workflow-config.mjs saves the configuration, the editable paths and the env lines', (t) => {
  const dir = sandbox(t);
  fs.writeFileSync(path.join(dir, 'project-adapter.yml'), [
    'project:', '  id: p', '  default_branch: develop',
    'providers:', '  watched: [anthropic, openai]',
    'constitution:', '  allowed_paths: [src/a.js]', '  create_only_paths: [tests/new_*.js]', '  approval_class: autonomous-merge',
    'evaluation:', '  test_commands: [npm test]', '  setup_commands: [npm ci]',
    '',
  ].join('\n'));
  const out = path.join(dir, 'runner-temp');
  const githubEnv = path.join(dir, 'github-env');
  fs.writeFileSync(githubEnv, 'EXISTING=1\n');

  const r = run(dir, 'workflow-config.mjs', ['--out', out], { GITHUB_ENV: githubEnv });
  assert.equal(r.status, 0, r.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(out, 'project-config.json'), 'utf8'));
  assert.deepEqual(config.testCommands, ['npm test']);
  assert.deepEqual(config.setupCommands, ['npm ci']);
  assert.equal(config.approvalClass, 'autonomous-merge');
  assert.equal(fs.readFileSync(path.join(out, 'editable-paths'), 'utf8'), 'src/a.js\ntests/new_*.js\n');
  const env = fs.readFileSync(githubEnv, 'utf8');
  assert.match(env, /^EXISTING=1\nDEFAULT_BRANCH=develop\n/);
  assert.match(env, /\nAPPROVAL_CLASS=autonomous-merge\n/);
  assert.match(env, /\nPROVIDERS_CSV=anthropic,openai\n/);
});

test('workflow-config.mjs exits 1 and writes nothing when there is no adapter, or an unsafe one', (t) => {
  const dir = sandbox(t);
  const out = path.join(dir, 'runner-temp');
  const githubEnv = path.join(dir, 'github-env');
  fs.writeFileSync(githubEnv, '');

  const missing = run(dir, 'workflow-config.mjs', ['--out', out], { GITHUB_ENV: githubEnv });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /No project-adapter\.yml/);

  fs.writeFileSync(path.join(dir, 'project-adapter.yml'), 'project:\n  id: p\n  default_branch: "main\\nEVIL=1"\n');
  const unsafe = run(dir, 'workflow-config.mjs', ['--out', out], { GITHUB_ENV: githubEnv });
  assert.equal(unsafe.status, 1);
  assert.equal(fs.readFileSync(githubEnv, 'utf8'), '', 'nothing reached $GITHUB_ENV');
  assert.ok(!fs.existsSync(path.join(out, 'project-config.json')));
});

function savedConfig(dir, config) {
  const file = path.join(dir, 'project-config.json');
  fs.writeFileSync(file, JSON.stringify({ testCommands: [], setupCommands: [], ...config }));
  return file;
}

test('run-project-commands.mjs runs the commands in order from the project root, and stops at the first failure', shellOpts, (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, { testCommands: ['echo 1 > first', 'exit 3', 'echo 1 > third'] });
  const r = run(dir, 'run-project-commands.mjs', ['test', '--config', config], bashEnv);
  assert.equal(r.status, 3);
  assert.ok(fs.existsSync(path.join(dir, 'first')));
  assert.ok(!fs.existsSync(path.join(dir, 'third')), 'nothing ran after the failure');
  assert.match(r.stderr, /exited 3/);
});

test('run-project-commands.mjs: a failing command piped into tee fails the gate, as pipefail does in a copied-in workflow', shellOpts, (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, { testCommands: ['(echo "not ok 1"; exit 1) | tee tests.tap'] });
  const r = run(dir, 'run-project-commands.mjs', ['test', '--config', config], bashEnv);
  assert.equal(r.status, 1, 'tee exiting 0 must not pass failing tests');
  assert.match(fs.readFileSync(path.join(dir, 'tests.tap'), 'utf8'), /not ok 1/);
});

test('run-project-commands.mjs: the commands share one shell, so a cd or export carries to the next line', shellOpts, (t) => {
  const dir = sandbox(t);
  fs.mkdirSync(path.join(dir, 'app'));
  const config = savedConfig(dir, { testCommands: ['cd app', 'export MARK=shared', 'echo "$MARK" > marker'] });
  const r = run(dir, 'run-project-commands.mjs', ['test', '--config', config], bashEnv);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'app', 'marker'), 'utf8').trim(), 'shared');
});

test('run-project-commands.mjs: every command passing exits 0', shellOpts, (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, { setupCommands: ['true'], testCommands: ['true', 'true'] });
  assert.equal(run(dir, 'run-project-commands.mjs', ['setup', '--config', config], bashEnv).status, 0);
  assert.equal(run(dir, 'run-project-commands.mjs', ['test', '--config', config], bashEnv).status, 0);
});

test('run-project-commands.mjs: a saved command spanning lines is refused rather than run as two', (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, { testCommands: ['true\nrm -rf app'] });
  const r = run(dir, 'run-project-commands.mjs', ['test', '--config', config], bashEnv);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no valid test command list/);
});

test('run-project-commands.mjs: no test commands fails the gate, no setup commands is nothing to do', (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, {});
  const tests = run(dir, 'run-project-commands.mjs', ['test', '--config', config]);
  assert.equal(tests.status, 1);
  assert.match(tests.stderr, /nothing to prove a change with/);
  assert.equal(run(dir, 'run-project-commands.mjs', ['setup', '--config', config]).status, 0);
});

test('run-project-commands.mjs refuses an unknown kind and a missing configuration', (t) => {
  const dir = sandbox(t);
  assert.equal(run(dir, 'run-project-commands.mjs', ['deploy']).status, 2);
  const missing = run(dir, 'run-project-commands.mjs', ['test', '--config', path.join(dir, 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Could not read the saved project configuration/);
});
