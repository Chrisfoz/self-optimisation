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
