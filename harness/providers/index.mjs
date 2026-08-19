/**
 * Registers every provider this harness ships with. Side-effect-only —
 * import this file once, before the first callModel()/resolveProvider()
 * call, and all nine labs are available.
 *
 * A project that only watches a subset of labs (see project-adapter.yml's
 * `providers.watched`) can import individual files instead of this one —
 * `import '../harness/providers/anthropic.mjs'` registers only Anthropic —
 * so an unused provider costs nothing beyond the file existing.
 *
 * Import order is the pattern-matching fallback order (see
 * llm-provider.mjs's resolveProvider doc for why that fallback rarely
 * matters in practice). This mirrors the order carrotgame's original,
 * single-file PROVIDER_PATTERNS list used.
 */
import './anthropic.mjs';
import './openai.mjs';
import './google.mjs';
import './moonshot.mjs';
import './deepseek.mjs';
import './qwen.mjs';
import './xai.mjs';
import './meta.mjs';
import './zai.mjs';
