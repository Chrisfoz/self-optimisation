import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dirname, '../../harness/scripts/check-guarded-paths.mjs');
const NODE_MODULES = path.join(import.meta.dirname, '../../node_modules');

/** A real repo whose main branch carries an adapter with a goal, and a branch that edits it. */
function repoWithGoal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-goal-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'A');
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), 'project:\n  id: p\n  goal:\n    statement: Become calm.\nconstitution:\n  allowed_paths: [project-adapter.yml, index.html]\n  churn_ceiling: {max_files: 50, max_lines: 10000}\n');
  fs.writeFileSync(path.join(root, 'index.html'), 'v1');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'agent');
  return { root, git };
}

function runGuard(root) {
  return spawnSync(process.execPath, [SCRIPT, 'main'], { cwd: root, encoding: 'utf8' });
}

test('check-guarded-paths refuses a diff that changes project.goal in the adapter', (t) => {
  const { root, git } = repoWithGoal();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), fs.readFileSync(path.join(root, 'project-adapter.yml'), 'utf8').replace('Become calm.', 'Become fast.'));
  git('commit', '-q', '-am', 'a model edits the goal');
  const result = runGuard(root);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /project\.goal is frozen/);
});

test('check-guarded-paths passes an adapter edit that leaves the goal alone, and a diff that never touches the adapter', (t) => {
  const { root, git } = repoWithGoal();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(root, 'project-adapter.yml'), '  extra: 1\n');
  git('commit', '-q', '-am', 'another field');
  assert.equal(runGuard(root).status, 0);
  fs.writeFileSync(path.join(root, 'index.html'), 'v2');
  git('commit', '-q', '-am', 'source only');
  assert.equal(runGuard(root).status, 0);
});
