import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderRunHistory, statusOf, changeOf, safeUrl, writeReports } from '../../harness/lib/run-history.mjs';

// The owner's page: every run, newest first, in plain words. Every string on
// it came from a record a model wrote into, so escaping and link safety are
// tested as carefully as the content.

const approvedOpen = {
  generation: '005', date: '2026-09-17', outcome: 'approved', campaign: true,
  fanOut: { asked: ['gemini-3.8-flash (google)'], chosen: 'gemini-3.8-flash (google)' },
  implementedBy: 'claude-opus-5',
  proposalSummary: 'long proposal text',
  attempts: [
    { attempt: 1, by: 'gemini-3.8-flash (google)', outcome: 'tests-failed', detail: 'npm test: exit 1 [39mTests: 2 failed[0m' },
    { attempt: 2, by: 'claude-opus-5', outcome: 'approved', detail: 'Close persona dialogue on a tap outside it' },
  ],
  spend: { totalTokens: 1154965, cacheReadTokens: 50000 },
  pullRequestUrl: 'https://github.com/o/r/pull/53',
  run: { url: 'https://github.com/o/r/actions/runs/1', source: 'github-actions' },
};
const crashed = {
  generation: '003', date: '2026-09-17', outcome: 'crashed', campaign: true, suggestModel: 'gpt-6-astra (openai)',
  proposalSummary: 'Make each pending exchange belong to its persona',
  attempts: [{ attempt: 1, by: 'claude-opus-5', outcome: 'crashed', detail: 'Stage 2 response was truncated' }],
  spend: { totalTokens: 1057031 },
};
const merged = { generation: '002', date: '2026-09-10', outcome: 'approved', pullRequestUrl: 'https://github.com/o/r/pull/9', pullRequest: { state: 'merged' }, attempts: [{ outcome: 'approved', detail: 'Add a pause button' }] };

test('statusOf: plain words for every outcome, and an opened pull request not yet read back is waiting, not shipped', () => {
  assert.equal(statusOf(approvedOpen).label, 'Waiting for your review');
  assert.equal(statusOf({ ...approvedOpen, pullRequest: { state: 'closed' } }).label, 'Closed without merging');
  assert.equal(statusOf({ outcome: 'approved', reverted: {} }).label, 'Shipped, then reverted');
  assert.equal(statusOf({ outcome: 'approved', run: { source: 'local' } }).label, 'Approved in a practice run');
  assert.equal(statusOf(crashed).label, 'Crashed');
  assert.equal(statusOf({ outcome: 'abandoned' }).label, 'No change survived the checks');
  assert.equal(statusOf({ outcome: 'no-proposal' }).label, 'No usable proposal');
});

test('changeOf: the approved attempt summary first, the proposal otherwise', () => {
  assert.equal(changeOf(approvedOpen), 'Close persona dialogue on a tap outside it');
  assert.equal(changeOf(crashed), 'Make each pending exchange belong to its persona');
  assert.equal(changeOf({}), '');
});

test('the page: newest first, a waiting-for-you list, failed attempts with reasons, tokens and cache', () => {
  const html = renderRunHistory({ records: [merged, crashed, approvedOpen], projectName: 'demo' });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.indexOf('>005<') < html.indexOf('>003<') && html.indexOf('>003<') < html.indexOf('>002<'), 'newest first');
  assert.match(html, /Waiting for you<\/h2>[\s\S]*href="https:\/\/github\.com\/o\/r\/pull\/53"/);
  assert.match(html, /failed the project&#39;s tests/);
  assert.match(html, /Tests: 2 failed/);
  assert.doesNotMatch(html, /|\[39m/, 'terminal colour codes stripped');
  assert.match(html, /1,154,965/);
  assert.match(html, /50,000 from cache/);
  assert.match(html, /1 of 3|1<\/div><div class="label">change shipped/);
  assert.match(html, /models named by hand/);
});

test('the page: model-written text is escaped, and only https links are rendered', () => {
  const hostile = {
    generation: '009', outcome: 'approved', proposalSummary: 'x',
    attempts: [{ outcome: 'approved', detail: '<script>alert(1)</script><img src=x onerror=alert(2)>' }],
    pullRequestUrl: 'javascript:alert(3)',
    run: { url: 'data:text/html,<b>x</b>' },
    suggestModel: '"><svg onload=alert(4)> (evil)',
  };
  const html = renderRunHistory({ records: [hostile] });
  assert.doesNotMatch(html, /<script>alert|<img src=x|<svg onload/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /javascript:|data:text/);
  assert.equal(safeUrl('https://github.com/o/r/pull/1?a="b"'), 'https://github.com/o/r/pull/1?a=%22b%22');
  assert.equal(safeUrl('http://github.com'), null);
});

test('the page: self-contained, with nothing to load and nothing to run', () => {
  const html = renderRunHistory({ records: [approvedOpen] });
  assert.doesNotMatch(html, /<script|<link |<img |@import|url\(|src=/i);
});

test('the page: no runs yet says so instead of an empty table', () => {
  const html = renderRunHistory({ records: [] });
  assert.match(html, /No runs yet/);
  assert.doesNotMatch(html, /<table/);
});

test('the page: open and flagged escalations are listed, settled ones are not', () => {
  const ledger = { escalations: [
    { id: 'esc-001', title: 'Settled', status: 'superseded', target: 'pipeline', supporters: [] },
    { id: 'esc-002', title: 'Make the retrieval services editable', status: 'open', target: 'hard-constraint', supporters: [{}] },
  ] };
  const html = renderRunHistory({ records: [approvedOpen], ledger });
  assert.match(html, /esc-002/);
  assert.doesNotMatch(html, /esc-001/);
});

test('writeReports: REPORT.md and index.html from the records on disk, and the report script writes both', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const r of [crashed, approvedOpen]) {
    fs.mkdirSync(path.join(repoRoot, 'docs/generations', `gen-${r.generation}`), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs/generations', `gen-${r.generation}`, 'attempts.json'), JSON.stringify(r));
  }
  const written = writeReports({ repoRoot, projectName: 'demo' });
  assert.deepEqual(written, ['docs/generations/REPORT.md', 'docs/generations/index.html']);
  assert.match(fs.readFileSync(path.join(repoRoot, 'docs/generations/index.html'), 'utf8'), /demo: self-improvement run history/);
  assert.match(fs.readFileSync(path.join(repoRoot, 'docs/generations/REPORT.md'), 'utf8'), /1 still open as pull requests/);

  fs.rmSync(path.join(repoRoot, 'docs/generations/index.html'));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'harness', 'scripts', 'report.mjs');
  const result = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, GITHUB_WORKSPACE: repoRoot, GITHUB_OUTPUT: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(repoRoot, 'docs/generations/index.html')), 'report.mjs writes the page too');
});
