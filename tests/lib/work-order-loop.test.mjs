import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { compileAllowlist } from '../../harness/lib/edit-format.mjs';
import { runGeneration, takeWorkOrder } from '../../harness/lib/orchestrator.mjs';
import { loadLedger, saveLedger, emptyLedger } from '../../harness/lib/escalations.mjs';

/**
 * The work-order loop, driven through runGeneration() with the model calls
 * faked — the same boundary every other test here draws.
 *
 * What this proves that the unit tests cannot: the queue is actually drained
 * by a real run, the assignment reaches the suggestion prompt, and the
 * outcome label is written back when the run finishes — including when it
 * finishes badly. Before this component, acceptance changed a status field
 * and scheduled nothing; the run below is what "and then something happens"
 * looks like.
 */

const LEDGER = 'docs/escalations/ledger.json';

function repoWithAcceptedEscalation({ status = 'accepted' } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-order-'));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');
  saveLedger(
    {
      ...emptyLedger(),
      escalations: [{
        id: 'esc-001',
        slug: 'widen-the-brief',
        title: 'Widen the brief to allow test files',
        target: 'agent-brief',
        status,
        opened: { generation: '003', date: '2026-01-01', model: 'm1', provider: 'p1' },
        case: 'The brief forbids touching tests, so no proposal can ever add one. '.repeat(4),
        supporters: [
          { generation: '003', model: 'm1', provider: 'p1', note: '' },
          { generation: '004', model: 'm2', provider: 'p2', note: '' },
          { generation: '005', model: 'm3', provider: 'p1', note: '' },
        ],
        dissenters: [{ generation: '006', model: 'm9', provider: 'p2', note: 'it will break the guard' }],
        flagged: { generation: '005', date: '2026-01-05', models: ['m1', 'm2', 'm3'], labs: ['p1', 'p2'] },
        resolution: 'Agreed — append-only tests are enough of a guard.',
      }],
    },
    { repoRoot, ledgerPath: LEDGER }
  );
  return repoRoot;
}

const SUGGESTION = `PILLAR: Feedback Loops
PROBLEM: no pause button exists
CHANGE: add a pause button to index.html
WHY THIS ONE: it is the highest-value gap
RISK: none
ALSO UPDATE: nothing
VERIFICATION: the button should be visible
BRIEF FEEDBACK: clear
ESCALATION: none
ESCALATION TARGET: none
ESCALATION CASE: none
ESCALATION SUPPORT: none
ESCALATION DISSENT: none

<<<EDIT>>>
FILE: index.html
<<<SEARCH>>>
original content
<<<REPLACE>>>
original content with a pause button
<<<END>>>`;

function config(repoRoot, overrides = {}) {
  return {
    repoRoot,
    genNumber: '011',
    agentBrief: 'THE PROJECT BRIEF',
    reviewerBrief: 'THE REVIEWER BRIEF.',
    editableFiles: ['index.html'],
    allowlist: compileAllowlist({ allowedPaths: ['index.html'] }),
    suggestModels: [{ id: 'suggest-model', provider: 'anthropic' }],
    implementModel: 'implement-model',
    reviewModel: 'review-model',
    rankModel: 'rank-model',
    maxAttempts: 1,
    scope: { scope: 'ambitious', reason: 'two focused generations in a row' },
    projectDescription: 'a test project',
    context: { manifest: 'MANIFEST', sources: 'SOURCE' },
    ledgerPath: LEDGER,
    ...overrides,
  };
}

function recordingCall(prompts, { verdict = 'APPROVED' } = {}) {
  return async ({ model, user, system }) => {
    prompts.push({ model, user, system });
    if (model === 'suggest-model') return { text: SUGGESTION, truncated: false, provider: 'anthropic', sentImages: 0 };
    if (model === 'review-model') return { text: `VERDICT: ${verdict}\nREASON: fine`, truncated: false };
    if (model === 'implement-model') {
      return { text: `SUMMARY: a pause button\nRATIONALE: as decided\n\n<<<EDIT>>>\nFILE: index.html\n<<<SEARCH>>>\noriginal content\n<<<REPLACE>>>\noriginal content with a pause button\n<<<END>>>`, truncated: false };
    }
    throw new Error(`unexpected call: ${model}`);
  };
}

test('an ambitious run takes the queued work order, is told what it is, and records the outcome', async (t) => {
  const repoRoot = repoWithAcceptedEscalation();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const prompts = [];
  const result = await runGeneration(config(repoRoot), { call: recordingCall(prompts) });

  assert.equal(result.outcome, 'approved');
  assert.deepEqual(result.workOrder, { id: 'esc-001', title: 'Widen the brief to allow test files', outcome: 'approved' });

  // The suggesting model was told the change is decided, not asked to choose.
  const suggestPrompt = prompts.find((p) => p.model === 'suggest-model').user;
  assert.match(suggestPrompt, /THIS GENERATION HAS BEEN ASSIGNED A DECIDED CHANGE/);
  assert.match(suggestPrompt, /esc-001 — Widen the brief to allow test files/);
  assert.doesNotMatch(suggestPrompt, /Pick the ONE improvement you would make/);

  const ledger = loadLedger({ repoRoot, ledgerPath: LEDGER });
  const entry = ledger.escalations[0];
  assert.equal(entry.status, 'accepted', "the human's decision does not expire");
  assert.equal(entry.work.assigned.generation, '011');
  assert.equal(entry.work.completed.outcome, 'approved');
  // 8d: it shipped, so the model that said it would break is on record.
  assert.equal(entry.dissenters[0].contradicted.by, 'the accepted change shipped');
});

test('the same order is not handed to a second run', async (t) => {
  const repoRoot = repoWithAcceptedEscalation();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  await runGeneration(config(repoRoot), { call: recordingCall([]) });

  const prompts = [];
  const second = await runGeneration(config(repoRoot, { genNumber: '012' }), { call: recordingCall(prompts) });
  assert.equal(second.workOrder, null);
  assert.doesNotMatch(prompts.find((p) => p.model === 'suggest-model').user, /ASSIGNED A DECIDED CHANGE/);
});

test('a focused run leaves the queue alone — an accepted escalation is not a small, localised change', async (t) => {
  const repoRoot = repoWithAcceptedEscalation();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const prompts = [];
  const result = await runGeneration(
    config(repoRoot, { scope: { scope: 'focused', reason: 'default' } }),
    { call: recordingCall(prompts) }
  );
  assert.equal(result.workOrder, null);
  assert.doesNotMatch(prompts.find((p) => p.model === 'suggest-model').user, /ASSIGNED A DECIDED CHANGE/);
  assert.equal(loadLedger({ repoRoot, ledgerPath: LEDGER }).escalations[0].work.assigned, null);
});

test('an abandoned run still completes its order, and vindicates nobody', async (t) => {
  const repoRoot = repoWithAcceptedEscalation();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const result = await runGeneration(config(repoRoot), { call: recordingCall([], { verdict: 'REJECTED' }) });
  assert.equal(result.outcome, 'abandoned');
  assert.equal(result.workOrder.outcome, 'abandoned');

  const entry = loadLedger({ repoRoot, ledgerPath: LEDGER }).escalations[0];
  assert.equal(entry.work.completed.outcome, 'abandoned');
  assert.equal(entry.dissenters[0].contradicted, undefined);
});

test('a run that gets no proposals at all still completes its order rather than stalling the queue', async (t) => {
  const repoRoot = repoWithAcceptedEscalation();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const result = await runGeneration(config(repoRoot), {
    call: async () => { throw new Error('404 model not found'); },
  });
  assert.equal(result.outcome, 'no-proposal');
  const entry = loadLedger({ repoRoot, ledgerPath: LEDGER }).escalations[0];
  assert.equal(entry.work.completed.outcome, 'no-proposal');
});

test('an escalation nobody has engaged with is put to the fan-out, and an AGREE carries it over the bar', async (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-order-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repoRoot, 'index.html'), 'original content');
  saveLedger({
    ...emptyLedger(),
    escalations: [{
      id: 'esc-001', slug: 's', title: 'A lonely idea', target: 'pipeline', status: 'open',
      opened: { generation: '001', date: '2026-01-01', model: 'm1', provider: 'p1' },
      case: 'A long, argued case that nobody has responded to. '.repeat(5),
      supporters: [
        { generation: '001', model: 'm1', provider: 'p1', note: '' },
        { generation: '001', model: 'm2', provider: 'p2', note: '' },
      ],
      dissenters: [], flagged: null, resolution: null,
    }],
  }, { repoRoot, ledgerPath: LEDGER });

  const prompts = [];
  const call = async ({ model, user, system }) => {
    prompts.push({ model, user, system });
    if (model === 'suggest-model') {
      return {
        text: `${SUGGESTION}\n\nESCALATION REVIEW: esc-001 AGREE — I had not seen this; it is right.`,
        truncated: false, provider: 'anthropic', sentImages: 0,
      };
    }
    if (model === 'review-model') return { text: 'VERDICT: APPROVED\nREASON: fine', truncated: false };
    throw new Error(`unexpected call: ${model}`);
  };

  const result = await runGeneration(config(repoRoot, { suggestModels: [{ id: 'suggest-model', provider: 'zai' }] }), { call });
  assert.equal(result.outcome, 'approved');

  const suggestPrompt = prompts.find((p) => p.model === 'suggest-model').user;
  assert.match(suggestPrompt, /AWAITING JUDGEMENT/);
  assert.match(suggestPrompt, /ESCALATION REVIEW:/);
  assert.match(suggestPrompt, /"I had not considered it" is not an answer/);

  const entry = loadLedger({ repoRoot, ledgerPath: LEDGER }).escalations[0];
  assert.equal(entry.supporters.length, 3, 'the AGREE counted as backing');
  assert.equal(entry.status, 'flagged', 'and carried it over the bar in the same run');
});

test('takeWorkOrder on a project with no ledger at all is a no-op, not a crash', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'work-order-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const out = takeWorkOrder({ repoRoot, ledgerPath: LEDGER, genNumber: '011', scope: 'ambitious' });
  assert.deepEqual(out, { order: null, workOrderBrief: null, queued: [], due: [], escalationBrief: null });
  assert.equal(fs.existsSync(path.join(repoRoot, LEDGER)), false, 'and it writes nothing');
});
