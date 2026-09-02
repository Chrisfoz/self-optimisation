import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  normalizeMetric, runEvaluators, buildMetricsBrief, buildMetricsRecord,
  loadLatestMetrics, DEFAULT_TIMEOUT_MS,
} from '../../harness/lib/evaluators.mjs';
import sourceWeight from '../../harness/plugins/evaluators/source-weight/index.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evaluators-test-'));
}

// --- normalizeMetric ----------------------------------------------------------
// Plugins are third-party code. Their shape is checked here so that a
// malformed metric becomes a recorded plugin error rather than something the
// digest or the next prompt has to survive.

test('normalizeMetric fills the optional fields and keeps the required ones', () => {
  const m = normalizeMetric({ name: '  lines  ', value: 42, unit: ' lines ', direction: 'lower', detail: ' grew a bit ' });
  assert.deepEqual(m, { name: 'lines', value: 42, unit: 'lines', direction: 'lower', detail: 'grew a bit' });
});

test('normalizeMetric defaults unit/direction/detail to null rather than omitting them', () => {
  const m = normalizeMetric({ name: 'thing', value: 'green' });
  assert.equal(m.unit, null);
  assert.equal(m.direction, null);
  assert.equal(m.detail, null);
});

test('normalizeMetric rejects a metric with no name or no usable value', () => {
  assert.throws(() => normalizeMetric(null), /must be an object/);
  assert.throws(() => normalizeMetric({ value: 1 }), /non-empty name/);
  assert.throws(() => normalizeMetric({ name: 'x' }), /no usable value/);
  assert.throws(() => normalizeMetric({ name: 'x', value: NaN }), /no usable value/);
  assert.throws(() => normalizeMetric({ name: 'x', value: Infinity }), /no usable value/);
  assert.throws(() => normalizeMetric({ name: 'x', value: '   ' }), /no usable value/);
});

test('normalizeMetric ignores a direction it does not recognise rather than passing it through', () => {
  assert.equal(normalizeMetric({ name: 'x', value: 1, direction: 'up' }).direction, null);
});

test('normalizeMetric clamps detail, so a plugin that returns a log file cannot become the largest block in the prompt', () => {
  const m = normalizeMetric({ name: 'x', value: 1, detail: 'a'.repeat(5000) });
  assert.equal(m.detail.length, 500);
});

// --- runEvaluators: rule 1, a plugin cannot fail a generation -----------------

test('runEvaluators collects metrics from every plugin, tagged with which one produced them', async () => {
  const { metrics, errors } = await runEvaluators({
    repoRoot: '/nowhere',
    plugins: [
      { name: 'a', evaluate: () => ({ name: 'one', value: 1 }) },
      { name: 'b', evaluate: async () => [{ name: 'two', value: 2 }, { name: 'three', value: 3 }] },
    ],
  });
  assert.equal(errors.length, 0);
  assert.deepEqual(metrics.map((m) => [m.plugin, m.name]), [['a', 'one'], ['b', 'two'], ['b', 'three']]);
});

test('runEvaluators: a plugin that throws is recorded and stepped over, never rethrown', async () => {
  const { metrics, errors } = await runEvaluators({
    repoRoot: '/nowhere',
    plugins: [
      { name: 'broken', evaluate: () => { throw new Error('boom'); } },
      { name: 'fine', evaluate: () => ({ name: 'ok', value: 1 }) },
    ],
  });
  assert.equal(metrics.length, 1, 'the working plugin still ran');
  // The plugin's name is a field on the error, not smuggled into its text.
  assert.deepEqual(errors, [{ plugin: 'broken', error: 'boom' }]);
});

test('runEvaluators: a plugin returning a malformed metric fails that plugin, not the run', async () => {
  const { metrics, errors } = await runEvaluators({
    repoRoot: '/nowhere',
    plugins: [{ name: 'sloppy', evaluate: () => [{ value: 1 }] }],
  });
  assert.equal(metrics.length, 0);
  assert.match(errors[0].error, /non-empty name/);
});

test('runEvaluators: a plugin with no evaluate() is an error, not a crash', async () => {
  const { errors } = await runEvaluators({ repoRoot: '/nowhere', plugins: [{ name: 'empty' }] });
  assert.deepEqual(errors, [{ plugin: 'empty', error: 'exports no evaluate() function' }]);
});

test('runEvaluators: a plugin that never returns is abandoned at the timeout', async () => {
  const { metrics, errors } = await runEvaluators({
    repoRoot: '/nowhere',
    timeoutMs: 25,
    plugins: [{ name: 'hangs', evaluate: () => new Promise(() => {}) }],
  });
  assert.equal(metrics.length, 0);
  assert.match(errors[0].error, /timed out after 25ms/);
});

test('runEvaluators: nothing configured is a normal outcome, not an error', async () => {
  const { metrics, errors } = await runEvaluators({ repoRoot: '/nowhere', plugins: [] });
  assert.deepEqual(metrics, []);
  assert.deepEqual(errors, []);
  assert.ok(DEFAULT_TIMEOUT_MS > 0);
});

test('runEvaluators: a plugin returning null or undefined contributes nothing, without complaint', async () => {
  const { metrics, errors } = await runEvaluators({
    repoRoot: '/nowhere',
    plugins: [{ name: 'quiet', evaluate: () => null }, { name: 'quieter', evaluate: () => undefined }],
  });
  assert.deepEqual(metrics, []);
  assert.deepEqual(errors, []);
});

// --- buildMetricsBrief --------------------------------------------------------

test('buildMetricsBrief returns null when there is nothing measured, dropping the prompt section entirely', () => {
  // This is what keeps a project with no evaluators on a prompt
  // byte-identical to one from before any of this existed.
  assert.equal(buildMetricsBrief(null), null);
  assert.equal(buildMetricsBrief({}), null);
  assert.equal(buildMetricsBrief({ metrics: [] }), null);
});

test('buildMetricsBrief says plainly that these are not gates and not targets', () => {
  const brief = buildMetricsBrief({
    throughGeneration: '012',
    metrics: [{ name: 'source lines', value: 1200, unit: 'lines', direction: 'lower', detail: 'across 8 files' }],
  });
  assert.match(brief, /NOT gates/);
  assert.match(brief, /not because they are targets/);
  assert.match(brief, /as of generation 012/);
  assert.match(brief, /- source lines: 1200 lines \(lower is better\) — across 8 files/);
});

test('buildMetricsBrief omits the direction clause when neither way is better', () => {
  const brief = buildMetricsBrief({ metrics: [{ name: 'files by kind', value: 'mixed' }] });
  assert.match(brief, /- files by kind: mixed$/m);
});

// --- the record on disk -------------------------------------------------------

test('buildMetricsRecord stamps the generation and the date', () => {
  const r = buildMetricsRecord({ throughGeneration: '007', metrics: [], errors: [{ plugin: 'x', error: 'y' }], date: new Date('2026-09-02T00:00:00Z') });
  assert.equal(r.version, 1);
  assert.equal(r.throughGeneration, '007');
  assert.equal(r.date, '2026-09-02');
  assert.deepEqual(r.errors, [{ plugin: 'x', error: 'y' }]);
});

test('loadLatestMetrics finds the newest generation that has a metrics.json, skipping ones that do not', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const gen of ['001', '002', '003']) {
    fs.mkdirSync(path.join(repoRoot, 'docs/generations', `gen-${gen}`), { recursive: true });
  }
  fs.writeFileSync(path.join(repoRoot, 'docs/generations/gen-002/metrics.json'), JSON.stringify({ throughGeneration: '002', metrics: [] }));
  // gen-003 ran but had nothing to measure — the last real measurement stands.
  assert.equal(loadLatestMetrics({ repoRoot }).throughGeneration, '002');
});

test('loadLatestMetrics returns null for a project with no generations and for a malformed file', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.equal(loadLatestMetrics({ repoRoot }), null);

  fs.mkdirSync(path.join(repoRoot, 'docs/generations/gen-001'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/generations/gen-001/metrics.json'), '{ not json');
  assert.equal(loadLatestMetrics({ repoRoot }), null);
});

// --- the shipped example plugin ----------------------------------------------

test('source-weight measures lines, the largest file, and how many are over the threshold', async () => {
  const repoRoot = tempRepo();
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src/small.js'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(repoRoot, 'src/big.js'), 'x\n'.repeat(12));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'not measured\n');

  const metrics = await sourceWeight.evaluate({
    repoRoot,
    generation: { filesChanged: ['src/big.js'] },
    config: { paths: ['src/**'], largeFileLines: 10 },
  });
  fs.rmSync(repoRoot, { recursive: true, force: true });

  const by = Object.fromEntries(metrics.map((m) => [m.name, m]));
  assert.equal(by['source lines'].value, 15);
  assert.match(by['source lines'].detail, /across 2 measured file\(s\); this generation touched 1/);
  assert.equal(by['largest file'].value, 12);
  assert.equal(by['largest file'].detail, 'src/big.js');
  assert.equal(by['files over 10 lines'].value, 1);
});

test('source-weight returns nothing at all when its paths match nothing, rather than a row of zeros', async () => {
  const repoRoot = tempRepo();
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>hi</p>\n');
  const metrics = await sourceWeight.evaluate({ repoRoot, generation: null, config: { paths: ['src/**/*.java'] } });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  assert.deepEqual(metrics, []);
});

test('source-weight skips the directories nobody means to measure', async () => {
  const repoRoot = tempRepo();
  fs.mkdirSync(path.join(repoRoot, 'node_modules/pkg'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'node_modules/pkg/index.js'), 'x\n'.repeat(9000));
  fs.writeFileSync(path.join(repoRoot, '.git/config'), 'x\n'.repeat(50));
  fs.writeFileSync(path.join(repoRoot, 'app.js'), 'a\nb\n');

  const metrics = await sourceWeight.evaluate({ repoRoot, generation: null, config: {} });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  assert.equal(metrics.find((m) => m.name === 'source lines').value, 2);
});

test('source-weight output survives normalizeMetric — the shipped example honours its own interface', async () => {
  const repoRoot = tempRepo();
  fs.writeFileSync(path.join(repoRoot, 'a.js'), 'one\ntwo\n');
  const metrics = await sourceWeight.evaluate({ repoRoot, generation: null, config: {} });
  fs.rmSync(repoRoot, { recursive: true, force: true });
  assert.doesNotThrow(() => metrics.map(normalizeMetric));
});
