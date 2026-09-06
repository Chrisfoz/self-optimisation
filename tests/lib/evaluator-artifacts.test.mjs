import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  normalizeArtifact, runEvaluators, buildMetricsBrief, buildMetricsRecord,
  loadVisualEvidence, createVisualCapture, artifactsDirFor,
  MAX_ARTIFACTS_PER_PLUGIN, MAX_IMAGE_BYTES, MAX_OBSERVATION_CHARS,
} from '../../harness/lib/evaluators.mjs';
import { buildSuggestUserPrompt } from '../../harness/lib/orchestrator.mjs';

/**
 * The artifact half of the evaluator category — docs/Tool-Use-Design.md
 * phase 1. A plugin that renders (Blender, a physics probe, a headless
 * browser) has an image to hand back, and until this existed there was
 * nowhere to put it.
 *
 * The property every test here is ultimately protecting: a project that
 * configures no renderer must be on byte-identically the prompt it was on
 * before any of this existed.
 */

/** The smallest thing that is genuinely a PNG — a real 1x1, so nothing here fakes the file. */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function tempDir(prefix = 'artifacts-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A repo with one generation whose plugins produced `artifacts`, images written for real. */
function repoWithArtifacts({ genNumber = '001', artifacts = [], images = {}, generationsDir = 'docs/generations' } = {}) {
  const repoRoot = tempDir('repo-artifacts-');
  const genDir = path.join(repoRoot, generationsDir, `gen-${genNumber}`);
  fs.mkdirSync(path.join(genDir, 'artifacts'), { recursive: true });
  for (const [file, buffer] of Object.entries(images)) {
    fs.writeFileSync(path.join(genDir, 'artifacts', file), buffer);
  }
  fs.writeFileSync(
    path.join(genDir, 'metrics.json'),
    JSON.stringify(buildMetricsRecord({ throughGeneration: genNumber, metrics: [], artifacts }))
  );
  return repoRoot;
}

// --- normalizeArtifact -------------------------------------------------------

test('normalizeArtifact: an observation keeps its text, clamped', () => {
  const a = normalizeArtifact({ kind: 'observation', label: 'reachability', text: 'apex 1.9m; the gap needs 2.1m' });
  assert.deepEqual(a, { kind: 'observation', label: 'reachability', text: 'apex 1.9m; the gap needs 2.1m' });

  const long = normalizeArtifact({ label: 'x', text: 'y'.repeat(MAX_OBSERVATION_CHARS + 500) });
  assert.equal(long.text.length, MAX_OBSERVATION_CHARS);
});

test('normalizeArtifact: kind is inferred from which field is present', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'frame.png'), PNG_1x1);

  assert.equal(normalizeArtifact({ label: 'a', text: 'saw a thing' }).kind, 'observation');
  assert.equal(normalizeArtifact({ label: 'b', file: 'frame.png' }, { artifactsDir: dir }).kind, 'image');
});

test('normalizeArtifact: an image derives its mime from the extension', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['frame.png', 'shot.jpg', 'x.webp']) fs.writeFileSync(path.join(dir, f), PNG_1x1);

  const mimeOf = (file) => normalizeArtifact({ label: 'a', file }, { artifactsDir: dir }).mime;
  assert.equal(mimeOf('frame.png'), 'image/png');
  assert.equal(mimeOf('shot.jpg'), 'image/jpeg');
  assert.equal(mimeOf('x.webp'), 'image/webp');
});

test('normalizeArtifact: an image with no directory to verify it against is refused, not trusted', () => {
  // Recording a pointer to a file nothing downstream could load is
  // principle 18 — never claim data you did not supply.
  assert.throws(() => normalizeArtifact({ label: 'a', file: 'frame.png' }), /cannot be verified/);
});

test('normalizeArtifact: refuses what it cannot use', () => {
  assert.throws(() => normalizeArtifact(null), /must be an object/);
  assert.throws(() => normalizeArtifact({ text: 'no label' }), /non-empty label/);
  assert.throws(() => normalizeArtifact({ label: 'a' }), /neither an image .* nor an observation/);
  assert.throws(() => normalizeArtifact({ label: 'a', text: '   ' }), /neither an image|no text/);
  assert.throws(() => normalizeArtifact({ label: 'a', file: 'notes.txt' }), /no recognisable image type/);
});

test('normalizeArtifact: an image may not climb out of the directory it was given', () => {
  // The one path a plugin may write to is not a suggestion — the same rule
  // edit-format.mjs enforces on an edit target.
  for (const file of ['../secrets.png', '/etc/x.png', 'a/../../b.png', 'dir\\x.png']) {
    assert.throws(() => normalizeArtifact({ label: 'escape', file }), /unusable file path|no recognisable image type/, file);
  }
});

test('normalizeArtifact: with an artifactsDir, the file must actually exist and fit', (t) => {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => normalizeArtifact({ label: 'missing', file: 'nope.png' }, { artifactsDir: dir }),
    /did not write into artifactsDir/
  );

  fs.writeFileSync(path.join(dir, 'real.png'), PNG_1x1);
  const ok = normalizeArtifact({ label: 'real', file: 'real.png' }, { artifactsDir: dir });
  assert.equal(ok.bytes, PNG_1x1.length);

  fs.writeFileSync(path.join(dir, 'huge.png'), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  assert.throws(() => normalizeArtifact({ label: 'huge', file: 'huge.png' }, { artifactsDir: dir }), /over the .*KB limit/);
});

// --- runEvaluators -----------------------------------------------------------

test('runEvaluators: a plugin written before artifacts existed still works unchanged', async () => {
  const plugins = [{ name: 'old', evaluate: async () => [{ name: 'lines', value: 12 }] }];
  const { metrics, artifacts, errors } = await runEvaluators({ plugins, repoRoot: '/tmp' });
  assert.equal(errors.length, 0);
  assert.equal(metrics.length, 1);
  assert.deepEqual(artifacts, []);
});

test('runEvaluators: hands every plugin the one directory it may write to, and collects what it wrote', async (t) => {
  const artifactsDir = tempDir();
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));

  let seen = null;
  const plugins = [{
    name: 'renderer',
    evaluate: async ({ artifactsDir: given }) => {
      seen = given;
      fs.writeFileSync(path.join(given, 'frame.png'), PNG_1x1);
      return {
        metrics: [{ name: 'draw calls', value: 812, direction: 'lower' }],
        artifacts: [
          { kind: 'image', file: 'frame.png', label: 'level 3' },
          { kind: 'observation', label: 'reachability', text: 'apex 1.9m, gap needs 2.1m' },
        ],
      };
    },
  }];

  const { metrics, artifacts, errors } = await runEvaluators({ plugins, repoRoot: '/tmp', artifactsDir });
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.equal(seen, artifactsDir);
  assert.equal(metrics.length, 1);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].plugin, 'renderer');
  assert.equal(artifacts[0].mime, 'image/png');
  assert.equal(artifacts[1].kind, 'observation');
});

test('runEvaluators: one malformed artifact costs that plugin everything, not half of itself', async (t) => {
  const artifactsDir = tempDir();
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(artifactsDir, 'good.png'), PNG_1x1);

  const plugins = [{
    name: 'half-broken',
    evaluate: async () => ({
      metrics: [{ name: 'a', value: 1 }],
      artifacts: [{ kind: 'image', file: 'good.png', label: 'fine' }, { label: 'broken' }],
    }),
  }];

  const { metrics, artifacts, errors } = await runEvaluators({ plugins, repoRoot: '/tmp', artifactsDir });
  assert.equal(errors.length, 1);
  assert.deepEqual(metrics, [], 'a partial result is harder to reason about than none');
  assert.deepEqual(artifacts, []);
});

test('runEvaluators: a plugin cannot flood the record with artifacts', async (t) => {
  const artifactsDir = tempDir();
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));
  const many = Array.from({ length: MAX_ARTIFACTS_PER_PLUGIN + 5 }, (_, i) => ({ label: `o${i}`, text: 'seen' }));
  const plugins = [{ name: 'chatty', evaluate: async () => ({ artifacts: many }) }];
  const { artifacts } = await runEvaluators({ plugins, repoRoot: '/tmp', artifactsDir });
  assert.equal(artifacts.length, MAX_ARTIFACTS_PER_PLUGIN);
});

test('runEvaluators: an image with no artifactsDir to verify it against is refused, not trusted', async () => {
  const plugins = [{ name: 'r', evaluate: async () => ({ artifacts: [{ file: 'frame.png', label: 'x' }] }) }];
  const { artifacts, errors } = await runEvaluators({ plugins, repoRoot: '/tmp' });
  assert.deepEqual(artifacts, []);
  assert.equal(errors.length, 1);
});

// --- buildMetricsBrief -------------------------------------------------------

test('buildMetricsBrief: a record with no artifacts renders byte-identically to one from before artifacts existed', () => {
  const metrics = [{ name: 'lines', value: 1200, unit: 'lines', direction: 'lower' }];
  const before = buildMetricsBrief({ metrics, throughGeneration: '007' });
  assert.equal(buildMetricsBrief({ metrics, artifacts: [], throughGeneration: '007' }), before);
  assert.equal(buildMetricsBrief({ metrics, artifacts: undefined, throughGeneration: '007' }), before);
});

test('buildMetricsBrief: observations render as their own block, images never do', () => {
  const brief = buildMetricsBrief({
    metrics: [{ name: 'lines', value: 5 }],
    artifacts: [
      { kind: 'observation', label: 'reachability', text: 'gap at x=44 unreachable' },
      { kind: 'image', label: 'level 3', file: 'frame.png', mime: 'image/png' },
    ],
    throughGeneration: '007',
  });
  assert.match(brief, /reachability: gap at x=44 unreachable/);
  assert.match(brief, /not a verdict and not a score/);
  assert.doesNotMatch(brief, /frame\.png/, 'an image is attached to the call, never described in prose');
});

test('buildMetricsBrief: observations alone are enough to produce a brief', () => {
  const brief = buildMetricsBrief({ metrics: [], artifacts: [{ kind: 'observation', label: 'a', text: 'saw it' }] });
  assert.match(brief, /saw it/);
  assert.equal(buildMetricsBrief({ metrics: [], artifacts: [] }), null);
});

// --- loadVisualEvidence ------------------------------------------------------

test('loadVisualEvidence: nothing on record yields exactly the value the socket was hardcoded to', () => {
  assert.deepEqual(loadVisualEvidence({ repoRoot: tempDir() }), { images: [], source: null });
});

test('loadVisualEvidence: reads the images an evaluator recorded, base64, with labels', (t) => {
  const repoRoot = repoWithArtifacts({
    artifacts: [{ kind: 'image', file: 'frame.png', mime: 'image/png', label: 'level 3' }],
    images: { 'frame.png': PNG_1x1 },
  });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const evidence = loadVisualEvidence({ repoRoot });
  assert.equal(evidence.source, 'gen-001');
  assert.equal(evidence.images.length, 1);
  assert.equal(evidence.images[0].mime, 'image/png');
  assert.equal(evidence.images[0].label, 'level 3');
  assert.equal(evidence.images[0].data, PNG_1x1.toString('base64'));
});

test('loadVisualEvidence: a later generation with no images does not shadow an earlier one that has them', (t) => {
  // The reference implementation's own incident: a FAILED generation still
  // creates its folder, and looking only at the newest one dropped every
  // model back to a stale baseline while the prompt claimed the images were
  // current. learning/03-failure-modes.md, "One failed generation hid the
  // current screenshots".
  const repoRoot = repoWithArtifacts({
    genNumber: '001',
    artifacts: [{ kind: 'image', file: 'frame.png', mime: 'image/png', label: 'from 001' }],
    images: { 'frame.png': PNG_1x1 },
  });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  // gen-002 exists and failed: a record, no artifacts.
  const failed = path.join(repoRoot, 'docs/generations/gen-002');
  fs.mkdirSync(failed, { recursive: true });
  fs.writeFileSync(path.join(failed, 'attempts.json'), JSON.stringify({ outcome: 'abandoned' }));

  const evidence = loadVisualEvidence({ repoRoot });
  assert.equal(evidence.source, 'gen-001');
  assert.equal(evidence.images[0].label, 'from 001');
});

test('loadVisualEvidence: a record naming an image that is gone shrinks the section rather than breaking', (t) => {
  const repoRoot = repoWithArtifacts({
    artifacts: [{ kind: 'image', file: 'deleted.png', mime: 'image/png', label: 'gone' }],
    images: {},
  });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.deepEqual(loadVisualEvidence({ repoRoot }), { images: [], source: null });
});

test('loadVisualEvidence: caps how many images reach a prompt', (t) => {
  const images = Object.fromEntries(['a.png', 'b.png', 'c.png', 'd.png'].map((f) => [f, PNG_1x1]));
  const repoRoot = repoWithArtifacts({
    artifacts: Object.keys(images).map((file) => ({ kind: 'image', file, mime: 'image/png', label: file })),
    images,
  });
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.equal(loadVisualEvidence({ repoRoot }).images.length, 3);
  assert.equal(loadVisualEvidence({ repoRoot, maxImages: 2 }).images.length, 2);
});

test('artifactsDirFor: the path a generation stores its renders at', () => {
  assert.equal(artifactsDirFor({ genNumber: '007' }), 'docs/generations/gen-007/artifacts');
  assert.equal(artifactsDirFor({ generationsDir: 'records', genNumber: '007' }), 'records/gen-007/artifacts');
});

// --- createVisualCapture -----------------------------------------------------

test('createVisualCapture: renders the change and hands the reviewer the images', async (t) => {
  const artifactsDir = tempDir('capture-');
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));

  const capture = createVisualCapture({
    plugin: {
      name: 'screenshotter',
      evaluate: async ({ artifactsDir: given }) => {
        fs.writeFileSync(path.join(given, 'after.png'), PNG_1x1);
        return { artifacts: [{ kind: 'image', file: 'after.png', label: 'after the edits' }] };
      },
    },
    repoRoot: '/tmp',
    artifactsDir,
  });

  const visual = await capture();
  assert.equal(visual.available, true);
  assert.equal(visual.images.length, 1);
  assert.equal(visual.images[0].label, 'after the edits');
  assert.match(visual.reason, /screenshotter/);
});

test('createVisualCapture: a plugin that throws costs the reviewer its pictures, never the generation', async (t) => {
  const artifactsDir = tempDir('capture-');
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));

  const capture = createVisualCapture({
    plugin: { name: 'broken', evaluate: async () => { throw new Error('blender not installed'); } },
    repoRoot: '/tmp',
    artifactsDir,
  });

  const visual = await capture();
  assert.equal(visual.available, false);
  assert.deepEqual(visual.images, []);
  assert.match(visual.reason, /blender not installed/);
});

test('createVisualCapture: a plugin that hangs is abandoned, not waited on', async (t) => {
  const artifactsDir = tempDir('capture-');
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));

  const capture = createVisualCapture({
    plugin: { name: 'hangs', evaluate: () => new Promise(() => {}) },
    repoRoot: '/tmp',
    artifactsDir,
    timeoutMs: 30,
  });

  const visual = await capture();
  assert.equal(visual.available, false);
  assert.match(visual.reason, /timed out/);
});

test('createVisualCapture: a plugin producing only observations reports no images rather than claiming some', async (t) => {
  const artifactsDir = tempDir('capture-');
  t.after(() => fs.rmSync(artifactsDir, { recursive: true, force: true }));

  const capture = createVisualCapture({
    plugin: { name: 'text-only', evaluate: async () => ({ artifacts: [{ label: 'note', text: 'nothing to draw' }] }) },
    repoRoot: '/tmp',
    artifactsDir,
  });

  const visual = await capture();
  assert.equal(visual.available, false);
  assert.match(visual.reason, /produced no images/);
});

// --- the prompt --------------------------------------------------------------

test('buildSuggestUserPrompt: with no images the prompt is byte-identical to before the socket was fed', () => {
  const base = { genLabel: 'Generation #1', context: { manifest: 'M', sources: 'S' } };
  const explicitlyEmpty = buildSuggestUserPrompt({ ...base, screenshots: { images: [], source: null } });
  assert.equal(buildSuggestUserPrompt(base), explicitlyEmpty);
  assert.doesNotMatch(explicitlyEmpty, /Screenshots/);
});

test('buildSuggestUserPrompt: images carry their provenance, so "current" cannot mean a stale render', () => {
  const prompt = buildSuggestUserPrompt({
    genLabel: 'Generation #8',
    context: { manifest: 'M' },
    screenshots: { images: [{ mime: 'image/png', data: 'x', label: 'level 3' }], source: 'gen-007' },
  });
  assert.match(prompt, /# Screenshots/);
  assert.match(prompt, /rendered at gen-007/);
  assert.match(prompt, /the state this change starts from, not its result/);
});
