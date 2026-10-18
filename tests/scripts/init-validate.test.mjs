import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const INIT_SCRIPT = path.join(REPO_ROOT, 'harness/cli/init.mjs');
const HARNESS_DIR = path.join(REPO_ROOT, 'harness');

/**
 * A fresh target-project directory with its own copy of harness/ (init.mjs
 * resolves its templates relative to its own file location, so a symlink to
 * the real harness/ is enough — no need to actually copy it). No
 * node_modules: the harness's one library is vendored.
 */
function freshProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'init-validate-'));
  fs.symlinkSync(HARNESS_DIR, path.join(root, 'harness'));
  return root;
}

test('init --yes scaffolds files and then reports the validation of what it just wrote', (t) => {
  const root = freshProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [path.join(root, 'harness/cli/init.mjs'), '--yes'], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Checking what was just written/);
  // --yes takes every default, and the editable-paths prompt has no
  // default — this is the one error every --yes run necessarily produces,
  // and it's the proof the new validate step actually ran against the
  // adapter init just wrote rather than a fixture.
  assert.match(result.stdout, /allowed_paths is empty/);
  assert.match(result.stdout, /Fix the error\(s\) above first/);
  assert.ok(fs.existsSync(path.join(root, 'project-adapter.yml')));
});

test('validate.mjs standalone agrees with what init just reported', (t) => {
  const root = freshProject();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  spawnSync(process.execPath, [path.join(root, 'harness/cli/init.mjs'), '--yes'], { cwd: root, encoding: 'utf8' });

  const result = spawnSync(process.execPath, [path.join(root, 'harness/scripts/validate.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /allowed_paths is empty/);
  assert.match(result.stdout, /FAIL/);
});
