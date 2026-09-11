/**
 * Before and after: did a generation's change actually move anything this
 * project measures, which way, and at what cost — and did a person keep it?
 *
 * The evaluator plugins (harness/lib/evaluators.mjs) used to run once, after
 * a change, so a number in metrics.json said where the project stood and
 * nothing about what the change did to it. A frame-time p95 of 21ms is
 * uninterpretable without the 18ms it was before. This file compares two
 * measurements of the SAME evaluators — one of the untouched tree
 * (baseline-metrics.json, taken before the first model call) and one of the
 * changed tree (metrics.json) — and writes comparison.json beside them.
 *
 * Reproducible on purpose: a measurement carries a fingerprint of exactly
 * which evaluators ran with exactly which config, and two measurements with
 * different fingerprints are declared NOT comparable rather than compared.
 * A plugin that was added, removed or reconfigured between the two runs
 * would otherwise produce a "regression" that is really a change of ruler.
 *
 * Nothing here gates. A regression is recorded, reported and shown to a
 * person; it stops nothing, for the same reason the evaluators themselves
 * stop nothing (harness/plugins/evaluators/README.md, rule 1).
 *
 * Pure: plain data in, plain data out.
 */

import crypto from 'node:crypto';

/** Stable JSON: object keys sorted, so the same config always hashes the same. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * A short, stable identifier for "these evaluators, configured like this".
 * @param {Array<{module: string, name?: string|null, config?: object}>} configured
 * @returns {string}
 */
export function evaluatorFingerprint(configured = []) {
  const canonical = configured
    .map((e) => ({ module: e.module, name: e.name ?? null, config: e.config ?? {} }))
    .sort((a, b) => `${a.module}|${a.name}`.localeCompare(`${b.module}|${b.name}`));
  return crypto.createHash('sha256').update(stable(canonical)).digest('hex').slice(0, 16);
}

/**
 * Compare one metric across the two measurements.
 * Tolerance is absolute and defaults to 0 (exact): a deterministic plugin
 * (a line count, a bundle size) should report any change, and a noisy one
 * (frame timing) says how much noise it has by returning `tolerance`.
 */
function compareOne(before, after) {
  const base = { name: after?.name ?? before?.name, unit: after?.unit ?? before?.unit ?? null, direction: after?.direction ?? before?.direction ?? null };
  if (!before) return { ...base, before: null, after: after.value, verdict: 'appeared' };
  if (!after) return { ...base, before: before.value, after: null, verdict: 'disappeared' };

  if (typeof before.value !== 'number' || typeof after.value !== 'number') {
    return { ...base, before: before.value, after: after.value, verdict: before.value === after.value ? 'unchanged' : 'changed' };
  }
  const delta = after.value - before.value;
  const tolerance = Math.max(Number(after.tolerance ?? before.tolerance ?? 0) || 0, 0);
  const relative = before.value !== 0 ? delta / Math.abs(before.value) : null;
  let verdict;
  if (Math.abs(delta) <= tolerance) verdict = 'unchanged';
  else if (base.direction === 'higher') verdict = delta > 0 ? 'benefit' : 'regression';
  else if (base.direction === 'lower') verdict = delta < 0 ? 'benefit' : 'regression';
  else verdict = 'changed';
  return { ...base, before: before.value, after: after.value, delta, relative, tolerance, verdict };
}

/**
 * @param {{metrics: object[], fingerprint?: string}} baseline  baseline-metrics.json
 * @param {{metrics: object[], fingerprint?: string}} after     metrics.json
 * @returns {{comparable: boolean, reason: string|null, fingerprint: string|null, rows: object[],
 *            benefits: string[], regressions: string[], changed: string[], unchanged: string[], appeared: string[], disappeared: string[]}}
 */
export function compareMeasurements(baseline, after) {
  const empty = { rows: [], benefits: [], regressions: [], changed: [], unchanged: [], appeared: [], disappeared: [] };
  if (!baseline || !after) {
    return { comparable: false, reason: `no ${!baseline ? 'baseline' : 'after'} measurement`, fingerprint: null, ...empty };
  }
  if (!baseline.fingerprint || !after.fingerprint || baseline.fingerprint !== after.fingerprint) {
    return {
      comparable: false,
      reason: `the evaluators differ between the two measurements (${baseline.fingerprint ?? 'none'} vs ${after.fingerprint ?? 'none'}) — a change of ruler, not a change of project`,
      fingerprint: null,
      ...empty,
    };
  }
  const byName = (list) => new Map((list ?? []).map((m) => [m.name, m]));
  const b = byName(baseline.metrics);
  const a = byName(after.metrics);
  const names = [...new Set([...b.keys(), ...a.keys()])].sort();
  const rows = names.map((name) => compareOne(b.get(name), a.get(name)));
  const pick = (verdict) => rows.filter((r) => r.verdict === verdict).map((r) => r.name);
  return {
    comparable: true,
    reason: null,
    fingerprint: after.fingerprint,
    rows,
    benefits: pick('benefit'),
    regressions: pick('regression'),
    changed: pick('changed'),
    unchanged: pick('unchanged'),
    appeared: pick('appeared'),
    disappeared: pick('disappeared'),
  };
}

/**
 * The comparison.json written beside a generation's record: the metric
 * deltas, and the cost that bought them. Whether a person KEPT the change is
 * not known yet when this is written — the pull request is still open — so
 * it is read from attempts.json (pullRequest state, reverted) at report
 * time rather than copied here and left to go stale.
 */
export function buildComparisonRecord({ genNumber, comparison, record = null, date = new Date() }) {
  return {
    version: 1,
    generation: String(genNumber),
    date: (date instanceof Date ? date.toISOString() : String(date)).slice(0, 10),
    outcome: record?.outcome ?? null,
    cost: record?.spend ? { totalTokens: record.spend.totalTokens, calls: record.spend.calls } : null,
    ...comparison,
  };
}

/** One line for a log or a digest: "2 benefits (fps_p95, …), 1 regression (bundle_kb)". */
export function summarizeComparison(c) {
  if (!c?.comparable) return `not comparable — ${c?.reason ?? 'no comparison'}`;
  const part = (list, one, many) => (list.length ? `${list.length} ${list.length === 1 ? one : many} (${list.join(', ')})` : null);
  return [
    part(c.benefits, 'benefit', 'benefits'),
    part(c.regressions, 'regression', 'regressions'),
    part(c.changed, 'change without a direction', 'changes without a direction'),
  ].filter(Boolean).join(', ') || `no measured change across ${c.rows.length} metric(s)`;
}
