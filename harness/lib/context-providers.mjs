/**
 * Context providers: project-chosen plugins that add a section of evidence to
 * the suggestion prompt — research notes, a search, a design system, an
 * issue tracker's open bugs. The harness ships the socket and runs nothing
 * a project did not configure.
 *
 * Configured in project-adapter.yml:
 *
 *   context:
 *     providers:
 *       - module: harness/plugins/context/game-references/index.mjs
 *         config: { notes_path: docs/GAME-REFERENCE-PILOT.md }
 *         env: [GAME_REFERENCE_WEB_SEARCH, BRAVE_SEARCH_API_KEY]
 *         max_chars: 12000
 *
 * A plugin's default export is `{ name, async provide({ repoRoot, config,
 * env, log }) }` returning text or null. Same rules as the evaluator
 * plugins, for the same reasons:
 *
 *   - it fails SAFE: a provider that throws, hangs or returns nothing costs
 *     its own section, never the generation;
 *   - it sees only the environment variables it declared, never the lab keys;
 *   - what it returns is fenced as data and capped, because it usually
 *     came from somewhere nobody on the project wrote — a search result, a
 *     README — and goes in the user prompt, never the system prompt.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fenceUntrusted } from './context-pack.mjs';

export const DEFAULT_PROVIDER_MAX_CHARS = 12000;
export const DEFAULT_PROVIDER_TIMEOUT_MS = 30000;

/** context.providers, normalised. Malformed entries are dropped by validate.mjs's warning, not here. */
export function contextProvidersConfig(adapter) {
  const list = Array.isArray(adapter?.context?.providers) ? adapter.context.providers : [];
  return list
    .filter((p) => p && typeof p.module === 'string' && p.module)
    .map((p) => ({
      module: p.module,
      config: p.config && typeof p.config === 'object' ? p.config : {},
      env: Array.isArray(p.env) ? p.env.filter((n) => typeof n === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(n)) : [],
      maxChars: Number.isFinite(p.max_chars) && p.max_chars > 0 ? p.max_chars : DEFAULT_PROVIDER_MAX_CHARS,
    }));
}

/** A provider module must live inside the project: a path that leaves it is refused. */
export async function loadContextProvider({ repoRoot, module: modulePath, importModule = (url) => import(url) }) {
  const root = path.resolve(repoRoot);
  const absolute = path.resolve(root, modulePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new Error(`context provider ${modulePath} is outside the project`);
  const mod = await importModule(pathToFileURL(absolute).href);
  const plugin = mod.default ?? mod;
  if (typeof plugin?.provide !== 'function') throw new Error(`context provider ${modulePath} exports no provide() function`);
  return { name: String(plugin.name || modulePath), provide: plugin.provide };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run every configured provider. Returns the combined, fenced section text,
 * or null when none produced anything — which drops the section.
 */
export async function runContextProviders({ repoRoot, configured, env = process.env, log = () => {}, importModule, timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS }) {
  const sections = [];
  for (const entry of configured) {
    try {
      const plugin = await loadContextProvider({ repoRoot, module: entry.module, importModule });
      const scopedEnv = Object.fromEntries(entry.env.filter((n) => env[n] !== undefined).map((n) => [n, env[n]]));
      const text = await withTimeout(Promise.resolve(plugin.provide({ repoRoot, config: entry.config, env: scopedEnv, log })), timeoutMs);
      if (typeof text !== 'string' || !text.trim()) { log(`   context provider ${plugin.name}: nothing to add`); continue; }
      const capped = text.length > entry.maxChars ? `${text.slice(0, entry.maxChars)}\n[cut at ${entry.maxChars} characters]` : text;
      sections.push(fenceUntrusted(`CONTEXT FROM ${plugin.name.toUpperCase()}`, capped.trim()));
      log(`   context provider ${plugin.name}: ${capped.length.toLocaleString()} chars`);
    } catch (err) {
      log(`   ⚠️  context provider ${entry.module} skipped: ${err.message}`);
    }
  }
  return sections.length ? sections.join('\n\n') : null;
}
