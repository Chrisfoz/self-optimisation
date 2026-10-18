import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';

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

test('the release notes give the SHA-pinned shared install line', () => {
  assert.match(file, /--shared \$GITHUB_SHA --shared-label v\$VERSION/);
});
