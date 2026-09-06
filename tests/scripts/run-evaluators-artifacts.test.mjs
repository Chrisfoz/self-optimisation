import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadVisualEvidence } from '../../harness/lib/evaluators.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'harness/scripts/run-evaluators.mjs');
const NODE_MODULES = path.join(REPO_ROOT, 'node_modules');
const HARNESS_DIR = path.join(REPO_ROOT, 'harness');

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * The whole artifact path through the real CLI: a project-owned plugin that
 * renders, run by the real script, writing a real metrics.json — and then
 * read back by the same function run-generation.mjs uses to feed the
 * suggestion prompt. This is the seam docs/Tool-Use-Design.md §3 says a
 * Blender or physics plugin would sit in; the test stands in for the engine
 * with a plugin that writes a real PNG.
 */
function projectWithRenderer({ pluginBody }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evaluator-artifacts-'));
  fs.symlinkSync(HARNESS_DIR, path.join(root, 'harness'));
  fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'));

  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools/renderer.mjs'), pluginBody);

  fs.mkdirSync(path.join(root, 'docs/generations/gen-001'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs/generations/gen-001/attempts.json'),
    JSON.stringify({ generation: '001', outcome: 'approved', filesChanged: ['index.html'] })
  );

  fs.writeFileSync(
    path.join(root, 'project-adapter.yml'),
    [
      'project:',
      '  id: renderer-test',
      'constitution:',
      '  allowed_paths: [index.html]',
      'evaluation:',
      '  evaluators:',
      '    - module: tools/renderer.mjs',
      '',
    ].join('\n')
  );
  return root;
}

const RENDERING_PLUGIN = `
import fs from 'fs';
import path from 'path';

const PNG = Buffer.from('${PNG_1x1.toString('base64')}', 'base64');

export default {
  name: 'level-render',
  async evaluate({ artifactsDir }) {
    fs.writeFileSync(path.join(artifactsDir, 'frame.png'), PNG);
    return {
      metrics: [{ name: 'draw calls', value: 812, direction: 'lower' }],
      artifacts: [
        { kind: 'image', file: 'frame.png', label: 'level 3, player spawn' },
        { kind: 'observation', label: 'reachability', text: 'apex 1.9m; the gap at x=44 needs 2.1m' },
      ],
    };
  },
};
`;

test('a rendering plugin writes into artifactsDir, and the record carries both the image and the observation', (t) => {
  const root = projectWithRenderer({ pluginBody: RENDERING_PLUGIN });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, GEN_NUMBER: '001' } });
  assert.equal(result.status, 0, result.stderr);

  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.equal(record.errors.length, 0, JSON.stringify(record.errors));
  assert.equal(record.metrics.length, 1);
  assert.equal(record.artifacts.length, 2);

  const image = record.artifacts.find((a) => a.kind === 'image');
  assert.equal(image.file, 'frame.png');
  assert.equal(image.mime, 'image/png');
  assert.equal(image.plugin, 'level-render');
  assert.ok(fs.existsSync(path.join(root, 'docs/generations/gen-001/artifacts/frame.png')));

  // And the read side — the same call run-generation.mjs makes to feed the
  // suggestion prompt's screenshots socket.
  const evidence = loadVisualEvidence({ repoRoot: root });
  assert.equal(evidence.source, 'gen-001');
  assert.equal(evidence.images.length, 1);
  assert.equal(evidence.images[0].data, PNG_1x1.toString('base64'));
});

test('a plugin that returns an image it never wrote is recorded as an error, and cannot fail the run', (t) => {
  const root = projectWithRenderer({
    pluginBody: `export default { name: 'liar', async evaluate() { return { artifacts: [{ kind: 'image', file: 'ghost.png', label: 'never written' }] }; } };`,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, GEN_NUMBER: '001' } });
  assert.equal(result.status, 0, 'a measurement can never fail a workflow step');

  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.deepEqual(record.artifacts, []);
  assert.equal(record.errors.length, 1);
  assert.match(record.errors[0].error, /did not write into artifactsDir/);
});

test('a project whose plugins produce no artifacts leaves no empty artifacts directory behind', (t) => {
  const root = projectWithRenderer({
    pluginBody: `export default { name: 'scalar-only', async evaluate() { return [{ name: 'lines', value: 10 }]; } };`,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', env: { ...process.env, GEN_NUMBER: '001' } });

  assert.ok(!fs.existsSync(path.join(root, 'docs/generations/gen-001/artifacts')), 'an empty directory is noise in a diff a human reads');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'docs/generations/gen-001/metrics.json'), 'utf8'));
  assert.deepEqual(record.artifacts, []);
  assert.equal(record.metrics.length, 1);
});
