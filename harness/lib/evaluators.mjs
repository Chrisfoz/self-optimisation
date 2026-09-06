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
 * owns the adapter, the process-level concerns and the record it writes.
 * The two exceptions are loadEvaluatorPlugin() and loadVisualEvidence(),
 * which read from disk because reading a plugin and reading a generation's
 * own artifacts IS their whole purpose — the same latitude
 * loadLatestMetrics() above and every builder in context-pack.mjs already
 * take.
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

/** How long any one plugin gets before it is abandoned. Generous — a plugin that renders or builds is doing real work — but finite. */
export const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Caps on what one plugin may hand back per run. Metrics were always
 * bounded by being scalars; artifacts are not, and an unbounded one would
 * quietly become the largest thing in the next generation's prompt — the
 * same failure `detail`'s 500-character clamp already prevents for text.
 *
 * See docs/Tool-Use-Design.md §4.1. MAX_IMAGE_BYTES is generous for a real
 * render (a 1024px PNG is a few hundred KB) and small enough that a plugin
 * returning a video frame dump is refused rather than sent.
 */
export const MAX_ARTIFACTS_PER_PLUGIN = 8;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_OBSERVATION_CHARS = 1000;

/** How many images reach a prompt, and from how many generations back to look. */
export const DEFAULT_MAX_IMAGES = 3;

const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** The directory a generation's evaluator artifacts live in, relative to the repo root. */
export function artifactsDirFor({ generationsDir = 'docs/generations', genNumber }) {
  return `${generationsDir}/gen-${genNumber}/artifacts`;
}

/**
 * Normalise one artifact a plugin returned.
 *
 * Two kinds, and the split is the same one buildRuntimeEvidence() draws
 * between an anomaly and a total: an `image` is something a model has to
 * LOOK at, an `observation` is something it can read. Both describe what a
 * tool actually saw, which is the whole reason this category exists — see
 * docs/Tool-Use-Design.md §1.
 *
 * `kind` is inferred when absent (a `file` means an image, `text` means an
 * observation) because a forgiving parser costs nothing here: the runner
 * catches whatever this throws and records it as a plugin error.
 *
 * @param {unknown} raw
 * @param {{artifactsDir?: string}} [opts]  Where an image's `file` must
 *   actually be, checked to exist and to be within MAX_IMAGE_BYTES. An
 *   IMAGE with no artifactsDir to verify it against is REFUSED rather than
 *   trusted: nothing downstream could ever load it (loadVisualEvidence()
 *   reads from the generation's own artifacts directory), so recording it
 *   would put a pointer to a nonexistent file into a record that later
 *   claims to describe what a probe saw — principle 18, never claim data
 *   you did not supply. Observations need no directory and are unaffected.
 * @returns {{kind: 'image'|'observation', label: string, file?: string, mime?: string, bytes?: number, text?: string}}
 * @throws on anything unusable — the caller turns that into a recorded
 *   plugin error rather than letting it escape.
 */
export function normalizeArtifact(raw, { artifactsDir = null } = {}) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`an artifact must be an object, got ${typeof raw}`);
  }

  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 200) : '';
  if (!label) throw new Error('an artifact must have a non-empty label');

  const kind = raw.kind === 'image' || raw.kind === 'observation'
    ? raw.kind
    : typeof raw.file === 'string' && raw.file.trim() ? 'image'
    : typeof raw.text === 'string' && raw.text.trim() ? 'observation'
    : null;
  if (!kind) throw new Error(`artifact "${label}" is neither an image (no file) nor an observation (no text)`);

  if (kind === 'observation') {
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) throw new Error(`observation "${label}" has no text`);
    return { kind, label, text: text.slice(0, MAX_OBSERVATION_CHARS) };
  }

  const file = typeof raw.file === 'string' ? raw.file.trim() : '';
  if (!file) throw new Error(`image "${label}" has no file`);
  // A plugin writes into the directory it was given and names the file
  // relative to it. Anything that climbs out of that directory is refused
  // for the same reason edit-format.mjs refuses `..` in an edit target: the
  // one path a plugin may write to is not a suggestion.
  if (file.includes('..') || path.isAbsolute(file) || file.includes('\\')) {
    throw new Error(`image "${label}" has an unusable file path (${file}) — name it relative to artifactsDir, with no "..'"`);
  }

  const mime = typeof raw.mime === 'string' && raw.mime.trim()
    ? raw.mime.trim()
    : IMAGE_MIMES[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`image "${label}" (${file}) has no recognisable image type`);

  if (!artifactsDir) {
    throw new Error(`image "${label}" cannot be verified — this run has no artifacts directory, so nothing downstream could ever load it`);
  }
  const absolute = path.join(artifactsDir, file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`image "${label}" names ${file}, which the plugin did not write into artifactsDir`);
  }
  const bytes = fs.statSync(absolute).size;
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`image "${label}" is ${Math.round(bytes / 1024)}KB, over the ${Math.round(MAX_IMAGE_BYTES / 1024)}KB limit`);
  }

  return { kind, label, file, mime, bytes };
}

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
 * @param {string} [opts.artifactsDir]  Absolute path to the ONE directory a
 *   plugin may write to (docs/Tool-Use-Design.md §4.1). The interface's rule
 *   2 — a plugin does not write — exists because a plugin editing the
 *   working tree corrupts the diff a human is about to review; a renderer
 *   has to write something, so it gets a directory outside that tree and the
 *   rule sharpens rather than loosens. Omitted means artifacts cannot be
 *   verified and any image is refused.
 * @param {number} [opts.timeoutMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{metrics: Array, artifacts: Array, errors: Array<{plugin: string, error: string}>}>}
 *   All three, always. A run where every plugin failed returns no metrics,
 *   no artifacts and every error — never a throw, because that is the one
 *   thing this must not do.
 */
export async function runEvaluators({ plugins = [], repoRoot, generation = null, artifactsDir = null, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  const metrics = [];
  const artifacts = [];
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
        (async () => plugin.evaluate({ repoRoot, generation, config: plugin.config || {}, artifactsDir }))(),
        timeoutMs
      );

      // Two accepted shapes. A bare metric or array of them is what every
      // plugin written before artifacts existed returns, and stays valid
      // forever; `{metrics, artifacts}` is the richer one. Detected by the
      // presence of either key rather than by a version field, so a plugin
      // never has to declare which era it belongs to.
      const isRich = raw && !Array.isArray(raw) && typeof raw === 'object'
        && ('metrics' in raw || 'artifacts' in raw);
      const rawMetrics = isRich ? raw.metrics : raw;
      const rawArtifacts = isRich ? raw.artifacts : [];

      const metricList = Array.isArray(rawMetrics) ? rawMetrics : rawMetrics == null ? [] : [rawMetrics];
      const normalized = metricList.map(normalizeMetric).map((m) => ({ ...m, plugin: name }));

      const artifactList = (Array.isArray(rawArtifacts) ? rawArtifacts : rawArtifacts == null ? [] : [rawArtifacts])
        .slice(0, MAX_ARTIFACTS_PER_PLUGIN);
      const normalizedArtifacts = artifactList
        .map((a) => normalizeArtifact(a, { artifactsDir }))
        .map((a) => ({ ...a, plugin: name }));

      // Both lists are normalised BEFORE either is pushed, so a plugin whose
      // third artifact is malformed contributes nothing rather than half of
      // itself — the same all-or-nothing rule applyEdits() follows, for the
      // same reason: a partial result is harder to reason about than none.
      metrics.push(...normalized);
      artifacts.push(...normalizedArtifacts);
      log(`   ✅ ${name}: ${normalized.length} metric(s), ${normalizedArtifacts.length} artifact(s)`);
    } catch (err) {
      // Rule 1. A plugin's failure is data about the plugin, not about the
      // generation — recorded, reported, and then stepped over.
      errors.push({ plugin: name, error: err.message });
      log(`   ⚠️  ${name} failed: ${err.message} (not gating — the generation is unaffected)`);
    }
  }

  return { metrics, artifacts, errors };
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
 * Observation artifacts, when a project's plugins produced any, are appended
 * as their own block. They are deliberately NOT metrics: an observation is
 * what a tool saw ("apex 1.9m; the gap needs 2.1m"), which cannot be
 * optimised the way a single number can — the distinction
 * buildRuntimeEvidence() already draws, and the reason principle 22b's
 * `readingLevel` incident is about a score rather than an observation.
 *
 * A record with no artifacts renders byte-identically to one from before
 * artifacts existed, which is what keeps every project that configures no
 * renderer on exactly the prompt it had.
 *
 * @param {{metrics: Array, artifacts?: Array, throughGeneration?: string}} record
 * @returns {string|null}
 */
export function buildMetricsBrief(record) {
  const metrics = Array.isArray(record?.metrics) ? record.metrics : [];
  const observations = (Array.isArray(record?.artifacts) ? record.artifacts : [])
    .filter((a) => a?.kind === 'observation' && a.text);

  if (!metrics.length && !observations.length) return null;

  const measuredAt = record.throughGeneration ? ` as of generation ${record.throughGeneration}` : '';
  const blocks = [];

  if (metrics.length) {
    const lines = metrics.map((m) => {
      const value = m.unit ? `${m.value} ${m.unit}` : `${m.value}`;
      const better = m.direction ? ` (${m.direction} is better)` : '';
      const detail = m.detail ? ` — ${m.detail}` : '';
      return `- ${m.name}: ${value}${better}${detail}`;
    });
    blocks.push(
      `These dimensions are measured${measuredAt} and are NOT gates: no value here can reject a change, ` +
      `and a change that makes one worse for a good reason is allowed. They are here because someone ` +
      `decided this project should be able to see them, not because they are targets to optimise.\n\n` +
      lines.join('\n')
    );
  }

  if (observations.length) {
    blocks.push(
      `What this project's own probes actually observed${measuredAt} — the observation itself, not a ` +
      `verdict and not a score:\n\n` +
      observations.map((o) => `- ${o.label}: ${o.text}`).join('\n')
    );
  }

  return blocks.join('\n\n');
}

/**
 * The file written next to a generation's attempts.json.
 *
 * Its own file rather than a field inside attempts.json, for the same reason
 * recordPullRequestUrl() is a second write: the evaluators run after
 * run-generation.mjs has exited, and a record that is rewritten by a later
 * step is a record two things can disagree about.
 */
export function buildMetricsRecord({ throughGeneration, metrics, artifacts = [], errors = [], date = new Date() }) {
  return {
    version: 1,
    throughGeneration: String(throughGeneration),
    date: (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10),
    metrics,
    // What the project's own probes produced: images a later prompt attaches,
    // and observations it reads. Absent on every record written before
    // artifacts existed, which every reader here treats as an empty list.
    artifacts,
    errors,
  };
}

/**
 * Load the most recent generation's image artifacts, ready to attach to a
 * model call — the read side of the suggestion prompt's `screenshots`
 * socket (`orchestrator.mjs`'s buildSuggestUserPrompt), which has existed
 * since the port and been fed `{images: [], source: null}` ever since.
 *
 * Searches newest-first and stops at the first generation that actually has
 * images, rather than looking only at the newest. That is not a nicety: the
 * reference implementation looked only in the newest generation's folder,
 * and a FAILED generation still creates its folder (to store its failure
 * record) without ever storing images — so one failed run shadowed the last
 * real pictures and dropped every model back to a stale baseline, while the
 * prompt told them these were current. See learning/03-failure-modes.md,
 * "One failed generation hid the current screenshots".
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] @param {string} [opts.generationsDir]
 * @param {number} [opts.maxImages]  Default 3 — the reference
 *   implementation's own number, and roughly 4,500 vision tokens at
 *   context-pack.mjs's IMAGE_TOKENS_EACH estimate.
 * @param {number} [opts.lookBack]  How many generations back to search.
 * @returns {{images: Array<{mime: string, data: string, label: string}>, source: string|null}}
 *   The exact shape the screenshots socket takes, so a project with no
 *   artifacts yields `{images: [], source: null}` — today's value.
 */
export function loadVisualEvidence({
  repoRoot = process.cwd(),
  generationsDir = 'docs/generations',
  maxImages = DEFAULT_MAX_IMAGES,
  lookBack = 5,
} = {}) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(repoRoot, generationsDir)).filter((d) => /^gen-\d+$/.test(d)).sort();
  } catch {
    return { images: [], source: null };
  }

  for (const dir of dirs.slice(-Math.max(0, lookBack)).reverse()) {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(repoRoot, generationsDir, dir, 'metrics.json'), 'utf8'));
    } catch {
      continue; // no metrics.json, or an unreadable one: keep looking back
    }

    const wanted = (Array.isArray(record?.artifacts) ? record.artifacts : [])
      .filter((a) => a?.kind === 'image' && a.file && a.mime)
      .slice(0, Math.max(0, maxImages));
    if (!wanted.length) continue;

    const artifactsDir = path.join(repoRoot, generationsDir, dir, 'artifacts');
    const images = [];
    for (const artifact of wanted) {
      try {
        const absolute = path.join(artifactsDir, artifact.file);
        // The record says the file exists; the file is what actually has to.
        // A record pointing at a deleted image must shrink the section, never
        // send a broken attachment or throw mid-prompt.
        if (!fs.existsSync(absolute)) continue;
        images.push({ mime: artifact.mime, data: fs.readFileSync(absolute).toString('base64'), label: artifact.label });
      } catch {
        // One unreadable image does not cost the others.
      }
    }
    if (images.length) return { images, source: dir };
  }

  return { images: [], source: null };
}

/**
 * Load one evaluator-interface plugin by module path.
 *
 * Shared by run-evaluators.mjs (the quality dimensions) and
 * run-generation.mjs (the visual-capture hook), because they load the same
 * interface the same way and two copies of a dynamic import is how the two
 * quietly stop agreeing about what a plugin is.
 *
 * @param {{repoRoot?: string, module: string, name?: string, config?: object}} entry
 * @returns {Promise<{name: string, evaluate: Function|undefined, config: object}>}
 * @throws when the module cannot be imported — the caller records that the
 *   same way it records a plugin that threw, one step earlier.
 */
export async function loadEvaluatorPlugin({ repoRoot = process.cwd(), module: modulePath, name = null, config = {} }) {
  const absolute = path.resolve(repoRoot, modulePath);
  const mod = await import(pathToFileURL(absolute).href);
  const plugin = mod.default ?? mod;
  return { name: name || plugin?.name || modulePath, evaluate: plugin?.evaluate, config };
}

/**
 * Turn a loaded plugin into the `captureVisual` hook review.mjs takes — the
 * second socket that has been wired to nothing since the port
 * (`review.mjs`'s noVisualCapture(), "no visual capture configured for this
 * project").
 *
 * Unlike the evaluators, this runs INSIDE the generation, against the tree
 * the edits produced, so the reviewer sees the change rather than its
 * predecessor. `learning/03-failure-modes.md`'s "a review gate that had
 * never been shown a picture" is what this is for: a warning ring stroked
 * across a character's own face was correct code, passed review, and was
 * unreadable to a child — a diff cannot show that.
 *
 * Fails SAFE, always. A capture plugin that throws, hangs or returns nothing
 * yields `{available: false, reason}`, which review.mjs already renders as
 * "you are reviewing the diff and source only". A broken renderer must never
 * be able to fail a generation — evaluator rule 1, which holds here for the
 * stronger reason that this one runs inside the gate.
 *
 * @param {object} opts
 * @param {{name: string, evaluate: Function}} opts.plugin
 * @param {string} opts.repoRoot
 * @param {string} opts.artifactsDir  Somewhere outside the working tree —
 *   this runs mid-generation, and a renderer writing into the tree would
 *   corrupt the very diff under review.
 * @returns {() => Promise<{available: boolean, images: Array, reason?: string}>}
 */
export function createVisualCapture({ plugin, repoRoot, artifactsDir, maxImages = DEFAULT_MAX_IMAGES, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} }) {
  return async () => {
    try {
      if (typeof plugin?.evaluate !== 'function') throw new Error('exports no evaluate() function');
      fs.mkdirSync(artifactsDir, { recursive: true });

      const raw = await withTimeout(
        (async () => plugin.evaluate({ repoRoot, generation: null, config: plugin.config || {}, artifactsDir }))(),
        timeoutMs
      );
      const rawArtifacts = raw && !Array.isArray(raw) && typeof raw === 'object' && 'artifacts' in raw ? raw.artifacts : raw;
      const list = (Array.isArray(rawArtifacts) ? rawArtifacts : rawArtifacts == null ? [] : [rawArtifacts])
        .slice(0, MAX_ARTIFACTS_PER_PLUGIN);

      const images = [];
      for (const artifact of list) {
        const normalized = normalizeArtifact(artifact, { artifactsDir });
        if (normalized.kind !== 'image' || images.length >= maxImages) continue;
        images.push({
          mime: normalized.mime,
          data: fs.readFileSync(path.join(artifactsDir, normalized.file)).toString('base64'),
          label: normalized.label,
        });
      }

      if (!images.length) return { available: false, images: [], reason: `${plugin.name} produced no images` };
      return { available: true, images, reason: `rendered by ${plugin.name} from the working tree after the edits` };
    } catch (err) {
      log(`   ⚠️  visual capture failed: ${err.message} (not gating — the review proceeds on the diff alone)`);
      return { available: false, images: [], reason: `visual capture failed: ${err.message}` };
    }
  };
}
