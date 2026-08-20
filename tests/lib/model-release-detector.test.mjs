import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { getProvider, registeredProviders } from '../../harness/lib/llm-provider.mjs';
import { isChatModel, rankCandidates, checkReleases } from '../../harness/lib/model-release-detector.mjs';

test('isChatModel: excludes known non-chat families by name', () => {
  assert.equal(isChatModel('claude-opus-5'), true);
  assert.equal(isChatModel('text-embedding-3-large'), false);
  assert.equal(isChatModel('whisper-1'), false);
  assert.equal(isChatModel('dall-e-3'), false);
  assert.equal(isChatModel('gpt-4o-realtime-preview'), false);
  assert.equal(isChatModel('gpt-3.5-turbo-instruct'), false);
});

test('isChatModel: short exclusion tokens only match whole segments, not substrings', () => {
  // 'ada' must not falsely exclude a real id that merely contains it.
  assert.equal(isChatModel('kimi-k3-adaptive'), true);
  // but a bare "ada" segment (the old text-ada-* embedding family) is excluded.
  assert.equal(isChatModel('text-ada-001'), false);
});

test('rankCandidates: newest first, ties fall to descending id sort', () => {
  const ranked = rankCandidates([
    { id: 'model-old', created: 1000 },
    { id: 'model-new', created: 5000 },
    { id: 'model-tie-b', created: 0 },
    { id: 'model-tie-a', created: 0 },
  ]);
  assert.deepEqual(ranked.map((m) => m.id), ['model-new', 'model-old', 'model-tie-b', 'model-tie-a']);
});

// Fixtures shaped like each lab's real /models response, captured from the
// reference implementation's provider config comments.
const FIXTURES = {
  anthropic: { data: [{ id: 'claude-opus-5', created_at: '2026-06-01T00:00:00Z' }] },
  openai: { data: [{ id: 'gpt-5.6-luna', created: 1750000000 }] },
  google: {
    models: [
      { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'], inputTokenLimit: 1000000 },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ],
  },
  moonshot: { data: [{ id: 'kimi-k3', created: 1750000000 }] },
  deepseek: { data: [{ id: 'deepseek-v4-pro' }] }, // no `created` — matches the real API
  qwen: { data: [{ id: 'qwen3-max', created: 1750000000 }] },
  xai: { data: [{ id: 'grok-4.6', created: 1750000000 }] },
  meta: { data: [{ id: 'muse-spark-1.2', created: 1750000000 }] },
  zai: { data: [{ id: 'glm-5.3', created: 1750000000, owned_by: 'z-ai' }] },
};

test('every registered provider carries a listModels config that parses its real fixture shape', () => {
  for (const name of registeredProviders()) {
    const p = getProvider(name);
    assert.ok(p.hostname, `${name} should have a hostname`);
    assert.ok(p.listModels, `${name} should have listModels`);
    assert.equal(typeof p.listModels.path, 'function');
    assert.equal(typeof p.listModels.parseModels, 'function');

    const parsed = p.listModels.parseModels(FIXTURES[name]);
    assert.ok(Array.isArray(parsed) && parsed.length > 0, `${name}: parseModels should return at least one model`);

    const url = p.listModels.path('FAKEKEY');
    assert.ok(typeof url === 'string' && url.startsWith('/'), `${name}: listModels.path should return a path string`);
  }
});

test('google: applies a capability filter and carries the context window through', () => {
  const parsed = getProvider('google').listModels.parseModels(FIXTURES.google);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'gemini-3.7-flash');
  assert.equal(parsed[0].contextWindow, 1000000);
});

test('deepseek: a missing `created` field defaults to 0 rather than throwing', () => {
  const parsed = getProvider('deepseek').listModels.parseModels(FIXTURES.deepseek);
  assert.equal(parsed[0].created, 0);
});

test('non-default catalogue paths are exactly right, not assumed from the chat-completions path', () => {
  assert.equal(getProvider('deepseek').listModels.path('k'), '/models');
  assert.equal(getProvider('qwen').listModels.path('k'), '/compatible-mode/v1/models');
  assert.equal(getProvider('zai').listModels.path('k'), '/api/paas/v4/models');
  assert.ok(getProvider('google').listModels.path('SECRET').includes('key=SECRET'));
});

test('checkReleases: every watched provider missing its key reports skipped, not an error', async () => {
  for (const name of registeredProviders()) {
    delete process.env[getProvider(name).envKey];
  }

  const result = await checkReleases({ providers: registeredProviders(), snapshot: {}, maxFanout: 8 });

  assert.equal(result.hasNewReleases, false);
  assert.equal(result.selectedModels.length, 0);
  assert.ok(registeredProviders().every((n) => result.results[n].status === 'skipped'));
  assert.deepEqual(result.newSnapshot, {});
});

test('checkReleases: a prior snapshot survives a provider check that could not run', async () => {
  delete process.env[getProvider('anthropic').envKey];
  const result = await checkReleases({
    providers: ['anthropic'],
    snapshot: { anthropic: ['claude-opus-4', 'claude-sonnet-4'] },
    maxFanout: 8,
  });
  assert.deepEqual(result.newSnapshot.anthropic, ['claude-opus-4', 'claude-sonnet-4']);
});
