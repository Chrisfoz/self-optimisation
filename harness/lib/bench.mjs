/**
 * The replay bench: the same tasks, the same models, the same budget and the
 * same memory, run under two or more operating strategies, so a change to how
 * the harness works (context strategy, retrieval, memory, review evidence) is
 * adopted on evidence rather than on how plausible it sounds.
 *
 * A task is a repository at a pinned commit — which pins the source AND the
 * memory, because the generation records, ledger and themes are committed
 * there too — plus held-out ORACLE commands: checks the models never see,
 * run after the generation, that decide whether the change was actually
 * right. A planted bug with a hidden test, or a past generation whose later
 * fate is known, both fit. The oracle is the only label here that is not the
 * harness grading itself.
 *
 * A variant is a patch over the task's adapter plus environment overrides.
 * Patches may not touch the constitution, the roles' review seat, the
 * evaluation gates or the approval class: a strategy may change what the
 * harness looks at, never what it is allowed to do or how it is judged.
 *
 * This file is the pure part — spec validation, adapter patching, scoring
 * and the report. harness/scripts/bench.mjs owns the clones and processes.
 */

/** Adapter sections a variant may not patch: authority and judgement stay fixed. */
export const FROZEN_SECTIONS = ['constitution', 'evaluation', 'deployment'];
const FROZEN_ROLE_KEYS = ['review'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @returns {{tasks: object[], variants: object[], trials: number}} the spec, normalised
 * @throws on anything that would make the comparison unfair or unsafe
 */
export function validateSpec(spec) {
  const errors = [];
  if (!isObject(spec)) throw new Error('bench spec must be a JSON object');
  const tasks = Array.isArray(spec.tasks) ? spec.tasks : [];
  const variants = Array.isArray(spec.variants) ? spec.variants : [];
  if (!tasks.length) errors.push('tasks: at least one task is required');
  if (variants.length < 2) errors.push('variants: at least two are required — a baseline and a candidate');
  const trials = Number.isInteger(spec.trials) && spec.trials > 0 ? spec.trials : 1;

  const ids = new Set();
  tasks.forEach((t, i) => {
    const at = `tasks[${i}]`;
    if (!t?.id) errors.push(`${at}.id is required`);
    if (ids.has(t?.id)) errors.push(`${at}.id ${t.id} is used twice`);
    ids.add(t?.id);
    if (!t?.repo) errors.push(`${at}.repo is required (a path or git URL)`);
    if (!/^[0-9a-f]{7,40}$/i.test(String(t?.baseCommit ?? ''))) errors.push(`${at}.baseCommit must be a commit sha — a branch name would drift between variants`);
    if (!Array.isArray(t?.oracleCommands) || !t.oracleCommands.length) errors.push(`${at}.oracleCommands: at least one held-out check is required, or nothing here is measured but the harness's own opinion`);
    if (!Array.isArray(t?.suggestModels) || !t.suggestModels.every((m) => m?.id)) errors.push(`${at}.suggestModels must be a list of {id, provider?}`);
  });

  const vids = new Set();
  variants.forEach((v, i) => {
    const at = `variants[${i}]`;
    if (!v?.id) errors.push(`${at}.id is required`);
    if (vids.has(v?.id)) errors.push(`${at}.id ${v.id} is used twice`);
    vids.add(v?.id);
    const patch = v?.adapter ?? {};
    if (!isObject(patch)) errors.push(`${at}.adapter must be an object`);
    for (const section of FROZEN_SECTIONS) {
      if (patch[section] !== undefined) errors.push(`${at}.adapter.${section}: a variant may not change ${section} — strategies change what the harness looks at, not what it may do or how it is judged`);
    }
    for (const key of FROZEN_ROLE_KEYS) {
      if (patch.roles?.[key] !== undefined) errors.push(`${at}.adapter.roles.${key}: the review seat is fixed across variants`);
    }
    if (patch.budget !== undefined) errors.push(`${at}.adapter.budget: the budget is fixed across variants (set it on the spec)`);
    if (v?.env !== undefined && !isObject(v.env)) errors.push(`${at}.env must be an object`);
    for (const k of Object.keys(v?.env ?? {})) {
      if (/(_KEY|TOKEN|SECRET)$/.test(k) || ['REVIEW_MODEL', 'TEST_COMMANDS', 'TEST_IN_LOOP', 'MAX_ATTEMPTS'].includes(k)) {
        errors.push(`${at}.env.${k}: not overridable by a variant`);
      }
    }
  });

  if (errors.length) throw new Error(`invalid bench spec:\n- ${errors.join('\n- ')}`);
  return { tasks, variants, trials, budgetTokens: Number.isFinite(spec.budgetTokens) ? spec.budgetTokens : null };
}

/** A deep merge where the patch wins; arrays are replaced, not concatenated. */
export function mergeAdapter(base, patch) {
  if (!isObject(patch)) return base;
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isObject(v) && isObject(out[k]) ? mergeAdapter(out[k], v) : v;
  }
  return out;
}

/**
 * An oracle command with `$BENCH_ORACLE_DIR` / `${BENCH_ORACLE_DIR}` filled
 * in by the bench itself. The test runner uses the platform shell, and
 * Windows' cmd.exe expands only %VAR%, so leaving it to the shell made every
 * oracle fail there. The variable stays in the environment too, for oracle
 * scripts that read it.
 */
export function withOracleDir(command, dir) {
  return String(command).replace(/\$\{BENCH_ORACLE_DIR\}|\$BENCH_ORACLE_DIR\b/g, () => dir);
}

/**
 * One trial's result, from the generation's own attempts.json and the
 * oracle's exit codes.
 */
export function scoreTrial({ task, variant, trial, record, oracle, durationMs, error = null }) {
  const approved = record?.outcome === 'approved';
  const oraclePassed = Boolean(oracle?.length) && oracle.every((o) => o.passed);
  return {
    task: task.id,
    variant: variant.id,
    trial,
    outcome: error ? 'bench-error' : (record?.outcome ?? 'no-record'),
    approved,
    oraclePassed,
    // The two numbers this exists for. A verified success is an approved
    // change the held-out checks agree with. A missed regression is an
    // approved change they do not — the review and the in-loop tests both
    // let it through.
    verifiedSuccess: approved && oraclePassed,
    missedRegression: approved && !oraclePassed,
    attempts: record?.attempts?.length ?? 0,
    totalTokens: record?.spend?.totalTokens ?? 0,
    inputTokens: record?.spend?.inputTokens ?? 0,
    outputTokens: record?.spend?.outputTokens ?? 0,
    estimatedPromptTokens: record?.contextSize?.estimatedTokens ?? null,
    durationMs: durationMs ?? null,
    oracle: (oracle ?? []).map((o) => ({ command: o.command, passed: o.passed })),
    error,
  };
}

/** Wilson score interval for k of n, 95%. */
export function wilson(k, n, z = 1.96) {
  if (!n) return { rate: null, low: null, high: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { rate: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** Per-variant totals. Bench errors are counted and excluded, never scored as failures of the strategy. */
export function summarise(results) {
  const byVariant = new Map();
  for (const r of results) {
    if (!byVariant.has(r.variant)) byVariant.set(r.variant, []);
    byVariant.get(r.variant).push(r);
  }
  return [...byVariant.entries()].map(([variant, rows]) => {
    const scored = rows.filter((r) => r.outcome !== 'bench-error');
    const n = scored.length;
    const verified = scored.filter((r) => r.verifiedSuccess).length;
    const missed = scored.filter((r) => r.missedRegression).length;
    const approved = scored.filter((r) => r.approved).length;
    const tokens = scored.map((r) => r.totalTokens);
    const totalTokens = tokens.reduce((a, b) => a + b, 0);
    return {
      variant,
      trials: n,
      benchErrors: rows.length - n,
      approved,
      verified: wilson(verified, n),
      verifiedCount: verified,
      // Of the changes that were approved, how many the oracle rejected.
      missedRegressions: missed,
      missedRegressionRate: wilson(missed, approved),
      meanTokens: mean(tokens),
      sdTokens: sd(tokens),
      tokensPerVerifiedSuccess: verified ? totalTokens / verified : null,
      meanAttempts: mean(scored.map((r) => r.attempts)),
    };
  });
}

/**
 * The adoption rule from docs/harness-kpis: a candidate is adopted only if it
 * uses fewer resources without weakening correctness. With overlapping
 * intervals the answer is "not shown", never "better".
 */
export function compare(baseline, candidate) {
  if (!baseline?.trials || !candidate?.trials) return { decision: 'insufficient-data', reasons: ['a variant has no scored trials'] };
  const reasons = [];
  const tokenChange = baseline.meanTokens ? (candidate.meanTokens - baseline.meanTokens) / baseline.meanTokens : null;
  if (tokenChange !== null) reasons.push(`mean tokens ${tokenChange <= 0 ? '' : '+'}${(tokenChange * 100).toFixed(1)}% against ${baseline.variant}`);
  const worse = candidate.verified.high < baseline.verified.low;
  const better = candidate.verified.low > baseline.verified.high;
  const overlap = !worse && !better;
  reasons.push(`verified success ${fmtRate(candidate.verified)} against ${fmtRate(baseline.verified)}${overlap ? ' (intervals overlap: not distinguishable at this sample size)' : ''}`);
  if (candidate.missedRegressions > baseline.missedRegressions) reasons.push(`${candidate.missedRegressions} missed regression(s) against ${baseline.missedRegressions}`);

  let decision;
  if (worse || candidate.missedRegressions > baseline.missedRegressions) decision = 'reject';
  else if (better) decision = 'adopt';
  else if (tokenChange !== null && tokenChange < 0 && candidate.verifiedCount >= baseline.verifiedCount) decision = 'adopt-provisionally';
  else decision = 'not-shown';
  return { decision, tokenChange, reasons };
}

const fmtRate = (w) => (w.rate === null ? 'n/a' : `${(w.rate * 100).toFixed(0)}% [${(w.low * 100).toFixed(0)}–${(w.high * 100).toFixed(0)}]`);

/** Markdown, for a person deciding whether to change how the harness works. */
export function renderReport({ spec, results, summary, comparisons, startedAt }) {
  const lines = [
    `# Replay bench — ${startedAt}`,
    '',
    `${spec.tasks.length} task(s) × ${spec.variants.length} variant(s) × ${spec.trials} trial(s). Same models, budget and memory snapshot in every cell; the oracle commands were never shown to a model.`,
    '',
    '| Variant | Trials | Verified success (95% CI) | Approved | Missed regressions | Mean tokens (sd) | Tokens / verified | Bench errors |',
    '|---|---|---|---|---|---|---|---|',
    ...summary.map((s) => `| ${s.variant} | ${s.trials} | ${fmtRate(s.verified)} | ${s.approved} | ${s.missedRegressions} | ${s.meanTokens === null ? 'n/a' : Math.round(s.meanTokens).toLocaleString()}${s.sdTokens === null ? '' : ` (${Math.round(s.sdTokens).toLocaleString()})`} | ${s.tokensPerVerifiedSuccess === null ? 'n/a' : Math.round(s.tokensPerVerifiedSuccess).toLocaleString()} | ${s.benchErrors} |`),
    '',
    '## Against the baseline',
    '',
    ...comparisons.map((c) => `- **${c.variant}: ${c.decision}** — ${c.reasons.join('; ')}`),
    '',
    '`adopt-provisionally` means cheaper and no observed loss, at a sample size that cannot rule one out: run a bounded real-project trial before changing a default.',
    '',
    '## Every trial',
    '',
    '| Task | Variant | Trial | Outcome | Oracle | Tokens | Attempts |',
    '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.task} | ${r.variant} | ${r.trial} | ${r.outcome}${r.error ? ` — ${String(r.error).replace(/\|/g, '/').slice(0, 120)}` : ''} | ${r.oraclePassed ? 'pass' : 'fail'} | ${r.totalTokens.toLocaleString()} | ${r.attempts} |`),
    '',
  ];
  return lines.join('\n');
}
