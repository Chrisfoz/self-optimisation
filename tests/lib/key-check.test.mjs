import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BALANCE_CHECKS, classifyKey, summarise, formatLine } from '../../harness/lib/key-check.mjs';

const SECRET = 'sk-ant-secret-value-nobody-should-see';

test('classifyKey: a key that lists models is ok, and carries the count', () => {
  const r = classifyKey({
    provider: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    key: SECRET,
    listing: { status: 'success', models: [{ id: 'a' }, { id: 'b' }] },
  });
  assert.equal(r.state, 'ok');
  assert.equal(r.models, 2);
});

test('classifyKey: no key at all is "missing", not a failure', () => {
  const r = classifyKey({ provider: 'zai', envKey: 'ZAI_API_KEY', key: undefined, listing: null });
  assert.equal(r.state, 'missing');
  assert.match(r.detail, /ZAI_API_KEY is not set/);
});

test('classifyKey: a key that is set but EMPTY is its own state, and says why', () => {
  // The real case: --env-file keeps the last assignment, so a duplicate line
  // with nothing after the `=` silently blanks a working key above it.
  for (const blank of ['', '   ']) {
    const r = classifyKey({ provider: 'sendgrid', envKey: 'SENDGRID_API_KEY', key: blank, listing: null });
    assert.equal(r.state, 'blank', JSON.stringify(blank));
    assert.match(r.detail, /duplicate line/);
  }
});

test('classifyKey: a present key the lab refused is "rejected", with the lab reason', () => {
  const r = classifyKey({
    provider: 'google',
    envKey: 'GOOGLE_API_KEY',
    key: SECRET,
    listing: { status: 'error', reason: 'HTTP 401' },
  });
  assert.equal(r.state, 'rejected');
  assert.equal(r.detail, 'HTTP 401');
});

test('classifyKey: a present key with no reason given still rejects, rather than passing by default', () => {
  const r = classifyKey({ provider: 'meta', envKey: 'META_API_KEY', key: SECRET, listing: { status: 'error' } });
  assert.equal(r.state, 'rejected');
  assert.match(r.detail, /did not accept/);
});

test('summarise: only a present key that does not work fails the check', () => {
  const ok = { state: 'ok' };
  assert.equal(summarise([ok, ok, { state: 'missing' }]).code, 0, 'a lab you simply do not use is fine');
  assert.equal(summarise([ok, { state: 'rejected' }]).code, 1);
  assert.equal(summarise([ok, { state: 'blank' }]).code, 1, 'a blank key is a typo that looks like a choice');
  const s = summarise([ok, ok, { state: 'rejected' }, { state: 'blank' }, { state: 'missing' }]);
  assert.deepEqual({ ok: s.ok, failed: s.failed, blank: s.blank, missing: s.missing }, { ok: 2, failed: 1, blank: 1, missing: 1 });
});

test('formatLine: never prints the key, in any state', () => {
  const states = [
    classifyKey({ provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', key: SECRET, listing: { status: 'success', models: [{ id: 'x' }] } }),
    classifyKey({ provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', key: SECRET, listing: { status: 'error', reason: 'HTTP 401' } }),
    classifyKey({ provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', key: '', listing: null }),
    classifyKey({ provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY', key: undefined, listing: null }),
  ];
  for (const r of states) {
    const line = formatLine(r, '12.00 USD');
    assert.doesNotMatch(line, /secret-value/, `leaked in state ${r.state}`);
    assert.ok(!line.includes(SECRET), `leaked in state ${r.state}`);
  }
});

test('formatLine: a balance is shown only when there is one, and the count is pluralised', () => {
  const one = classifyKey({ provider: 'deepseek', envKey: 'DEEPSEEK_API_KEY', key: SECRET, listing: { status: 'success', models: [{ id: 'x' }] } });
  assert.match(formatLine(one, '18.88 USD'), /1 model · balance: 18\.88 USD/);
  assert.match(formatLine(one, null), /1 model$/);
  const many = classifyKey({ provider: 'openai', envKey: 'OPENAI_API_KEY', key: SECRET, listing: { status: 'success', models: [{ id: 'x' }, { id: 'y' }] } });
  assert.match(formatLine(many, null), /2 models$/);
});

test('BALANCE_CHECKS: each parser reads its lab real shape, and degrades to null rather than guessing', () => {
  assert.equal(
    BALANCE_CHECKS.deepseek.parse({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '18.88' }] }),
    '18.88 USD',
  );
  assert.equal(BALANCE_CHECKS.moonshot.parse({ data: { available_balance: 22.64 } }), '22.64');

  // A lab that changes this endpoint must not turn a working key into a crash
  // or an invented number.
  for (const [lab, junk] of [
    ['deepseek', {}], ['deepseek', { balance_infos: [] }], ['deepseek', { balance_infos: [{ currency: 'USD' }] }],
    ['moonshot', {}], ['moonshot', { data: {} }],
  ]) {
    assert.equal(BALANCE_CHECKS[lab].parse(junk), null, `${lab} ${JSON.stringify(junk)}`);
  }
});

test('BALANCE_CHECKS: only labs that expose a balance to an ORDINARY key are listed', () => {
  // Anthropic and OpenAI report spend to an admin key only, which a harness
  // installation has no business holding. Absent on purpose.
  assert.deepEqual(Object.keys(BALANCE_CHECKS).sort(), ['deepseek', 'moonshot']);
});
