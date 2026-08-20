import { registerProvider } from '../lib/llm-provider.mjs';

registerProvider('google', {
  pattern: /^(gemini|palm|text-bison)/i,
  envKey: 'GOOGLE_API_KEY',
  hostname: 'generativelanguage.googleapis.com',
  truncationReasons: ['MAX_TOKENS'],
  // Google puts the model in the URL and the key in the query string.
  path: ({ model, key }) =>
    `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
  headers: () => ({}),
  listModels: {
    path: (key) => `/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`,
    // Google exposes no creation timestamp, but does declare which methods a
    // model supports — a stronger filter than name matching. It also,
    // unlike every other provider here, reports the model's real context
    // window (inputTokenLimit) in this listing — no other lab's /models
    // endpoint carries this, so it's captured only here rather than assumed
    // for providers that never actually send it. See checkContextFit() in
    // probe-models.mjs for how this is used: to skip a candidate whose
    // window plainly cannot fit the real prompt, never to guess one.
    parseModels: (data) =>
      (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({
          id: m.name.split('/').pop(),
          created: 0,
          contextWindow: Number.isFinite(m.inputTokenLimit) ? m.inputTokenLimit : null,
        })),
  },
  body: ({ system, user, maxTokens, images }) => ({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{
      role: 'user',
      parts: [
        ...images.map((img) => ({ inlineData: { mimeType: img.mime, data: img.data } })),
        { text: user },
      ],
    }],
    generationConfig: { maxOutputTokens: maxTokens },
  }),
  parse: (data) => {
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    return {
      text: parts.map((p) => p.text ?? '').join(''),
      stopReason: candidate?.finishReason ?? null,
      blockTypes: ['text'],
      usage: data.usageMetadata ?? null,
    };
  },
});
