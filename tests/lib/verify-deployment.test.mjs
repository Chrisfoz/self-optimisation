import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonicalize, compareFile, verifyUrl, verifyDeployment } from '../../harness/lib/verify-deployment.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-deploy-test-'));
}

// --- canonicalize -----------------------------------------------------------

test('canonicalize: HTML extracts script contents and visible text, ignoring markup differences', () => {
  const a = canonicalize('<html><body class="x"><script>var y=1;</script><p>Hello</p></body></html>', true);
  const b = canonicalize("<html><body><script>var y=1;</script>\n  <p>Hello</p>\n</body></html>", true);
  assert.equal(a, b); // attribute differences and whitespace must not matter
});

test('canonicalize: HTML strips style blocks and tags from the text portion', () => {
  const result = canonicalize('<html><style>.x{color:red}</style><body><p>Hi</p></body></html>', true);
  assert.doesNotMatch(result, /color:red/);
  assert.match(result, /Hi/);
});

test('canonicalize: HTML with genuinely different visible text is NOT equal', () => {
  const a = canonicalize('<p>Hello</p>', true);
  const b = canonicalize('<p>Goodbye</p>', true);
  assert.notEqual(a, b);
});

test('canonicalize: non-HTML compares verbatim aside from trailing whitespace', () => {
  assert.equal(canonicalize('var x = 1;\n\n\n', false), 'var x = 1;');
  assert.notEqual(canonicalize('var x = 1;', false), canonicalize('var x = 2;', false));
});

// --- compareFile --------------------------------------------------------------

test('compareFile: matches when the fetched content canonicalizes the same as local', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<html><body class="a"><p>Hi</p></body></html>');

  const fetchImpl = async () => ({ ok: true, text: async () => '<html><body class="b"><p>Hi</p></body></html>' });
  const result = await compareFile({ repoRoot, relative: 'index.html', siteUrl: 'https://example.test', fetchImpl });
  assert.equal(result.ok, true);
});

test('compareFile: reports a mismatch with both hashes when content actually differs', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>Hello</p>');

  const fetchImpl = async () => ({ ok: true, text: async () => '<p>Old version</p>' });
  const result = await compareFile({ repoRoot, relative: 'index.html', siteUrl: 'https://example.test', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /local .* vs live/);
});

test('compareFile: a non-OK HTTP response is reported, not thrown', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>Hi</p>');

  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await compareFile({ repoRoot, relative: 'index.html', siteUrl: 'https://example.test', fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.detail, 'HTTP 404');
});

test('compareFile: a network failure is reported, not thrown', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>Hi</p>');

  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  const result = await compareFile({ repoRoot, relative: 'index.html', siteUrl: 'https://example.test', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /fetch failed: ECONNRESET/);
});

// --- verifyUrl ------------------------------------------------------------------

test('verifyUrl: succeeds on the first check when everything already matches', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>Hi</p>');

  let sleepCalls = 0;
  const result = await verifyUrl({
    repoRoot,
    watchedFiles: ['index.html'],
    siteUrl: 'https://example.test/',
    fetchImpl: async () => ({ ok: true, text: async () => '<p>Hi</p>' }),
    sleep: async () => { sleepCalls++; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(sleepCalls, 0); // never needed to wait
});

test('verifyUrl: retries until it matches, within the timeout', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>New</p>');

  let call = 0;
  let sleptMs = [];
  const result = await verifyUrl({
    repoRoot,
    watchedFiles: ['index.html'],
    siteUrl: 'https://example.test',
    timeoutMs: 10_000,
    intervalMs: 50,
    fetchImpl: async () => {
      call++;
      return { ok: true, text: async () => (call < 3 ? '<p>Old</p>' : '<p>New</p>') };
    },
    sleep: async (ms) => { sleptMs.push(ms); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
  assert.equal(sleptMs.length, 2);
});

test('verifyUrl: reports STALE once the timeout elapses, without hanging (fake clock via injected sleep)', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>New</p>');

  // Simulate time passing without real delay: advance a fake clock inside
  // the injected sleep function rather than actually waiting.
  let now = 0;
  const realDateNow = Date.now;
  Date.now = () => now;
  t.after(() => { Date.now = realDateNow; });

  const result = await verifyUrl({
    repoRoot,
    watchedFiles: ['index.html'],
    siteUrl: 'https://example.test',
    timeoutMs: 100,
    intervalMs: 40,
    fetchImpl: async () => ({ ok: true, text: async () => '<p>Old, never updates</p>' }),
    sleep: async (ms) => { now += ms; },
  });

  assert.equal(result.ok, false);
  assert.ok(result.attempts >= 2);
});

// --- verifyDeployment dispatcher --------------------------------------------

test('verifyDeployment: strategy "none" is a deliberate no-op that reports ok', async () => {
  const result = await verifyDeployment({ strategy: 'none' });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test('verifyDeployment: strategy "url" delegates to verifyUrl', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), '<p>Hi</p>');

  const result = await verifyDeployment(
    { strategy: 'url', repoRoot, watchedFiles: ['index.html'], siteUrl: 'https://example.test' },
    { fetchImpl: async () => ({ ok: true, text: async () => '<p>Hi</p>' }) }
  );
  assert.equal(result.strategy, 'url');
  assert.equal(result.ok, true);
});

test('verifyDeployment: an unimplemented strategy fails loudly rather than silently passing', async () => {
  await assert.rejects(() => verifyDeployment({ strategy: 'registry' }), /not implemented yet/);
  await assert.rejects(() => verifyDeployment({ strategy: 'artifact' }), /not implemented yet/);
});
