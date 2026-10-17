import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateLessons, buildLessonsBrief, observationsFrom, lessonKey, supersede, refreshLessons, LESSONS_FILE } from '../../harness/lib/lessons.mjs';

const failed = (generation, detail, files = ['src/a.js'], outcome = 'rejected-by-review') => ({
  generation, outcome: 'abandoned', provenance: { baseCommit: 'c0' },
  attempts: [{ attempt: 1, outcome, detail, files }],
});
const approved = (generation, files, pullRequest = null, extra = {}) => ({
  generation, outcome: 'approved', proposalSummary: 'add a pause button',
  attempts: [{ attempt: 1, outcome: 'approved', detail: 'add a pause button', files }],
  ...(pullRequest ? { pullRequest } : {}), ...extra,
});

let hashes;
const lookups = () => ({ hashOf: (f) => hashes[f] ?? null, depsOf: (f) => (f === 'src/a.js' ? ['src/b.js'] : []), date: '2026-10-17' });

test('observationsFrom: failed attempts and a shipped change, with a person\'s verdict where there is one', () => {
  assert.equal(observationsFrom(failed('001', 'x')).length, 1);
  assert.equal(observationsFrom({ attempts: [{ outcome: 'edits-did-not-apply', detail: 'x', files: ['a'] }] }).length, 0, 'a formatting slip is not a lesson');
  assert.equal(observationsFrom(approved('002', ['a'], { state: 'merged' }))[0].verdict, 'merged');
  const closed = observationsFrom(approved('003', ['a'], { state: 'closed' }))[0];
  assert.equal(closed.kind, 'failure');
  assert.match(closed.text, /closed without merging/);
  assert.match(observationsFrom(approved('004', ['a'], null, { reverted: { reason: 'broke mobile' } }))[0].text, /reverted.*broke mobile/);
});

test('lessonKey ignores the numbers that differ between two sightings of one failure', () => {
  assert.equal(lessonKey('failure', ['a'], 'tests-failed exit 1 at line 12 in gen-003'), lessonKey('failure', ['a'], 'tests-failed exit 2 at line 40 in gen-007'));
  assert.notEqual(lessonKey('failure', ['a'], 'x'), lessonKey('failure', ['b'], 'x'));
});

test('one observation is a candidate; the same failure in a second generation verifies it, without a duplicate', () => {
  hashes = { 'src/a.js': 'h1', 'src/b.js': 'd1' };
  let ledger = updateLessons(null, [failed('001', 'Missing null check in total()')], lookups());
  assert.equal(ledger.lessons.length, 1);
  assert.equal(ledger.lessons[0].status, 'candidate');
  assert.deepEqual(ledger.lessons[0].dependencies, { 'src/b.js': 'd1' });
  ledger = updateLessons(ledger, [failed('001', 'Missing null check in total()'), failed('004', 'Missing null check in total()')], lookups());
  assert.equal(ledger.lessons.length, 1);
  assert.equal(ledger.lessons[0].status, 'verified');
  assert.deepEqual(ledger.lessons[0].evidence.map((e) => e.generation), ['001', '004']);
  // Idempotent.
  assert.deepEqual(updateLessons(ledger, [failed('001', 'Missing null check in total()'), failed('004', 'Missing null check in total()')], lookups()), ledger);
});

test('a merge verifies a success; a change to the file or to what it imports makes a lesson stale and drops it from the brief', () => {
  hashes = { 'src/a.js': 'h1', 'src/b.js': 'd1' };
  let ledger = updateLessons(null, [approved('002', ['src/a.js'], { state: 'merged' }), failed('003', 'Off by one in paging', ['src/a.js'])], lookups());
  assert.deepEqual(ledger.lessons.map((l) => l.status), ['verified', 'candidate']);
  let brief = buildLessonsBrief(ledger, { hashOf: (f) => hashes[f] });
  assert.match(brief, /\[L-0001 · verified\] An approved change to src\/a\.js, merged by a person/);
  assert.match(brief, /\[L-0002 · candidate\]/);
  assert.ok(brief.indexOf('L-0001') < brief.indexOf('L-0002'), 'verified first');

  hashes['src/b.js'] = 'd2'; // a dependency changed, the file itself did not
  brief = buildLessonsBrief(ledger, { hashOf: (f) => hashes[f] });
  assert.equal(brief, null, 'nothing current to say');
  ledger = updateLessons(ledger, [], lookups());
  assert.deepEqual(ledger.lessons.map((l) => l.status), ['stale', 'stale']);

  // Seen again after the change: current again, re-anchored.
  ledger = updateLessons(ledger, [failed('005', 'Off by one in paging', ['src/a.js'])], lookups());
  assert.equal(ledger.lessons[1].status, 'verified');
  assert.equal(ledger.lessons[1].dependencies['src/b.js'], 'd2');
});

test('supersede is kept through every later update; the brief respects its budget and says what it left out', () => {
  hashes = { 'src/a.js': 'h1', 'src/b.js': 'd1' };
  let ledger = updateLessons(null, [failed('001', 'one'), failed('002', 'two'), failed('003', 'three')], lookups());
  supersede(ledger, 'L-0001', { note: 'the owner rewrote this module' });
  ledger = updateLessons(ledger, [failed('001', 'one')], lookups());
  assert.equal(ledger.lessons[0].status, 'superseded');
  const brief = buildLessonsBrief(ledger, { hashOf: (f) => hashes[f], maxChars: 120 });
  assert.doesNotMatch(brief, /L-0001/);
  assert.match(brief, /1 more lesson\(s\) not shown/);
  assert.throws(() => supersede(ledger, 'L-9999'), /no lesson/);
});

test('refreshLessons: failed attempts are anchored to the commit they were tried on, and status is stored as of the named branch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'A');
  fs.writeFileSync(path.join(root, 'a.js'), 'v1');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  // The agent branch's tree: the approved change applied.
  fs.writeFileSync(path.join(root, 'a.js'), 'v2');
  fs.mkdirSync(path.join(root, 'docs/generations/gen-001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/generations/gen-001/attempts.json'), JSON.stringify({
    generation: '001', outcome: 'approved', provenance: { baseCommit: base }, proposalSummary: 'v2',
    attempts: [{ attempt: 1, outcome: 'tests-failed', detail: 'boom', files: ['a.js'] }, { attempt: 2, outcome: 'approved', detail: 'v2', files: ['a.js'] }],
  }));
  const ledger = refreshLessons({ repoRoot: root, statusRef: 'main' });
  const [failure, success] = ledger.lessons;
  assert.equal(failure.status, 'candidate', 'current on main, where a.js is still v1');
  assert.equal(success.status, 'stale', 'the change is not on main yet');
  assert.ok(fs.existsSync(path.join(root, 'docs/generations', LESSONS_FILE)));
});
