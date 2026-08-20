import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs'; // resolveProvider() needs providers registered — each test file runs isolated
import { checkContextFit, probeCandidates } from '../../harness/lib/probe-models.mjs';

test('checkContextFit: an unknown context window never blocks a candidate', () => {
  assert.equal(checkContextFit({ contextWindow: null }, 500000), null);
  assert.equal(checkContextFit({}, 500000), null);
});

test('checkContextFit: a window too small for the estimate is reported', () => {
  const reason = checkContextFit({ contextWindow: 8000 }, 100000);
  assert.equal(typeof reason, 'string');
  assert.match(reason, /context window/);
});

test('checkContextFit: a window comfortably big enough passes', () => {
  assert.equal(checkContextFit({ contextWindow: 2000000 }, 100000), null);
});

test('probeCandidates: a reachable model survives, an unreachable one is dropped with its reason', async () => {
  const prober = async ({ model }) => {
    if (model === 'unreachable-model') throw new Error('404 not a chat model');
    return { text: 'OK' };
  };

  const { survivors, dropped } = await probeCandidates(
    [{ id: 'claude-opus-5', provider: 'anthropic' }, { id: 'unreachable-model', provider: 'openai' }],
    prober
  );

  assert.ok(survivors.some((s) => s.id === 'claude-opus-5'));
  assert.ok(dropped.some((d) => d.id === 'unreachable-model' && d.reason.includes('404')));
});

test('probeCandidates: an id with no explicit provider is resolved before probing', async () => {
  const seen = [];
  const prober = async ({ model, provider }) => {
    seen.push({ model, provider });
    return { text: 'OK' };
  };
  const { survivors } = await probeCandidates([{ id: 'claude-opus-5' }], prober);
  assert.equal(survivors[0].provider, 'anthropic');
  assert.equal(seen[0].provider, 'anthropic');
});

test('probeCandidates: an id that resolves to no known provider is dropped, not thrown', async () => {
  const prober = async () => ({ text: 'OK' });
  const { dropped, survivors } = await probeCandidates([{ id: 'totally-unknown-model' }], prober);
  assert.equal(survivors.length, 0);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].reason, /Cannot resolve a provider/);
});
