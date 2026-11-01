import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('moonshot', {
  pattern: /^(kimi|moonshot)/i,
  // Kimi K3 and K3.1 Pro always reason and default reasoning_effort to
  // "max" (top-level field; "low", "high" and "max" are accepted). That is
  // the same shape that made GLM-5.3 reason past the 10-minute per-request
  // timeout on a full-source prompt and return nothing — see zai.mjs and
  // learning/03-failure-modes.md. A reachability probe's few words cannot
  // surface it; only a real-size call can. "low" is set pre-emptively for
  // Kimi K3.1 Pro rather than after a run is lost to it: it is the value that
  // reliably answers inside a bounded per-request timeout.
  ...openAiCompatible('MOONSHOT_API_KEY', 'api.moonshot.ai', {
    extraBody: { reasoning_effort: 'low' },
  }),
});
