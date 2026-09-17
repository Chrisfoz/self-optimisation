/**
 * The run history: one page a project's owner can open to see every
 * generation, what it tried, what became of it, and what it cost. Written to
 * `<generationsDir>/index.html` beside REPORT.md, from the same records, and
 * rebuilt after every run (persist-records.mjs) and at the start of every
 * cycle, once pull-request fates are read back (report.mjs).
 *
 * REPORT.md is the audit: the paper's metrics, in the paper's terms. This is
 * the progress record: plain words, newest first, the attempts that did not
 * ship shown under the one that did, and a "waiting for you" line at the top.
 * carrotgame's hand-built workflow page grew a table like this and it was the
 * part people actually read; this is the portable version, the same for every
 * installation.
 *
 * Self-contained on purpose: no script, no external stylesheet or font, no
 * image. It opens from disk, from a downloaded artifact, or from GitHub Pages
 * the same way, and it cannot be broken by a content security policy.
 *
 * Every string that reaches the page from a record (model names, change
 * summaries, review reasons, test output) was written or influenced by a
 * model, so all of it is escaped, and a link is rendered only for an https://
 * URL.
 *
 * Pure except for writeReports(), which owns the filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadRecords, computeMetrics, renderReport, fateOf } from './report.mjs';

// Test output carries terminal colour codes; they are noise on a page.
const stripAnsi = (s) => String(s ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');

const esc = (value) => stripAnsi(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** An https:// URL, escaped for an attribute, or null. Anything else (javascript:, data:, relative) is not linked. */
export function safeUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? esc(parsed.href) : null;
  } catch {
    return null;
  }
}

const tokens = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US') : '—');

/** Where a generation ended up, in words an owner uses, and a tone for its badge. */
export function statusOf(record) {
  switch (record?.outcome) {
    case 'approved': {
      const fate = fateOf(record);
      if (fate === 'open') return { label: 'Waiting for your review', tone: 'waiting' };
      if (fate === 'merged') return { label: 'Shipped', tone: 'good' };
      if (fate === 'closed') return { label: 'Closed without merging', tone: 'neutral' };
      if (fate === 'reverted') return { label: 'Shipped, then reverted', tone: 'bad' };
      if (fate === 'rehearsed') return { label: 'Approved in a practice run', tone: 'neutral' };
      return { label: 'Approved', tone: 'good' };
    }
    case 'abandoned': return { label: 'No change survived the checks', tone: 'bad' };
    case 'crashed': return { label: 'Crashed', tone: 'bad' };
    case 'no-proposal': return { label: 'No usable proposal', tone: 'bad' };
    case 'over-budget': return { label: 'Stopped before spending: over budget', tone: 'neutral' };
    default: return { label: record?.outcome ? String(record.outcome) : 'Unknown', tone: 'neutral' };
  }
}

const ATTEMPT_WORDS = {
  approved: 'approved by review',
  'rejected-by-review': 'rejected by review',
  'review-unparseable': 'review could not be read',
  'edits-did-not-apply': 'edits did not apply',
  'tests-failed': "failed the project's tests",
  'needed-files': 'asked to see more files',
  'budget-exhausted': 'stopped: budget used up',
  crashed: 'crashed',
};

/** The change, in the words closest to what shipped: the approved attempt's summary, else the proposal's. */
export function changeOf(record) {
  const approved = (record?.attempts ?? []).find((a) => a.outcome === 'approved');
  return approved?.detail || record?.proposalSummary || '';
}

const labOf = (s) => String(s ?? '').replace(/\s*\([^)]*\)\s*$/, '');

/**
 * @param {object} opts
 * @param {object[]} opts.records    loadRecords().records, oldest first
 * @param {object} [opts.ledger]     the escalation ledger, if there is one
 * @param {string} [opts.projectName]
 * @param {Date} [opts.generatedAt]
 * @param {string} [opts.generationsDir]
 * @returns {string} a complete HTML document
 */
export function renderRunHistory({ records = [], ledger = null, projectName = 'This project', generatedAt = new Date(), generationsDir = 'docs/generations' } = {}) {
  const metrics = computeMetrics(records);
  const newestFirst = [...records].reverse();
  const waiting = records.filter((r) => r.outcome === 'approved' && fateOf(r) === 'open');
  const shipped = metrics.fates.merged;
  const didNotShip = records.filter((r) => ['abandoned', 'crashed', 'no-proposal'].includes(r.outcome)).length;
  const cacheRead = records.reduce((s, r) => s + (Number.isFinite(r.spend?.cacheReadTokens) ? r.spend.cacheReadTokens : 0), 0);

  const card = (value, label, note = '') => `<div class="card"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div>${note ? `<div class="note">${esc(note)}</div>` : ''}</div>`;

  const waitingBlock = waiting.length
    ? `<section class="callout"><h2>Waiting for you</h2><ul>${waiting.map((r) => {
        const url = safeUrl(r.pullRequestUrl ?? r.pullRequest?.url);
        const text = `Generation ${esc(r.generation)}: ${esc(changeOf(r))}`;
        return `<li>${url ? `<a href="${url}">${text}</a>` : text}</li>`;
      }).join('')}</ul><p>Each passed every check the loop runs. Nothing merges until you do.</p></section>`
    : '';

  const attemptList = (r) => {
    const attempts = r.attempts ?? [];
    if (!attempts.length) return '';
    const items = attempts.map((a) => `<li><span class="who">${esc(a.by ?? '—')}</span> ${esc(ATTEMPT_WORDS[a.outcome] ?? a.outcome ?? '')}${a.detail && a.outcome !== 'approved' ? `<div class="detail">${esc(a.detail)}</div>` : ''}</li>`).join('');
    return `<details><summary>${attempts.length} attempt${attempts.length === 1 ? '' : 's'}</summary><ol>${items}</ol></details>`;
  };

  const rows = newestFirst.map((r) => {
    const status = statusOf(r);
    const pr = safeUrl(r.pullRequestUrl ?? r.pullRequest?.url);
    const run = safeUrl(r.run?.url);
    const asked = r.fanOut?.asked?.length ?? 0;
    const suggester = r.fanOut?.chosen ?? r.suggestModel;
    const by = suggester ? `${esc(labOf(suggester))}${asked > 1 ? ` <span class="muted">(1 of ${asked} asked)</span>` : ''}` : '<span class="muted">—</span>';
    const wrote = r.outcome === 'approved' && r.implementedBy ? `<div class="muted">written by ${esc(labOf(r.implementedBy))}</div>` : '';
    const why = r.campaign ? 'models named by hand' : 'new model release';
    const cache = Number.isFinite(r.spend?.cacheReadTokens) ? `<div class="muted">${tokens(r.spend.cacheReadTokens)} from cache</div>` : '';
    const links = [pr ? `<a href="${pr}">pull request</a>` : '', run ? `<a href="${run}">run</a>` : ''].filter(Boolean).join(' · ');
    return `<tr>
<td class="gen">${esc(r.generation)}<div class="muted">${esc(r.date ?? '')}</div></td>
<td>${by}${wrote}<div class="muted">${esc(why)}</div></td>
<td class="change">${esc(changeOf(r)) || '<span class="muted">—</span>'}${attemptList(r)}</td>
<td><span class="badge ${status.tone}">${esc(status.label)}</span>${links ? `<div class="links">${links}</div>` : ''}</td>
<td class="num">${tokens(r.spend?.totalTokens)}${cache}</td>
</tr>`;
  }).join('\n');

  const open = (ledger?.escalations ?? []).filter((e) => e.status === 'open' || e.status === 'flagged');
  const escalations = open.length
    ? `<section><h2>Changes the models asked for but may not make</h2><p class="muted">A model can argue for a change to something it is not allowed to edit. You decide: set the entry's status in <code>docs/escalations/ledger.json</code>.</p><ul class="escalations">${open.map((e) => `<li><b>${esc(e.id)}</b> ${esc(e.title)} <span class="muted">(${esc(e.target ?? '')}${e.status === 'flagged' ? ', enough models agree' : ''}; backed by ${esc((e.supporters ?? []).length)})</span></li>`).join('')}</ul></section>`
    : '';

  const body = records.length
    ? `<div class="cards">
${card(records.length, records.length === 1 ? 'run' : 'runs')}
${card(shipped, shipped === 1 ? 'change shipped' : 'changes shipped', 'merged and kept')}
${card(waiting.length, 'waiting for you', 'open pull requests')}
${card(didNotShip, "didn't produce a change")}
${card(tokens(metrics.cost.tokens), 'tokens spent', cacheRead ? `${tokens(cacheRead)} read from cache` : 'input plus output, all models')}
</div>
${waitingBlock}
<section><h2>Every run</h2>
<div class="scroll"><table>
<thead><tr><th>Gen</th><th>Suggested by</th><th>Change, or what was tried</th><th>Outcome</th><th class="num">Tokens</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<p class="muted">Tokens are what each lab reported. They aren't dollars: most are input, the models reading your code, which costs far less than output.</p>
</section>
${escalations}`
    : `<section class="callout"><h2>No runs yet</h2><p>This page fills in after the first generation. The loop runs when a watched lab releases a new model, checked on its schedule, or when you start it with named models from the Actions tab.</p></section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(projectName)} — run history</title>
<style>
:root { --bg:#fbfaf7; --ink:#1d2330; --muted:#636b7a; --line:#e3e0d8; --card:#ffffff; --good:#1f7a4d; --good-bg:#e5f4ea; --bad:#a3342b; --bad-bg:#fbe9e7; --wait:#8a5a00; --wait-bg:#fff2d6; --neutral:#4b5563; --neutral-bg:#eceff3; --link:#1d5fbf; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171d; --ink:#e7e9ee; --muted:#9aa3b2; --line:#2b313b; --card:#1b1f27; --good:#7fd3a3; --good-bg:#16301f; --bad:#f2a49b; --bad-bg:#3a1c19; --wait:#f3c77a; --wait-bg:#3a2c10; --neutral:#c3c9d3; --neutral-bg:#262b34; --link:#8ab4f8; } }
* { box-sizing: border-box; }
body { margin:0; padding:32px 16px 48px; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1100px; margin:0 auto; }
h1 { font-size:28px; margin:0 0 4px; } h2 { font-size:19px; margin:28px 0 10px; }
.muted { color:var(--muted); font-size:13px; }
a { color:var(--link); }
code { font-size:13px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-top:24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.card .value { font-size:26px; font-weight:650; font-variant-numeric:tabular-nums; }
.card .label { font-weight:600; } .card .note { color:var(--muted); font-size:13px; }
.callout { background:var(--wait-bg); border:1px solid var(--line); border-radius:10px; padding:4px 18px 8px; margin-top:20px; }
.scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
table { border-collapse:collapse; width:100%; min-width:760px; }
th, td { text-align:left; vertical-align:top; padding:10px 12px; border-bottom:1px solid var(--line); }
th { font-size:13px; color:var(--muted); font-weight:600; } tbody tr:last-child td { border-bottom:0; }
td.gen { font-weight:650; white-space:nowrap; } td.change { max-width:440px; }
.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:13px; font-weight:600; }
.badge.good { color:var(--good); background:var(--good-bg); } .badge.bad { color:var(--bad); background:var(--bad-bg); }
.badge.waiting { color:var(--wait); background:var(--wait-bg); } .badge.neutral { color:var(--neutral); background:var(--neutral-bg); }
.links { margin-top:6px; font-size:13px; }
details { margin-top:6px; font-size:13px; } summary { cursor:pointer; color:var(--muted); }
details ol { margin:6px 0 0; padding-left:20px; } details li { margin:4px 0; }
.who { font-weight:600; } .detail { color:var(--muted); overflow-wrap:anywhere; }
.escalations li { margin:6px 0; }
footer { margin-top:32px; }
</style>
</head>
<body>
<main>
<h1>${esc(projectName)}: self-improvement run history</h1>
<p class="muted">Rebuilt by the harness after every run, from <code>${esc(generationsDir)}/gen-NNN/attempts.json</code>. Last updated ${esc(generatedAt.toISOString().slice(0, 10))}. Don't edit this file; the next run replaces it.</p>
${body}
<footer class="muted"><p>The metrics behind these numbers, in more detail: <code>${esc(generationsDir)}/REPORT.md</code>.</p></footer>
</main>
</body>
</html>
`;
}

/**
 * Regenerate REPORT.md and index.html from the records on disk. Never throws
 * for a bad ledger; returns the repo-relative paths written.
 *
 * @param {{repoRoot?: string, generationsDir?: string, ledgerPath?: string, projectName?: string, generatedAt?: Date}} [opts]
 */
export function writeReports({ repoRoot = process.cwd(), generationsDir = 'docs/generations', ledgerPath = 'docs/escalations/ledger.json', projectName = 'This project', generatedAt = new Date() } = {}) {
  const { records, malformed } = loadRecords({ repoRoot, generationsDir });
  let ledger = null;
  try { ledger = JSON.parse(fs.readFileSync(path.join(repoRoot, ledgerPath), 'utf8')); } catch { /* no ledger yet */ }
  fs.mkdirSync(path.join(repoRoot, generationsDir), { recursive: true });
  const reportPath = `${generationsDir}/REPORT.md`;
  const historyPath = `${generationsDir}/index.html`;
  fs.writeFileSync(path.join(repoRoot, reportPath), renderReport(computeMetrics(records), { generatedAt, generationsDir, malformed }), 'utf8');
  fs.writeFileSync(path.join(repoRoot, historyPath), renderRunHistory({ records, ledger, projectName, generatedAt, generationsDir }), 'utf8');
  return [reportPath, historyPath];
}
