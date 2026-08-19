import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('xai', {
  // xAI's ids are grok-*. Distinctive enough that no other lab collides
  // with it.
  pattern: /^grok/i,
  ...openAiCompatible('XAI_API_KEY', 'api.x.ai'),
});
