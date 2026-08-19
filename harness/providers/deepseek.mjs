import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('deepseek', {
  pattern: /^deepseek/i,
  ...openAiCompatible('DEEPSEEK_API_KEY', 'api.deepseek.com'),
});
