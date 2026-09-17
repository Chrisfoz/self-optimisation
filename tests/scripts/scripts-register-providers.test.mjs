import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A provider file registers its lab when it is imported, and nothing else
// registers it. A script that calls a model without importing
// providers/index.mjs cannot resolve any model id at all. When that call has
// a fallback, the script still exits 0: send-digest.mjs and
// send-escalation-notice.mjs sent only their terse fallback email on every
// run, and no test noticed because every test injects its own `call`. Read
// the entry points as text, so a new script can't repeat it.
const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness', 'scripts');

const MODEL_CALLS = /\b(callModel|callModelWithHeadroom|resolveProvider|fetchModels|checkReleases)\b/;
const REGISTERS = /import\s+['"]\.\.\/providers\/index\.mjs['"]/;

test('every harness script that calls or resolves a model registers the providers first', () => {
  const offenders = fs.readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => {
      const source = fs.readFileSync(path.join(scriptsDir, name), 'utf8');
      return MODEL_CALLS.test(source) && !REGISTERS.test(source);
    });
  assert.deepEqual(offenders, [], `these scripts use a model without importing '../providers/index.mjs': ${offenders.join(', ')}`);
});

test('the check sees the two notify scripts at all (not a vacuous pass)', () => {
  for (const name of ['send-digest.mjs', 'send-escalation-notice.mjs']) {
    assert.match(fs.readFileSync(path.join(scriptsDir, name), 'utf8'), MODEL_CALLS, `${name} no longer calls a model; update this test`);
  }
});
