import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('deepseek', {
  pattern: /^deepseek/i,
  // Verified live: the catalogue is served bare at /models, not /v1/models
  // like the rest of this factory's default.
  ...openAiCompatible('DEEPSEEK_API_KEY', 'api.deepseek.com', { listModelsPath: '/models' }),
});
