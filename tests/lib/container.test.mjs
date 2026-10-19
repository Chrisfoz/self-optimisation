import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load as loadYaml } from '../../harness/vendor/js-yaml.mjs';

const REPO_ROOT = path.join(import.meta.dirname, '../..');
// CRLF-normalised: a Windows checkout with core.autocrlf writes these with \r\n.
const read = (p) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// The image is built and run for real in CI (the console-image job). These
// are the rules that make it safe, checked on every machine, Docker or not.

test('Dockerfile copies only what the console reads, never the whole checkout', () => {
  const copies = read('Dockerfile').split('\n').filter((l) => /^COPY\s/.test(l));
  assert.deepEqual(copies, ['COPY package.json ./', 'COPY harness/ harness/', 'COPY console/ console/']);
  assert.doesNotMatch(read('Dockerfile'), /npm (ci|install)/, 'there is nothing to install');
  assert.match(read('Dockerfile'), /^USER node$/m, 'not root');
});

test('.dockerignore keeps every env file out of the build context, at any depth', () => {
  const rules = read('.dockerignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  for (const rule of ['**/.env', '**/.env.*']) assert.ok(rules.includes(rule), `missing ${rule}`);
  // Only placeholder templates are re-admitted.
  assert.deepEqual(rules.filter((r) => r.startsWith('!')), ['!**/.env.example', '!**/.env.harness.example']);
});

test('CI builds the image with a planted key file and fails if it ships', () => {
  const job = loadYaml(read('.github/workflows/ci.yml')).jobs['console-image'];
  assert.ok(job, 'the console-image job exists');
  const runs = job.steps.map((s) => s.run || '').join('\n');
  assert.match(runs, /> harness\/\.env\.harness\.local/);
  assert.match(runs, /docker build/);
  assert.match(runs, /find \/app -name '\.env\*'/);
  assert.match(runs, /\/healthz/);
});

test('the devcontainer brings Node 22 and the GitHub CLI', () => {
  // JSON with comments, as VS Code writes it.
  const config = JSON.parse(read('.devcontainer/devcontainer.json').replace(/^\s*\/\/.*$/gm, ''));
  assert.match(config.image, /javascript-node:.*22/);
  assert.ok(Object.keys(config.features).some((f) => f.includes('github-cli')));
  assert.deepEqual(config.forwardPorts, [3000]);
});
