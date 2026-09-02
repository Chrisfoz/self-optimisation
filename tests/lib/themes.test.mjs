import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadLatestThemesReview, buildThemesBrief, reviewedGenerations } from '../../harness/lib/themes.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'themes-test-'));
}

test('loadLatestThemesReview returns null when the themes directory does not exist', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.equal(loadLatestThemesReview({ repoRoot }), null);
});

test('loadLatestThemesReview picks the highest-numbered review, not just the last one alphabetically-adjacent', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const dir = path.join(repoRoot, 'docs/themes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-010.json'), JSON.stringify({ throughGeneration: 10, date: '2026-01-01', themes: [{ noticed: 'a', means: 'b' }] }));
  fs.writeFileSync(path.join(dir, 'review-020.json'), JSON.stringify({ throughGeneration: 20, date: '2026-02-01', themes: [{ noticed: 'c', means: 'd' }] }));

  const review = loadLatestThemesReview({ repoRoot });
  assert.equal(review.throughGeneration, 20);
});

test('loadLatestThemesReview returns null (not a throw) on a malformed file', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const dir = path.join(repoRoot, 'docs/themes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-010.json'), 'not json');
  assert.equal(loadLatestThemesReview({ repoRoot }), null);
});

test('loadLatestThemesReview respects a custom themesDir', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const dir = path.join(repoRoot, 'custom/themes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-001.json'), JSON.stringify({ throughGeneration: 1, date: '2026-01-01', themes: [{ noticed: 'a', means: 'b' }] }));
  const review = loadLatestThemesReview({ repoRoot, themesDir: 'custom/themes' });
  assert.equal(review.throughGeneration, 1);
});

test('buildThemesBrief returns null for a missing or empty review', () => {
  assert.equal(buildThemesBrief(null), null);
  assert.equal(buildThemesBrief({ throughGeneration: 10, themes: [] }), null);
});

test('buildThemesBrief formats real themes for the prompt', () => {
  const review = {
    throughGeneration: 20, date: '2026-02-01',
    themes: [
      { noticed: 'Three generations in a row hit the same output-budget wall.', means: 'Fixed budgets guess against models that do not exist yet.' },
    ],
  };
  const brief = buildThemesBrief(review);
  assert.match(brief, /generation 20/);
  assert.match(brief, /2026-02-01/);
  assert.match(brief, /1\. Noticed: Three generations/);
  assert.match(brief, /Means: Fixed budgets guess/);
});


// --- reviewedGenerations ------------------------------------------------------
// Read from the filenames rather than by opening each file: the filename is
// what loadLatestThemesReview() sorts on, so it is the thing that has to be
// unique.

test('reviewedGenerations returns [] for a project that has never reached a cadence boundary', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.deepEqual(reviewedGenerations({ repoRoot }), []);
});

test('reviewedGenerations lists the generations covered, ignoring anything else in the directory', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const dir = path.join(repoRoot, 'docs/themes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-010.json'), '{}');
  fs.writeFileSync(path.join(dir, 'review-020.json'), '{}');
  fs.writeFileSync(path.join(dir, 'README.md'), 'notes');
  fs.writeFileSync(path.join(dir, 'review-draft.json'), '{}');
  assert.deepEqual(reviewedGenerations({ repoRoot }), ['010', '020']);
});

test('buildOpenQuestionsBrief: renders only themes with an UNKNOWN, numbered for citation, and null when none carry one', async () => {
  const { buildOpenQuestionsBrief } = await import('../../harness/lib/themes.mjs');
  const review = { throughGeneration: '010', date: '2026-09-02', themes: [
    { noticed: 'a', means: 'b' },
    { noticed: 'c', means: 'd', unknown: 'does the reviewer ever see timing?' },
    { noticed: 'e', means: 'f', unknown: '   ' },
  ] };
  const brief = buildOpenQuestionsBrief(review);
  assert.match(brief, /through generation 010/);
  assert.match(brief, /- q2: does the reviewer ever see timing\?/);
  assert.doesNotMatch(brief, /q1:|q3:/);
  assert.equal(buildOpenQuestionsBrief({ throughGeneration: '010', themes: [{ noticed: 'a', means: 'b' }] }), null);
  assert.equal(buildOpenQuestionsBrief(null), null);
});
