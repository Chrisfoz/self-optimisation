import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  emptyLedger, loadLedger, saveLedger, parseEscalation, consensusOf,
  recordRound, buildEscalationBrief, renderForNotification, slugify, CONSENSUS,
} from '../../harness/lib/escalations.mjs';

function tempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'escalations-test-'));
}

test('emptyLedger has the expected shape', () => {
  const ledger = emptyLedger();
  assert.equal(ledger.version, 1);
  assert.deepEqual(ledger.consensus, CONSENSUS);
  assert.deepEqual(ledger.escalations, []);
});

test('loadLedger returns an empty ledger when the file does not exist', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  assert.deepEqual(loadLedger({ repoRoot }), emptyLedger());
});

test('loadLedger returns an empty ledger on malformed JSON rather than throwing', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repoRoot, 'docs/escalations'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'docs/escalations/ledger.json'), '{not json');
  assert.deepEqual(loadLedger({ repoRoot }), emptyLedger());
});

test('saveLedger then loadLedger round-trips, and respects a custom ledgerPath', (t) => {
  const repoRoot = tempRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const ledger = { ...emptyLedger(), escalations: [{ id: 'esc-001', title: 'test' }] };
  saveLedger(ledger, { repoRoot, ledgerPath: 'custom/ledger.json' });
  assert.ok(fs.existsSync(path.join(repoRoot, 'custom/ledger.json')));
  const loaded = loadLedger({ repoRoot, ledgerPath: 'custom/ledger.json' });
  assert.equal(loaded.escalations[0].id, 'esc-001');
});

test('parseEscalation: "none" fields parse to a null opened case', () => {
  const parsed = parseEscalation('ESCALATION: none\nESCALATION TARGET: none\nESCALATION CASE: none\n');
  assert.equal(parsed.opened, null);
  assert.deepEqual(parsed.supports, []);
  assert.deepEqual(parsed.dissents, []);
});

test('parseEscalation: a real case parses title, target and body', () => {
  const text = [
    'SUMMARY: some proposal',
    'ESCALATION: Let the agent edit the workflow schedule',
    'ESCALATION TARGET: pipeline',
    'ESCALATION CASE: The monthly cadence misses same-week releases from two labs.',
    'ESCALATION SUPPORT: none',
    'ESCALATION DISSENT: none',
  ].join('\n');
  const parsed = parseEscalation(text);
  assert.ok(parsed.opened);
  assert.equal(parsed.opened.title, 'Let the agent edit the workflow schedule');
  assert.equal(parsed.opened.target, 'pipeline');
  assert.match(parsed.opened.case, /misses same-week releases/);
});

test('parseEscalation: SUPPORT/DISSENT lines extract ids and trailing notes', () => {
  const text = 'ESCALATION: none\nESCALATION SUPPORT: esc-001 — because it would help ages 3-8\nESCALATION DISSENT: esc-002: too risky\n';
  const parsed = parseEscalation(text);
  assert.deepEqual(parsed.supports.map((s) => s.id), ['esc-001']);
  assert.match(parsed.supports[0].note, /help ages 3-8/);
  assert.deepEqual(parsed.dissents.map((d) => d.id), ['esc-002']);
});

test('consensusOf counts DISTINCT models and labs, not raw supporter count', () => {
  const entry = {
    supporters: [
      { model: 'claude-opus-5', provider: 'anthropic' },
      { model: 'claude-opus-5', provider: 'anthropic' }, // same model twice — should not double count
      { model: 'gpt-5', provider: 'openai' },
    ],
  };
  const c = consensusOf(entry, { models: 3, labs: 2 });
  assert.equal(c.models, 2);
  assert.equal(c.labs, 2);
  assert.equal(c.reached, false); // needs 3 models, has 2
});

test('recordRound: opens a new escalation from one model asking', () => {
  const ledger = emptyLedger();
  const entries = [{
    model: 'claude-opus-5', provider: 'anthropic',
    parsed: parseEscalation('ESCALATION: Widen the token budget\nESCALATION TARGET: pipeline\nESCALATION CASE: Real prompts run over the current cap.\n'),
  }];
  const result = recordRound({ generation: '001', entries, ledger });
  assert.equal(result.ledger.escalations.length, 1);
  assert.equal(result.opened.length, 1);
  assert.equal(result.ledger.escalations[0].status, 'open');
  // The opener counts as the first supporter.
  assert.equal(result.ledger.escalations[0].supporters.length, 1);
});

test('recordRound: a second model raising the SAME title backs it instead of duplicating', () => {
  const ledger = emptyLedger();
  const case1 = parseEscalation('ESCALATION: Widen the token budget\nESCALATION TARGET: pipeline\nESCALATION CASE: Real prompts run over the current cap.\n');
  const case2 = parseEscalation('ESCALATION: Widen the token budget\nESCALATION TARGET: pipeline\nESCALATION CASE: Same problem, independently observed.\n');

  const round1 = recordRound({ generation: '001', entries: [{ model: 'claude-opus-5', provider: 'anthropic', parsed: case1 }], ledger });
  const round2 = recordRound({ generation: '002', entries: [{ model: 'gpt-5', provider: 'openai', parsed: case2 }], ledger: round1.ledger });

  assert.equal(round2.ledger.escalations.length, 1); // still one entry, not two
  assert.equal(round2.ledger.escalations[0].supporters.length, 2);
  assert.equal(round2.supported.length, 1);
  assert.equal(round2.opened.length, 0);
});

test('recordRound: flags an escalation once consensus is reached, and stays flagged (does not re-flag)', () => {
  let ledger = emptyLedger();
  const threshold = { models: 3, labs: 2 };
  const openCase = () => parseEscalation('ESCALATION: Loosen a frozen path\nESCALATION TARGET: hard-constraint\nESCALATION CASE: Reasoned case for it.\n');
  const support = () => parseEscalation(`ESCALATION: none\nESCALATION SUPPORT: esc-001 — agreed\n`);

  let r = recordRound({ generation: '001', entries: [{ model: 'claude-opus-5', provider: 'anthropic', parsed: openCase() }], ledger, threshold });
  ledger = r.ledger;
  assert.equal(ledger.escalations[0].status, 'open');

  r = recordRound({ generation: '002', entries: [{ model: 'gpt-5', provider: 'openai', parsed: support() }], ledger, threshold });
  ledger = r.ledger;
  assert.equal(ledger.escalations[0].status, 'open'); // 2 models, 2 labs — not yet 3 models

  r = recordRound({ generation: '003', entries: [{ model: 'grok-4.6', provider: 'xai', parsed: support() }], ledger, threshold });
  ledger = r.ledger;
  assert.equal(ledger.escalations[0].status, 'flagged'); // 3 models, 2 labs — reached
  assert.equal(r.flagged.length, 1);

  // A 4th supporter must not re-flag (flagged.length should be 0 this round).
  const case4 = parseEscalation('ESCALATION: none\nESCALATION SUPPORT: esc-001\n');
  r = recordRound({ generation: '004', entries: [{ model: 'kimi-k3', provider: 'moonshot', parsed: case4 }], ledger, threshold });
  assert.equal(r.flagged.length, 0);
  assert.equal(r.ledger.escalations[0].status, 'flagged');
});

test('recordRound: support/dissent against a resolved entry is ignored', () => {
  let ledger = emptyLedger();
  ledger.escalations.push({
    id: 'esc-001', slug: slugify('settled thing'), title: 'settled thing', target: 'pipeline',
    status: 'declined', opened: { generation: '001', date: '2026-01-01', model: 'x', provider: 'y' },
    case: 'x', supporters: [], dissenters: [], flagged: null, resolution: 'Not doing this.',
  });
  const parsed = parseEscalation('ESCALATION: none\nESCALATION SUPPORT: esc-001\n');
  const r = recordRound({ generation: '005', entries: [{ model: 'claude-opus-5', provider: 'anthropic', parsed }], ledger });
  assert.equal(r.supported.length, 0);
  assert.equal(r.ledger.escalations[0].supporters.length, 0);
});

test('buildEscalationBrief returns null for an empty ledger', () => {
  assert.equal(buildEscalationBrief(emptyLedger()), null);
});

test('buildEscalationBrief renders live and settled entries differently', () => {
  const ledger = {
    ...emptyLedger(),
    escalations: [
      {
        id: 'esc-001', title: 'Live one', target: 'pipeline', status: 'open',
        opened: { generation: '001', model: 'claude-opus-5', provider: 'anthropic' },
        case: 'A real case.', supporters: [{ model: 'claude-opus-5', provider: 'anthropic', generation: '001' }], dissenters: [],
      },
      {
        id: 'esc-002', title: 'Settled one', target: 'hard-constraint', status: 'declined',
        opened: { generation: '001', model: 'gpt-5', provider: 'openai' },
        case: 'x', supporters: [], dissenters: [], resolution: 'Rejected: not worth the risk.',
      },
    ],
  };
  const brief = buildEscalationBrief(ledger);
  assert.match(brief, /esc-001 — Live one/);
  assert.match(brief, /esc-002 — Settled one/);
  assert.match(brief, /DECLINED by the project's owner/);
  assert.match(brief, /Rejected: not worth the risk\./);
});

test('renderForNotification formats a flagged entry with backers and dissenters', () => {
  const entry = {
    id: 'esc-003', title: 'Widen scope', target: 'pipeline',
    opened: { model: 'claude-opus-5', provider: 'anthropic', generation: '001' },
    case: 'The case text.',
    supporters: [
      { model: 'claude-opus-5', provider: 'anthropic', generation: '001', note: '' },
      { model: 'gpt-5', provider: 'openai', generation: '002', note: 'agreed' },
    ],
    dissenters: [{ model: 'grok-4.6', provider: 'xai', generation: '003', note: 'too risky' }],
  };
  const rendered = renderForNotification(entry);
  assert.match(rendered, /esc-003 — Widen scope/);
  assert.match(rendered, /Backed by:/);
  assert.match(rendered, /gpt-5 \(openai, generation 002\)/);
  assert.match(rendered, /Argued against by:/);
  assert.match(rendered, /too risky/);
});
