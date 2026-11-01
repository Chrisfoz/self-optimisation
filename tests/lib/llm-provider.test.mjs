import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../../harness/providers/index.mjs';
import { resolveProvider, registeredProviders, pinModelProvider, pinnedModelProvider, __testing } from '../../harness/lib/llm-provider.mjs';

// Real model ids pulled from the reference implementation's own generation
// log — see SELF-IMPROVEMENT.md in the reference implementation. Resolving
// each to the correct lab is the one thing this module must never get wrong:
// sending a model id to the wrong provider returns a confusing 404 rather
// than a useful error.
test('resolveProvider resolves real-world model ids to the correct lab', () => {
  const cases = [
    ['claude-opus-5', 'anthropic'],
    ['gpt-5.6-luna', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-3.7-flash', 'google'],
    ['kimi-k3', 'moonshot'],
    ['deepseek-v4-pro', 'deepseek'],
    ['qwen3-max', 'qwen'],
    ['qwq-32b', 'qwen'],
    ['grok-4.6', 'xai'],
    ['muse-spark-1', 'meta'],
    ['glm-5.3', 'zai'],
  ];
  for (const [id, expected] of cases) {
    assert.equal(resolveProvider(id), expected, `${id} should resolve to ${expected}`);
  }
});

test('resolveProvider throws rather than guessing on an unrecognised id', () => {
  assert.throws(() => resolveProvider('mystery-model-1'), /Cannot resolve a provider/);
});

// The seat-flexibility path: a model whose name no pattern was written for
// is exactly the case this harness exists to handle, and before pinning
// existed it could not fill a seat at all without someone editing a regex.
test('a pinned model id resolves to the lab it was pinned to, whatever its name', () => {
  assert.throws(() => resolveProvider('atlas-1'), /Cannot resolve a provider/);
  pinModelProvider('atlas-1', 'openai');
  assert.equal(resolveProvider('atlas-1'), 'openai');
  assert.equal(pinnedModelProvider('atlas-1'), 'openai');
});

test('a pin beats the pattern table, and is case-insensitive like a real catalogue', () => {
  // A lab re-listing another lab's model is a real case (model-aliases.mjs);
  // the pattern would send this to Anthropic, and the pin must win.
  pinModelProvider('claude-opus-5-via-reseller', 'zai');
  assert.equal(resolveProvider('CLAUDE-OPUS-5-VIA-RESELLER'), 'zai');
  assert.equal(pinnedModelProvider('claude-OPUS-5-via-Reseller'), 'zai');
});

test('pinning to a lab this harness cannot call fails loudly, at startup', () => {
  assert.throws(() => pinModelProvider('atlas-2', 'not-a-lab'), /no provider is registered/);
  assert.throws(() => pinModelProvider('', 'openai'), /Invalid model id/);
  assert.equal(pinnedModelProvider('atlas-2'), null);
  assert.equal(pinnedModelProvider(null), null);
});

test('resolveProvider rejects a non-string model id', () => {
  assert.throws(() => resolveProvider(null));
  assert.throws(() => resolveProvider(undefined));
});

test('registerProvider refuses to double-register the same name', async () => {
  const { registerProvider } = await import('../../harness/lib/llm-provider.mjs');
  assert.throws(() => registerProvider('anthropic', {}), /already registered/);
});

test('all nine reference providers are registered', () => {
  const names = registeredProviders();
  for (const expected of ['anthropic', 'openai', 'google', 'moonshot', 'deepseek', 'qwen', 'xai', 'meta', 'zai']) {
    assert.ok(names.includes(expected), `expected ${expected} to be registered`);
  }
});

test('anthropic body shape: text-only user content, max_tokens set', () => {
  const anth = __testing.PROVIDERS.anthropic;
  const body = anth.body({ model: 'claude-opus-5', system: 'sys', user: 'hi', maxTokens: 100, images: [] });
  assert.equal(body.messages[0].content, 'hi');
  assert.equal(body.max_tokens, 100);
});

test('openai body shape uses max_completion_tokens, and the legacy retry swaps it for max_tokens', () => {
  const oai = __testing.PROVIDERS.openai;
  const body = oai.body({ model: 'gpt-5', system: 'sys', user: 'hi', maxTokens: 50, images: [] });
  assert.equal(body.max_completion_tokens, 50);

  const adjusted = oai.retryWithAdjustedBody({
    statusCode: 400,
    raw: 'Unrecognized request argument supplied: max_completion_tokens',
    body,
  });
  assert.ok(adjusted, 'expected a retry body');
  assert.equal(adjusted.max_tokens, 50);
  assert.equal('max_completion_tokens' in adjusted, false);
});

test('openai retry hook declines when the failure is unrelated', () => {
  const oai = __testing.PROVIDERS.openai;
  const adjusted = oai.retryWithAdjustedBody({ statusCode: 500, raw: 'internal error', body: {} });
  assert.equal(adjusted, null);
});

test('moonshot sends reasoning_effort "low", and no other OpenAI-compatible lab inherits it', async () => {
  const { getProvider } = await import('../../harness/lib/llm-provider.mjs');
  const args = { model: 'kimi-k3.1-pro', system: 's', user: 'u', maxTokens: 9, images: [] };
  const body = getProvider('moonshot').body(args);
  assert.equal(body.reasoning_effort, 'low', 'Kimi defaults to "max", which can reason past the per-request timeout');
  assert.equal('thinking' in body, false, 'the thinking field is Z.ai-specific');
  for (const lab of ['deepseek', 'xai', 'qwen']) {
    assert.equal('reasoning_effort' in getProvider(lab).body(args), false, `${lab} should be untouched`);
  }
});
