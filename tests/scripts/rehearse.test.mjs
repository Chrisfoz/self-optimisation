import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'harness/scripts/rehearse.mjs');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const HARNESS_DIR = path.join(REPO_ROOT, 'harness');

/**
 * A real, minimal, otherwise-valid rehearsal project: one editable file, a
 * committed adapter, and two brief files with no placeholders — so every
 * test below is isolating the ONE thing it deliberately breaks, rather
 * than tripping over validate.mjs's own (separately tested) checks.
 */
function project({ providersWatched = ['anthropic'], testCommands = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-script-'));
  fs.symlinkSync(HARNESS_DIR, path.join(root, 'harness'));
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'A');

  fs.writeFileSync(path.join(root, 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(root, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude/agents/improve.md'), 'Improve the project. No placeholders here.');
  fs.writeFileSync(path.join(root, '.claude/agents/review.md'), 'Review the change. No placeholders here.');

  const adapter = [
    'project:',
    '  id: rehearse-test',
    'constitution:',
    '  allowed_paths:',
    '    - index.html',
    '  frozen_paths:',
    '    - ".github/**"',
    'roles:',
    '  agent_brief_path: .claude/agents/improve.md',
    '  reviewer_brief_path: .claude/agents/review.md',
    'providers:',
    `  watched: [${providersWatched.join(', ')}]`,
    ...(testCommands.length ? ['evaluation:', '  test_commands:', ...testCommands.map((c) => `    - ${JSON.stringify(c)}`)] : []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), adapter);

  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, git };
}

/** No API keys reach the child process, regardless of the parent's own environment. */
function runRehearse(root, args = [], env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...Object.fromEntries(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'].map((k) => [k, undefined])), ...env },
  });
}

test('--help prints usage without touching git or the filesystem', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Local rehearsal/);
});

test('refuses a dirty working tree before anything else runs', (t) => {
  const { root } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'index.html'), 'changed');

  const result = runRehearse(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Working tree is not clean/);
});

test('refuses when no project-adapter.yml exists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-script-noadapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(HARNESS_DIR, path.join(root, 'harness'));
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'A');
  fs.writeFileSync(path.join(root, 'f'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  const result = runRehearse(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No project-adapter\.yml found/);
});

test('a structurally invalid adapter is refused at the validate step, before preflight or any network call', (t) => {
  const { root, git } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'project-adapter.yml'),
    fs.readFileSync(path.join(root, 'project-adapter.yml'), 'utf8').replace('index.html', 'does-not-exist.html')
  );
  git('commit', '-q', '-am', 'point allowed_paths at a file that does not exist');

  const result = runRehearse(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Step 1\/6 — Validating the adapter/);
  assert.match(result.stdout, /does-not-exist\.html.*does not exist/);
  assert.doesNotMatch(result.stdout, /Step 2\/6/);
});

test('an unresolvable --models id is refused before a branch is created', (t) => {
  const { root, git } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runRehearse(root, ['--models', 'not-a-real-model-id']);
  assert.equal(result.status, 1);
  // campaign-models.mjs's own diagnostic (inherited stderr) names the id;
  // rehearse.mjs's own fail() message confirms it stopped there.
  assert.match(result.stderr, /Cannot resolve a lab for: not-a-real-model-id/);
  assert.match(result.stderr, /could not resolve the named models/);
  // No branch was left behind, and the working tree is exactly as it was.
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
});

test('with no provider key set and no --models, a release check finds nothing and exits 0 having changed only the model snapshot', (t) => {
  const { root, git } = project();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runRehearse(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Nothing to rehearse — no new model release/);
  // The snapshot recorded the baseline and was committed to the base
  // branch, mirroring the generated workflow's own "commit the updated
  // model snapshot" step — this is the one real side effect a no-op
  // rehearsal is expected to leave behind.
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(git('status', '--porcelain'), '');
  assert.ok(fs.existsSync(path.join(root, '.agent/model-snapshot.json')));
  assert.match(git('log', '-1', '--format=%s'), /Update model snapshot/);
});

test('a failing preflight command stops the rehearsal before any model is checked', (t) => {
  const { root, git } = project({ testCommands: ['exit 1'] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runRehearse(root);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Step 2\/6 — Preflight/);
  assert.doesNotMatch(result.stdout, /Step 3\/6/);
  assert.equal(git('branch', '--show-current'), 'main');
});

test('--skip-preflight skips the preflight commands', (t) => {
  const { root } = project({ testCommands: ['exit 1'] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = runRehearse(root, ['--skip-preflight']);
  assert.match(result.stdout, /Skipped \(--skip-preflight\)/);
  // Still gets past preflight to the (deterministic, keyless) release check.
  assert.match(result.stdout, /Nothing to rehearse|Step 3\/6/);
});

test('--models with an unregistered watched provider in the adapter still validates and reports the campaign models it CAN resolve', (t) => {
  const { root } = project({ providersWatched: [] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // No watched providers at all is legal (campaign mode never consults
  // providers.watched); the campaign path resolves purely from the model
  // id's own pattern.
  const result = runRehearse(root, ['--models', 'claude-opus-5']);
  assert.match(result.stdout, /Campaign: claude-opus-5 \(anthropic\)/);
  // It gets as far as probing reachability and, with no real key, reports
  // nothing reachable rather than crashing.
  assert.match(result.stdout, /Step 4\/6 — Probing reachability/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no candidate model was reachable/);
});
