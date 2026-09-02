import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, estimateTokens, createSpendLedger, withSpend, projectedFanOut } from '../../harness/lib/spend.mjs';

test('normalizeUsage: the four provider shapes reduce to input/output tokens', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 100, output_tokens: 20 }), { inputTokens: 100, outputTokens: 20 });
  assert.deepEqual(normalizeUsage({ input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 }), { inputTokens: 150, outputTokens: 20 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }), { inputTokens: 7, outputTokens: 3 });
  assert.deepEqual(normalizeUsage({ promptTokenCount: 9, candidatesTokenCount: 4, thoughtsTokenCount: 6 }), { inputTokens: 9, outputTokens: 10 });
});

test('normalizeUsage: null, non-objects and unrecognised shapes return null rather than zero', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage('usage'), null);
  assert.equal(normalizeUsage({ billed: 12 }), null);
});

test('ledger: records real usage as-is and estimates when the provider gave none, and says which', () => {
  const ledger = createSpendLedger();
  ledger.record({ site: 'suggest', model: 'a', provider: 'anthropic', usage: { input_tokens: 1000, output_tokens: 200 } });
  ledger.record({ site: 'review', model: 'b', provider: 'openai', usage: null, system: 'x'.repeat(400), user: 'y'.repeat(400), text: 'z'.repeat(40) });
  assert.equal(ledger.total(), 1200 + 200 + 10);
  const s = ledger.summary();
  assert.equal(s.calls, 2);
  assert.equal(s.estimatedCalls, 1);
  assert.equal(s.totalTokens, 1410);
  assert.deepEqual(s.byModel.a, { calls: 1, inputTokens: 1000, outputTokens: 200 });
  assert.deepEqual(s.bySite.review, { calls: 1, inputTokens: 200, outputTokens: 10 });
});

test('withSpend: records a successful call from the result, and a failed call as an estimate before rethrowing', async () => {
  const ledger = createSpendLedger();
  const ok = withSpend(async () => ({ text: 'hi', model: 'm', provider: 'p', usage: { input_tokens: 5, output_tokens: 1 } }), ledger, 'rank');
  await ok({ model: 'm', system: 's', user: 'u' });
  const bad = withSpend(async () => { throw new Error('500'); }, ledger, 'implement');
  await assert.rejects(() => bad({ model: 'n', system: 's'.repeat(80), user: '' }), /500/);
  assert.equal(ledger.calls.length, 2);
  assert.equal(ledger.calls[0].estimated, false);
  assert.equal(ledger.calls[1].estimated, true);
  assert.equal(ledger.calls[1].inputTokens, 20);
  assert.equal(ledger.calls[1].outputTokens, 0);
});

test('projectedFanOut: multiplies the prompt by the number of models, and never trips without a cap', () => {
  assert.deepEqual(projectedFanOut({ promptChars: 4000, models: 3, maxTokens: 2500 }), { over: true, estimatedTokens: 3000 });
  assert.equal(projectedFanOut({ promptChars: 4000, models: 3, maxTokens: 3000 }).over, false);
  assert.equal(projectedFanOut({ promptChars: 4000, models: 3, maxTokens: null }).over, false);
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});
