import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnfixable, mergeUnfixable } from '../../harness/lib/unfixable-models.mjs';

test('isUnfixable: matches on the (provider, id) PAIR, never the bare id', () => {
  // The same id string can legitimately exist under two providers — a lab's
  // own model versus a reseller's listing of it. A bare-id match would
  // wrongly suppress a genuinely different candidate elsewhere.
  const snapshot = {
    _unfixable: [{ id: 'kimi/kimi-k3', provider: 'qwen', reason: 'product not activated' }],
  };
  assert.equal(isUnfixable(snapshot, 'qwen', 'kimi/kimi-k3'), true);
  assert.equal(isUnfixable(snapshot, 'moonshot', 'kimi/kimi-k3'), false);
  assert.equal(isUnfixable(snapshot, 'qwen', 'kimi-k3'), false);
});

test('isUnfixable: a snapshot with no _unfixable key is handled', () => {
  assert.equal(isUnfixable({}, 'qwen', 'anything'), false);
  assert.equal(isUnfixable({ _unfixable: [] }, 'qwen', 'anything'), false);
  assert.equal(isUnfixable(null, 'qwen', 'anything'), false);
});

test('mergeUnfixable: records a diagnosis with its provenance', () => {
  const merged = mergeUnfixable(
    {},
    [{ id: 'kimi/kimi-k3', provider: 'qwen', reason: 'product not activated' }],
    '021',
    () => new Date('2026-09-01T00:00:00Z')
  );
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], {
    id: 'kimi/kimi-k3',
    provider: 'qwen',
    reason: 'product not activated',
    diagnosedGeneration: '021',
    diagnosedDate: '2026-09-01',
  });
});

test('mergeUnfixable: re-diagnosing the same pair replaces rather than duplicates', () => {
  const first = mergeUnfixable({}, [{ id: 'm', provider: 'p', reason: 'old' }], '001');
  const second = mergeUnfixable({ _unfixable: first }, [{ id: 'm', provider: 'p', reason: 'new' }], '002');
  assert.equal(second.length, 1);
  assert.equal(second[0].reason, 'new');
  assert.equal(second[0].diagnosedGeneration, '002');
});

test('mergeUnfixable: existing entries for other candidates survive', () => {
  const existing = [{ id: 'a', provider: 'p', reason: 'r' }];
  const merged = mergeUnfixable({ _unfixable: existing }, [{ id: 'b', provider: 'p', reason: 'r2' }], '003');
  assert.deepEqual(merged.map((e) => e.id).sort(), ['a', 'b']);
});

test('mergeUnfixable: nothing diagnosed leaves the list untouched', () => {
  const existing = [{ id: 'a', provider: 'p', reason: 'r' }];
  assert.deepEqual(mergeUnfixable({ _unfixable: existing }, [], '004'), existing);
  assert.deepEqual(mergeUnfixable({ _unfixable: existing }, null, '004'), existing);
});
