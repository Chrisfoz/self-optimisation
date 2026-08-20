#!/usr/bin/env node

/**
 * Loads a project's project-adapter.yml — the file that answers "which
 * paths may this project's agent edit, which providers should it watch,
 * what commands must pass" for one specific installation. See
 * examples/carrotgame/project-adapter.yml for a real, worked instance and
 * Portable-Harness-Design.md §5 for the schema this was validated against.
 *
 * THIS IS THE ONLY FILE IN THE HARNESS THAT KNOWS ABOUT YAML. Every other
 * kernel component (llm-provider.mjs, edit-format.mjs,
 * model-release-detector.mjs, probe-models.mjs) takes plain JS objects and
 * has zero npm dependencies — that stays true. `js-yaml` is scoped to this
 * one file on purpose: it is the one place a project's own config has to be
 * parsed from a human-editable format, and everywhere else in the harness
 * should keep working even if this file, or the dependency it needs, is
 * unavailable for some reason. Callers treat a missing or unparseable
 * adapter as "no adapter" (see loadAdapter's return value), not as a fatal
 * error — CLI flags and environment variables remain a complete fallback
 * for every value this file can supply. That's deliberate: a project
 * without a project-adapter.yml yet, or one just trying the harness for the
 * first time, is not blocked from running anything in it.
 */

import fs from 'fs';
import path from 'path';

/**
 * Load and parse a project-adapter.yml.
 *
 * `js-yaml` is imported dynamically, INSIDE this function, after the
 * existence check below — not as a static top-level import. That's not a
 * style choice: a static top-level `import 'js-yaml'` here would make it
 * a hard dependency of every caller of this module, including
 * check-model-releases.mjs, which imports adapter.mjs unconditionally.
 * Every project that never creates a project-adapter.yml — which is a
 * completely valid, supported way to use this harness — would then need
 * `npm install` for a dependency it never actually exercises. Deferring the
 * import until the file is confirmed to exist keeps that promise true: no
 * project-adapter.yml, no dependency on js-yaml being installed, ever.
 *
 * @param {string} [filePath]  Defaults to project-adapter.yml in the
 *   current working directory — the target project's root, the same
 *   assumption harness/scripts/check-model-releases.mjs already makes for
 *   its snapshot file.
 * @returns {Promise<object|null>}  The parsed adapter, or null if the file
 *   doesn't exist. Never throws on a missing file; DOES throw on a file
 *   that exists but fails to parse — a malformed adapter that gets silently
 *   ignored is worse than a loud failure, since a silently-ignored one
 *   falls back to defaults that may be wrong for this specific project in a
 *   way nobody would notice until an autonomous run did the wrong thing.
 */
export async function loadAdapter(filePath = path.join(process.cwd(), 'project-adapter.yml')) {
  if (!fs.existsSync(filePath)) return null;

  // js-yaml v5 ships named exports only, no default — `load()` is always
  // the safe variant (no arbitrary JS type tags), which is what a
  // project's own config file should be parsed with regardless.
  const { load: parseYaml } = await import('js-yaml');

  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`${filePath} exists but could not be parsed as YAML: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${filePath} exists but did not parse to an object (got ${JSON.stringify(parsed)}).`);
  }

  return parsed;
}

/**
 * Provider names this adapter says to watch, or null if the adapter has no
 * opinion (missing file, or no `providers.watched` section) — callers
 * should fall back to their own default (e.g. "every registered provider")
 * rather than treating null as "watch nothing".
 *
 * Accepts both shapes seen in the wild: a bare list of names
 * (`['anthropic', 'openai']`) and the more explicit list of objects
 * (`[{lab: 'anthropic', env_var: 'ANTHROPIC_API_KEY'}]`) used in
 * examples/carrotgame/project-adapter.yml — the env var name itself is
 * documentation for a human reading the file, since llm-provider.mjs's
 * getProvider() already knows each registered provider's real envKey.
 */
export function watchedProviders(adapter) {
  const watched = adapter?.providers?.watched;
  if (!watched) return null;
  return watched.map((entry) => (typeof entry === 'string' ? entry : entry.lab));
}

/** Path to the model-release snapshot file, or null if unset. */
export function snapshotPath(adapter) {
  return adapter?.providers?.snapshot_path ?? null;
}

/** Max fan-out for newly released models, or null if unset. */
export function maxFanout(adapter) {
  const value = adapter?.providers?.max_fanout;
  return Number.isFinite(value) ? value : null;
}

/** Editable-path allowlist config, ready for edit-format.mjs's compileAllowlist(). */
export function constitutionAllowlist(adapter) {
  return {
    allowedPaths: adapter?.constitution?.allowed_paths ?? [],
    createOnlyPaths: adapter?.constitution?.create_only_paths ?? [],
  };
}
