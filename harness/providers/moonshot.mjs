import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('moonshot', {
  pattern: /^(kimi|moonshot)/i,
  ...openAiCompatible('MOONSHOT_API_KEY', 'api.moonshot.ai'),
});
