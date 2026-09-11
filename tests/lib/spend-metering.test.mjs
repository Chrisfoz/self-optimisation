import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { createSpendLedger, withSpend } from '../../harness/lib/spend.mjs';
import { callModel, callModelWithHeadroom } from '../../harness/lib/llm-provider.mjs';

// Every underlying request is admitted (reserved) before it is sent and
// settled (recorded) after — see createSpendLedger()'s doc in spend.mjs.

// --- admit / settle / release ----------------------------------------------------

test('admit: refuses a request that spent + in flight + its reservation would push over the cap', () => {
  const ledger = createSpendLedger({ maxTokens: 1000 });
  const a = ledger.admit({ site: 'suggest', model: 'a', inputTokens: 100, outputTokens: 300 });
  const b = ledger.admit({ site: 'suggest', model: 'b', inputTokens: 100, outputTokens: 300 });
  assert.equal(ledger.reservedTokens(), 800);
  // Nothing is SPENT yet — the old check (spent > cap) would have admitted this.
  assert.throws(
    () => ledger.admit({ site: 'suggest', model: 'c', inputTokens: 100, outputTokens: 300 }),
    (e) => e.kind === 'budget' && /in flight/.test(e.message)
  );
  ledger.settle(a, { usage: { input_tokens: 100, output_tokens: 50 } });
  ledger.settle(b, { usage: { input_tokens: 100, output_tokens: 50 } });
  assert.equal(ledger.reservedTokens(), 0);
  assert.equal(ledger.total(), 300);
  assert.equal(ledger.summary().refusedRequests, 1);
});

test('settle is idempotent, and release records nothing', () => {
  const ledger = createSpendLedger();
  const t = ledger.admit({ site: 'review', model: 'm', inputTokens: 10, outputTokens: 10 });
  assert.ok(ledger.settle(t, { usage: { input_tokens: 7, output_tokens: 3 } }));
  assert.equal(ledger.settle(t, { usage: { input_tokens: 999, output_tokens: 999 } }), null);
  const u = ledger.admit({ site: 'review', model: 'm', inputTokens: 10, outputTokens: 10 });
  ledger.release(u);
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.total(), 10);
  assert.equal(ledger.reservedTokens(), 0);
});

test('withSpend: a call is refused before it is made when the cap cannot hold its reservation', async () => {
  const ledger = createSpendLedger({ maxTokens: 5000 });
  let called = false;
  const wrapped = withSpend(async () => { called = true; return { text: 'x' }; }, ledger, 'implement');
  await assert.rejects(() => wrapped({ model: 'm', system: '', user: '', maxTokens: 16000 }), (e) => e.kind === 'budget');
  assert.equal(called, false);
});

test('withSpend: parallel calls each reserve as they start, so a fan-out cannot collectively overshoot', async () => {
  const ledger = createSpendLedger({ maxTokens: 2500 });
  let sent = 0;
  const slow = withSpend(async () => { sent += 1; await new Promise((r) => setTimeout(r, 5)); return { text: 'ok', usage: { input_tokens: 10, output_tokens: 10 } }; }, ledger, 'suggest');
  const settled = await Promise.allSettled([1, 2, 3].map(() => slow({ model: 'm', system: '', user: '', maxTokens: 1000 })));
  assert.deepEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled', 'rejected']);
  assert.equal(settled[2].reason.kind, 'budget');
  assert.equal(sent, 2, 'the third was never sent');
});

// --- headroom retries --------------------------------------------------------------

test('a headroom retry is recorded as its own call: two 200-token calls cost 400, not 200 (confirmed defect)', async () => {
  const ledger = createSpendLedger();
  let n = 0;
  const inner = async () => {
    n += 1;
    return n === 1
      ? { text: 'partial', truncated: true, stopReason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 100 } }
      : { text: 'complete', truncated: false, stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 100 } };
  };
  const call = withSpend((opts) => callModelWithHeadroom(opts, { call: inner }), ledger, 'review');
  const result = await call({ model: 'm', system: 's', user: 'u', maxTokens: 1000 });
  assert.equal(result.text, 'complete');
  assert.equal(n, 2);
  assert.equal(ledger.calls.length, 2);
  assert.equal(ledger.total(), 400);
});

test('a headroom retry reserves its doubled allowance first, and is skipped when the cap cannot hold it', async () => {
  const ledger = createSpendLedger({ maxTokens: 2500 });
  let n = 0;
  const inner = async () => { n += 1; return { text: 'partial', truncated: true, stopReason: 'max_tokens', usage: { input_tokens: 100, output_tokens: 1000 } }; };
  const call = withSpend((opts) => callModelWithHeadroom(opts, { call: inner }), ledger, 'suggest');
  const result = await call({ model: 'm', system: '', user: '', maxTokens: 1000 });
  // 1,100 spent; the retry would reserve 2,000 of output on top: over 2,500.
  assert.equal(n, 1, 'the retry was never sent');
  assert.equal(result.budgetStopped, true);
  assert.equal(result.truncated, true);
  assert.ok(ledger.total() <= 2500);
});

// --- the real callModel, with a fake transport ----------------------------------------

function anthropicReply({ text = 'hi', stop = 'end_turn', input = 100, output = 50 } = {}) {
  return {
    statusCode: 200,
    raw: JSON.stringify({ content: text ? [{ type: 'text', text }] : [], stop_reason: stop, usage: { input_tokens: input, output_tokens: output } }),
  };
}

function withKey(t, value) {
  const prev = process.env.ANTHROPIC_API_KEY;
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = value;
  t.after(() => { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; });
}

test('callModel: every HTTP request is metered — a rejected image request and its text-only retry are two entries', async (t) => {
  withKey(t, 'test-key');
  const ledger = createSpendLedger();
  const sent = [];
  const transport = async (req) => {
    sent.push(req.body);
    return sent.length === 1
      ? { statusCode: 400, raw: '{"error":{"message":"this model does not support image input"}}' }
      : anthropicReply({ input: 300, output: 40 });
  };
  const result = await withSpend(callModel, ledger, 'suggest')({
    model: 'claude-opus-5', provider: 'anthropic', system: 's', user: 'u', maxTokens: 500,
    images: [{ mime: 'image/png', data: 'AAAA' }], transport,
  });
  assert.equal(result.text, 'hi');
  assert.equal(sent.length, 2);
  assert.equal(ledger.calls.length, 2);
  assert.equal(ledger.calls[0].failed, true);
  assert.equal(ledger.calls[0].statusCode, 400);
  assert.deepEqual([ledger.calls[1].inputTokens, ledger.calls[1].outputTokens, ledger.calls[1].estimated], [300, 40, false]);
  assert.equal(ledger.reservedTokens(), 0);
});

test('callModel + headroom through the real stack: truncated then complete records both requests at their real usage', async (t) => {
  withKey(t, 'test-key');
  const ledger = createSpendLedger();
  const maxTokensSeen = [];
  const transport = async (req) => {
    maxTokensSeen.push(req.body.max_tokens);
    return maxTokensSeen.length === 1
      ? anthropicReply({ text: 'VERDICT: APPROVED', stop: 'max_tokens', input: 100, output: 100 })
      : anthropicReply({ text: 'done', input: 100, output: 100 });
  };
  const result = await withSpend(callModelWithHeadroom, ledger, 'review')({
    model: 'claude-opus-5', provider: 'anthropic', system: 's', user: 'u', maxTokens: 1000, transport,
  });
  assert.equal(result.text, 'done');
  assert.deepEqual(maxTokensSeen, [1000, 2000]);
  assert.equal(ledger.total(), 400);
  assert.equal(ledger.calls.filter((c) => !c.estimated).length, 2);
  assert.equal(ledger.reservedTokens(), 0);
});

test('callModel: a response that spent everything on reasoning and returned no text is still recorded at its usage', async (t) => {
  withKey(t, 'test-key');
  const ledger = createSpendLedger();
  const transport = async () => anthropicReply({ text: '', stop: 'max_tokens', input: 50, output: 900 });
  await assert.rejects(() => withSpend(callModel, ledger, 'review')({ model: 'claude-opus-5', provider: 'anthropic', system: 's', user: 'u', maxTokens: 900, transport }), /no text content/);
  assert.equal(ledger.calls.length, 1);
  assert.equal(ledger.total(), 950);
  assert.equal(ledger.calls[0].estimated, false);
});

test('callModel: a missing key releases the reservation and records nothing — nothing was sent', async (t) => {
  withKey(t, undefined);
  const ledger = createSpendLedger();
  await assert.rejects(
    () => withSpend(callModel, ledger, 'rank')({ model: 'claude-opus-5', provider: 'anthropic', system: 's', user: 'u', maxTokens: 100 }),
    /not set/
  );
  assert.equal(ledger.calls.length, 0);
  assert.equal(ledger.reservedTokens(), 0);
});
