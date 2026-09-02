import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * The themes-review CLI, run as a real child process against a real
 * temporary project — the same boundary the generated workflow calls it
 * across.
 *
 * Everything decidable from plain data (the cadence rule, the prompts, the
 * parser, the output object, the filename padding) is unit-tested in
 * tests/lib/generate-themes.test.mjs. What only a child process can prove is
 * the wiring: that the script's imports resolve, that it reads the adapter's
 * `memory.themes_review` section rather than some other one, that it finds
 * the generation records on disk, and — the part worth the most — that every
 * failure path writes NOTHING and exits with the code a workflow step will
 * read.
 *
 * The model call is the one thing not exercised. It is reached, though: the
 * "due, and the call fails" case below runs the whole script including
 * history assembly and stops at the API boundary because no key is set,
 * which is exactly the failure a real installation hits first.
 */

const SCRIPT = path.join(import.meta.dirname, '../../harness/scripts/generate-themes-review.mjs');

function project({ adapter, generations = [], reviews = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'themes-cli-'));
  if (adapter) fs.writeFileSync(path.join(root, 'project-adapter.yml'), adapter);
  for (const gen of generations) {
    const dir = path.join(root, 'docs/generations', `gen-${gen}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'proposal.md'),
      `# Generation ${gen} — proposal\n\n- **Summary:** did something in generation ${gen}\n`
    );
  }
  for (const [name, body] of Object.entries(reviews)) {
    const dir = path.join(root, 'docs/themes');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  return root;
}

const ADAPTER = `project:
  id: test-project
memory:
  themes_review:
    dir: docs/themes
    cadence_generations: 10
`;

function run(root, env = {}) {
  const outputFile = path.join(root, 'gh-output.txt');
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      // A deliberately bare environment: inheriting the developer's own
      // ANTHROPIC_API_KEY would turn one of these tests into a real,
      // billable API call.
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    (fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
  return { ...result, outputs };
}

test('exits 1 when there is no project-adapter.yml, naming the file it wanted', (t) => {
  const root = project({ adapter: null });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr } = run(root);
  assert.equal(status, 1);
  assert.match(stderr, /project-adapter\.yml/);
});

test('not a cadence boundary: exits 0, writes nothing, and says when the next review is', (t) => {
  // Exit 0 matters. This runs after every generation and stays quiet nine
  // times out of ten; failing the step for the ordinary case would train
  // everyone to ignore it on the run that matters.
  const root = project({ adapter: ADAPTER, generations: ['001', '002', '003'] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr, outputs } = run(root, { GEN_NUMBER: '003' });
  assert.equal(status, 0);
  assert.equal(outputs.ran, 'false');
  assert.match(stderr, /Next review at generation 010/);
  assert.equal(fs.existsSync(path.join(root, 'docs/themes')), false);
});

test('defaults GEN_NUMBER to the newest generation on record', (t) => {
  const root = project({ adapter: ADAPTER, generations: ['001', '002', '007'] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr } = run(root);
  assert.equal(status, 0);
  assert.match(stderr, /generation 007/);
});

test('a review that already covers this generation is not redone, even with FORCE_REVIEW', (t) => {
  const existing = JSON.stringify({ version: 1, throughGeneration: '010', date: '2026-01-01', themes: [] });
  const root = project({
    adapter: ADAPTER,
    generations: ['008', '009', '010'],
    reviews: { 'review-010.json': existing },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr, outputs } = run(root, { GEN_NUMBER: '010', FORCE_REVIEW: 'true' });
  assert.equal(status, 0);
  assert.equal(outputs.ran, 'false');
  assert.match(stderr, /already covers generation 010/);
  // and the existing review is untouched
  assert.equal(fs.readFileSync(path.join(root, 'docs/themes/review-010.json'), 'utf8'), existing);
});

test('no generation records at all: nothing to find a pattern in, exit 0', (t) => {
  const root = project({ adapter: ADAPTER, generations: [] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr, outputs } = run(root, { GEN_NUMBER: '010', FORCE_REVIEW: 'true' });
  assert.equal(status, 0);
  assert.equal(outputs.ran, 'false');
  assert.match(stderr, /nothing to find a pattern in/);
});

test('due, but the model call fails: exit 1, and nothing is written', (t) => {
  // The failure a real installation hits first — a missing API key — and the
  // rule this script exists to honour: a themes review becomes permanent
  // standing context for every future generation, so a half-written or
  // absent one must never be left behind as though it were real.
  const root = project({ adapter: ADAPTER, generations: ['008', '009', '010'] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr, outputs } = run(root, { GEN_NUMBER: '010' });
  assert.equal(status, 1);
  assert.equal(outputs.ran, 'false');
  assert.match(stderr, /Reviewing 3 generation\(s\) through 010/);
  assert.match(stderr, /ANTHROPIC_API_KEY/);
  assert.match(stderr, /Nothing was written/);
  assert.equal(fs.existsSync(path.join(root, 'docs/themes/review-010.json')), false);
});

test('THEMES_MODEL picks the model, over the adapter and over the built-in default', (t) => {
  const root = project({
    adapter: `${ADAPTER}roles:\n  review:\n    model: claude-opus-5\n`,
    generations: ['010'],
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { stderr } = run(root, { GEN_NUMBER: '010', THEMES_MODEL: 'gpt-5' });
  assert.match(stderr, /with gpt-5/);
  assert.match(stderr, /OPENAI_API_KEY/); // resolved to the right lab, not just echoed
});
