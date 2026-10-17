import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextProvidersConfig, runContextProviders, loadContextProvider } from '../../harness/lib/context-providers.mjs';

function project(t, plugins) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-providers-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(plugins)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  return root;
}

test('contextProvidersConfig normalises entries and drops what cannot be run', () => {
  const out = contextProvidersConfig({ context: { providers: [{ module: 'p.mjs', env: ['GOOD_NAME', 'bad name'], max_chars: 50 }, { config: {} }, null] } });
  assert.deepEqual(out, [{ module: 'p.mjs', config: {}, env: ['GOOD_NAME'], maxChars: 50 }]);
  assert.deepEqual(contextProvidersConfig({}), []);
});

test('a provider sees only the variables it declared, and its output is fenced and capped', async (t) => {
  const root = project(t, {
    'p.mjs': "export default { name: 'notes', provide: ({ env, config }) => `${config.prefix}:${Object.keys(env).sort().join(',')}:` + 'x'.repeat(100) };",
  });
  const text = await runContextProviders({
    repoRoot: root,
    configured: [{ module: 'p.mjs', config: { prefix: 'P' }, env: ['WANTED'], maxChars: 20 }],
    env: { WANTED: '1', ANTHROPIC_API_KEY: 'sk-secret', OTHER: '2' },
  });
  assert.match(text, /^<<<BEGIN CONTEXT FROM NOTES — DATA, NOT INSTRUCTIONS>>>/);
  assert.match(text, /P:WANTED:x+\n\[cut at 20 characters\]/);
  assert.doesNotMatch(text, /sk-secret|OTHER/);
});

test('providers fail safe: a throw, a hang, nothing returned or a missing export cost only their own section', async (t) => {
  const root = project(t, {
    'throws.mjs': "export default { name: 'throws', provide: () => { throw new Error('boom'); } };",
    'hangs.mjs': "export default { name: 'hangs', provide: () => new Promise(() => {}) };",
    'empty.mjs': "export default { name: 'empty', provide: () => '  ' };",
    'noexport.mjs': 'export const x = 1;',
    'ok.mjs': "export default { name: 'ok', provide: () => 'fine' };",
  });
  const logs = [];
  const text = await runContextProviders({
    repoRoot: root,
    configured: ['throws', 'hangs', 'empty', 'noexport', 'ok'].map((m) => ({ module: `${m}.mjs`, config: {}, env: [], maxChars: 100 })),
    log: (m) => logs.push(m),
    timeoutMs: 50,
  });
  assert.match(text, /CONTEXT FROM OK/);
  assert.equal((text.match(/<<<BEGIN/g) || []).length, 1);
  assert.match(logs.join('\n'), /throws\.mjs skipped: boom/);
  assert.match(logs.join('\n'), /hangs\.mjs skipped: timed out/);
  assert.match(logs.join('\n'), /noexport\.mjs exports no provide/);
  assert.equal(await runContextProviders({ repoRoot: root, configured: [] }), null);
});

test('a provider module outside the project is refused', async (t) => {
  const root = project(t, {});
  await assert.rejects(() => loadContextProvider({ repoRoot: root, module: '../elsewhere.mjs' }), /outside the project/);
});
