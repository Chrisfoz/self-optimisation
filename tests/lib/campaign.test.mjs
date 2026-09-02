import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { buildCampaignCheck } from '../../harness/lib/campaign.mjs';

test('buildCampaignCheck: resolves each id to its lab and mirrors the detector output shape, stamped campaign', () => {
  const check = buildCampaignCheck('gpt-5, claude-opus-5');
  assert.equal(check.campaign, true);
  assert.equal(check.hasNewReleases, true);
  assert.equal(check.releaseDetected, true);
  assert.deepEqual(check.selectedModels, [{ id: 'gpt-5', provider: 'openai', contextWindow: null }, { id: 'claude-opus-5', provider: 'anthropic', contextWindow: null }]);
  assert.equal(check.selectedModel, 'gpt-5');
  assert.deepEqual(check.unresolved, []);
});

test('buildCampaignCheck: an unresolvable id is reported, and an empty list has nothing new', () => {
  assert.deepEqual(buildCampaignCheck('gpt-5,nonsense-9000').unresolved, ['nonsense-9000']);
  assert.equal(buildCampaignCheck('').hasNewReleases, false);
});
