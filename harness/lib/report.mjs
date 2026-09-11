#!/usr/bin/env node

/**
 * The operational report — the paper's §7 metrics, computed from the
 * records every run already writes, rendered as one markdown page that is
 * generated and never hand-edited (learning/01-principles.md, 23).
 *
 * Every number here is derivable from `docs/generations/gen-NNN/
 * attempts.json` plus what harness/lib/pull-requests.mjs and
 * harness/lib/rollback.mjs write back into it. Nothing is a model's
 * opinion. Where a metric needs data the records do not hold yet (a
 * generation from before spend existed), the row says so rather than
 * printing a zero that would read as free or as perfect.
 *
 * Pure: takes loaded records, returns numbers and a string. The CLI
 * (harness/scripts/report.mjs) owns the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Read every attempts.json under generationsDir, oldest first. Malformed ones are skipped and counted. */
export function loadRecords({ repoRoot = process.cwd(), generationsDir = 'docs/generations' } = {}) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(path.join(repoRoot, generationsDir)).filter((d) => /^gen-\d+$/.test(d)).sort();
  } catch {
    return { records: [], malformed: 0 };
  }
  const records = [];
  let malformed = 0;
  for (const dir of dirs) {
    try {
      const raw = fs.readFileSync(path.join(repoRoot, generationsDir, dir, 'attempts.json'), 'utf8');
      const record = JSON.parse(raw);
      // The before/after measurement, when this generation changed something
      // and the project has evaluators (harness/lib/measure.mjs). Its own
      // file, read beside the record rather than copied into it.
      let comparison = null;
      try { comparison = JSON.parse(fs.readFileSync(path.join(repoRoot, generationsDir, dir, 'comparison.json'), 'utf8')); } catch { /* none taken */ }
      records.push({ ...record, generation: record.generation ?? dir.replace('gen-', ''), ...(comparison ? { comparison } : {}) });
    } catch {
      // A directory with a proposal.md but no record predates records; a
      // directory with a broken one is worth counting, not crashing over.
      if (fs.existsSync(path.join(repoRoot, generationsDir, dir, 'attempts.json'))) malformed += 1;
    }
  }
  return { records, malformed };
}

/** What became of an approved generation after the loop approved it — mirrors context-pack.mjs's fateOf(). */
export function fateOf(record) {
  if (record?.reverted) return 'reverted';
  const state = record?.pullRequest?.state;
  if (state === 'closed') return 'closed';
  if (state === 'open') return 'open';
  // See context-pack.mjs's fateOf(): a local rehearsal's approval was never
  // put to a person, so it is not a change anyone kept.
  if (!state && record?.run?.source === 'local') return 'rehearsed';
  return 'merged';
}

const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const pct = (num, den) => (den > 0 ? `${Math.round((num / den) * 100)}%` : 'n/a');
const n = (v) => (Number.isFinite(v) ? v : 0);

/**
 * The metrics.
 *
 * @param {object[]} records
 * @returns {object}
 */
export function computeMetrics(records) {
  const total = records.length;
  const byOutcome = {};
  for (const r of records) byOutcome[r.outcome ?? 'unknown'] = (byOutcome[r.outcome ?? 'unknown'] ?? 0) + 1;

  const approved = records.filter((r) => r.outcome === 'approved');
  const fates = { merged: 0, open: 0, closed: 0, reverted: 0, rehearsed: 0 };
  for (const r of approved) fates[fateOf(r)] += 1;

  // Release yield: cycles that produced a change a person kept.
  const kept = fates.merged;
  // Promotion precision: of what landed, how much stayed. A closed PR never
  // landed, so it is a review-vs-owner disagreement, reported separately.
  const landed = fates.merged + fates.reverted;

  // Failure recurrence: an abandoned proposal whose summary repeats an
  // earlier abandoned one. Crude, and honest about being crude.
  const abandonedSummaries = [];
  let recurred = 0;
  for (const r of records.filter((x) => x.outcome === 'abandoned')) {
    const key = normalise(r.proposalSummary).slice(0, 60);
    if (key && abandonedSummaries.includes(key)) recurred += 1;
    if (key) abandonedSummaries.push(key);
  }

  // Cost. Only records that carry spend count; the rest are reported as unknown.
  const withSpend = records.filter((r) => Number.isFinite(r.spend?.totalTokens));
  const tokens = withSpend.reduce((s, r) => s + r.spend.totalTokens, 0);
  const keptWithSpend = withSpend.filter((r) => r.outcome === 'approved' && fateOf(r) === 'merged').length;

  // Per lab: who was asked, who won the ranking, who shipped, who wrote their own edits.
  const labs = {};
  const lab = (s) => (String(s ?? '').match(/\(([^)]+)\)\s*$/)?.[1] ?? 'unknown');
  for (const r of records) {
    for (const asked of r.fanOut?.asked ?? []) {
      const l = lab(asked);
      labs[l] ??= { asked: 0, chosen: 0, approved: 0, kept: 0, selfImplemented: 0 };
      labs[l].asked += 1;
    }
    const chosen = r.fanOut?.chosen ?? r.suggestModel;
    if (chosen) {
      const l = lab(chosen);
      labs[l] ??= { asked: 0, chosen: 0, approved: 0, kept: 0, selfImplemented: 0 };
      labs[l].chosen += 1;
      if (r.outcome === 'approved') {
        labs[l].approved += 1;
        if (fateOf(r) === 'merged') labs[l].kept += 1;
        if (r.selfImplemented) labs[l].selfImplemented += 1;
      }
    }
  }

  // Ambition: did the earned headroom pay?
  const scopes = {};
  for (const r of records) {
    const s = r.scope ?? 'unknown';
    scopes[s] ??= { runs: 0, approved: 0, kept: 0 };
    scopes[s].runs += 1;
    if (r.outcome === 'approved') {
      scopes[s].approved += 1;
      if (fateOf(r) === 'merged') scopes[s].kept += 1;
    }
  }

  const campaign = records.filter((r) => r.campaign).length;

  // Measured effect: the same evaluators before and after each approved
  // change (harness/lib/measure.mjs), beside what it cost and what a person
  // then did with it. The one table here that is about the PROJECT rather
  // than the loop — whether the changes that shipped moved anything.
  const measured = approved
    .filter((r) => r.comparison?.comparable)
    .map((r) => ({
      generation: r.generation,
      fate: fateOf(r),
      tokens: Number.isFinite(r.spend?.totalTokens) ? r.spend.totalTokens : null,
      benefits: r.comparison.benefits ?? [],
      regressions: r.comparison.regressions ?? [],
      changed: r.comparison.changed ?? [],
    }));
  const measurement = {
    rows: measured,
    notComparable: approved.filter((r) => r.comparison && !r.comparison.comparable).length,
    withBenefit: measured.filter((m) => m.benefits.length).length,
    withRegression: measured.filter((m) => m.regressions.length).length,
    keptWithRegression: measured.filter((m) => m.regressions.length && m.fate === 'merged').length,
  };

  return {
    total, byOutcome, approved: approved.length, fates,
    releaseYield: { kept, total },
    promotionPrecision: { stayed: fates.merged, landed, closedByOwner: fates.closed },
    failureRecurrence: { recurred, abandoned: n(byOutcome.abandoned) },
    cost: { records: withSpend.length, unknown: total - withSpend.length, tokens, keptWithSpend },
    labs, scopes, campaign, measurement,
  };
}

/** Render the metrics as the REPORT.md page. */
export function renderReport(metrics, { generatedAt = new Date(), generationsDir = 'docs/generations', malformed = 0 } = {}) {
  const m = metrics;
  const date = generatedAt.toISOString().slice(0, 10);
  const lines = [
    `# Self-improvement — operational report`,
    ``,
    `Generated ${date} by \`harness/scripts/report.mjs\` from every \`${generationsDir}/gen-NNN/attempts.json\`. **Do not edit by hand** — the next run overwrites it. The definitions are the paper's §7 metrics (\`Model-Release-Driven-Software-Improvement-Paper-Outline.md\`).`,
    ``,
    `| Metric | Value | Definition |`,
    `|---|---|---|`,
    `| Generations on record | ${m.total}${m.campaign ? ` (${m.campaign} in campaign mode)` : ''} | one per cycle that produced a record |`,
    `| Release yield | ${pct(m.releaseYield.kept, m.releaseYield.total)} (${m.releaseYield.kept} of ${m.releaseYield.total}) | generations whose change a person kept: approved, merged, not reverted |`,
    `| Promotion precision | ${pct(m.promotionPrecision.stayed, m.promotionPrecision.landed)} (${m.promotionPrecision.stayed} of ${m.promotionPrecision.landed} landed) | of the changes that reached the default branch, how many were not reverted |`,
    `| Closed by the owner | ${m.promotionPrecision.closedByOwner} | approved by review, but the pull request was closed unmerged — the reviewer and the owner disagreed |`,
    `| Failure recurrence | ${m.failureRecurrence.abandoned ? `${m.failureRecurrence.recurred} of ${m.failureRecurrence.abandoned} abandoned` : 'no abandoned generations'} | an abandoned proposal whose summary repeats an earlier abandoned one (crude: first 60 characters, normalised) |`,
    `| Tokens spent | ${m.cost.records ? `${m.cost.tokens.toLocaleString()} across ${m.cost.records} generation(s)` : 'not recorded'}${m.cost.unknown ? ` — ${m.cost.unknown} older generation(s) carry no spend` : ''} | input plus output, every model call, from provider-reported usage |`,
    `| Tokens per kept change | ${m.cost.keptWithSpend ? Math.round(m.cost.tokens / m.cost.keptWithSpend).toLocaleString() : 'n/a'} | tokens spent (where recorded) ÷ kept changes among those generations |`,
    ``,
    `## Outcomes`,
    ``,
    `| Outcome | Count |`,
    `|---|---|`,
    ...Object.entries(m.byOutcome).sort().map(([k, v]) => `| ${k} | ${v} |`),
    ``,
    `Of the ${m.approved} approved: ${m.fates.merged} merged and kept, ${m.fates.open} still open as pull requests, ${m.fates.closed} closed unmerged, ${m.fates.reverted} reverted${m.fates.rehearsed ? `, ${m.fates.rehearsed} approved only in a local rehearsal and never put to a person` : ''}.`,
    ``,
    `## By scope`,
    ``,
    `| Scope | Runs | Approved | Kept |`,
    `|---|---|---|---|`,
    ...Object.entries(m.scopes).sort().map(([k, v]) => `| ${k} | ${v.runs} | ${v.approved} (${pct(v.approved, v.runs)}) | ${v.kept} (${pct(v.kept, v.runs)}) |`),
    ``,
    `## By lab`,
    ``,
    `Asked = proposals requested in a fan-out. Chosen = won the ranking. Approved = the chosen proposal passed review. Kept = it merged and stayed. Self-implemented = the suggesting model's own edit blocks shipped.`,
    ``,
    `| Lab | Asked | Chosen | Approved | Kept | Self-implemented |`,
    `|---|---|---|---|---|---|`,
    ...Object.entries(m.labs).sort().map(([k, v]) => `| ${k} | ${v.asked} | ${v.chosen} | ${v.approved} | ${v.kept} | ${v.selfImplemented} |`),
    ``,
  ];
  const ms = m.measurement;
  if (ms && (ms.rows.length || ms.notComparable)) {
    const names = (list) => (list.length ? list.join(', ') : '—');
    lines.push(
      `## Measured effect`,
      ``,
      `The project's own evaluators, run on the untouched tree before each generation and on the changed tree after it — same evaluators, same config, or the pair is not compared. Benefits and regressions follow each metric's declared direction; a metric with no direction is only "changed". Nothing here gates. Fate is what a person did with the change afterwards.`,
      ``,
      `${ms.rows.length} measured change(s): ${ms.withBenefit} moved something the right way, ${ms.withRegression} moved something the wrong way${ms.keptWithRegression ? `, and ${ms.keptWithRegression} of those were kept anyway` : ''}.${ms.notComparable ? ` ${ms.notComparable} more could not be compared, because the evaluators changed between the two measurements.` : ''}`,
      ``,
      `| Generation | Fate | Tokens | Benefits | Regressions | Changed (no direction) |`,
      `|---|---|---|---|---|---|`,
      ...ms.rows.slice(-20).map((r) => `| ${r.generation} | ${r.fate} | ${r.tokens === null ? 'n/a' : r.tokens.toLocaleString()} | ${names(r.benefits)} | ${names(r.regressions)} | ${names(r.changed)} |`),
      ``,
    );
  }
  if (malformed) lines.push(`_${malformed} attempts.json file(s) could not be parsed and are not counted._`, ``);
  return lines.join('\n');
}
