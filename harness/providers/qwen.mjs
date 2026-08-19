import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('qwen', {
  // Alibaba ships reasoning and multimodal lines under their own prefixes
  // (QwQ, QVQ) rather than as qwen-* variants.
  pattern: /^(qwen|qwq|qvq)/i,
  // Alibaba serves Qwen through DashScope's OpenAI-compatible mode. The
  // `-intl` host is the one that works outside mainland China; the domestic
  // host rejects international keys with an opaque error — verified live,
  // not inferred from documentation.
  ...openAiCompatible('QWEN_API_KEY', 'dashscope-intl.aliyuncs.com', {
    path: '/compatible-mode/v1/chat/completions',
  }),
});
