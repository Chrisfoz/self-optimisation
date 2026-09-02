import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { harnessVersion, compareVersions, checkUpgrade } from '../../harness/lib/version.mjs';

test('harnessVersion reads the real VERSION file and it is a dotted version', () => {
  assert.match(harnessVersion(), /^\d+\.\d+\.\d+$/);
});

test('harnessVersion returns "unknown" for a missing or malformed file rather than throwing', () => {
  assert.equal(harnessVersion({ file: path.join(os.tmpdir(), 'no-such-VERSION-file') }), 'unknown');
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ver-')), 'VERSION');
  fs.writeFileSync(bad, 'latest\n');
  assert.equal(harnessVersion({ file: bad }), 'unknown');
});

test('compareVersions orders numerically, not lexically, and refuses non-versions', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('unknown', '1.0.0'), null);
});

test('checkUpgrade reports behind/current without the network, and an error instead of a guess', async () => {
  assert.deepEqual(
    await checkUpgrade({ local: '0.1.0', fetchText: async () => '0.2.0\n' }),
    { local: '0.1.0', upstream: '0.2.0', behind: true }
  );
  assert.deepEqual(
    await checkUpgrade({ local: '0.2.0', fetchText: async () => '0.2.0' }),
    { local: '0.2.0', upstream: '0.2.0', behind: false }
  );
  const failed = await checkUpgrade({ local: '0.1.0', fetchText: async () => { throw new Error('offline'); } });
  assert.equal(failed.behind, null);
  assert.match(failed.error, /offline/);
});
