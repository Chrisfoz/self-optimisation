#!/usr/bin/env node

/**
 * The write side of runtime evidence: turning what a CI run actually saw
 * into the file `context-pack.mjs`'s `buildRuntimeEvidence()` reads back.
 *
 * See docs/curiosity/C10-runtime-evidence.md for why this exists at all.
 * The short version: every other signal in this harness's prompt describes
 * what the project *is*. Nothing described what it *did*, so the improvement
 * signal was "review approved, tests green" — a judgement about code, made
 * by reading code.
 *
 * Pure, as everywhere else here. This file shapes and validates plain data;
 * harness/scripts/record-runtime-evidence.mjs owns the files, the arguments
 * and the exit code.
 *
 * The evidence file is assembled from *fragments* rather than produced by
 * one omniscient step, because the things worth recording happen in
 * different places: the test step knows about skipped tests, the deploy
 * check knows what it fetched, a project's own probe knows its dimensions.
 * Each writes a small JSON file; this merges them.
 */

/** Anything longer than this in one observation is a log file, not an observation. */
const MAX_OBSERVATION = 300;

const clamp = (text, max = MAX_OBSERVATION) => String(text ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

/**
 * Parse a TAP 13 stream into suite-shaped evidence.
 *
 * TAP because it is what `node --test` emits, and what a good many other
 * runners can emit on request — it is the one format worth building in.
 * Every other ecosystem writes its own fragment instead: that is the whole
 * point of the fragment shape, and it is why this function is one option
 * rather than the interface.
 *
 * What it extracts is deliberately lopsided. Counts are cheap and mostly
 * uninteresting; the SKIPPED NAMES are the reason this function exists, and
 * a skipped test is a lie the record tells by omission.
 *
 * @param {string} tap
 * @param {string} [name]  What to call this suite in the record.
 * @returns {{name: string, passed: number, failed: number, skipped: string[]}}
 */
export function parseTap(tap, name = 'tests') {
  const lines = String(tap ?? '').split('\n');
  let passed = 0;
  let failed = 0;
  const skipped = [];

  for (const line of lines) {
    // `ok 12 - name # SKIP reason` / `not ok 3 - name`. The leading indent
    // varies with nesting depth in node:test's output, so it is tolerated
    // rather than anchored against.
    const match = line.match(/^\s*(not ok|ok)\s+\d+\s*-?\s*(.*)$/);
    if (!match) continue;

    const [, verdict, rest] = match;
    const directive = rest.match(/#\s*(SKIP|TODO)\b(.*)$/i);
    const title = rest.replace(/#\s*(SKIP|TODO)\b.*$/i, '').trim();

    if (directive) {
      skipped.push(title || '(unnamed)');
      continue;
    }
    if (verdict === 'ok') passed += 1;
    else failed += 1;
  }

  return { name, passed, failed, skipped };
}

/**
 * Merge fragments into one evidence record.
 *
 * Fragments are shallow-merged by section (`tests`, `deploy`, `probe`,
 * `timing`), with suites, checks, dimensions and steps concatenated rather
 * than replaced — two test steps in one workflow are two suites, not one
 * overwriting the other.
 *
 * **Composite scores are dropped here, at the point of writing**, not only
 * at the point of rendering. A score that is never written cannot leak into
 * a prompt through some later reader that forgot the rule. The `readingLevel`
 * lesson is the reason: a single number invites optimisation of the number,
 * while a raw observation cannot be gamed the same way because there is no
 * single quantity to move.
 *
 * @param {object} opts
 * @param {string|number} opts.generation
 * @param {Array<object>} opts.fragments
 * @param {Date|string} [opts.date]
 */
export function buildEvidenceRecord({ generation, fragments = [], date = new Date() }) {
  const record = {
    version: 1,
    generation: String(generation),
    date: (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10),
  };

  const suites = [];
  const checks = [];
  const dimensions = [];
  const slowest = [];
  let deployUrl = null;

  for (const fragment of fragments) {
    if (!fragment || typeof fragment !== 'object') continue;

    for (const suite of fragment.tests?.suites ?? []) {
      if (!suite?.name) continue;
      suites.push({
        name: clamp(suite.name, 120),
        passed: Number(suite.passed) || 0,
        failed: Number(suite.failed) || 0,
        skipped: (suite.skipped ?? []).filter(Boolean).map((sk) => clamp(sk, 160)),
      });
    }

    if (fragment.deploy?.url) deployUrl = fragment.deploy.url;
    for (const check of fragment.deploy?.checks ?? []) {
      if (!check?.what) continue;
      checks.push({
        what: clamp(check.what, 120),
        observed: clamp(check.observed),
        ...(check.ok === false ? { ok: false } : {}),
      });
    }

    for (const dimension of fragment.probe?.dimensions ?? []) {
      if (!dimension?.name) continue;
      dimensions.push({
        name: clamp(dimension.name, 120),
        observed: clamp(dimension.observed),
        // `method` is kept because HOW a thing was measured turned out to be
        // the part that mattered — it is what lets a model notice the metric
        // is blind.
        ...(dimension.method ? { method: clamp(dimension.method, 160) } : {}),
      });
    }

    for (const step of fragment.timing?.slowest ?? []) {
      if (!step?.step || !Number.isFinite(Number(step.ms))) continue;
      slowest.push({ step: clamp(step.step, 120), ms: Number(step.ms) });
    }
  }

  if (suites.length) record.tests = { suites };
  if (checks.length) record.deploy = { ...(deployUrl ? { url: deployUrl } : {}), checks };
  if (dimensions.length) record.probe = { dimensions };
  if (slowest.length) {
    // Slowest first, and only a few: "every step took some time" is not an
    // observation, and the budget this competes for is small.
    record.timing = { slowest: slowest.sort((a, b) => b.ms - a.ms).slice(0, 3) };
  }

  return record;
}

/** True when a record carries nothing worth writing — every section empty. */
export function isEmptyEvidence(record) {
  return !record?.tests && !record?.deploy && !record?.probe && !record?.timing;
}

/** The evidence fragment a verifyDeployment() result becomes. */
export function deployFragment(result, { url = null } = {}) {
  const checks = (result?.results ?? []).map((r) => ({
    what: r.relative ?? r.what ?? 'check',
    observed: r.detail ?? (r.ok ? 'matched' : 'did not match'),
    ...(r.ok === false ? { ok: false } : {}),
  }));
  if (!checks.length && result?.detail) {
    checks.push({ what: 'deployment', observed: result.detail, ...(result.ok === false ? { ok: false } : {}) });
  }
  return checks.length ? { deploy: { ...(url ? { url } : {}), checks } } : {};
}
