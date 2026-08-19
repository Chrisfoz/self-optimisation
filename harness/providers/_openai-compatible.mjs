/**
 * Shared helpers for providers that speak OpenAI's chat-completions dialect.
 * Not a provider itself — nothing here calls registerProvider(). Imported by
 * the provider files that need it (openai.mjs builds its own entry instead
 * of using the factory — see the note in that file for why).
 */

/**
 * OpenAI and OpenAI-compatible APIs share a content shape: a plain string
 * when there are no images, an array of typed parts when there are. Sending
 * the array form with a single text part also works, but the string form is
 * what every older model accepts, so it stays the default.
 */
export const openAiContent = (user, images) =>
  images.length
    ? [
        ...images.map((img) => ({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.data}` },
        })),
        { type: 'text', text: user },
      ]
    : user;

/**
 * Build a provider config for a lab that speaks OpenAI's chat-completions
 * dialect at its own hostname and (usually) its own path. Several labs
 * expose the same request and response shape, differing only in hostname,
 * path and key — Moonshot, DeepSeek, xAI, Alibaba's DashScope (Qwen), Meta's
 * Model API and Zhipu's GLM all verified live against this same factory.
 *
 * They use `max_tokens` rather than OpenAI's own `max_completion_tokens`,
 * which only the reasoning models on api.openai.com require — so
 * providers/openai.mjs keeps a bespoke entry and is deliberately NOT built
 * from this factory.
 *
 * @param {string} envKey    Environment variable holding the API key.
 * @param {string} hostname
 * @param {object} [opts]
 * @param {string} [opts.path]       Request path. Default '/v1/chat/completions'.
 * @param {object} [opts.extraBody]  Extra fields merged into every request body.
 *   A lab-specific escape hatch for fields the shared shape doesn't need
 *   anywhere else (e.g. Zhipu/GLM's forced reasoning-effort controls — see
 *   providers/zai.mjs). Kept as an opt-in on the factory rather than a
 *   special case in the shared body builder, so every other
 *   OpenAI-compatible entry stays untouched.
 * @param {string[]} [opts.truncationReasons]  Default ['length'], the
 *   OpenAI-dialect stop-reason for "ran out of room".
 */
export function openAiCompatible(envKey, hostname, { path = '/v1/chat/completions', extraBody = null, truncationReasons = ['length'] } = {}) {
  return {
    envKey,
    hostname,
    truncationReasons,
    path: () => path,
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ model, system, user, maxTokens, images }) => ({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: openAiContent(user, images) },
      ],
      max_tokens: maxTokens,
      ...extraBody,
    }),
    parse: (data) => {
      const choice = data.choices?.[0];
      return {
        text: choice?.message?.content ?? '',
        stopReason: choice?.finish_reason ?? null,
        blockTypes: ['text'],
        usage: data.usage ?? null,
      };
    },
  };
}
