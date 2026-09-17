import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { getProvider, registeredProviders } from '../../harness/lib/llm-provider.mjs';
import { validateAdapter } from '../../harness/lib/validate.mjs';
import os from 'node:os';

// roles.<seat>.effort. On a ~380k-token prompt Opus 5 at its default effort
// spent a 16k and then a 32k output allowance thinking and never finished its
// edits. Effort is the lever, and it has to be opt-in: sending it to a model
// that does not know it would 400 every call to that seat.

const base = { model: 'claude-opus-5', system: 's', user: 'u', maxTokens: 32000, images: [] };

test('anthropic: no effort, no output_config (the request is unchanged)', () => {
  const body = getProvider('anthropic').body(base);
  assert.equal('output_config' in body, false);
});

test('anthropic: an effort is sent as output_config.effort', () => {
  const body = getProvider('anthropic').body({ ...base, effort: 'medium' });
  assert.deepEqual(body.output_config, { effort: 'medium' });
  assert.equal('thinking' in body, false, 'thinking stays omitted');
});

test('every other lab ignores effort entirely', () => {
  for (const name of registeredProviders().filter((n) => n !== 'anthropic')) {
    const without = JSON.stringify(getProvider(name).body({ ...base, model: 'm' }));
    const withEffort = JSON.stringify(getProvider(name).body({ ...base, model: 'm', effort: 'low' }));
    assert.equal(withEffort, without, name);
  }
});

test('validate refuses an effort no lab accepts', () => {
  const adapter = { project: { id: 'x' }, constitution: { allowed_paths: [] }, roles: { implement: { effort: 'turbo' }, review: { effort: 'high' } } };
  const { errors } = validateAdapter(adapter, { repoRoot: os.tmpdir(), env: {} });
  assert.ok(errors.some((e) => /roles\.implement\.effort is "turbo"/.test(e)));
  assert.ok(!errors.some((e) => /roles\.review\.effort/.test(e)));
});