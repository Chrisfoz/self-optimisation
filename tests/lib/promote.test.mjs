import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { promote, cleanupBranch } from '../../harness/lib/promote.mjs';

/**
 * A real two-repo setup: a bare "origin" and a working clone, so `git push`
 * and `git fetch origin <branch>` behave exactly as they do against a real
 * remote — not simulated. This is what actually proves promote()'s git
 * invocations are correct, the same reasoning as guard.test.mjs's real-repo
 * tests.
 */
function realRemoteSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
  const originDir = path.join(root, 'origin.git');
  const workDir = path.join(root, 'work');

  execFileSync('git', ['init', '-q', '--bare', originDir]);

  fs.mkdirSync(workDir);
  const git = (...args) => execFileSync('git', args, { cwd: workDir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'setup@example.com');
  git('config', 'user.name', 'Setup');
  git('remote', 'add', 'origin', originDir);

  fs.writeFileSync(path.join(workDir, 'index.html'), 'v1');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  git('push', '-q', 'origin', 'main');

  return { root, workDir, git };
}

test('promote: merges an agent branch to main and tags it, verified against a real remote', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git('checkout', '-q', '-b', 'agent/gen-001');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'v2 from the agent');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change');
  git('push', '-q', 'origin', 'agent/gen-001');
  git('checkout', '-q', 'main');

  const result = promote({ repoRoot: workDir, branch: 'agent/gen-001', tag: 'gen-001' });

  assert.deepEqual(result, { merged: true, branch: 'agent/gen-001', tag: 'gen-001', baseBranch: 'main' });
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'v2 from the agent');
  assert.equal(git('rev-parse', 'gen-001'), git('rev-parse', 'main'));

  // The remote must have actually received both the merge and the tag —
  // check by cloning fresh rather than trusting the local working copy.
  // The bare origin's HEAD symref never got updated by any push (nothing
  // sets it outside of `git clone --bare` from a real remote), so a plain
  // `git clone` here checks out an empty tree — explicitly check out main
  // rather than trusting clone's default checkout.
  const freshClone = path.join(root, 'fresh-clone');
  execFileSync('git', ['clone', '-q', '--no-checkout', root + '/origin.git', freshClone]);
  const freshGit = (...args) => execFileSync('git', args, { cwd: freshClone, encoding: 'utf8' }).trim();
  freshGit('checkout', 'main');
  assert.equal(fs.readFileSync(path.join(freshClone, 'index.html'), 'utf8'), 'v2 from the agent');
  assert.doesNotThrow(() => freshGit('rev-parse', 'gen-001'));
});

test('promote: sets the configured commit identity on the merge', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git('checkout', '-q', '-b', 'agent/gen-002');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'v2');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change');
  git('push', '-q', 'origin', 'agent/gen-002');
  git('checkout', '-q', 'main');

  promote({ repoRoot: workDir, branch: 'agent/gen-002', tag: 'gen-002', identity: { name: 'Custom Bot', email: 'bot@example.com' } });

  assert.equal(git('config', 'user.name'), 'Custom Bot');
  assert.equal(git('config', 'user.email'), 'bot@example.com');
});

test('promote: throws without a branch or a tag rather than doing something partial', (t) => {
  const { root, workDir } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => promote({ repoRoot: workDir, tag: 'gen-001' }), /requires a branch/);
  assert.throws(() => promote({ repoRoot: workDir, branch: 'agent/gen-001' }), /requires a tag/);
});

test('promote: a genuine merge conflict throws rather than silently landing something broken', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git('checkout', '-q', '-b', 'agent/gen-003');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'agent version');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change');
  git('push', '-q', 'origin', 'agent/gen-003');

  // main diverges after the branch point, on the same line, guaranteeing a conflict.
  git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'a human changed this too');
  git('add', '-A');
  git('commit', '-q', '-m', 'human change on main');
  git('push', '-q', 'origin', 'main');

  assert.throws(() => promote({ repoRoot: workDir, branch: 'agent/gen-003', tag: 'gen-003' }));
});

test('cleanupBranch: deletes the branch from the remote after a successful merge', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git('checkout', '-q', '-b', 'agent/gen-004');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'v2');
  git('add', '-A');
  git('commit', '-q', '-m', 'x');
  git('push', '-q', 'origin', 'agent/gen-004');

  const result = cleanupBranch({ repoRoot: workDir, branch: 'agent/gen-004' });
  assert.equal(result.deleted, true);

  execFileSync('git', ['fetch', 'origin'], { cwd: workDir });
  const remoteBranches = execFileSync('git', ['branch', '-r'], { cwd: workDir, encoding: 'utf8' });
  assert.doesNotMatch(remoteBranches, /agent\/gen-004/);
});

test('cleanupBranch: a branch that does not exist is reported, not thrown', (t) => {
  const { root, workDir } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = cleanupBranch({ repoRoot: workDir, branch: 'agent/does-not-exist' });
  assert.equal(result.deleted, false);
  assert.ok(result.reason);
});
