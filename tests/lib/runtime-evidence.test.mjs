import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildRuntimeEvidence, EVIDENCE_BUDGET } from '../../harness/lib/context-pack.mjs';
import { parseTap, buildEvidenceRecord, isEmptyEvidence, deployFragment } from '../../harness/lib/runtime-evidence.mjs';

/**
 * C10 — runtime evidence (docs/curiosity/C10-runtime-evidence.md).
 *
 * Every other signal in the suggestion prompt describes what the project IS.
 * This is the only one that describes what it DID. The two rules under test
 * are the ones that came out of real incidents rather than taste:
 * observations are sent and scores are not, and anomalies outrank totals
 * when the budget runs out.
 */

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-evidence-'));
}

function withEvidence(t, files) {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const dir = path.join(repoRoot, 'docs/runtime');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return repoRoot;
}

// --- buildRuntimeEvidence: the read side --------------------------------------

test('buildRuntimeEvidence returns null for a missing directory and for an empty one', (t) => {
  const bare = tempRepo();
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  assert.equal(buildRuntimeEvidence({ repoRoot: bare }), null);

  const empty = withEvidence(t, {});
  assert.equal(buildRuntimeEvidence({ repoRoot: empty }), null);
});

test('buildRuntimeEvidence survives one malformed file without losing the others', (t) => {
  const repoRoot = withEvidence(t, {
    'gen-001.json': '{ not json at all',
    'gen-002.json': { generation: '002', date: '2026-02-01', tests: { suites: [{ name: 'unit', passed: 98, failed: 0, skipped: ['the slow one'] }] } },
  });
  const text = buildRuntimeEvidence({ repoRoot });
  assert.match(text, /the slow one/);
});

test('buildRuntimeEvidence always includes skipped test names — a skipped test is a lie by omission', (t) => {
  const repoRoot = withEvidence(t, {
    'gen-003.json': {
      generation: '003', date: '2026-03-01',
      tests: { suites: [{ name: 'unit', passed: 340, failed: 0, skipped: ['renders offline', 'handles a 429'] }] },
    },
  });
  const text = buildRuntimeEvidence({ repoRoot });
  assert.match(text, /SKIPPED 2 — renders offline, handles a 429/);
});

test('buildRuntimeEvidence never renders a composite score, even when the file carries one', (t) => {
  // The readingLevel lesson: a single number invites optimisation of the
  // number. A raw observation cannot be gamed the same way, because there is
  // no single quantity to move.
  const repoRoot = withEvidence(t, {
    'gen-004.json': {
      generation: '004', date: '2026-04-01',
      probe: {
        score: 87,
        composite: 'B+',
        dimensions: [{ name: 'first paint', observed: 'stalled 13s with the font host unreachable', method: 'loaded the page with that host blackholed' }],
      },
    },
  });
  const text = buildRuntimeEvidence({ repoRoot });
  assert.match(text, /stalled 13s/);
  assert.match(text, /measured by: loaded the page/);
  assert.doesNotMatch(text, /87/);
  assert.doesNotMatch(text, /B\+/);
});

test('buildRuntimeEvidence holds the character cap, and totals are what gets cut', (t) => {
  // "98 passed" changes no decision. "3 skipped, named X, Y, Z" might change
  // several — so when the budget runs out, the totals go first.
  const suites = Array.from({ length: 40 }, (_, i) => ({
    name: `suite-${i}`,
    passed: 100 + i,
    failed: 0,
    skipped: i === 39 ? ['the one that matters'] : [],
  }));
  const repoRoot = withEvidence(t, {
    'gen-005.json': { generation: '005', date: '2026-05-01', tests: { suites } },
  });

  const text = buildRuntimeEvidence({ repoRoot });
  assert.ok(text.length <= EVIDENCE_BUDGET, `expected <= ${EVIDENCE_BUDGET}, got ${text.length}`);
  assert.match(text, /the one that matters/, 'the anomaly survived');
  assert.doesNotMatch(text, /suite-39: \d+ passed/, 'and its own totals line did not');
});

test('buildRuntimeEvidence reads only the last `limit` runs, newest last', (t) => {
  const repoRoot = withEvidence(t, {
    'gen-001.json': { generation: '001', probe: { dimensions: [{ name: 'oldest', observed: 'x' }] } },
    'gen-002.json': { generation: '002', probe: { dimensions: [{ name: 'middle', observed: 'y' }] } },
    'gen-003.json': { generation: '003', probe: { dimensions: [{ name: 'newest', observed: 'z' }] } },
  });
  const text = buildRuntimeEvidence({ repoRoot, limit: 2 });
  assert.doesNotMatch(text, /oldest/);
  assert.match(text, /middle/);
  assert.match(text, /newest/);
});

test('buildRuntimeEvidence marks a failed deploy check as an anomaly and a passing one as a total', (t) => {
  const repoRoot = withEvidence(t, {
    'gen-006.json': {
      generation: '006',
      deploy: {
        url: 'https://example.com',
        checks: [
          { what: 'styles.css', observed: 'sha 1a2b', ok: true },
          { what: 'index.html', observed: 'local 1a2b vs live 9f8e', ok: false },
        ],
      },
    },
  });
  const text = buildRuntimeEvidence({ repoRoot });
  const failedAt = text.indexOf('index.html');
  const passedAt = text.indexOf('styles.css');
  assert.ok(failedAt !== -1 && passedAt !== -1);
  assert.ok(failedAt < passedAt, 'the check that observed something unexpected comes first');
});

// --- parseTap -----------------------------------------------------------------

test('parseTap counts passes and failures and names every skipped test', () => {
  const tap = `TAP version 13
ok 1 - adds two numbers
not ok 2 - handles a 429
ok 3 - renders offline # SKIP no network in CI
    ok 1 - a nested assertion
ok 4 - todo something # TODO not written yet
1..4`;
  const suite = parseTap(tap, 'unit');
  assert.equal(suite.name, 'unit');
  assert.equal(suite.failed, 1);
  assert.deepEqual(suite.skipped, ['renders offline', 'todo something']);
  assert.equal(suite.passed, 2, 'the nested ok counts; the skipped and todo ones do not');
});

test('parseTap on empty or non-TAP input returns an honest zero rather than throwing', () => {
  assert.deepEqual(parseTap('', 'unit'), { name: 'unit', passed: 0, failed: 0, skipped: [] });
  assert.deepEqual(parseTap('Ran 40 tests, all fine', 'unit'), { name: 'unit', passed: 0, failed: 0, skipped: [] });
  assert.deepEqual(parseTap(null), { name: 'tests', passed: 0, failed: 0, skipped: [] });
});

// --- buildEvidenceRecord ------------------------------------------------------

test('buildEvidenceRecord merges fragments section by section, concatenating rather than replacing', () => {
  const record = buildEvidenceRecord({
    generation: '007',
    date: new Date('2026-09-02T00:00:00Z'),
    fragments: [
      { tests: { suites: [{ name: 'unit', passed: 10, failed: 0, skipped: [] }] } },
      { tests: { suites: [{ name: 'e2e', passed: 2, failed: 1, skipped: ['flaky'] }] } },
      { deploy: { url: 'https://example.com', checks: [{ what: 'index.html', observed: 'matched' }] } },
    ],
  });
  assert.equal(record.version, 1);
  assert.equal(record.generation, '007');
  assert.equal(record.date, '2026-09-02');
  assert.deepEqual(record.tests.suites.map((s) => s.name), ['unit', 'e2e']);
  assert.equal(record.deploy.url, 'https://example.com');
});

test('buildEvidenceRecord drops a composite score at the point of writing, not only at rendering', () => {
  // A score that is never written cannot leak into a prompt through some
  // later reader that forgot the rule.
  const record = buildEvidenceRecord({
    generation: '007',
    fragments: [{ probe: { score: 87, composite: 'B+', dimensions: [{ name: 'd', observed: 'o', method: 'm' }] } }],
  });
  assert.equal(record.probe.score, undefined);
  assert.equal(record.probe.composite, undefined);
  assert.deepEqual(record.probe.dimensions, [{ name: 'd', observed: 'o', method: 'm' }]);
});

test('buildEvidenceRecord keeps only the three slowest steps, slowest first', () => {
  const record = buildEvidenceRecord({
    generation: '007',
    fragments: [{ timing: { slowest: [
      { step: 'a', ms: 100 }, { step: 'b', ms: 12800 }, { step: 'c', ms: 4000 }, { step: 'd', ms: 900 },
    ] } }],
  });
  assert.deepEqual(record.timing.slowest.map((s) => s.step), ['b', 'c', 'd']);
});

test('buildEvidenceRecord ignores junk fragments and clamps an observation that is really a log file', () => {
  const record = buildEvidenceRecord({
    generation: '007',
    fragments: [null, 'not an object', 42, { probe: { dimensions: [{ name: 'd', observed: 'x'.repeat(9000) }] } }],
  });
  assert.equal(record.probe.dimensions[0].observed.length, 300);
});

test('isEmptyEvidence is true when nothing was observed, so no file claims evidence that does not exist', () => {
  assert.equal(isEmptyEvidence(buildEvidenceRecord({ generation: '007', fragments: [] })), true);
  assert.equal(isEmptyEvidence(buildEvidenceRecord({ generation: '007', fragments: [{ timing: { slowest: [{ step: 'a', ms: 1 }] } }] })), false);
});

test('deployFragment turns a verifyDeployment result into observations, keeping what was actually seen', () => {
  const fragment = deployFragment(
    { ok: false, attempts: 3, results: [
      { relative: 'index.html', ok: false, detail: 'local 1a2b vs live 9f8e' },
      { relative: 'styles.css', ok: true, detail: 'sha 1a2b' },
    ] },
    { url: 'https://example.com' }
  );
  assert.deepEqual(fragment, {
    deploy: {
      url: 'https://example.com',
      checks: [
        { what: 'index.html', observed: 'local 1a2b vs live 9f8e', ok: false },
        { what: 'styles.css', observed: 'sha 1a2b' },
      ],
    },
  });
});

test('deployFragment on a strategy with no per-file results still records what it observed', () => {
  assert.deepEqual(deployFragment({ ok: true, detail: 'npm my-cli@1.2.3 found' }), {
    deploy: { checks: [{ what: 'deployment', observed: 'npm my-cli@1.2.3 found' }] },
  });
  assert.deepEqual(deployFragment({ ok: true }), {}, 'and nothing at all when there is nothing to say');
});
