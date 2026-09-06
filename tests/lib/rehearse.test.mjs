import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { nextGenerationNumber } from '../../harness/lib/rehearse.mjs';

/** A real repo, so tag listing and sorting go through real git rather than a fixture of its output shape. */
function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.c');
  git('config', 'user.name', 'A');
  fs.writeFileSync(path.join(root, 'f'), 'x');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, git };
}

test('nextGenerationNumber: "001" on a repo with no gen- tags at all', (t) => {
  const { root, git } = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(nextGenerationNumber(git), '001');
});

test('nextGenerationNumber: one past the highest existing tag, not the count of tags', (t) => {
  const { root, git } = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git('tag', 'gen-001');
  git('tag', 'gen-002');
  git('tag', 'gen-005'); // a gap — e.g. 003/004 were reverted or never tagged
  assert.equal(nextGenerationNumber(git), '006');
});

test('nextGenerationNumber: sorts numerically, not lexicographically', (t) => {
  const { root, git } = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git('tag', 'gen-002');
  git('tag', 'gen-010'); // lexicographically before "gen-002", numerically after
  assert.equal(nextGenerationNumber(git), '011');
});

test('nextGenerationNumber: ignores tags that are not gen-<number>', (t) => {
  const { root, git } = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git('tag', 'gen-003');
  git('tag', 'v1.0.0');
  assert.equal(nextGenerationNumber(git), '004');
});

test('nextGenerationNumber: widens past three digits rather than truncating', (t) => {
  const { root, git } = tempRepo();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git('tag', 'gen-999');
  assert.equal(nextGenerationNumber(git), '1000');
});
