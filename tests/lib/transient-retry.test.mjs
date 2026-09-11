import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { callModel, isTransientNetworkError } from '../../harness/lib/llm-provider.mjs';
import { createSpendLedger, withSpend } from '../../harness/lib/spend.mjs';

// One lab lost its proposal to `read ECONNRESET` in both real campaign runs,
// while the same model answered a large request cleanly minutes later. A
// transient failure now gets exactly one more try — metered like any other
// request — and nothing else does.

const OK = { statusCode: 200, raw: JSON.stringify({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) };

function withKey(t) {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
}

const call = (ledger, transport) => withSpend(callModel, ledger, 'suggest')({
  model: 'claude-opus-5', provider: 'anthropic', system: 's', user: 'u', maxTokens: 100, transport, retryDelayMs: 0,
});

test('isTransientNetworkError: connection drops yes; our own timeout and ordinary errors no', () => {
  assert.equal(isTransientNetworkError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientNetworkError(new Error('socket hang up')), true);
  assert.equal(isTransientNetworkError(new Error('Request to api.x timed out after 600000ms')), false);
  assert.equal(isTransientNetworkError(new Error('unparseable JSON')), false);
});

test('a dropped connection is retried once, and both requests are on the ledger', async (t) => {
  withKey(t);
  const ledger = createSpendLedger();
  let n = 0;
  const result = await call(ledger, async () => { n += 1; if (n === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); return OK; });
  assert.equal(result.text, 'hi');
  assert.equal(n, 2);
  assert.deepEqual(ledger.calls.map((c) => Boolean(c.failed)), [true, false]);
  assert.equal(ledger.reservedTokens(), 0);
});

test('an overloaded gateway (529/503) is retried once', async (t) => {
  withKey(t);
  let n = 0;
  const result = await call(createSpendLedger(), async () => (++n === 1 ? { statusCode: 529, raw: '{"error":"overloaded"}' } : OK));
  assert.equal(result.text, 'hi');
  assert.equal(n, 2);
});

test('only once: a second drop fails the call', async (t) => {
  withKey(t);
  let n = 0;
  await assert.rejects(() => call(createSpendLedger(), async () => { n += 1; throw new Error('read ECONNRESET'); }), /ECONNRESET/);
  assert.equal(n, 2);
});

test('a 400 or a 429 is never retried — waiting does not fix a wrong request or a quota', async (t) => {
  withKey(t);
  for (const statusCode of [400, 429]) {
    let n = 0;
    await assert.rejects(() => call(createSpendLedger(), async () => { n += 1; return { statusCode, raw: '{"error":"no"}' }; }));
    assert.equal(n, 1, `status ${statusCode}`);
  }
});

test('the retry is admitted against the budget like any other request', async (t) => {
  withKey(t);
  const ledger = createSpendLedger({ maxTokens: 150 });
  let n = 0;
  // The first request reserves ~100 + its prompt; after it fails (settled at
  // its estimated input), the retry must fit what is left, or be refused.
  await assert.rejects(() => call(ledger, async () => { n += 1; throw new Error('read ECONNRESET'); }), (e) => /ECONNRESET|budget/.test(e.message));
  assert.ok(ledger.total() <= 150);
});
