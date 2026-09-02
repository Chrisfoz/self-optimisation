import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { getProvider } from '../../harness/lib/llm-provider.mjs';
import { checkReleases } from '../../harness/lib/model-release-detector.mjs';

/* checkReleases() must actually USE model-aliases.mjs and unfixable-models.mjs.
 *
 * Those two modules have their own unit tests, and passing them proves
 * nothing on its own: a perfectly correct library that nothing calls is
 * exactly the shape of bug that survives a review. These tests go through
 * checkReleases() itself, with the catalogue fetch injected.
 */

/** Stands in for a provider's /models response. */
function fetcherReturning(ids) {
  return async () => ({
    status: 'success',
    models: ids.map((id, i) => ({ id, created: 1000 + i })),
  });
}

const KEY = getProvider('qwen').envKey;

function withKey(fn) {
  const had = process.env[KEY];
  process.env[KEY] = 'test-key';
  return fn().finally(() => {
    if (had === undefined) delete process.env[KEY];
    else process.env[KEY] = had;
  });
}

test('a vendor-namespaced re-listing of an already-seen model is not a new release', () =>
  withKey(async () => {
    // The exact case that cost the reference implementation a cycle: the
    // catalogue now also lists kimi-k3 under a vendor prefix.
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: { qwen: ['kimi-k3', 'qwen3-max'] },
      fetchModelsImpl: fetcherReturning(['kimi-k3', 'qwen3-max', 'kimi/kimi-k3']),
    });

    assert.equal(result.hasNewReleases, false, 'a re-listing is not a release');
    assert.deepEqual(result.selectedModels, []);
    // And it says so, rather than dropping it in silence.
    assert.deepEqual(result.results.qwen.seenAsAlias, ['kimi/kimi-k3']);
  }));

test('a genuinely new model alongside a re-listing is still detected', () =>
  withKey(async () => {
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: { qwen: ['kimi-k3'] },
      fetchModelsImpl: fetcherReturning(['kimi-k3', 'kimi/kimi-k3', 'qwen4-max']),
    });

    assert.equal(result.hasNewReleases, true);
    assert.deepEqual(result.selectedModels.map((m) => m.id), ['qwen4-max']);
  }));

test('both forms arriving in the same listing collapse to one candidate', () =>
  withKey(async () => {
    // Neither is "already seen" here, so only same-run deduping catches it.
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: { qwen: ['qwen3-max'] },
      fetchModelsImpl: fetcherReturning(['qwen3-max', 'kimi-k3', 'kimi/kimi-k3']),
    });

    assert.deepEqual(result.selectedModels.map((m) => m.id), ['kimi-k3'], 'the bare form is kept');
    assert.deepEqual(result.results.qwen.aliasDuplicates, [
      { id: 'kimi/kimi-k3', duplicateOf: 'kimi-k3' },
    ]);
  }));

test('a candidate diagnosed unfixable is not re-selected, and says why', () =>
  withKey(async () => {
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: {
        qwen: ['qwen3-max'],
        _unfixable: [{ id: 'kimi/kimi-k4', provider: 'qwen', reason: 'product not activated' }],
      },
      fetchModelsImpl: fetcherReturning(['qwen3-max', 'kimi/kimi-k4']),
    });

    assert.equal(result.hasNewReleases, false);
    assert.deepEqual(result.results.qwen.skippedUnfixable, ['kimi/kimi-k4']);
  }));

test('an unfixable diagnosis for ANOTHER provider does not suppress this one', () =>
  withKey(async () => {
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: {
        qwen: ['qwen3-max'],
        _unfixable: [{ id: 'kimi-k4', provider: 'moonshot', reason: 'no access' }],
      },
      fetchModelsImpl: fetcherReturning(['qwen3-max', 'kimi-k4']),
    });

    assert.equal(result.hasNewReleases, true, 'same id, different provider, different endpoint');
    assert.deepEqual(result.selectedModels.map((m) => m.id), ['kimi-k4']);
  }));

test('_unfixable survives a snapshot rebuild', () =>
  withKey(async () => {
    // The new snapshot is assembled from per-provider results. Without an
    // explicit carry-forward every diagnosis would be erased on the next
    // run, and the candidates would quietly start being retried again.
    const unfixable = [{ id: 'kimi/kimi-k4', provider: 'qwen', reason: 'product not activated' }];
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: { qwen: ['qwen3-max'], _unfixable: unfixable },
      fetchModelsImpl: fetcherReturning(['qwen3-max']),
    });

    assert.deepEqual(result.newSnapshot._unfixable, unfixable);
  }));

test('releaseDetected is reported alongside hasNewReleases', () =>
  withKey(async () => {
    // Both true here. The point of the field is that a later probe step may
    // set hasNewReleases false while this stays true — the difference
    // between "nothing shipped" and "we could not reach what shipped".
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: { qwen: [] },
      fetchModelsImpl: fetcherReturning(['qwen4-max']),
    });

    assert.equal(result.releaseDetected, true);
    assert.equal(result.hasNewReleases, true);
  }));

test('a baseline run records everything and triggers nothing, aliases included', () =>
  withKey(async () => {
    const result = await checkReleases({
      providers: ['qwen'],
      snapshot: {},
      fetchModelsImpl: fetcherReturning(['kimi-k3', 'kimi/kimi-k3']),
    });

    assert.equal(result.releaseDetected, false);
    assert.equal(result.results.qwen.baseline, true);
    assert.deepEqual(result.newSnapshot.qwen, ['kimi-k3', 'kimi/kimi-k3']);
  }));
