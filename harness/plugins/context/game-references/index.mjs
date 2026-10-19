/**
 * A context provider (harness/lib/context-providers.mjs) for game projects:
 * owner-maintained reference-game research notes, and optionally public
 * GitHub repository metadata and Brave web search snippets about one
 * mechanic. Protocol and safety rules: docs/Game-Reference-Research.md.
 *
 *   context:
 *     providers:
 *       - module: harness/plugins/context/game-references/index.mjs
 *         config:
 *           notes_path: docs/GAME-REFERENCE-PILOT.md   # optional, the default
 *           github_query: "traffic simulation game language:JavaScript"   # optional
 *           web_query: "road safety game vehicle movement"                # optional
 *         env: [GAME_REFERENCE_LIVE_SEARCH, GAME_REFERENCE_WEB_SEARCH, BRAVE_SEARCH_API_KEY]
 *
 * Live searches stay off unless their switch is "true" in the environment;
 * failures of either degrade to the local notes alone.
 */

import {
  loadGameReferences, discoverGameReferences, formatDiscoveredReferences,
  discoverWebGameReferences, formatWebGameReferences,
} from './references.mjs';

export default {
  name: 'game-references',
  // Every variable provide() reads. The shared workflow wires these; a
  // project still lists the ones it uses in its adapter entry's `env`.
  env: ['GAME_REFERENCE_LIVE_SEARCH', 'GAME_REFERENCE_QUERY', 'GAME_REFERENCE_WEB_SEARCH', 'GAME_REFERENCE_WEB_QUERY', 'BRAVE_SEARCH_API_KEY'],
  async provide({ repoRoot, config = {}, env = {}, log = () => {} }) {
    const notes = loadGameReferences({ repoRoot, enabled: true, ...(config.notes_path ? { relativePath: config.notes_path } : {}) });
    const github = await discoverGameReferences({ enabled: env.GAME_REFERENCE_LIVE_SEARCH === 'true', query: config.github_query || env.GAME_REFERENCE_QUERY || '' });
    const web = await discoverWebGameReferences({
      enabled: env.GAME_REFERENCE_WEB_SEARCH === 'true',
      query: config.web_query || env.GAME_REFERENCE_WEB_QUERY || '',
      apiKey: env.BRAVE_SEARCH_API_KEY || '',
    });
    log(`   game references: notes ${notes ? 'loaded' : 'missing'}, GitHub ${github.status}, web ${web.status}`);
    return [notes, formatDiscoveredReferences(github), formatWebGameReferences(web)].filter(Boolean).join('\n') || null;
  },
};
