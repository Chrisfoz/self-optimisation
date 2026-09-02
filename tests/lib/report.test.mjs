import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecords, computeMetrics, renderReport, fateOf } from '../../harness/lib/report.mjs';

const rec = (over) => ({ outcome: 'approved', scope: 'focused', attempts: [{ attempt: 1, outcome: 'approved' }], fanOut: { asked: ['a (anthropic)', 'g (openai)'], chosen: 'a (anthropic)' }, suggestModel: 'a (anthropic)', ...over });

const RECORDS = [
  rec({ generation: '001', spend: { totalTokens: 1000 } }),
  rec({ generation: '002', pullRequest: { state: 'closed' }, spend: { totalTokens: 1000 } }),
  rec({ generation: '003', reverted: { date: 'd' }, spend: { totalTokens: 2000 }, scope: 'ambitious' }),
  rec({ generation: '004', outcome: 'abandoned', proposalSummary: 'Add a pause button to the game', spend: { totalTokens: 500 } }),
  rec({ generation: '005', outcome: 'abandoned', proposalSummary: 'Add a Pause button to the game!', spend: { totalTokens: 500 } }),
  rec({ generation: '006', outcome: 'no-proposal', fanOut: { asked: ['g (openai)'], chosen: null }, suggestModel: null }),
  rec({ generation: '007', selfImplemented: true, fanOut: { asked: ['g (openai)'], chosen: 'g (openai)' }, suggestModel: 'g (openai)', campaign: true }),
];

test('fateOf mirrors context-pack: reverted, closed, open, else merged', () => {
  assert.equal(fateOf({ reverted: {} }), 'reverted');
  assert.equal(fateOf({ pullRequest: { state: 'closed' } }), 'closed');
  assert.equal(fateOf({ pullRequest: { state: 'open' } }), 'open');
  assert.equal(fateOf({}), 'merged');
});

test('computeMetrics: yield, precision, recurrence, cost and per-lab/per-scope counts from the records alone', () => {
  const m = computeMetrics(RECORDS);
  assert.equal(m.total, 7);
  assert.deepEqual(m.byOutcome, { approved: 4, abandoned: 2, 'no-proposal': 1 });
  assert.deepEqual(m.fates, { merged: 2, open: 0, closed: 1, reverted: 1 });
  assert.deepEqual(m.releaseYield, { kept: 2, total: 7 });
  assert.deepEqual(m.promotionPrecision, { stayed: 2, landed: 3, closedByOwner: 1 });
  assert.deepEqual(m.failureRecurrence, { recurred: 1, abandoned: 2 });
  assert.deepEqual(m.cost, { records: 5, unknown: 2, tokens: 5000, keptWithSpend: 1 });
  assert.deepEqual(m.labs.anthropic, { asked: 5, chosen: 5, approved: 3, kept: 1, selfImplemented: 0 });
  assert.deepEqual(m.labs.openai, { asked: 7, chosen: 1, approved: 1, kept: 1, selfImplemented: 1 });
  assert.deepEqual(m.scopes.ambitious, { runs: 1, approved: 1, kept: 0 });
  assert.equal(m.campaign, 1);
});

test('computeMetrics on no records yields zeros and n/a, never NaN', () => {
  const page = renderReport(computeMetrics([]));
  assert.doesNotMatch(page, /NaN/);
  assert.match(page, /Release yield \| n\/a/);
  assert.match(page, /Tokens spent \| not recorded/);
});

test('renderReport: a generated page with the header, the four tables, and no hand-editable claims', () => {
  const page = renderReport(computeMetrics(RECORDS), { generatedAt: new Date('2026-09-02T00:00:00Z'), malformed: 1 });
  assert.match(page, /^# Self-improvement — operational report/);
  assert.match(page, /Generated 2026-09-02/);
  assert.match(page, /Do not edit by hand/);
  assert.match(page, /Release yield \| 29% \(2 of 7\)/);
  assert.match(page, /Promotion precision \| 67% \(2 of 3 landed\)/);
  assert.match(page, /1 of 2 abandoned/);
  assert.match(page, /5,000 across 5 generation\(s\) — 2 older generation\(s\) carry no spend/);
  assert.match(page, /\| openai \| 7 \| 1 \| 1 \| 1 \| 1 \|/);
  assert.match(page, /1 attempts.json file\(s\) could not be parsed/);
  assert.match(page, /\(1 in campaign mode\)/);
});

test('loadRecords reads every gen-NNN/attempts.json oldest first and counts malformed ones', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'report-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const [g, body] of [['002', '{"outcome":"approved"}'], ['001', '{"outcome":"abandoned"}'], ['003', '{not json']]) {
    fs.mkdirSync(path.join(repoRoot, 'docs/generations', `gen-${g}`), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs/generations', `gen-${g}`, 'attempts.json'), body);
  }
  const { records, malformed } = loadRecords({ repoRoot });
  assert.deepEqual(records.map((r) => r.generation), ['001', '002']);
  assert.equal(malformed, 1);
  assert.deepEqual(loadRecords({ repoRoot: path.join(repoRoot, 'nowhere') }), { records: [], malformed: 0 });
});
