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
