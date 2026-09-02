import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * The evaluator CLI as a real child process. The claim under test is the one
 * that matters most and is hardest to prove from unit tests alone: **this
 * step cannot fail a workflow.** A plugin that throws, one that cannot even
 * be imported, and a project with nothing configured all exit 0 — and the
 * failures are still recorded rather than swallowed.
 */

const SCRIPT = path.join(import.meta.dirname, '../../harness/scripts/run-evaluators.mjs');
const HARNESS = path.join(import.meta.dirname, '../../harness');

function project({ evaluators = [], generations = ['001'], files = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluators-cli-'));
  const adapter = [
    'project:',
    '  id: test-project',
    'context:',
    '  generations_dir: docs/generations',
    'evaluation:',
    '  evaluators:',
    ...evaluators.flatMap((e) => [
      `    - module: ${e.module}`,
      ...(e.config ? [`      config:`, ...Object.entries(e.config).map(([k, v]) => `        ${k}: ${JSON.stringify(v)}`)] : []),
    ]),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'project-adapter.yml'), evaluators.length ? adapter : adapter.replace(/evaluation:[\s\S]*/, ''));

  for (const gen of generations) {
    const dir = path.join(root, 'docs/generations', `gen-${gen}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'attempts.json'), JSON.stringify({ generation: gen, outcome: 'approved', filesChanged: ['app.js'] }));
  }
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  // The harness is vendored into a target project, so point the adapter's
  // module paths at a real copy the same way a real installation would.
  fs.cpSync(HARNESS, path.join(root, 'harness'), { recursive: true });
  return root;
}

function run(root, env = {}) {
  const outputFile = path.join(root, 'gh-output.txt');
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GITHUB_OUTPUT: outputFile, ...env },
  });
  const outputs = Object.fromEntries(
    (fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
  return { ...result, outputs };
}

test('no evaluators configured: exits 0 and says so, writing no metrics file', (t) => {
  // The normal state of most projects, and not a warning.
  const root = project({ evaluators: [] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr, outputs } = run(root, { GEN_NUMBER: '001' });
  assert.equal(status, 0);
  assert.equal(outputs.ran, 'false');
  assert.match(stderr, /No evaluators configured/);
  assert.equal(fs.existsSync(path.join(root, 'docs/generations/gen-001/metrics.json')), false);
});

test('the shipped example plugin runs end to end and writes metrics.json', (t) => {
  const root = project({
    evaluators: [{ module: 'harness/plugins/evaluators/source-weight/index.mjs', config: { paths: ['app.js'] } }],
    files: { 'app.js': 'one\ntwo\nthree\n' },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, outputs } = run(root, { GEN_NUMBER: '001' });
  assert.equal(status, 0);
  assert.equal(outputs.ran, 'true');
  assert.equal(outputs.errors, '0');

  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.equal(record.version, 1);
  assert.equal(record.throughGeneration, '001');
  const lines = record.metrics.find((m) => m.name === 'source lines');
  assert.equal(lines.value, 3);
  assert.equal(lines.plugin, 'source-weight');
  // It was handed the generation record, and used it.
  assert.match(lines.detail, /this generation touched 1/);
});

test('a plugin that throws is recorded, and the step still exits 0', (t) => {
  const root = project({
    evaluators: [{ module: 'tools/broken.mjs' }],
    files: { 'tools/broken.mjs': 'export default { name: "broken", evaluate() { throw new Error("nope"); } };\n' },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, outputs } = run(root, { GEN_NUMBER: '001' });
  assert.equal(status, 0, 'a measurement must never fail the workflow step');
  assert.equal(outputs.errors, '1');

  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.equal(record.metrics.length, 0);
  assert.match(record.errors[0].error, /nope/);
});

test('a plugin module that cannot even be imported is recorded like any other failure', (t) => {
  const root = project({ evaluators: [{ module: 'tools/missing.mjs' }] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, stderr } = run(root, { GEN_NUMBER: '001' });
  assert.equal(status, 0);
  assert.match(stderr, /could not be loaded/);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.match(record.errors[0].error, /could not be loaded/);
});

test('a project-local plugin is loaded from the project, not from the harness', (t) => {
  // The point of resolving `module` against the project root: your plugin
  // lives in your repository, beside the thing it measures.
  const root = project({
    evaluators: [{ module: 'tools/mine.mjs' }],
    files: { 'tools/mine.mjs': 'export default { name: "mine", evaluate: () => ({ name: "custom", value: 7, unit: "widgets" }) };\n' },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status } = run(root, { GEN_NUMBER: '001' });
  assert.equal(status, 0);
  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.deepEqual(record.metrics, [{ name: 'custom', value: 7, unit: 'widgets', direction: null, detail: null, plugin: 'mine' }]);
});

test('defaults to the newest generation when GEN_NUMBER is not set', (t) => {
  const root = project({
    evaluators: [{ module: 'harness/plugins/evaluators/source-weight/index.mjs', config: { paths: ['app.js'] } }],
    generations: ['001', '002'],
    files: { 'app.js': 'x\n' },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { status, outputs } = run(root);
  assert.equal(status, 0);
  assert.equal(outputs.path, path.join('docs/generations', 'gen-002', 'metrics.json'));
});
