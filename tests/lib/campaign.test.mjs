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

// `lab:model-id`. The case this exists for is real: DashScope (`qwen`) serves
// `deepseek-v4.1-flash` and deepseek.com does not, while the `/^deepseek/i`
// pattern would send it to deepseek.com and lose a reachability probe
// finding that out.
test('buildCampaignCheck: an entry may name the lab that serves it, overriding the id pattern', () => {
  const check = buildCampaignCheck('qwen:deepseek-v4.1-flash');
  assert.deepEqual(check.selectedModels, [
    { id: 'deepseek-v4.1-flash', provider: 'qwen', contextWindow: null },
  ]);
  assert.equal(check.selectedProvider, 'qwen');
  assert.deepEqual(check.unresolved, []);
  // Without the prefix the same id goes to the lab its name implies.
  assert.equal(buildCampaignCheck('deepseek-v4.1-flash').selectedModels[0].provider, 'deepseek');
});

test('buildCampaignCheck: a named lab is used verbatim or refused — never silently re-resolved', () => {
  // An unregistered lab must NOT fall back to the pattern table: falling back
  // would send the run to the endpoint the caller just said was wrong.
  assert.deepEqual(buildCampaignCheck('nosuchlab:deepseek-v4.1-flash').unresolved, ['nosuchlab:deepseek-v4.1-flash']);
  assert.deepEqual(buildCampaignCheck('qwen:').unresolved, ['qwen:']);
  // A leading colon names no lab, so it is an ordinary (here, unresolvable) id.
  assert.deepEqual(buildCampaignCheck(':gpt-5').unresolved, [':gpt-5']);
});

test('buildCampaignCheck: named and unnamed entries mix in one campaign', () => {
  const check = buildCampaignCheck('gemini-3.8-flash, qwen:deepseek-v4.1-flash');
  assert.deepEqual(check.selectedModels.map((m) => `${m.provider}/${m.id}`), [
    'google/gemini-3.8-flash',
    'qwen/deepseek-v4.1-flash',
  ]);
});
