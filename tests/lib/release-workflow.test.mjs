import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';
import { runStep, shellTestOptions } from '../helpers/gha-shell.mjs';

// The release workflow is the only one here with write access to the
// repository's tags, and it runs unattended on every VERSION bump. These
// pin the properties that keep it that narrow.

const root = path.join(import.meta.dirname, '../..');
const file = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const wf = loadYaml(file);
const steps = wf.jobs.release.steps;

test('it runs only on a push to main that changes harness/VERSION', () => {
  assert.deepEqual(Object.keys(wf.on), ['push']);
  assert.deepEqual(wf.on.push.branches, ['main']);
  assert.deepEqual(wf.on.push.paths, ['harness/VERSION']);
});

test('its only write permission is contents', () => {
  assert.deepEqual(wf.permissions, { contents: 'write' });
});

test('every action it uses is pinned by full commit SHA', () => {
  for (const step of steps.filter((s) => s.uses)) {
    assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
  }
});

test('no expression is interpolated into a script; values arrive through env', () => {
  for (const step of steps.filter((s) => s.run)) {
    assert.doesNotMatch(step.run, /\$\{\{/, `${step.name} interpolates an expression into its script`);
  }
});

test('it refuses a version that is malformed, already tagged, older, or disagrees with package.json', () => {
  const check = steps.find((s) => s.id === 'version').run;
  assert.match(check, /\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(check, /refs\/tags\/v\$version/);
  assert.match(check, /sort -V/);
  assert.match(check, /package\.json/);
});

// The check itself, run the way GitHub runs it, against a real repository:
// a gate tested only by grepping its source cannot be shown to fail.
function releaseRepo(t, { version, pkgVersion = version, tags = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'harness'));
  fs.writeFileSync(path.join(dir, 'harness/VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: pkgVersion }));
  git('add', '.');
  git('commit', '-q', '-m', 'release');
  for (const tag of tags) git('tag', tag);
  return dir;
}

const check = steps.find((s) => s.id === 'version');
const scenarios = [
  { name: 'a valid first release', version: '0.2.0', ok: true },
  { name: 'a valid bump past the latest release', version: '0.3.0', tags: ['v0.2.0'], ok: true },
  { name: 'a stray non-version tag does not outrank real ones', version: '0.3.0', tags: ['v0.2.0', 'vnext'], ok: true },
  { name: 'a malformed version', version: '0.3', ok: false, error: /not X\.Y\.Z/ },
  { name: 'a version already tagged', version: '0.2.0', tags: ['v0.2.0'], ok: false, error: /already released/ },
  { name: 'a version older than the latest release', version: '0.1.9', tags: ['v0.2.0'], ok: false, error: /not newer/ },
  { name: 'package.json disagreeing', version: '0.3.0', pkgVersion: '0.2.0', ok: false, error: /package\.json says 0\.2\.0/ },
];
for (const s of scenarios) {
  test(`the version check: ${s.name}`, shellTestOptions(), (t) => {
    const result = runStep(check, { cwd: releaseRepo(t, s) });
    assert.equal(result.status === 0, s.ok, result.stdout + result.stderr);
    if (s.ok) assert.equal(result.outputs.version, s.version);
    else assert.match(result.stdout + result.stderr, s.error);
  });
}

test('the release notes give the SHA-pinned shared install line', () => {
  assert.match(file, /--shared \$GITHUB_SHA --shared-label v\$VERSION/);
});
