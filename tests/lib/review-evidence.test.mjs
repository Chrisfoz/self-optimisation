import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReviewEvidence, servable, touchedSymbols } from '../../harness/lib/review-evidence.mjs';

function repo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return root;
}

test('servable refuses secrets, traversal and binaries', () => {
  for (const ok of ['src/a.js', 'pkg/mod.py', 'README.md', 'config/app.yml']) assert.ok(servable(ok), ok);
  for (const bad of ['.env', 'config/.env.local', 'certs/server.pem', 'deploy/id_rsa', 'src/secrets.js', '../outside.js', '/etc/passwd.md', 'img/logo.png', '.npmrc']) assert.ok(!servable(bad), bad);
});

test('touchedSymbols names the definitions an edit touched', () => {
  assert.deepEqual(touchedSymbols([{ search: 'export function total(items) {\n  return sum(items);\n}', replace: 'export function total(items, tax) {\n  return sum(items) * tax;\n}' }]), ['total']);
});

test('dependents: unchanged importers and callers of a changed definition, excerpted around the use', (t) => {
  const root = repo(t, {
    'src/price.js': 'export function total(items) { return items.length; }\n',
    'src/cart.js': "import { total } from './price.js';\n\nexport function checkout(items) {\n  return total(items);\n}\n",
    'scripts/report.js': '// no import, global use\nconsole.log(total(window.items));\n',
    'src/unrelated.js': 'export const x = 1;\n',
    '.env': 'TOKEN=total\n',
  });
  const evidence = createReviewEvidence({ repoRoot: root, files: ['src/price.js', 'src/cart.js', 'scripts/report.js', 'src/unrelated.js', '.env'] });
  const text = evidence.dependents(['src/price.js'], [{ file: 'src/price.js', search: 'export function total(items) {', replace: 'export function total(items, tax) {' }]);
  assert.match(text, /#### src\/cart\.js — imports a changed file/);
  assert.match(text, /\n {4}4 {4}return total\(items\);/);
  assert.doesNotMatch(text, /```\n   ⋮/);
  assert.match(text, /#### scripts\/report\.js — mentions total/);
  assert.doesNotMatch(text, /unrelated|TOKEN/);
  assert.equal(evidence.dependents(['src/unrelated.js'], []), null);
});

test('read serves tracked source in full and names every refusal', (t) => {
  const root = repo(t, { 'src/a.js': 'A', '.env': 'SECRET=1', 'untracked.js': 'U' });
  const evidence = createReviewEvidence({ repoRoot: root, files: ['src/a.js', '.env'] });
  const got = evidence.read(['src/a.js', '.env', 'untracked.js']);
  assert.deepEqual(got.served, ['src/a.js']);
  assert.equal(got.refused.length, 2);
  assert.match(got.text, /#### src\/a\.js\n```\nA\n```/);
  assert.doesNotMatch(got.text, /SECRET/);
});

// Built at run time so the test file itself carries no key-shaped string.
const FAKE_KEY = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');

test('a credential committed under an innocent name is never served, asked for or as a dependent', (t) => {
  const root = repo(t, {
    'src/price.js': 'export function total(items) { return items.length; }\n',
    'config/app.js': `import { total } from '../src/price.js';\nexport const apiKey = '${FAKE_KEY}';\nexport const t = total([]);\n`,
    'src/cart.js': "import { total } from './price.js';\nexport const c = total([]);\n",
  });
  const ev = createReviewEvidence({ repoRoot: root, files: ['src/price.js', 'config/app.js', 'src/cart.js'] });
  const deps = ev.dependents(['src/price.js'], [{ search: 'export function total(items)', replace: 'export function total(items, x)' }]);
  assert.match(deps, /src\/cart\.js/);
  assert.doesNotMatch(deps, /config\/app\.js|sk-ant/);
  const got = ev.read(['config/app.js']);
  assert.equal(got.text, null);
  assert.match(got.refused[0], /credential-shaped/);
});

test('a tracked symlink is never followed, inside or outside the repository', (t) => {
  const root = repo(t, { 'src/a.js': 'A\n' });
  const outside = repo(t, { 'leak.md': 'OUTSIDE-THE-REPO\n' });
  try {
    fs.symlinkSync(path.join(outside, 'leak.md'), path.join(root, 'docs.md'));
    fs.symlinkSync(path.join(root, 'src/a.js'), path.join(root, 'alias.js'));
  } catch (err) {
    t.skip(`cannot create symlinks here (${err.code})`);
    return;
  }
  const ev = createReviewEvidence({ repoRoot: root, files: ['src/a.js', 'docs.md', 'alias.js'] });
  const got = ev.read(['docs.md', 'alias.js', 'src/a.js']);
  assert.deepEqual(got.served, ['src/a.js']);
  assert.equal(got.refused.length, 2);
  assert.doesNotMatch(got.text, /OUTSIDE-THE-REPO/);
});
