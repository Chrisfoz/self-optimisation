import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import { renderAdapterYaml } from '../../harness/lib/scaffold.mjs';

// `init --shared <sha>`: a project whose workflow calls the shared workflow at
// a pinned harness commit, instead of carrying a copy of harness/.

const root = path.join(import.meta.dirname, '../..');
const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';

function project(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-shared-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'project-adapter.yml'), renderAdapterYaml({
    projectId: 'p', defaultBranch: 'main', allowedPaths: ['src/a.js'], frozenPaths: ['.github/**'],
    testCommands: ['npm test'], providers: [{ name: 'openai', envKey: 'OPENAI_API_KEY' }],
    implementModel: 'gpt-5', reviewModel: 'gpt-5', includeSchedule: false,
    agentBriefPath: '.claude/agents/improve.md', reviewerBriefPath: '.claude/agents/review.md',
    ...overrides,
  }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), '');
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/agents/improve.md'), 'brief');
  fs.writeFileSync(path.join(dir, '.claude/agents/review.md'), 'review');
  const init = (...args) => spawnSync(process.execPath, [path.join(root, 'harness/cli/init.mjs'), ...args], { cwd: dir, encoding: 'utf8', stdin: 'ignore' });
  const workflow = () => fs.readFileSync(path.join(dir, '.github/workflows/self-improve.yml'), 'utf8');
  return { dir, init, workflow };
}

test('init --from-adapter regenerates a shared installation at the pin its adapter records', (t) => {
  const { dir, init, workflow } = project(t, { sharedHarness: { ref: SHA1, label: 'v0.1.0' } });
  const r = init('--from-adapter');
  assert.match(r.stdout, /wrote \.github\/workflows\/self-improve\.yml/);
  const doc = loadYaml(workflow());
  assert.equal(doc.jobs['self-improve'].uses, `Chrisfoz/self-optimisation/.github/workflows/self-improve.yml@${SHA1}`);
  assert.ok(!('schedule' in doc.on), 'the adapter said no schedule');
  assert.ok(!fs.existsSync(path.join(dir, 'harness')), 'nothing of the harness is copied in');
  assert.match(fs.readFileSync(path.join(dir, 'SELF-IMPROVE-README.md'), 'utf8'), /No copy of `harness\/` lives in this repository/);
});

test('init --from-adapter --shared moves the pin, and says the adapter still records the old one', (t) => {
  const { init, workflow } = project(t, { sharedHarness: { ref: SHA1 } });
  init('--from-adapter');
  const r = init('--from-adapter', '--shared', SHA2, '--shared-label', 'v0.2.0', '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.match(workflow(), new RegExp(`@${SHA2} # v0\\.2\\.0\\n`));
  assert.match(r.stdout, new RegExp(`records harness\\.shared\\.ref ${SHA1}; the workflow now pins ${SHA2}`));
});

test('init --shared refuses a branch or tag, and leaves the existing workflow alone', (t) => {
  const { init, workflow } = project(t, { sharedHarness: { ref: SHA1 } });
  init('--from-adapter');
  const before = workflow();
  for (const ref of ['main', 'v0.1.0']) {
    const r = init('--from-adapter', '--shared', ref, '--force');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /full 40-character commit SHA/);
  }
  assert.equal(workflow(), before);
});

test('init --from-adapter --shared turns a copied-in installation into a shared one', (t) => {
  const { init, workflow } = project(t);
  init('--from-adapter');
  assert.ok(loadYaml(workflow()).jobs['self-improve'].steps, 'starts copied-in, with steps of its own');
  const r = init('--from-adapter', '--shared', SHA1, '--force');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(loadYaml(workflow()).jobs['self-improve'].uses.endsWith(`@${SHA1}`), true);
  assert.match(r.stdout, /records no shared harness/);
});
