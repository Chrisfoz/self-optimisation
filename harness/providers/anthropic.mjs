import { registerProvider } from '../lib/llm-provider.mjs';

/**
 * The user turn as text blocks, with a cache breakpoint after \cachePrefix\`n * when the caller marked one. Everything up to a breakpoint (system prompt
 * included) is written to Anthropic's prompt cache and reread at a tenth of
 * the input price by any request with the same prefix within five minutes.
 * Writing costs 1.25x once. The implementer marks the proposal and source it
 * rereads unchanged on a headroom retry or a refinement: on a large project
 * that is ~380k tokens a time (NetworkinAI generations 002 and 003).
 *
 * A prefix that isn't actually a prefix of \user\ is ignored rather than
 * trusted: a breakpoint in the wrong place would cache nothing useful.
 */
export function userBlocks(user, cachePrefix) {
  if (!cachePrefix || typeof user !== 'string' || !user.startsWith(cachePrefix)) return [{ type: 'text', text: user }];
  const rest = user.slice(cachePrefix.length);
  const cached = { type: 'text', text: cachePrefix, cache_control: { type: 'ephemeral' } };
  return rest ? [cached, { type: 'text', text: rest }] : [cached];
}

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
  body: ({ model, system, user, maxTokens, images, effort = null, cachePrefix = null }) => ({
    model,
    max_tokens: maxTokens,
    // Opt-in, per seat (roles.<seat>.effort). Omitted by default for the same
    // reason as thinking below: this has to run on models that do not exist
    // yet. It matters because thinking counts against max_tokens: on a
    // ~380k-token prompt Opus 5 at its default effort spent a 16k and then a
    // 32k output allowance and never finished the edits (NetworkinAI
    // generation 003, ~1.06M tokens for nothing).
    ...(effort ? { output_config: { effort } } : {}),
    system,
    messages: [{
      role: 'user',
      content: images.length
        ? [
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mime, data: img.data },
            })),
            ...userBlocks(user, cachePrefix),
          ]
        : cachePrefix ? userBlocks(user, cachePrefix) : user,
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
