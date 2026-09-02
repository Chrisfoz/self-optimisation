import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalModelId,
  aliasKey,
  isKnownAlias,
  dedupeAliases,
  aliasDuplicates,
} from '../../harness/lib/model-aliases.mjs';

// The bug these lock out cost the reference implementation a full cycle:
// DashScope re-listed Moonshot's Kimi K3 as `kimi/kimi-k3`, the detector
// compared id strings, and a model that had already been merged four
// generations earlier was selected as that month's new release.

test('canonicalModelId: strips exactly one vendor prefix', () => {
  assert.equal(canonicalModelId('kimi/kimi-k3'), 'kimi-k3');
  assert.equal(canonicalModelId('ZHIPU/GLM-5.3'), 'GLM-5.3');
});

test('canonicalModelId: leaves anything that is not the observed convention alone', () => {
  assert.equal(canonicalModelId('qwen3.8-max'), 'qwen3.8-max');
  // A dated snapshot id is a DIFFERENT model, not an alias of the base id.
  assert.equal(canonicalModelId('qwen3.8-max-0902'), 'qwen3.8-max-0902');
  assert.equal(canonicalModelId('a/b/c'), 'a/b/c');
  assert.equal(canonicalModelId('/kimi-k3'), '/kimi-k3');
  assert.equal(canonicalModelId('kimi/'), 'kimi/');
});

test('canonicalModelId: a non-string is returned as-is rather than throwing', () => {
  assert.equal(canonicalModelId(null), null);
  assert.equal(canonicalModelId(undefined), undefined);
});

test('aliasKey: folds case, because real catalogues mix it', () => {
  // DashScope ships ZHIPU/GLM-5.3 alongside lowercase glm-5.2.
  assert.equal(aliasKey('ZHIPU/GLM-5.3'), aliasKey('glm-5.3'));
  assert.equal(aliasKey('kimi/kimi-k3'), aliasKey('kimi-k3'));
  assert.notEqual(aliasKey('glm-5.2'), aliasKey('glm-5.3'));
});

test('isKnownAlias: a namespaced re-listing of an already-seen model is not new', () => {
  const seen = ['glm-5.1', 'glm-5.2', 'kimi-k3', 'qwen3.8-max', 'ZHIPU/GLM-5.3'];
  assert.equal(isKnownAlias('kimi/kimi-k3', seen), true);
  assert.equal(isKnownAlias('qwen3.8-max-0902', seen), false);
  assert.equal(isKnownAlias('kimi/kimi-k4', seen), false);
});

test('isKnownAlias: canonicalises BOTH sides, so the mirrored case is caught too', () => {
  // The seen-list itself holds the namespaced form; the bare id arrives later.
  // Normalising only the incoming id would let this through as "new".
  assert.equal(isKnownAlias('glm-5.3', ['ZHIPU/GLM-5.3']), true);
});

test('isKnownAlias: an empty or missing seen-list is handled', () => {
  assert.equal(isKnownAlias('kimi-k3', []), false);
  assert.equal(isKnownAlias('kimi-k3', null), false);
});

test('dedupeAliases: both forms in one listing collapse to the bare id', () => {
  const kept = dedupeAliases([
    { id: 'kimi/kimi-k3', created: 200 },
    { id: 'kimi-k3', created: 100 },
    { id: 'qwen3.8-max-0902', created: 300 },
  ]);
  assert.deepEqual(kept.map((m) => m.id).sort(), ['kimi-k3', 'qwen3.8-max-0902']);
});

test('dedupeAliases: the bare form wins regardless of listing order', () => {
  // A rule that only works when the bare id happens to arrive second is a
  // coin-flip in production.
  const forward = dedupeAliases([{ id: 'kimi/kimi-k3' }, { id: 'kimi-k3' }]);
  const reverse = dedupeAliases([{ id: 'kimi-k3' }, { id: 'kimi/kimi-k3' }]);
  assert.deepEqual(forward.map((m) => m.id), ['kimi-k3']);
  assert.deepEqual(reverse.map((m) => m.id), ['kimi-k3']);
});

test('dedupeAliases: a namespaced id with no bare twin is KEPT, not dropped', () => {
  // Silently losing a real candidate is the failure this module exists to
  // prevent, not to introduce.
  assert.equal(dedupeAliases([{ id: 'kimi/kimi-k4' }]).length, 1);
});

test('dedupeAliases: candidate objects pass through intact', () => {
  const [kept] = dedupeAliases([{ id: 'kimi-k3', created: 100, provider: 'qwen' }]);
  assert.equal(kept.provider, 'qwen');
  assert.equal(kept.created, 100);
});

test('dedupeAliases: empty and nullish inputs are handled', () => {
  assert.deepEqual(dedupeAliases([]), []);
  assert.deepEqual(dedupeAliases(null), []);
});

test('aliasDuplicates: reports what was collapsed, so nothing vanishes silently', () => {
  const dropped = aliasDuplicates([{ id: 'kimi/kimi-k3' }, { id: 'kimi-k3' }, { id: 'glm-5.4' }]);
  assert.deepEqual(dropped, [{ id: 'kimi/kimi-k3', duplicateOf: 'kimi-k3' }]);
});

test('aliasDuplicates: nothing to collapse reports nothing', () => {
  assert.deepEqual(aliasDuplicates([{ id: 'kimi-k3' }]), []);
});
