import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import { evaluatorFingerprint, compareMeasurements, buildComparisonRecord, summarizeComparison } from '../../harness/lib/measure.mjs';
import { computeMetrics, renderReport, loadRecords } from '../../harness/lib/report.mjs';
import { normalizeMetric } from '../../harness/lib/evaluators.mjs';
import { renderWorkflowTemplate } from '../../harness/lib/scaffold.mjs';

const FP = 'same-evaluators';
const m = (name, value, extra = {}) => ({ name, value, unit: null, direction: null, detail: null, ...extra });

// --- the comparison -------------------------------------------------------------

test('compareMeasurements: a metric\'s declared direction decides benefit from regression', () => {
  const c = compareMeasurements(
    { fingerprint: FP, metrics: [m('frame p95', 22, { direction: 'lower', unit: 'ms' }), m('levels completed', 3, { direction: 'higher' }), m('touch targets under 44px', 4, { direction: 'lower' }), m('files', 9)] },
    { fingerprint: FP, metrics: [m('frame p95', 17, { direction: 'lower', unit: 'ms' }), m('levels completed', 2, { direction: 'higher' }), m('touch targets under 44px', 4, { direction: 'lower' }), m('files', 10)] },
  );
  assert.equal(c.comparable, true);
  assert.deepEqual(c.benefits, ['frame p95']);
  assert.deepEqual(c.regressions, ['levels completed']);
  assert.deepEqual(c.unchanged, ['touch targets under 44px']);
  assert.deepEqual(c.changed, ['files'], 'no direction: a change, not a verdict');
  const frame = c.rows.find((r) => r.name === 'frame p95');
  assert.equal(frame.delta, -5);
  assert.ok(Math.abs(frame.relative + 5 / 22) < 1e-9);
});

test('compareMeasurements: a noisy metric\'s declared tolerance is its noise floor; the default is exact', () => {
  const noisy = compareMeasurements(
    { fingerprint: FP, metrics: [m('frame p95', 20, { direction: 'lower', tolerance: 1.5 })] },
    { fingerprint: FP, metrics: [m('frame p95', 21, { direction: 'lower', tolerance: 1.5 })] },
  );
  assert.deepEqual(noisy.unchanged, ['frame p95']);
  const exact = compareMeasurements(
    { fingerprint: FP, metrics: [m('source lines', 1000, { direction: 'lower' })] },
    { fingerprint: FP, metrics: [m('source lines', 1001, { direction: 'lower' })] },
  );
  assert.deepEqual(exact.regressions, ['source lines']);
});

test('compareMeasurements: different evaluators are a change of ruler, not a result — never compared', () => {
  const c = compareMeasurements({ fingerprint: 'a', metrics: [m('x', 1, { direction: 'lower' })] }, { fingerprint: 'b', metrics: [m('x', 9, { direction: 'lower' })] });
  assert.equal(c.comparable, false);
  assert.match(c.reason, /change of ruler/);
  assert.deepEqual(c.regressions, []);
  assert.equal(compareMeasurements(null, { fingerprint: FP, metrics: [] }).comparable, false);
});

test('compareMeasurements: metrics that appear or disappear are named, and strings compare by equality', () => {
  const c = compareMeasurements(
    { fingerprint: FP, metrics: [m('old', 1), m('status', 'ok')] },
    { fingerprint: FP, metrics: [m('new', 1), m('status', 'degraded')] },
  );
  assert.deepEqual(c.appeared, ['new']);
  assert.deepEqual(c.disappeared, ['old']);
  assert.deepEqual(c.changed, ['status']);
});

test('evaluatorFingerprint: stable under key and entry order, sensitive to config', () => {
  const a = evaluatorFingerprint([{ module: 'x.mjs', config: { b: 1, a: [1, 2] } }, { module: 'y.mjs' }]);
  const b = evaluatorFingerprint([{ module: 'y.mjs', config: {} }, { module: 'x.mjs', config: { a: [1, 2], b: 1 } }]);
  assert.equal(a, b);
  assert.notEqual(a, evaluatorFingerprint([{ module: 'x.mjs', config: { b: 2, a: [1, 2] } }, { module: 'y.mjs' }]));
});

test('normalizeMetric keeps a plugin\'s tolerance, and drops a nonsensical one', () => {
  assert.equal(normalizeMetric({ name: 'fps', value: 60, tolerance: 2 }).tolerance, 2);
  assert.equal('tolerance' in normalizeMetric({ name: 'fps', value: 60, tolerance: -1 }), false);
});

test('summarizeComparison: one line a person can read', () => {
  const c = compareMeasurements(
    { fingerprint: FP, metrics: [m('a', 1, { direction: 'lower' }), m('b', 1, { direction: 'lower' })] },
    { fingerprint: FP, metrics: [m('a', 0, { direction: 'lower' }), m('b', 2, { direction: 'lower' })] },
  );
  assert.equal(summarizeComparison(c), '1 benefit (a), 1 regression (b)');
  assert.match(summarizeComparison({ comparable: false, reason: 'no baseline measurement' }), /not comparable/);
});

// --- the CLI, before and after, with the plugin the harness ships -------------------

test('run-evaluators.mjs --baseline, then after a change: comparison.json names what moved', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(import.meta.dirname, '../../harness'), path.join(root, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), [
    'project:', '  id: p', 'context:', '  generations_dir: docs/generations', 'evaluation:', '  evaluators:',
    '    - module: harness/plugins/evaluators/source-weight/index.mjs', '      config:', '        paths: ["src/**"]', '',
  ].join('\n'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/game.js'), Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join('\n') + '\n');
  // The real script; the vendored copy is there for the adapter's module path.
  const script = path.join(import.meta.dirname, '../../harness/scripts/run-evaluators.mjs');
  const env = { PATH: process.env.PATH, GEN_NUMBER: '001', GITHUB_OUTPUT: '' };

  const before = spawnSync(process.execPath, [script, '--baseline'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(before.status, 0, before.stderr);
  const genDir = path.join(root, 'docs/generations/gen-001');
  assert.ok(fs.existsSync(path.join(genDir, 'baseline-metrics.json')));
  assert.ok(!fs.existsSync(path.join(genDir, 'metrics.json')), 'a baseline is never read back as the latest measurement');

  // The generation's change: a third of the file removed.
  fs.writeFileSync(path.join(root, 'src/game.js'), Array.from({ length: 26 }, (_, i) => `const a${i} = ${i};`).join('\n') + '\n');
  fs.writeFileSync(path.join(genDir, 'attempts.json'), JSON.stringify({ outcome: 'approved', spend: { totalTokens: 91234, calls: 4 } }));
  const after = spawnSync(process.execPath, [script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stderr, /Before → after: .*benefit/);

  const comparison = JSON.parse(fs.readFileSync(path.join(genDir, 'comparison.json'), 'utf8'));
  assert.equal(comparison.comparable, true);
  assert.ok(comparison.benefits.includes('source lines'));
  assert.deepEqual(comparison.regressions, []);
  assert.deepEqual(comparison.cost, { totalTokens: 91234, calls: 4 });
  assert.equal(comparison.outcome, 'approved');
});

// --- the report ------------------------------------------------------------------------

test('the report puts measured effect, cost and what a person did side by side', () => {
  const comparison = (benefits, regressions) => ({ comparable: true, benefits, regressions, changed: [] });
  const records = [
    { generation: '001', outcome: 'approved', spend: { totalTokens: 100000 }, comparison: comparison(['frame p95'], []) },
    { generation: '002', outcome: 'approved', spend: { totalTokens: 80000 }, pullRequest: { state: 'closed' }, comparison: comparison([], ['levels completed']) },
    { generation: '003', outcome: 'approved', spend: { totalTokens: 50000 }, comparison: comparison(['frame p95'], ['bundle kb']) },
    { generation: '004', outcome: 'approved', comparison: { comparable: false, reason: 'ruler changed' } },
    { generation: '005', outcome: 'abandoned', spend: { totalTokens: 200000 } },
  ];
  const metrics = computeMetrics(records);
  assert.equal(metrics.measurement.rows.length, 3);
  assert.equal(metrics.measurement.withRegression, 2);
  assert.equal(metrics.measurement.keptWithRegression, 1, 'gen 3 merged with a regression; gen 2 was closed');
  assert.equal(metrics.measurement.notComparable, 1);
  const page = renderReport(metrics);
  assert.match(page, /## Measured effect/);
  assert.match(page, /\| 002 \| closed \| 80,000 \| — \| levels completed \| — \|/);
  assert.match(page, /1 of those were kept anyway/);
});

test('loadRecords reads comparison.json beside each record', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-load-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'docs/generations/gen-001');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'attempts.json'), JSON.stringify({ outcome: 'approved' }));
  fs.writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify(buildComparisonRecord({ genNumber: '001', comparison: { comparable: true, benefits: ['x'], regressions: [], rows: [] } })));
  assert.deepEqual(loadRecords({ repoRoot: root }).records[0].comparison.benefits, ['x']);
});

// --- the workflow takes the baseline before the loop ---------------------------------

test('the generated workflow measures the baseline after the claim and before the loop, and never gates on it', () => {
  const template = fs.readFileSync(path.join(import.meta.dirname, '../../harness/templates/workflow.yml.tmpl'), 'utf8');
  const steps = loadYaml(renderWorkflowTemplate(template, {
    projectId: 'p', providers: [{ name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' }], allowedPaths: ['a'], testCommands: ['true'],
  })).jobs['self-improve'].steps;
  const at = (id) => steps.findIndex((s) => s.id === id);
  assert.ok(at('gen') < at('baseline') && at('baseline') < at('improve'));
  assert.match(steps[at('baseline')].run, /run-evaluators\.mjs --baseline/);
  assert.equal(steps[at('baseline')]['continue-on-error'], true);
});
