import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { revertGeneration, findShippedCommit } from '../../harness/lib/rollback.mjs';
import { promote } from '../../harness/lib/promote.mjs';
import { recommendScope, buildGenerationIndex, buildGenerationHistory } from '../../harness/lib/context-pack.mjs';

/** Same real bare-origin + working-clone setup promote.test.mjs uses. */
function realRemoteSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
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

function writeRecord(workDir, gen, record) {
  const dir = path.join(workDir, 'docs/generations', `gen-${gen}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'attempts.json'), JSON.stringify(record, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'proposal.md'), `# Generation ${gen} — proposal\n\n- **Suggested by:** \`m\` (lab)\n- **Attempts:** 1\n- **Summary:** Changed index\n`);
}

const CLEAN = { outcome: 'approved', attempts: [{ attempt: 1, outcome: 'approved' }] };

/** Ship a generation the way the agent branch + promote would. */
function shipViaTag(workDir, git, gen, content) {
  writeRecord(workDir, gen, CLEAN);
  git('add', '-A');
  git('commit', '-q', '-m', `record gen-${gen}`);
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', `agent/gen-${gen}`);
  fs.writeFileSync(path.join(workDir, 'index.html'), content);
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change');
  git('push', '-q', 'origin', `agent/gen-${gen}`);
  git('checkout', '-q', 'main');
  promote({ repoRoot: workDir, branch: `agent/gen-${gen}`, tag: `gen-${gen}` });
}

test('revertGeneration: the autonomous path — finds the gen tag, reverts the merge, records it, pushes', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  shipViaTag(workDir, git, '001', 'v2 from the agent');
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'v2 from the agent');

  const result = revertGeneration({ repoRoot: workDir, genNumber: '001', reason: 'made the game worse', now: new Date('2026-09-02T00:00:00Z') });
  assert.equal(result.via, 'tag');
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'v1');
  const record = JSON.parse(fs.readFileSync(path.join(workDir, 'docs/generations/gen-001/attempts.json'), 'utf8'));
  assert.equal(record.reverted.reason, 'made the game worse');
  assert.equal(record.reverted.date, '2026-09-02');
  assert.equal(record.reverted.revertCommit, result.revertCommit);
  assert.doesNotThrow(() => git('rev-parse', 'gen-001'), 'the tag is left in place');

  // The remote has the revert AND the record.
  const fresh = path.join(root, 'fresh');
  execFileSync('git', ['clone', '-q', '--no-checkout', path.join(root, 'origin.git'), fresh]);
  execFileSync('git', ['checkout', 'main'], { cwd: fresh });
  assert.equal(fs.readFileSync(path.join(fresh, 'index.html'), 'utf8'), 'v1');
  assert.match(fs.readFileSync(path.join(fresh, 'docs/generations/gen-001/attempts.json'), 'utf8'), /"reverted"/);

  // And the next run reads it as a failure, in both the streak and the prompt.
  writeRecord(workDir, '000', CLEAN);
  assert.equal(recommendScope({ repoRoot: workDir, required: 2 }).scope, 'focused');
  assert.match(buildGenerationIndex({ repoRoot: workDir }), /\| 001 \| .* \| REVERTED \|/);
  assert.match(buildGenerationHistory({ repoRoot: workDir, limit: 1 }), /REVERTED — merged, then reverted by a person — made the game worse/);
});

test('revertGeneration: the pull-request path — uses the merge commit in the record, with no tag present', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  git('checkout', '-q', '-b', 'agent/gen-002');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'v2 via a PR');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change');
  git('checkout', '-q', 'main');
  git('merge', '--no-ff', '--no-edit', 'agent/gen-002'); // what "Merge pull request" produces
  const mergeCommit = git('rev-parse', 'HEAD');
  writeRecord(workDir, '002', { ...CLEAN, pullRequestUrl: 'https://github.com/o/r/pull/2', pullRequest: { state: 'merged', mergeCommit } });
  git('add', '-A');
  git('commit', '-q', '-m', 'record');
  git('push', '-q', 'origin', 'main');

  const result = revertGeneration({ repoRoot: workDir, genNumber: '002', gh: () => { throw new Error('gh must not be called when the record has the commit'); } });
  assert.equal(result.via, 'record');
  assert.equal(result.commit, mergeCommit);
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'v1');
});

test('revertGeneration: asks gh for the merge commit when the sync has not run, and refuses an unmerged or closed PR', (t) => {
  const { root, workDir, git } = realRemoteSetup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git('checkout', '-q', '-b', 'agent/gen-003');
  fs.writeFileSync(path.join(workDir, 'index.html'), 'v3');
  git('add', '-A');
  git('commit', '-q', '-m', 'agent change');
  git('checkout', '-q', 'main');
  git('merge', '--no-ff', '--no-edit', 'agent/gen-003');
  const mergeCommit = git('rev-parse', 'HEAD');
  writeRecord(workDir, '003', { ...CLEAN, pullRequestUrl: 'https://github.com/o/r/pull/3' });
  writeRecord(workDir, '004', { ...CLEAN, pullRequestUrl: 'https://github.com/o/r/pull/4', pullRequest: { state: 'closed' } });
  git('add', '-A');
  git('commit', '-q', '-m', 'records');
  git('push', '-q', 'origin', 'main');

  const result = revertGeneration({ repoRoot: workDir, genNumber: '003', gh: () => mergeCommit });
  assert.equal(result.via, 'gh');
  assert.equal(fs.readFileSync(path.join(workDir, 'index.html'), 'utf8'), 'v1');
  assert.throws(() => revertGeneration({ repoRoot: workDir, genNumber: '004' }), /closed without merging/);
  assert.throws(() => revertGeneration({ repoRoot: workDir, genNumber: '003' }), /already reverted/);
  assert.throws(() => findShippedCommit({ repoRoot: workDir, genNumber: '999', git: (...a) => execFileSync('git', a, { cwd: workDir, encoding: 'utf8' }).trim() }), /nothing shipped/);
});
