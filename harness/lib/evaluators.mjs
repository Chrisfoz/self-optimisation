#!/usr/bin/env node

/**
 * Quality-dimension evaluators — the category `visual-check.mjs` and
 * `wordless-play.mjs` were one instance of, generalised.
 *
 * Portable-Harness-Design.md §8.2 makes the correction this file implements:
 * "visual/wordless-play" was never the general case. The real abstraction is
 * *domain-specific quality dimensions beyond pass/fail, evaluated
 * non-gating*. A canvas game measures whether a child who cannot read can
 * still play it; a Java service measures a Checkstyle count and a JaCoCo
 * delta; a CLI measures startup time. None of those belong in this harness —
 * all of them are the same shape, and that shape is what belongs here.
 *
 * What makes this a *category* rather than a second test runner: the tests
 * already answer pass/fail, and a failing test stops the generation. A
 * quality dimension answers "how much", it is allowed to get worse, and it
 * never stops anything. See harness/plugins/evaluators/README.md for the
 * interface a plugin implements and why "never gating" is enforced here
 * rather than left to each plugin's good behaviour.
 *
 * Three rules this file exists to keep, none of which a plugin author should
 * have to remember:
 *
 * 1. **A plugin cannot fail a generation.** Every call is wrapped: a plugin
 *    that throws, hangs past its timeout, or returns nonsense produces a
 *    recorded error and nothing else. A measurement that can break the loop
 *    is a gate wearing a metric's clothes.
 * 2. **A plugin cannot write.** It is handed a repoRoot and the generation
 *    record and is expected to read them. Nothing enforces that at the
 *    filesystem level — Node has no such sandbox — but the interface gives a
 *    plugin no reason to write and the documentation says so plainly.
 * 3. **Metrics are named and typed on the way out**, so a project's own
 *    plugin can't produce a shape the digest or the next prompt chokes on.
 *
 * Same lib/scripts split as everywhere else here: this file is pure logic
 * over plain data plus a caller-supplied loader; harness/scripts/run-evaluators.mjs
 * owns the adapter, the dynamic import, and the file writes.
 */

import fs from 'fs';
import path from 'path';

/** How long any one plugin gets before it is abandoned. Generous — a plugin that renders or builds is doing real work — but finite. */
export const DEFAULT_TIMEOUT_MS = 120000;

/**
 * The most recent generation's metrics.json, parsed — or null if no
 * generation has produced one.
 *
 * Read side, mirroring themes.mjs's loadLatestThemesReview(): the newest
 * measurement is the one the next generation is shown. Older ones stay on
 * disk beside their generation, which is where a human comparing two runs
 * would look anyway.
 *
 * A malformed file returns null rather than throwing. This feeds an optional
 * prompt section; taking the suggestion stage down because one plugin wrote
 * bad JSON last month would be the tail wagging the dog.
 */
export function loadLatestMetrics({ repoRoot = process.cwd(), generationsDir = 'docs/generations' } = {}) {
  let dirs;
  try {
    dirs = fs.readdirSync(path.join(repoRoot, generationsDir)).filter((d) => /^gen-\d+$/.test(d)).sort();
  } catch {
    return null;
  }

  for (const dir of dirs.reverse()) {
    const file = path.join(repoRoot, generationsDir, dir, 'metrics.json');
    if (!fs.existsSync(file)) continue;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`⚠️  Could not parse ${generationsDir}/${dir}/metrics.json: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * Normalise one metric a plugin returned.
 *
 * A metric is deliberately small: a name, a number or string value, and
 * optional prose. Anything richer belongs in the plugin's own output file,
 * not in the record every future prompt reads.
 *
 * `direction` says which way is better — 'lower', 'higher', or null for a
 * dimension where neither is (a count of files by category, say). It exists
 * because a bare number in a prompt is uninterpretable: "complexity 41" says
 * nothing until you know whether 40 was better.
 *
 * @param {unknown} raw
 * @returns {{name: string, value: number|string, unit: string|null, direction: 'lower'|'higher'|null, detail: string|null}}
 * @throws on anything that isn't a usable metric — the caller turns that
 *   into a recorded plugin error rather than letting it escape.
 */
export function normalizeMetric(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`a metric must be an object, got ${typeof raw}`);
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) throw new Error('a metric must have a non-empty name');

  const value = raw.value;
  const usable = (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim());
  if (!usable) {
    throw new Error(`metric "${name}" has no usable value (got ${JSON.stringify(value)})`);
  }

  const direction = raw.direction === 'lower' || raw.direction === 'higher' ? raw.direction : null;

  return {
    name,
    value: typeof value === 'string' ? value.trim() : value,
    unit: typeof raw.unit === 'string' && raw.unit.trim() ? raw.unit.trim() : null,
    direction,
    // Clamped: this text is read back into every subsequent suggestion
    // prompt, and a plugin that returns a log file would quietly become the
    // largest block in it.
    detail: typeof raw.detail === 'string' && raw.detail.trim() ? raw.detail.trim().slice(0, 500) : null,
  };
}

/**
 * Race a promise against a timeout.
 *
 * A plugin shells out, renders, or builds; any of those can hang forever on
 * a runner with no TTY and no one watching. The timeout is what keeps rule 1
 * true for a plugin that never returns at all, as opposed to one that
 * throws.
 */
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    // Deliberately NOT unref'd. A plugin that never settles leaves nothing
    // else keeping the event loop alive, and an unref'd deadline in that
    // situation never fires — the process just exits, or the caller hangs
    // forever, which is the exact failure this timeout exists to prevent.
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run a set of evaluator plugins and collect what they measured.
 *
 * @param {object} opts
 * @param {Array<{name: string, evaluate: Function, config?: object}>} opts.plugins
 *   Already-loaded plugins. Loading is the caller's job (see
 *   run-evaluators.mjs) so this function stays testable with plain objects
 *   and no dynamic import.
 * @param {string} opts.repoRoot  The working tree as the generation left it.
 * @param {object} [opts.generation]  The generation record (attempts.json),
 *   parsed. A plugin that only measures the tree ignores it; one that wants
 *   to know what changed reads `filesChanged` or `outcome` from it.
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{metrics: Array, errors: Array<{plugin: string, error: string}>}>}
 *   Both lists, always. A run where every plugin failed returns no metrics
 *   and every error — never a throw, because that is the one thing this must
 *   not do.
 */
export async function runEvaluators({ plugins = [], repoRoot, generation = null, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  const metrics = [];
  const errors = [];

  for (const plugin of plugins) {
    const name = plugin?.name || 'unnamed-plugin';
    if (typeof plugin?.evaluate !== 'function') {
      errors.push({ plugin: name, error: 'exports no evaluate() function' });
      continue;
    }

    try {
      // `(async () => ...)()` rather than `Promise.resolve(fn())`: a plugin
      // that throws SYNCHRONOUSLY would otherwise throw before there is a
      // promise to race, skipping the timeout wrapper entirely. It still
      // lands in the catch below either way, but only one of the two shapes
      // is the one this file claims to handle.
      const raw = await withTimeout(
        (async () => plugin.evaluate({ repoRoot, generation, config: plugin.config || {} }))(),
        timeoutMs
      );
      const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
      const normalized = list.map(normalizeMetric).map((m) => ({ ...m, plugin: name }));
      metrics.push(...normalized);
      log(`   ✅ ${name}: ${normalized.length} metric(s)`);
    } catch (err) {
      // Rule 1. A plugin's failure is data about the plugin, not about the
      // generation — recorded, reported, and then stepped over.
      errors.push({ plugin: name, error: err.message });
      log(`   ⚠️  ${name} failed: ${err.message} (not gating — the generation is unaffected)`);
    }
  }

  return { metrics, errors };
}

/**
 * Format measured dimensions for the next generation's suggestion prompt.
 *
 * Returns null when there is nothing to say, which is what drops the section
 * from the prompt entirely rather than heading an empty one — the same
 * contract buildThemesBrief() and buildEscalationBrief() already follow, and
 * the reason a project with no evaluators configured gets a prompt
 * byte-identical to one from before this file existed.
 *
 * The framing sentence is doing real work. A model shown a number will treat
 * it as a target unless told otherwise, and these numbers are explicitly not
 * targets: they are measured because someone wanted to watch them, and a
 * generation that makes one worse for a good reason is allowed.
 *
 * @param {{metrics: Array, throughGeneration?: string}} record
 * @returns {string|null}
 */
export function buildMetricsBrief(record) {
  const metrics = record?.metrics;
  if (!Array.isArray(metrics) || !metrics.length) return null;

  const lines = metrics.map((m) => {
    const value = m.unit ? `${m.value} ${m.unit}` : `${m.value}`;
    const better = m.direction ? ` (${m.direction} is better)` : '';
    const detail = m.detail ? ` — ${m.detail}` : '';
    return `- ${m.name}: ${value}${better}${detail}`;
  });

  const measuredAt = record.throughGeneration ? ` as of generation ${record.throughGeneration}` : '';

  return (
    `These dimensions are measured${measuredAt} and are NOT gates: no value here can reject a change, ` +
    `and a change that makes one worse for a good reason is allowed. They are here because someone ` +
    `decided this project should be able to see them, not because they are targets to optimise.\n\n` +
    lines.join('\n')
  );
}

/**
 * The file written next to a generation's attempts.json.
 *
 * Its own file rather than a field inside attempts.json, for the same reason
 * recordPullRequestUrl() is a second write: the evaluators run after
 * run-generation.mjs has exited, and a record that is rewritten by a later
 * step is a record two things can disagree about.
 */
export function buildMetricsRecord({ throughGeneration, metrics, errors = [], date = new Date() }) {
  return {
    version: 1,
    throughGeneration: String(throughGeneration),
    date: (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10),
    metrics,
    errors,
  };
}
