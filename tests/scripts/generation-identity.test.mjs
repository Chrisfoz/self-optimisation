import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  generationOf, highestGeneration, nextGenerationNumber, reserveGeneration, runIdentity,
} from '../../harness/lib/generation-id.mjs';
import { persistRecords, changedFiles } from '../../harness/lib/persist-records.mjs';
import { renderSteps, findStep, runStep, shellTestOptions } from '../helpers/gha-shell.mjs';

// Real git throughout: a bare "origin" and clones of it, because the whole
// point is how refs, leases, worktrees and pushes actually behave.

const harnessRoot = path.join(import.meta.dirname, '../..');

function sh(cwd) {
  return (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** origin (bare) + one clone with a first commit on main. */
function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-id-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const clone = (name) => {
    const dir = path.join(root, name);
    // autocrlf off: a Windows machine's global setting would otherwise
    // rewrite line endings on checkout and every content check would fail.
    execFileSync('git', ['clone', '-q', '-c', 'core.autocrlf=false', origin, dir], { stdio: 'ignore' });
    const git = sh(dir);
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'A');
    return { dir, git };
  };
  const a = clone('a');
  fs.writeFileSync(path.join(a.dir, 'project-adapter.yml'), 'project:\n  id: p\n  default_branch: main\ncontext:\n  generations_dir: docs/generations\n');
  fs.writeFileSync(path.join(a.dir, 'game.js'), 'let speed = 1;\n');
  a.git('add', '-A');
  a.git('commit', '-q', '-m', 'base');
  a.git('push', '-q', 'origin', 'main');
  return { root, origin, clone, a };
}

function writeRecord(dir, n, outcome = 'abandoned') {
  const gen = path.join(dir, 'docs/generations', `gen-${n}`);
  fs.mkdirSync(gen, { recursive: true });
  fs.writeFileSync(path.join(gen, 'attempts.json'), JSON.stringify({ generation: n, outcome }) + '\n');
}

// --- pure ------------------------------------------------------------------------

test('generationOf / highestGeneration read a number out of tags, branches and record dirs alike', () => {
  assert.equal(generationOf('gen-007'), 7);
  assert.equal(generationOf('origin/agent/gen-012'), 12);
  assert.equal(generationOf('docs/generations/gen-003'), 3);
  assert.equal(generationOf('agent/general'), null);
  assert.equal(highestGeneration({ tags: ['gen-002'], branches: ['origin/agent/gen-009'], recordDirs: ['gen-004', 'README.md'] }), 9);
  assert.equal(highestGeneration({}), 0);
});

test('runIdentity: a GitHub re-run is a different run from the original', () => {
  const env = { GITHUB_RUN_ID: '555', GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r' };
  assert.equal(runIdentity({ ...env, GITHUB_RUN_ATTEMPT: '1' }).id, '555-1');
  assert.equal(runIdentity({ ...env, GITHUB_RUN_ATTEMPT: '2' }).id, '555-2');
  assert.match(runIdentity({ ...env, GITHUB_RUN_ATTEMPT: '2' }).url, /runs\/555\/attempts\/2$/);
  assert.match(runIdentity({}).id, /^local-\d{8}T\d{6}Z-\d+$/);
  assert.equal(runIdentity({ RUN_ID: 'given' }).id, 'given');
});

// --- numbering on the pull-request path (no tags, ever) -----------------------------

test('the pull-request path numbers upward: a persisted record, or a claimed branch, moves the next number on (confirmed defect)', (t) => {
  const { a } = world(t);
  // The old rule — tags only — gives 001 forever on this path.
  assert.equal(nextGenerationNumber(a.git, { baseRef: 'origin/main' }), '001');

  // Generation 001 claims its branch, fails, and persists its record.
  const first = reserveGeneration(a.git, { start: '001', remote: 'origin' });
  assert.equal(first.branch, 'agent/gen-001');
  a.git('checkout', '-q', first.branch);
  writeRecord(a.dir, '001');
  persistRecords({ repoRoot: a.dir, roots: ['docs/generations/gen-001'], baseBranch: 'main', message: 'gen 1 record' });

  assert.equal(nextGenerationNumber(a.git, { baseRef: 'origin/main' }), '002');

  // Even if the record had been lost, the claimed branch alone is enough.
  a.git('push', '-q', 'origin', '--delete', 'agent/gen-001');
  a.git('checkout', '-q', 'main');
  a.git('branch', '-q', '-D', 'agent/gen-001');
  a.git('fetch', '-q', '--prune', 'origin');
  assert.equal(nextGenerationNumber(a.git, { baseRef: 'origin/main' }), '002', 'the record on main still counts');
});

test('reserveGeneration: a branch another run claimed after we looked is not taken — the next number is', (t) => {
  const { a, clone } = world(t);
  const b = clone('b');
  // Both runs compute 001 from the same state...
  const startA = nextGenerationNumber(a.git, { baseRef: 'origin/main' });
  const startB = nextGenerationNumber(b.git, { baseRef: 'origin/main' });
  assert.equal(startA, startB);
  // ...one claims it first...
  assert.equal(reserveGeneration(b.git, { start: startB, remote: 'origin' }).number, '001');
  // ...and the other's lease fails, so it moves up rather than fast-forwarding b's branch.
  const claimed = reserveGeneration(a.git, { start: startA, remote: 'origin' });
  assert.equal(claimed.number, '002');
  assert.deepEqual(claimed.collisions, ['001']);
});

test('reserveGeneration without a remote (a rehearsal) refuses an existing local branch the same way', (t) => {
  const { a } = world(t);
  a.git('branch', 'agent/gen-001');
  assert.equal(reserveGeneration(a.git, { start: '001', remote: null }).number, '002');
});

// --- persisting records ---------------------------------------------------------------

test('persistRecords: an abandoned generation\'s record reaches main, and the agent branch and checkout are untouched', (t) => {
  const { a, clone } = world(t);
  a.git('checkout', '-q', '-b', 'agent/gen-001');
  fs.writeFileSync(path.join(a.dir, 'game.js'), 'let speed = 2;\n'); // an edit that is NOT a record
  writeRecord(a.dir, '001', 'abandoned');
  fs.mkdirSync(path.join(a.dir, 'docs/escalations'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'docs/escalations/ledger.json'), '{"entries":[]}\n');

  const result = persistRecords({
    repoRoot: a.dir, baseBranch: 'main', message: 'Generation 001: record (abandoned)',
    roots: ['docs/generations/gen-001', 'docs/escalations/ledger.json', 'docs/themes'],
  });
  assert.equal(result.pushed, true);
  assert.deepEqual(result.files.sort(), ['docs/escalations/ledger.json', 'docs/generations/gen-001/attempts.json']);

  const c = clone('c');
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.dir, 'docs/generations/gen-001/attempts.json'), 'utf8')).outcome, 'abandoned');
  assert.equal(fs.readFileSync(path.join(c.dir, 'game.js'), 'utf8'), 'let speed = 1;\n', 'the code edit did not ride along');
  assert.equal(a.git('branch', '--show-current'), 'agent/gen-001', 'the job\'s checkout was never switched');
  assert.equal(fs.readFileSync(path.join(a.dir, 'game.js'), 'utf8'), 'let speed = 2;\n');
  assert.equal(a.git('worktree', 'list').split('\n').length, 1, 'the temporary worktree is gone');

  // Nothing new since: nothing to do.
  const again = persistRecords({ repoRoot: a.dir, baseBranch: 'main', message: 'x', roots: ['docs/generations/gen-001'] });
  assert.equal(again.committed, false);
});

test('persistRecords: a push that loses a race retries on the new tip, and keeps the other writer\'s commit', (t) => {
  const { a, clone } = world(t);
  const b = clone('b');
  writeRecord(a.dir, '002');
  const result = persistRecords({
    repoRoot: a.dir, baseBranch: 'main', message: 'gen 2 record', roots: ['docs/generations/gen-002'],
    beforePush: (attempt) => {
      if (attempt !== 1) return;
      fs.writeFileSync(path.join(b.dir, 'other.txt'), 'someone else\n');
      b.git('add', '-A');
      b.git('commit', '-q', '-m', 'someone else pushed first');
      b.git('push', '-q', 'origin', 'main');
    },
  });
  assert.equal(result.pushed, true);
  assert.equal(result.attempts, 2);
  const c = clone('c');
  assert.ok(fs.existsSync(path.join(c.dir, 'other.txt')));
  assert.ok(fs.existsSync(path.join(c.dir, 'docs/generations/gen-002/attempts.json')));
});

test('persistRecords: only files this run changed are copied, so a shared directory is never rolled back', (t) => {
  const { a, clone } = world(t);
  fs.mkdirSync(path.join(a.dir, 'docs/themes'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'docs/themes/review-001.md'), 'old\n');
  a.git('add', '-A');
  a.git('commit', '-q', '-m', 'an old review');
  a.git('push', '-q', 'origin', 'main');
  // Someone improves the old review on main after this job checked out.
  const b = clone('b');
  fs.writeFileSync(path.join(b.dir, 'docs/themes/review-001.md'), 'corrected\n');
  b.git('commit', '-q', '-am', 'fix review');
  b.git('push', '-q', 'origin', 'main');
  // This run writes a new review; its stale copy of the old one must not win.
  fs.writeFileSync(path.join(a.dir, 'docs/themes/review-002.md'), 'new\n');
  assert.deepEqual(changedFiles(a.git, ['docs/themes']), ['docs/themes/review-002.md']);
  persistRecords({ repoRoot: a.dir, baseBranch: 'main', message: 'r', roots: ['docs/themes'] });
  const c = clone('c');
  assert.equal(fs.readFileSync(path.join(c.dir, 'docs/themes/review-001.md'), 'utf8'), 'corrected\n');
  assert.equal(fs.readFileSync(path.join(c.dir, 'docs/themes/review-002.md'), 'utf8'), 'new\n');
});

test('persistRecords: a MODIFIED tracked file as the first entry keeps its full path (the first GitHub Actions run)', (t) => {
  // " M docs/escalations/ledger.json" — the leading space is a status column.
  // A trimmed runner turned it into "ocs/escalations/ledger.json" and the
  // record was lost with the runner.
  const { a, clone } = world(t);
  fs.mkdirSync(path.join(a.dir, 'docs/escalations'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'docs/escalations/ledger.json'), '{"entries":[]}\n');
  a.git('add', '-A');
  a.git('commit', '-q', '-m', 'a ledger already on main');
  a.git('push', '-q', 'origin', 'main');
  a.git('checkout', '-q', '-b', 'agent/gen-003');
  fs.writeFileSync(path.join(a.dir, 'docs/escalations/ledger.json'), '{"entries":[{"id":"esc-001"}]}\n');
  writeRecord(a.dir, '003', 'approved');

  const result = persistRecords({ repoRoot: a.dir, baseBranch: 'main', message: 'gen 3', roots: ['docs/escalations/ledger.json', 'docs/generations/gen-003'] });
  assert.equal(result.pushed, true);
  assert.ok(result.files.includes('docs/escalations/ledger.json'), result.files.join(', '));
  const c = clone('c');
  assert.match(fs.readFileSync(path.join(c.dir, 'docs/escalations/ledger.json'), 'utf8'), /esc-001/);
});

test('changedFiles refuses output from a runner that trimmed the status columns, rather than mis-slicing it', () => {
  const trimming = () => 'M docs/escalations/ledger.json\0';
  assert.throws(() => changedFiles(trimming, ['docs']), /must not trim/);
});

test('workflow: a record that could not be saved turns the whole run red, after the digest', () => {
  for (const approvalClass of ['human-approval-required', 'autonomous-merge']) {
    const { steps } = renderSteps({ projectId: 'p', allowedPaths: ['a'], testCommands: ['true'], approvalClass, providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }] });
    // Found by name: later steps turn other silent failures red too (a crash,
    // an unreachable pinned seat), so it is no longer necessarily the last.
    const index = steps.findIndex((s) => /record was not saved/.test(s.name ?? ''));
    const step = steps[index];
    assert.match(step.if, /steps\.persist\.outcome == 'failure'/);
    assert.match(step.run, /exit 1/);
    const digest = steps.findIndex((s) => /Send the generation digest/.test(s.name ?? ''));
    assert.ok(digest === -1 || digest < index, 'after the digest, so the digest still has its say');
    assert.ok(steps.slice(index).every((s) => /^Fail the run/.test(s.name ?? '')), 'only other red-run checks follow it');
  }
});

test('persistRecords without a remote (a rehearsal) commits to the local base branch only', (t) => {
  const { a } = world(t);
  const before = a.git('rev-parse', 'origin/main');
  a.git('checkout', '-q', '-b', 'agent/gen-001');
  writeRecord(a.dir, '001');
  const result = persistRecords({ repoRoot: a.dir, baseBranch: 'main', remote: null, message: 'local', roots: ['docs/generations/gen-001'] });
  assert.equal(result.committed, true);
  assert.equal(result.pushed, false);
  assert.ok(a.git('ls-tree', '--name-only', 'main:docs/generations').includes('gen-001'));
  assert.equal(a.git('rev-parse', 'origin/main'), before, 'nothing was pushed');
});

// --- run-generation refuses to overwrite a record ----------------------------------------

test('run-generation.mjs will not overwrite an existing generation record', (t) => {
  const { a } = world(t);
  writeRecord(a.dir, '001', 'approved');
  const r = spawnSync(process.execPath, [path.join(harnessRoot, 'harness/scripts/run-generation.mjs')], {
    cwd: a.dir, encoding: 'utf8',
    env: { ...process.env, GEN_NUMBER: '001', SUGGEST_MODELS: '[{"id":"m","provider":"anthropic"}]', GITHUB_OUTPUT: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already has a record/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a.dir, 'docs/generations/gen-001/attempts.json'), 'utf8')).outcome, 'approved');
});

// --- the rendered workflow steps, run as GitHub would run them -----------------------------

/** A clone that vendors the harness the way a real installation does. */
function vendoredClone(t) {
  const w = world(t);
  fs.cpSync(path.join(harnessRoot, 'harness'), path.join(w.a.dir, 'harness'), { recursive: true });
  fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(w.a.dir, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(w.a.dir, '.gitignore'), 'node_modules\n');
  w.a.git('add', '-A');
  w.a.git('commit', '-q', '-m', 'vendor the harness');
  w.a.git('push', '-q', 'origin', 'main');
  return w;
}

const shellOpts = shellTestOptions();

test('workflow: the claim step and the persist step, twice over, give two generations and two records on main', shellOpts, (t) => {
  const { a, clone } = vendoredClone(t);
  const { steps } = renderSteps({
    projectId: 'p', defaultBranch: 'main', allowedPaths: ['game.js'], testCommands: ['true'],
    providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  });
  const gen = findStep(steps, 'gen');
  const persist = findStep(steps, 'persist');

  const numbers = [];
  for (const outcome of ['abandoned', 'no-proposal']) {
    a.git('checkout', '-q', 'main');
    a.git('pull', '-q', 'origin', 'main');
    const claimed = runStep(gen, { cwd: a.dir, env: { GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: String(numbers.length + 1) } });
    assert.equal(claimed.status, 0, claimed.stderr);
    numbers.push(claimed.outputs.number);
    assert.equal(claimed.outputs.branch, `agent/gen-${claimed.outputs.number}`);
    assert.equal(claimed.outputs['run-id'], `42-${numbers.length}`);
    assert.equal(a.git('branch', '--show-current'), claimed.outputs.branch);

    writeRecord(a.dir, claimed.outputs.number, outcome);
    const saved = runStep(persist, { cwd: a.dir, env: { GEN_NUMBER: claimed.outputs.number } });
    assert.equal(saved.status, 0, saved.stderr);
    assert.equal(saved.outputs.persisted, 'true');
    fs.rmSync(path.join(a.dir, 'docs'), { recursive: true, force: true }); // the runner is thrown away
  }
  assert.deepEqual(numbers, ['001', '002']);
  const c = clone('c');
  assert.deepEqual(fs.readdirSync(path.join(c.dir, 'docs/generations')).sort(), ['gen-001', 'gen-002']);
});

test('workflow: the agent-branch commit stages a newly created file under create_only_paths', shellOpts, (t) => {
  const { a } = vendoredClone(t);
  const { steps } = renderSteps({
    projectId: 'p', defaultBranch: 'main', allowedPaths: ['game.js'], createOnlyPaths: ['tests/**'], testCommands: ['true'],
    providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }],
  });
  a.git('checkout', '-q', '-b', 'agent/gen-001');
  a.git('push', '-q', 'origin', 'agent/gen-001');
  fs.writeFileSync(path.join(a.dir, 'game.js'), 'let speed = 2;\n');
  fs.mkdirSync(path.join(a.dir, 'tests/unit'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, 'tests/unit/speed.test.js'), 'test\n');
  writeRecord(a.dir, '001', 'approved'); // a record: must NOT be committed here

  const commit = steps.find((s) => /^Commit and push the agent branch/.test(s.name || ''));
  const r = runStep(commit, { cwd: a.dir, env: { BRANCH: 'agent/gen-001', GEN_NUMBER: '001', SUMMARY: 'Faster' } });
  assert.equal(r.status, 0, r.stderr);
  const committed = a.git('show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  assert.deepEqual(committed, ['game.js', 'tests/unit/speed.test.js']);
});
