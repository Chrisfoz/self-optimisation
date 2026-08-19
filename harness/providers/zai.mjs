import { registerProvider } from '../lib/llm-provider.mjs';
import { openAiCompatible } from './_openai-compatible.mjs';

registerProvider('zai', {
  // Z.ai (Zhipu) ships everything as glm-*. Matched on the family rather
  // than a version so a later release resolves without another edit here.
  //
  // This one is a genuine guess rather than an identification, and it is
  // the only pattern in this provider set that is. Alibaba's DashScope
  // resells Zhipu's models under the SAME bare ids — the live Qwen
  // catalogue carries glm-* ids alongside its own — so a bare "glm-X.Y"
  // names a model two labs will both serve, and no regex can tell them
  // apart.
  //
  // That is survivable because this pattern table is only ever the
  // fallback. Every id discovered by a real release-detection catalogue
  // arrives carrying the provider it was found in, and correct callers
  // honour that tag before ever calling resolveProvider() — see
  // llm-provider.mjs's resolveProvider doc. The pattern only decides when
  // nobody said, which in practice means a forced/manual override — where
  // Z.ai is the right default, because it is the lab that actually makes
  // these.
  pattern: /^glm/i,
  // Z.ai serves GLM through Zhipu's "paas v4" surface, which is OpenAI's
  // dialect at a non-default path — `/v1/chat/completions` on this host is
  // a bare nginx 404, verified live. There is a second path
  // (`/api/coding/paas/v4/...`) for the coding-plan subscription that
  // serves the same catalogue; the paas path is the general one and is
  // what this uses.
  //
  // extraBody exists here for a reason a trivial "reply OK" reachability
  // probe cannot surface: GLM cannot disable thinking, and defaults
  // reasoning_effort to "max". A prompt carrying full project source can
  // run well over 100k tokens; at the default effort, a real call that size
  // reasoned past a 10-minute per-request timeout and returned nothing —
  // the run died with zero output after burning the full window. The same
  // prompt at reasoning_effort:"low" answered in seconds. "low" is not this
  // model choosing to think less carefully — every GLM release forces
  // thinking on regardless of what is asked — it is the value that reliably
  // gets an answer back inside a bounded per-request timeout. See
  // learning/03-failure-modes.md, "A forced maximum reasoning effort turned
  // a timeout into a silent total loss", for the incident this survived.
  ...openAiCompatible('ZAI_API_KEY', 'api.z.ai', {
    path: '/api/paas/v4/chat/completions',
    extraBody: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
  }),
});
