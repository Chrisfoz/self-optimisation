import { registerProvider } from '../lib/llm-provider.mjs';

registerProvider('anthropic', {
  pattern: /^(claude|anthropic\.)/i,
  envKey: 'ANTHROPIC_API_KEY',
  hostname: 'api.anthropic.com',
  truncationReasons: ['max_tokens'],
  path: () => '/v1/messages',
  headers: (key) => ({
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  }),
  // Catalogue listing, for the model-release detector. Same hostname and
  // auth headers as a real call — see getProvider() in llm-provider.mjs for
  // why this lives here rather than a second, separate registry.
  listModels: {
    path: () => '/v1/models',
    // created_at is an ISO timestamp.
    parseModels: (data) => data.data.map((m) => ({ id: m.id, created: Date.parse(m.created_at) || 0 })),
  },
  body: ({ model, system, user, maxTokens, images }) => ({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{
      role: 'user',
      content: images.length
        ? [
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mime, data: img.data },
            })),
            { type: 'text', text: user },
          ]
        : user,
    }],
    // NOTE: `thinking` is deliberately omitted rather than set explicitly.
    // This has to run on models that do not exist yet. Omitting the field is
    // valid on every Claude model: newer models run adaptive thinking by
    // default, older ones simply run without it. Sending an explicit
    // thinking config that a given model doesn't recognise 400s; omission is
    // the only safe default across a model line you don't control the
    // roadmap of.
    //
    // `temperature` is likewise omitted: some models in this family reject
    // it outright, and it isn't worth the 400 risk for a parameter this
    // pipeline never needed.
  }),
  parse: (data) => {
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    return {
      text,
      stopReason: data.stop_reason ?? null,
      blockTypes: blocks.map((b) => b.type),
      usage: data.usage ?? null,
    };
  },
});
