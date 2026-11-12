import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashTree, writeManifest, readManifest, localEdits, editsLostBy, MANIFEST_FILE } from '../../harness/lib/manifest.mjs';

function tree(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

test('hashTree: every file by posix path, sorted, without the key file, packages or the record', (t) => {
  const dir = tree(t, {
    'VERSION': '0.4.0\n',
    'lib/b.mjs': 'b',
    'lib/a.mjs': 'a',
    '.env.harness.local': 'ANTHROPIC_API_KEY=secret',
    'node_modules/x/index.js': 'x',
    [MANIFEST_FILE]: '{}',
  });
  assert.deepEqual(Object.keys(hashTree(dir)), ['VERSION', 'lib/a.mjs', 'lib/b.mjs']);
});

test('hashTree: a CRLF checkout of a text file hashes the same; a binary file is hashed as it is', (t) => {
  const lf = tree(t, { 'a.mjs': 'one\ntwo\n', 'bin.dat': Buffer.from([0, 13, 10, 1]) });
  const crlf = tree(t, { 'a.mjs': 'one\r\ntwo\r\n', 'bin.dat': Buffer.from([0, 10, 1]) });
  assert.equal(hashTree(lf)['a.mjs'], hashTree(crlf)['a.mjs']);
  assert.notEqual(hashTree(lf)['bin.dat'], hashTree(crlf)['bin.dat']);
});

test('localEdits: null without a record; otherwise modified, added and missing, and nothing for an untouched copy', (t) => {
  const dir = tree(t, { 'VERSION': '0.4.0\n', 'lib/a.mjs': 'a', 'lib/b.mjs': 'b' });
  assert.equal(localEdits(dir), null);
  assert.equal(readManifest(dir), null);

  writeManifest(dir, '0.4.0');
  assert.deepEqual(localEdits(dir), { version: '0.4.0', modified: [], added: [], missing: [] });

  fs.writeFileSync(path.join(dir, 'lib/a.mjs'), 'edited');
  fs.writeFileSync(path.join(dir, 'lib/new.mjs'), 'new');
  fs.rmSync(path.join(dir, 'lib/b.mjs'));
  fs.writeFileSync(path.join(dir, '.env.harness.local'), 'KEY=1');
  assert.deepEqual(localEdits(dir), { version: '0.4.0', modified: ['lib/a.mjs'], added: ['lib/new.mjs'], missing: ['lib/b.mjs'] });
});

test('a record that is not JSON, or has no files, is treated as no record', (t) => {
  const dir = tree(t, { 'a.mjs': 'a', [MANIFEST_FILE]: 'not json' });
  assert.equal(localEdits(dir), null);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), '{"version":"1.0.0"}');
  assert.equal(localEdits(dir), null);
});

test('editsLostBy: an edit the incoming release already contains is not a loss; one it lacks is', (t) => {
  const installed = tree(t, { 'lib/a.mjs': 'old a', 'lib/b.mjs': 'old b', 'lib/gone.mjs': 'dropped upstream' });
  writeManifest(installed, '0.3.0');
  const incoming = tree(t, { 'lib/a.mjs': 'the fix', 'lib/b.mjs': 'new b' });

  // Untouched files that the release changed or removed are just the upgrade.
  assert.deepEqual(editsLostBy(installed, incoming), []);

  fs.writeFileSync(path.join(installed, 'lib/a.mjs'), 'the fix');        // back-ported by hand, then released
  fs.writeFileSync(path.join(installed, 'lib/b.mjs'), 'my local patch');  // never sent upstream
  fs.writeFileSync(path.join(installed, 'lib/mine.mjs'), 'my own file');
  assert.deepEqual(editsLostBy(installed, incoming), ['lib/b.mjs', 'lib/mine.mjs']);

  assert.equal(editsLostBy(incoming, installed), null, 'no record, nothing to compare');
});
