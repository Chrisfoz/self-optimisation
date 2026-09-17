import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectDefaultBranch, remoteDefaultBranch, gitRunner } from '../../harness/lib/git-default-branch.mjs';
import { validateAdapter } from '../../harness/lib/validate.mjs';

// init.mjs offered the CURRENT branch as the default, and the walkthrough has
// you on self-optimisation-setup by then. These drive real git repositories,
// because the bug was in what git reports from each state.

function run(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'default-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repoWithCommit(dir, branch = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  run(dir, 'init', '-q', '-b', branch);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  run(dir, 'add', '.');
  run(dir, 'commit', '-q', '-m', 'first');
}

test('a clone on a setup branch still reports the remote default, not the branch it is on', (t) => {
  const root = tempDir(t);
  const origin = path.join(root, 'origin');
  repoWithCommit(origin, 'main');
  run(root, 'clone', '-q', origin, 'clone');
  const clone = path.join(root, 'clone');
  run(clone, 'checkout', '-q', '-b', 'self-optimisation-setup');

  const git = gitRunner(clone);
  assert.equal(git('branch', '--show-current'), 'self-optimisation-setup', 'the old detector would have offered this');
  assert.equal(remoteDefaultBranch(git), 'main');
  assert.equal(detectDefaultBranch(git), 'main');
});

test('a remote whose default is not main is followed, not assumed', (t) => {
  const root = tempDir(t);
  const origin = path.join(root, 'origin');
  repoWithCommit(origin, 'trunk');
  run(root, 'clone', '-q', origin, 'clone');
  const git = gitRunner(path.join(root, 'clone'));
  assert.equal(detectDefaultBranch(git), 'trunk');
});

test('no remote: a local main is preferred over the branch you are on', (t) => {
  const dir = tempDir(t);
  repoWithCommit(dir, 'main');
  run(dir, 'checkout', '-q', '-b', 'self-optimisation-setup');
  const git = gitRunner(dir);
  assert.equal(remoteDefaultBranch(git), null);
  assert.equal(detectDefaultBranch(git), 'main');
});

test('no remote and no main or master: no guess, so the caller falls back', (t) => {
  const dir = tempDir(t);
  repoWithCommit(dir, 'develop');
  assert.equal(detectDefaultBranch(gitRunner(dir)), null);
});

test('not a git repository at all: null, never a throw', (t) => {
  const dir = tempDir(t);
  assert.equal(detectDefaultBranch(gitRunner(dir)), null);
});

test('validate warns when default_branch disagrees with the remote, and only then', () => {
  const adapter = { project: { id: 'x', default_branch: 'self-optimisation-setup' }, constitution: { allowed_paths: [] } };
  const warned = validateAdapter(adapter, { repoRoot: os.tmpdir(), env: {}, remoteDefaultBranch: 'main' });
  assert.ok(warned.warnings.some((w) => /default_branch is "self-optimisation-setup".*default branch is "main"/.test(w)));

  const agrees = validateAdapter({ ...adapter, project: { id: 'x', default_branch: 'main' } }, { repoRoot: os.tmpdir(), env: {}, remoteDefaultBranch: 'main' });
  assert.ok(!agrees.warnings.some((w) => /default_branch/.test(w)));

  // Unknown (a shallow CI checkout has no origin/HEAD) is not wrong.
  const unknown = validateAdapter(adapter, { repoRoot: os.tmpdir(), env: {}, remoteDefaultBranch: null });
  assert.ok(!unknown.warnings.some((w) => /default_branch/.test(w)));
});
