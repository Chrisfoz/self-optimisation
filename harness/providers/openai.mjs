import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiContent } from './_openai-compatible.mjs';

// Deliberately NOT built from the openAiCompatible() factory in
// _openai-compatible.mjs, even though the shape looks identical. OpenAI's
// own reasoning-tier models reject `max_tokens` and require
// `max_completion_tokens` instead; older chat models are the reverse. The
// retryWithAdjustedBody hook below carries that one-lab quirk without
// forcing the shared factory (used by six other, non-reasoning-quirked
// labs) to know about it.
registerProvider('openai', {
  pattern: /^(gpt|chatgpt|codex|o[0-9])/i,
  envKey: 'OPENAI_API_KEY',
  hostname: 'api.openai.com',
  truncationReasons: ['length'],
  path: () => '/v1/chat/completions',
  headers: (key) => ({ Authorization: `Bearer ${key}` }),
  listModels: {
    path: () => '/v1/models',
    parseModels: (data) => data.data.map((m) => ({ id: m.id, created: (m.created || 0) * 1000 })),
  },
  body: ({ model, system, user, maxTokens, images }) => ({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: openAiContent(user, images) },
    ],
    // Reasoning models reject `max_tokens` and require this field instead.
    // See retryWithAdjustedBody below for the older-model fallback.
    max_completion_tokens: maxTokens,
  }),
  // Older, non-reasoning chat models reject `max_completion_tokens` outright
  // and want the legacy `max_tokens` field. Retry once with the field
  // swapped rather than failing the whole call — this is exactly the named
  // hook registerProvider() documents for a quirk discovered only from a
  // live 4xx.
  retryWithAdjustedBody: ({ statusCode, raw, body }) => {
    if (statusCode !== 400 || !/max_completion_tokens/.test(raw)) return null;
    const legacy = { ...body };
    const maxTokens = legacy.max_completion_tokens;
    delete legacy.max_completion_tokens;
    legacy.max_tokens = maxTokens;
    return legacy;
  },
  parse: (data) => {
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      stopReason: choice?.finish_reason ?? null,
      blockTypes: ['text'],
      usage: data.usage ?? null,
    };
  },
});
