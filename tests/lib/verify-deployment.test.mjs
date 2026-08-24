import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  canonicalize, compareFile, verifyUrl, verifyDeployment,
  checkNpm, checkPypi, checkNuget, checkMaven, verifyRegistry, verifyArtifact,
} from '../../harness/lib/verify-deployment.mjs';

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

test('verifyDeployment: an unrecognised strategy fails loudly rather than silently passing', async () => {
  await assert.rejects(() => verifyDeployment({ strategy: 'carrier-pigeon' }), /not recognised/);
});

// --- registry checkers -------------------------------------------------------

test('checkNpm: ok when the registry 200s the exact version', async () => {
  const fetchImpl = async (url) => ({ ok: url.endsWith('/my-cli/2.3.0'), status: 200 });
  const result = await checkNpm({ package: 'my-cli', version: '2.3.0', fetchImpl });
  assert.equal(result.ok, true);
});

test('checkNpm: not ok on a 404, reported not thrown', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await checkNpm({ package: 'my-cli', version: '9.9.9', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 404/);
});

test('checkNpm: a network failure is reported, not thrown', async () => {
  const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
  const result = await checkNpm({ package: 'my-cli', version: '1.0.0', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /fetch failed: ENOTFOUND/);
});

test('checkPypi: ok when the registry 200s the exact version', async () => {
  const fetchImpl = async (url) => ({ ok: url.includes('/my-pkg/1.2.3/json'), status: 200 });
  const result = await checkPypi({ package: 'my-pkg', version: '1.2.3', fetchImpl });
  assert.equal(result.ok, true);
});

test('checkPypi: not ok when the version is absent', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await checkPypi({ package: 'my-pkg', version: '9.9.9', fetchImpl });
  assert.equal(result.ok, false);
});

test('checkNuget: ok when the version is a member of the flat-container index', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ versions: ['1.0.0', '1.1.0', '2.0.0'] }) });
  const result = await checkNuget({ package: 'My.Package', version: '2.0.0', fetchImpl });
  assert.equal(result.ok, true);
});

test('checkNuget: not ok when the version is missing from the index', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ versions: ['1.0.0'] }) });
  const result = await checkNuget({ package: 'My.Package', version: '9.9.9', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /1 version\(s\)/);
});

test('checkNuget: not ok on a non-OK index response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await checkNuget({ package: 'nope', version: '1.0.0', fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.detail, /HTTP 404/);
});

test('checkMaven: ok when solrsearch reports a hit', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ response: { numFound: 1 } }) });
  const result = await checkMaven({ groupId: 'com.example', artifactId: 'lib', version: '1.0.0', fetchImpl });
  assert.equal(result.ok, true);
});

test('checkMaven: not ok when solrsearch reports zero hits', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ response: { numFound: 0 } }) });
  const result = await checkMaven({ groupId: 'com.example', artifactId: 'lib', version: '9.9.9', fetchImpl });
  assert.equal(result.ok, false);
});

// --- verifyRegistry ----------------------------------------------------------

test('verifyRegistry: succeeds on the first check when the version is already published', async () => {
  let sleepCalls = 0;
  const result = await verifyRegistry({
    ecosystem: 'npm',
    package: 'my-cli',
    version: '2.3.0',
    fetchImpl: async () => ({ ok: true, status: 200 }),
    sleep: async () => { sleepCalls++; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.ecosystem, 'npm');
  assert.equal(sleepCalls, 0);
});

test('verifyRegistry: retries until the version shows up, within the timeout', async () => {
  let call = 0;
  const result = await verifyRegistry({
    ecosystem: 'pypi',
    package: 'my-pkg',
    version: '1.2.3',
    timeoutMs: 10_000,
    intervalMs: 50,
    fetchImpl: async () => { call++; return { ok: call >= 3, status: call >= 3 ? 200 : 404 }; },
    sleep: async () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test('verifyRegistry: reports failure once the timeout elapses, without hanging', async () => {
  let now = 0;
  const realDateNow = Date.now;
  Date.now = () => now;
  try {
    const result = await verifyRegistry({
      ecosystem: 'npm',
      package: 'never-published',
      version: '0.0.1',
      timeoutMs: 100,
      intervalMs: 40,
      fetchImpl: async () => ({ ok: false, status: 404 }),
      sleep: async (ms) => { now += ms; },
    });
    assert.equal(result.ok, false);
    assert.ok(result.attempts >= 2);
  } finally {
    Date.now = realDateNow;
  }
});

test('verifyRegistry: rejects an unsupported ecosystem loudly', async () => {
  await assert.rejects(() => verifyRegistry({ ecosystem: 'cargo', package: 'x', version: '1.0.0' }), /not supported/);
});

test('verifyRegistry: rejects when maven is missing groupId/artifactId', async () => {
  await assert.rejects(() => verifyRegistry({ ecosystem: 'maven', version: '1.0.0' }), /group_id and .artifact_id/);
});

test('verifyRegistry: rejects when version is missing', async () => {
  await assert.rejects(() => verifyRegistry({ ecosystem: 'npm', package: 'x' }), /version is required/);
});

// --- verifyArtifact ------------------------------------------------------------

test('verifyArtifact: passes when build, path and smoke check all succeed', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'dist'));
  fs.writeFileSync(path.join(repoRoot, 'dist', 'cli.js'), '// built');

  const calls = [];
  const exec = (cmd) => { calls.push(cmd); return ''; };

  const result = await verifyArtifact({
    repoRoot,
    buildCommand: 'npm run build',
    path: 'dist/cli.js',
    smokeCommand: 'node dist/cli.js --version',
    exec,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['npm run build', 'node dist/cli.js --version']);
});

test('verifyArtifact: fails when the build command throws', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const exec = () => { throw new Error('exit code 1'); };
  const result = await verifyArtifact({ repoRoot, buildCommand: 'npm run build', exec });
  assert.equal(result.ok, false);
  assert.match(result.detail, /build command failed/);
});

test('verifyArtifact: fails when the expected path is missing after the build', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const exec = () => '';
  const result = await verifyArtifact({ repoRoot, buildCommand: 'npm run build', path: 'dist/cli.js', exec });
  assert.equal(result.ok, false);
  assert.match(result.detail, /not found after the build/);
});

test('verifyArtifact: fails when the smoke command throws', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'cli.js'), '// built');

  const exec = (cmd) => { if (cmd.startsWith('node')) throw new Error('exit code 1'); return ''; };
  const result = await verifyArtifact({ repoRoot, path: 'cli.js', smokeCommand: 'node cli.js --version', exec });
  assert.equal(result.ok, false);
  assert.match(result.detail, /smoke command failed/);
});

test('verifyArtifact: a project with no build/smoke commands, only a path check, still passes', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'cli.js'), '// built');

  const result = await verifyArtifact({ repoRoot, path: 'cli.js', exec: () => { throw new Error('should not be called'); } });
  assert.equal(result.ok, true);
});

// --- verifyDeployment dispatcher: registry/artifact --------------------------

test('verifyDeployment: strategy "registry" delegates to verifyRegistry', async () => {
  const result = await verifyDeployment(
    { strategy: 'registry', registry: { ecosystem: 'npm', package: 'my-cli', version: '2.3.0' } },
    { fetchImpl: async () => ({ ok: true, status: 200 }) }
  );
  assert.equal(result.strategy, 'registry');
  assert.equal(result.ok, true);
});

test('verifyDeployment: strategy "artifact" delegates to verifyArtifact', async (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'cli.js'), '// built');

  const result = await verifyDeployment(
    { strategy: 'artifact', repoRoot, artifact: { path: 'cli.js' } },
    {}
  );
  assert.equal(result.strategy, 'artifact');
  assert.equal(result.ok, true);
});
