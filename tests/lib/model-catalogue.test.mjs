import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotModels, bundledModels, buildCatalogue, catalogueModels } from '../../harness/lib/model-catalogue.mjs';

const bundled = {
  fetchedAt: '2026-09-01T00:00:00.000Z',
  labs: {
    anthropic: { models: [{ id: 'claude-opus-5', created: '2026-05-01T00:00:00.000Z' }, { id: 'claude-fable-5-1', created: null }] },
    openai: { models: [{ id: 'gpt-5.5', created: '2026-06-01T00:00:00.000Z' }] },
  },
};

test('snapshotModels reads a real snapshot and ignores the diagnostic ledger', () => {
  assert.deepEqual(
    snapshotModels({
      anthropic: ['claude-opus-5', 'claude-opus-5', ' claude-sirius-6 '],
      openai: ['gpt-6-astra'],
      _unfixable: { openai: { 'gpt-6-astra': { generation: 4 } } },
    }),
    { anthropic: ['claude-opus-5', 'claude-sirius-6'], openai: ['gpt-6-astra'] }
  );
});

test('snapshotModels drops malformed input rather than throwing — a broken snapshot costs the live half, not the page', () => {
  assert.deepEqual(snapshotModels(null), {});
  assert.deepEqual(snapshotModels('nonsense'), {});
  assert.deepEqual(snapshotModels([1, 2]), {});
  assert.deepEqual(snapshotModels({ anthropic: 'claude-opus-5', openai: [''], google: [null, 'gemini-3.8-flash'] }), {
    google: ['gemini-3.8-flash'],
  });
});

test('bundledModels normalises ISO and epoch dates, and survives a missing file', () => {
  const parsed = bundledModels(bundled);
  assert.equal(parsed.fetchedAt, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(parsed.labs.anthropic, [
    { id: 'claude-opus-5', created: Date.parse('2026-05-01T00:00:00.000Z') },
    { id: 'claude-fable-5-1', created: 0 },
  ]);
  assert.deepEqual(bundledModels(null), { fetchedAt: null, labs: {} });
  assert.deepEqual(bundledModels({ labs: { openai: { models: [{ id: 'gpt-6', created: 1756684800000 }] } } }).labs.openai, [
    { id: 'gpt-6', created: 1756684800000 },
  ]);
});

test('a repository snapshot adds live models and flags the ones the bundled list has never seen', () => {
  const catalogue = buildCatalogue({
    bundled,
    snapshot: { anthropic: ['claude-opus-5', 'claude-sirius-6'], moonshot: ['kimi-k4'] },
    snapshotReadAt: '2026-09-12T09:00:00.000Z',
    provider: (name) => ({ envKey: `${name.toUpperCase()}_API_KEY` }),
  });

  assert.deepEqual(catalogue.counts, { bundled: 3, repository: 3, unseen: 1 });
  assert.equal(catalogue.snapshotReadAt, '2026-09-12T09:00:00.000Z');

  const anthropic = catalogue.labs.find((l) => l.name === 'anthropic');
  assert.equal(anthropic.envKey, 'ANTHROPIC_API_KEY');
  // Listed by both sources: one entry, both sources recorded, not "new".
  const opus = anthropic.models.find((m) => m.id === 'claude-opus-5');
  assert.deepEqual(opus.sources, ['bundled', 'repository']);
  assert.equal(opus.unseen, false);
  // Live-only, in a lab we do ship a list for: newer than what we shipped.
  const sirius = anthropic.models.find((m) => m.id === 'claude-sirius-6');
  assert.deepEqual(sirius.sources, ['repository']);
  assert.equal(sirius.unseen, true);

  // A lab absent from the bundled file entirely: present, but no claim is
  // made about it being new — there is nothing to have been newer than.
  const moonshot = catalogue.labs.find((l) => l.name === 'moonshot');
  assert.deepEqual(moonshot.models, [{ id: 'kimi-k4', created: 0, sources: ['repository'], unseen: false }]);
});

test('without a snapshot the bundled list stands alone, dated and ordered newest first', () => {
  const catalogue = buildCatalogue({ bundled });
  assert.equal(catalogue.fetchedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(catalogue.snapshotReadAt, null);
  assert.deepEqual(catalogue.counts, { bundled: 3, repository: 0, unseen: 0 });
  assert.deepEqual(
    catalogue.labs.find((l) => l.name === 'anthropic').models.map((m) => m.id),
    ['claude-opus-5', 'claude-fable-5-1']
  );
  assert.equal(catalogue.labs.find((l) => l.name === 'anthropic').envKey, null);
});

test('catalogueModels flattens every lab, unseen models first, then newest', () => {
  const rows = catalogueModels(
    buildCatalogue({ bundled, snapshot: { openai: ['gpt-6-astra'] } })
  );
  assert.deepEqual(rows.map((m) => `${m.provider}/${m.id}`), [
    'openai/gpt-6-astra',
    'openai/gpt-5.5',
    'anthropic/claude-opus-5',
    'anthropic/claude-fable-5-1',
  ]);
  assert.equal(rows[0].unseen, true);
});

test('an empty everything is an empty catalogue, not a crash', () => {
  const catalogue = buildCatalogue({});
  assert.deepEqual(catalogue.labs, []);
  assert.deepEqual(catalogueModels(catalogue), []);
  assert.deepEqual(catalogueModels(null), []);
});
