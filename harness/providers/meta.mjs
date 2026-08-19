import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('meta', {
  // Meta's Model API (api.meta.ai) ships chat models under the muse-* family
  // (muse-spark-*, muse-glimmer, ...) — verified live against the real
  // endpoint, not Meta's separate (and differently-hosted) Llama API.
  // Matched on the whole family rather than one member so a new line
  // resolves instead of silently getting dropped by a reachability probe
  // for "cannot resolve a provider".
  pattern: /^muse-/i,
  // Plain OpenAI chat-completions at the default path — verified live:
  // POST https://api.meta.ai/v1/chat/completions returns the standard
  // {choices:[{message,finish_reason}], usage} envelope.
  ...openAiCompatible('META_API_KEY', 'api.meta.ai'),
});
