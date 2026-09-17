import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs'; // resolveProvider() needs providers registered — each test file runs isolated
import { checkContextFit, probeCandidates, pinnedSeats, probePinnedSeats } from '../../harness/lib/probe-models.mjs';

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

// --- pinned seats ------------------------------------------------------------
// The first real GitHub run spent ~900k tokens before discovering the pinned
// implementer's account had no credit. The probe now asks those seats too.

const roles = (over = {}) => ({ implementModel: null, reviewModel: null, rankModel: null, implementProvider: null, reviewProvider: null, rankProvider: null, ...over });

test('pinnedSeats: implement and review default as run-generation does, and share one probe when they match', () => {
  const seats = pinnedSeats({ roles: roles() });
  assert.deepEqual(seats, [{ seats: ['implement', 'review'], model: 'claude-opus-5', provider: null }]);
});

test('pinnedSeats: a named ranker and a configured digest writer are included; an auto-picked ranker and no email are not', () => {
  const withAll = pinnedSeats({
    roles: roles({ reviewModel: 'gpt-6-astra', rankModel: 'gemini-3.8-flash' }),
    notify: { recipient: 'a@b.c', digestModel: 'claude-sonnet-5' },
  });
  assert.deepEqual(withAll.map((s) => `${s.model}:${s.seats.join('+')}`), [
    'claude-opus-5:implement', 'gpt-6-astra:review', 'gemini-3.8-flash:rank', 'claude-sonnet-5:digest',
  ]);
  const bare = pinnedSeats({ roles: roles(), notify: null });
  assert.ok(!bare.some((s) => s.seats.includes('rank') || s.seats.includes('digest')));
});

test('pinnedSeats: the environment overrides run-generation.mjs honours are honoured here too', () => {
  const seats = pinnedSeats({ roles: roles({ implementModel: 'claude-opus-5' }), env: { IMPLEMENT_MODEL: 'gpt-6-astra' } });
  assert.equal(seats[0].model, 'gpt-6-astra');
});

test('probePinnedSeats: returns only the seats that failed, with the reason', async () => {
  const seats = [
    { seats: ['implement', 'review'], model: 'claude-opus-5', provider: null },
    { seats: ['digest'], model: 'gpt-6-astra', provider: null },
  ];
  const prober = async ({ model }) => {
    if (model === 'claude-opus-5') throw new Error('anthropic API error 400: Your credit balance is too low');
    return { text: 'OK' };
  };
  const blocked = await probePinnedSeats(seats, prober);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].model, 'claude-opus-5');
  assert.equal(blocked[0].provider, 'anthropic', 'resolved from the id when not named');
  assert.match(blocked[0].reason, /credit balance/);
});
