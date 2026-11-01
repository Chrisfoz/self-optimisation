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
  assert.equal(ledger.calls[1].inputTokens, 27); // 81 chars at ADMISSION_CHARS_PER_TOKEN (3)
  assert.equal(ledger.calls[1].outputTokens, 0);
});

test('projectedFanOut: multiplies the prompt by the number of models, and never trips without a cap', () => {
  assert.deepEqual(projectedFanOut({ promptChars: 4000, models: 3, maxTokens: 2500 }), { over: true, estimatedTokens: 3000 });
  assert.equal(projectedFanOut({ promptChars: 4000, models: 3, maxTokens: 3000 }).over, false);
  assert.equal(projectedFanOut({ promptChars: 4000, models: 3, maxTokens: null }).over, false);
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
});

// --- Pools, cache weight and implausible usage (0.3.3) -----------------------

test('ledger pools: discovery is capped at its share, and a discovery overrun is never charged to the build stage', () => {
  const ledger = createSpendLedger({ maxTokens: 1000, discoveryShare: 0.3 });
  assert.equal(ledger.discoveryCap(), 300);
  // A provider reports far more than was admitted — networkinAI generation 015.
  const t = ledger.admit({ site: 'suggest', model: 'a', inputTokens: 200, outputTokens: 50 });
  ledger.settle(t, { usage: { prompt_tokens: 900, completion_tokens: 10 } });
  assert.throws(() => ledger.admit({ site: 'suggest', model: 'b', inputTokens: 1, outputTokens: 1 }), /discovery pool/);
  assert.throws(() => ledger.admit({ site: 'rank', model: 'r', inputTokens: 1, outputTokens: 1 }), /discovery pool/);
  // The build pool is the cap less discovery's share (300), not less the 910 it spent.
  const i = ledger.admit({ site: 'implement', model: 'c', inputTokens: 500, outputTokens: 200 });
  assert.throws(() => ledger.admit({ site: 'review', model: 'd', inputTokens: 1, outputTokens: 1 }), /build pool: 700/);
  ledger.release(i);
  assert.equal(ledger.summary().discoverySpent, 910);
});

test('ledger pools: the build stage may use whatever discovery left unused', () => {
  const ledger = createSpendLedger({ maxTokens: 1000, discoveryShare: 0.3 });
  const t = ledger.admit({ site: 'suggest', model: 'a', inputTokens: 50, outputTokens: 50 });
  ledger.settle(t, { usage: { input_tokens: 50, output_tokens: 50 } });
  assert.ok(ledger.admit({ site: 'implement', model: 'c', inputTokens: 800, outputTokens: 100 }));
});

test('ledger without a share: one pool, as before', () => {
  const ledger = createSpendLedger({ maxTokens: 1000 });
  assert.equal(ledger.discoveryCap(), null);
  ledger.admit({ site: 'suggest', model: 'a', inputTokens: 500, outputTokens: 400 });
  assert.throws(() => ledger.admit({ site: 'implement', model: 'b', inputTokens: 100, outputTokens: 50 }), /max_generation_tokens/);
});

test('ledger: cached reads count toward the cap at a tenth, and the raw totals are kept', () => {
  const ledger = createSpendLedger({ maxTokens: 2000000 });
  // Hospital of the Future generation 022's shape: 2,361,856 of 2,362,015 input tokens were cache reads.
  ledger.record({ site: 'suggest', model: 'q', provider: 'qwen', usage: { prompt_tokens: 2362015, completion_tokens: 1000, prompt_tokens_details: { cached_tokens: 2361856 } } });
  const s = ledger.summary();
  assert.equal(s.totalTokens, 2363015);
  assert.equal(s.costTokens, Math.round(159 + 236185.6 + 1000));
  assert.equal(ledger.total(), s.costTokens);
});

test('ledger: a reported input far above the request\'s own estimate is flagged implausibleUsage', () => {
  const ledger = createSpendLedger();
  const t = ledger.admit({ site: 'suggest', model: 'pre-mock', provider: 'qwen', inputTokens: 300000, outputTokens: 1000 });
  ledger.settle(t, { usage: { prompt_tokens: 1240542, completion_tokens: 1000 } });
  const ok = ledger.admit({ site: 'suggest', model: 'real', provider: 'anthropic', inputTokens: 300000, outputTokens: 1000 });
  ledger.settle(ok, { usage: { input_tokens: 310000, output_tokens: 1000 } });
  const s = ledger.summary();
  assert.deepEqual(s.implausibleUsage, [{ site: 'suggest', model: 'pre-mock', provider: 'qwen', reportedInputTokens: 1240542, estimatedInputTokens: 300000 }]);
});

test('affordableFanOut: how many suggesters a pool can hold, prompt plus output allowance each', async () => {
  const { affordableFanOut } = await import('../../harness/lib/spend.mjs');
  assert.deepEqual(affordableFanOut({ promptChars: 300000, outputTokens: 32000, models: 5, pool: 800000 }), { affordable: 5, perModel: 132000 });
  assert.equal(affordableFanOut({ promptChars: 1200000, outputTokens: 32000, models: 5, pool: 800000 }).affordable, 1);
  assert.equal(affordableFanOut({ promptChars: 3000000, outputTokens: 32000, models: 5, pool: 800000 }).affordable, 0);
  assert.equal(affordableFanOut({ promptChars: 3000000, outputTokens: 32000, models: 5, pool: null }).affordable, 5);
});
