import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The shared workflow's two project steps, driven as real child processes:
// read the adapter once and save it, then run the saved commands.

const root = path.join(import.meta.dirname, '../..');
const script = (name) => path.join(root, 'harness/scripts', name);

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

test('run-project-commands.mjs runs each command in order from the project root, and stops at the first failure', (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, {
    testCommands: [
      'node -e "require(\'fs\').writeFileSync(\'first\', \'1\')"',
      'node -e "process.exit(3)"',
      'node -e "require(\'fs\').writeFileSync(\'third\', \'1\')"',
    ],
  });
  const r = run(dir, 'run-project-commands.mjs', ['test', '--config', config]);
  assert.equal(r.status, 3);
  assert.ok(fs.existsSync(path.join(dir, 'first')));
  assert.ok(!fs.existsSync(path.join(dir, 'third')), 'nothing ran after the failure');
  assert.match(r.stderr, /exited 3/);
});

test('run-project-commands.mjs: every command passing exits 0', (t) => {
  const dir = sandbox(t);
  const config = savedConfig(dir, { setupCommands: ['node -e "process.exit(0)"'], testCommands: ['node -e "process.exit(0)"'] });
  assert.equal(run(dir, 'run-project-commands.mjs', ['setup', '--config', config]).status, 0);
  assert.equal(run(dir, 'run-project-commands.mjs', ['test', '--config', config]).status, 0);
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
