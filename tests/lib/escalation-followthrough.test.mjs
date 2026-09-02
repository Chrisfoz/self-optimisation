import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEscalationReview, recordJudgements, resurfaceDue,
  queueWorkOrders, assignWorkOrder, completeWorkOrder, workOrderOutcomes,
  minorityReport, renderMinorityReport,
  buildEscalationBrief, buildEscalationReviewField, buildWorkOrderBrief,
  emptyLedger, consensusOf, CONSENSUS, DEFAULT_RESURFACE_AFTER, IRRELEVANT_TO_RETIRE,
} from '../../harness/lib/escalations.mjs';

/**
 * C8 — escalation follow-through (docs/curiosity/C8-escalation-follow-through.md).
 *
 * Four gaps, all after the moment a human says yes, plus the one before it:
 * acceptance scheduled no work; silence was scored as rejection; the owner
 * never saw the minority report; dissent that turned out to be wrong was
 * never looked at again.
 */

function entry(over = {}) {
  return {
    id: 'esc-001',
    slug: 'a-case',
    title: 'A case',
    target: 'pipeline',
    status: 'open',
    opened: { generation: '001', date: '2026-01-01', model: 'm1', provider: 'p1' },
    case: 'x'.repeat(300),
    supporters: [{ generation: '001', date: '2026-01-01', model: 'm1', provider: 'p1', note: '' }],
    dissenters: [],
    flagged: null,
    resolution: null,
    ...over,
  };
}

const ledgerOf = (...entries) => ({ ...emptyLedger(), escalations: entries });

// --- parseEscalationReview ----------------------------------------------------

test('parseEscalationReview reads the three judgements out of the shapes models actually write', () => {
  const text = `CHANGE: something

ESCALATION REVIEW:
esc-004: AGREE — it blocks the thing I wanted to propose
- esc-007 DISAGREE (the risk argument is right and the case ignores it)
esc-011 irrelevant.

ESCALATION: none`;
  assert.deepEqual(parseEscalationReview(text), [
    { id: 'esc-004', judgement: 'agree', note: 'it blocks the thing I wanted to propose' },
    { id: 'esc-007', judgement: 'disagree', note: 'the risk argument is right and the case ignores it)' },
    { id: 'esc-011', judgement: 'irrelevant', note: '' },
  ]);
});

test('parseEscalationReview does not read DISAGREE as AGREE', () => {
  // "disagree" contains "agree", and getting this wrong would silently turn
  // every objection into a vote in favour.
  assert.deepEqual(parseEscalationReview('ESCALATION REVIEW: esc-002 DISAGREE'), [
    { id: 'esc-002', judgement: 'disagree', note: '' },
  ]);
});

test('parseEscalationReview returns nothing for silence, "none", or an unparseable answer', () => {
  // Silence must stay silence: inventing a judgement here would recreate the
  // exact bug this mechanism exists to fix.
  assert.deepEqual(parseEscalationReview('CHANGE: something'), []);
  assert.deepEqual(parseEscalationReview('ESCALATION REVIEW: none'), []);
  assert.deepEqual(parseEscalationReview('ESCALATION REVIEW: I had not considered esc-004.'), []);
  assert.deepEqual(parseEscalationReview(null), []);
});

test('parseEscalationReview keeps one judgement per entry, even if a model answers twice', () => {
  const out = parseEscalationReview('ESCALATION REVIEW:\nesc-004 AGREE\nesc-004 DISAGREE');
  assert.equal(out.length, 1);
  assert.equal(out[0].judgement, 'agree');
});

// --- recordJudgements ---------------------------------------------------------

test('AGREE adds a supporter, and can carry an entry over the bar in the same run', () => {
  // The point of asking: a resurfaced entry gets a real verdict now, not in
  // five more generations.
  const before = ledgerOf(entry({
    supporters: [
      { generation: '001', model: 'm1', provider: 'p1' },
      { generation: '002', model: 'm2', provider: 'p2' },
    ],
  }));
  assert.equal(consensusOf(before.escalations[0]).reached, false);

  const { ledger, agreed } = recordJudgements({
    generation: '010',
    entries: [{ model: 'm3', provider: 'p1', judgements: [{ id: 'esc-001', judgement: 'agree', note: 'fair' }] }],
    ledger: before,
  });
  assert.deepEqual(agreed, [{ id: 'esc-001', model: 'm3', provider: 'p1' }]);
  assert.equal(consensusOf(ledger.escalations[0]).reached, true);
});

test('DISAGREE records a dissenter and still does not veto anything', () => {
  const { ledger, disagreed } = recordJudgements({
    generation: '010',
    entries: [{ model: 'm2', provider: 'p2', judgements: [{ id: 'esc-001', judgement: 'disagree', note: 'no' }] }],
    ledger: ledgerOf(entry()),
  });
  assert.equal(disagreed.length, 1);
  assert.equal(ledger.escalations[0].dissenters.length, 1);
  assert.equal(ledger.escalations[0].status, 'open', 'dissent is recorded, never a veto');
});

test('three distinct models judging IRRELEVANT retires the entry, with that reason', () => {
  // Three models saying irrelevant is a real verdict; three models saying
  // nothing was never a verdict at all.
  let ledger = ledgerOf(entry());
  for (const [i, model] of ['m2', 'm3', 'm4'].entries()) {
    ledger = recordJudgements({
      generation: `01${i}`,
      entries: [{ model, provider: 'p2', judgements: [{ id: 'esc-001', judgement: 'irrelevant', note: 'off-goal' }] }],
      ledger,
    }).ledger;
  }
  assert.equal(IRRELEVANT_TO_RETIRE, 3);
  assert.equal(ledger.escalations[0].status, 'retired');
  assert.match(ledger.escalations[0].resolution, /3 distinct models/);
  assert.match(ledger.escalations[0].resolution, /No human decision was needed/);
});

test('one model saying IRRELEVANT three times is one opinion, not three', () => {
  let ledger = ledgerOf(entry());
  for (const generation of ['010', '011', '012']) {
    ledger = recordJudgements({
      generation,
      entries: [{ model: 'm2', provider: 'p2', judgements: [{ id: 'esc-001', judgement: 'irrelevant' }] }],
      ledger,
    }).ledger;
  }
  assert.equal(ledger.escalations[0].status, 'open');
  assert.equal(ledger.escalations[0].irrelevant.length, 3);
});

test('judgements about a settled entry are ignored', () => {
  const { ledger, agreed } = recordJudgements({
    generation: '010',
    entries: [{ model: 'm2', provider: 'p2', judgements: [{ id: 'esc-001', judgement: 'agree' }] }],
    ledger: ledgerOf(entry({ status: 'declined' })),
  });
  assert.deepEqual(agreed, []);
  assert.equal(ledger.escalations[0].supporters.length, 1);
});

// --- resurfaceDue -------------------------------------------------------------

test('resurfaceDue returns entries nobody has touched for the configured gap, and nothing else', () => {
  const stale = entry({ id: 'esc-001', supporters: [{ generation: '001', model: 'm1', provider: 'p1' }] });
  const fresh = entry({ id: 'esc-002', supporters: [{ generation: '009', model: 'm1', provider: 'p1' }] });
  const due = resurfaceDue(ledgerOf(stale, fresh), { currentGeneration: '010' });
  assert.deepEqual(due.map((e) => e.id), ['esc-001']);
  assert.equal(DEFAULT_RESURFACE_AFTER, 5);
});

test('resurfaceDue never returns an entry that has reached the bar, is flagged, or is settled', () => {
  const atBar = entry({
    id: 'esc-002',
    supporters: [
      { generation: '001', model: 'm1', provider: 'p1' },
      { generation: '001', model: 'm2', provider: 'p2' },
      { generation: '001', model: 'm3', provider: 'p1' },
    ],
  });
  const flagged = entry({ id: 'esc-003', status: 'flagged' });
  const settled = entry({ id: 'esc-004', status: 'accepted' });
  const due = resurfaceDue(ledgerOf(atBar, flagged, settled), { currentGeneration: '020' });
  assert.deepEqual(due, []);
});

test('resurfaceDue counts a judgement as activity, so an entry is not asked about every run forever', () => {
  const judged = entry({
    supporters: [{ generation: '001', model: 'm1', provider: 'p1' }],
    irrelevant: [{ generation: '009', model: 'm2', provider: 'p2' }],
  });
  assert.deepEqual(resurfaceDue(ledgerOf(judged), { currentGeneration: '010' }), []);
});

// --- work orders (8a) ---------------------------------------------------------

test('accepted queues a work order; declined and open do not', () => {
  const { ledger, queued } = queueWorkOrders(
    ledgerOf(
      entry({ id: 'esc-001', status: 'accepted' }),
      entry({ id: 'esc-002', status: 'declined' }),
      entry({ id: 'esc-003', status: 'open' })
    ),
    { date: '2026-09-02' }
  );
  assert.deepEqual(queued.map((q) => q.id), ['esc-001']);
  assert.deepEqual(ledger.escalations[0].work.queued, { date: '2026-09-02', by: 'owner' });
  assert.equal(ledger.escalations[1].work, undefined);
});

test('queueWorkOrders is idempotent — a second pass does not re-queue what is already queued or done', () => {
  const once = queueWorkOrders(ledgerOf(entry({ status: 'accepted' })), { date: '2026-09-01' });
  const twice = queueWorkOrders(once.ledger, { date: '2026-09-02' });
  assert.deepEqual(twice.queued, []);
  assert.equal(twice.ledger.escalations[0].work.queued.date, '2026-09-01');
});

test('a queued order is assigned exactly once; a second call takes the next one, or none', () => {
  // Assignment is written before the run starts, which is what makes two
  // runs racing for one order harmless.
  const queued = queueWorkOrders(ledgerOf(
    entry({ id: 'esc-001', status: 'accepted' }),
    entry({ id: 'esc-002', status: 'accepted' })
  )).ledger;

  const first = assignWorkOrder(queued, { generation: '011' });
  assert.equal(first.order.id, 'esc-001');

  const second = assignWorkOrder(first.ledger, { generation: '012' });
  assert.equal(second.order.id, 'esc-002');

  const third = assignWorkOrder(second.ledger, { generation: '013' });
  assert.equal(third.order, null);
});

test('completeWorkOrder records the outcome and the entry stays accepted', () => {
  // The human's decision does not expire; work.completed is what stops it
  // being re-queued. Overloading status to mean both would lose one.
  const assigned = assignWorkOrder(
    queueWorkOrders(ledgerOf(entry({ status: 'accepted' }))).ledger,
    { generation: '011' }
  ).ledger;

  const { ledger, completed } = completeWorkOrder(assigned, {
    generation: '011', outcome: 'approved', date: '2026-09-02',
  });
  assert.equal(completed.id, 'esc-001');
  assert.equal(ledger.escalations[0].status, 'accepted');
  assert.deepEqual(ledger.escalations[0].work.completed, {
    generation: '011', date: '2026-09-02', outcome: 'approved', pullRequestUrl: null,
  });

  // and it is not handed out again
  assert.equal(assignWorkOrder(ledger, { generation: '012' }).order, null);
  assert.deepEqual(queueWorkOrders(ledger).queued, []);
});

test('completeWorkOrder on a generation that carried no order changes nothing', () => {
  const { ledger, completed } = completeWorkOrder(ledgerOf(entry()), { generation: '011', outcome: 'approved' });
  assert.equal(completed, null);
  assert.equal(ledger.escalations[0].work, undefined);
});

test('a crashed or abandoned run still completes its order, with that outcome', () => {
  const assigned = assignWorkOrder(
    queueWorkOrders(ledgerOf(entry({ status: 'accepted' }))).ledger,
    { generation: '011' }
  ).ledger;
  const { ledger } = completeWorkOrder(assigned, { generation: '011', outcome: 'crashed' });
  assert.equal(ledger.escalations[0].work.completed.outcome, 'crashed');
  assert.equal(assignWorkOrder(ledger, { generation: '012' }).order, null, 'and the queue does not stall on it');
});

test('workOrderOutcomes is the row a human wants: what was agreed, and whether it worked', () => {
  const done = completeWorkOrder(
    assignWorkOrder(queueWorkOrders(ledgerOf(entry({
      status: 'accepted',
      resolution: 'Agreed — the brief is too narrow.',
      supporters: [
        { generation: '001', model: 'm1', provider: 'p1' },
        { generation: '002', model: 'm2', provider: 'p2' },
        { generation: '003', model: 'm3', provider: 'p1' },
      ],
    }))).ledger, { generation: '011' }).ledger,
    { generation: '011', outcome: 'approved' }
  ).ledger;

  assert.deepEqual(workOrderOutcomes(done), [{
    id: 'esc-001',
    title: 'A case',
    target: 'pipeline',
    accepted: 'Agreed — the brief is too narrow.',
    backing: 3,
    labs: 2,
    generation: '011',
    outcome: 'approved',
    pullRequestUrl: null,
    contradictedDissenters: [],
  }]);
});

// --- dissent that was wrong (8d) ---------------------------------------------

test('a dissenter whose objection the outcome contradicts is marked, on approval only', () => {
  const withDissent = entry({
    status: 'accepted',
    dissenters: [{ generation: '004', model: 'm9', provider: 'p2', note: 'this will break the guard' }],
  });
  const assigned = assignWorkOrder(queueWorkOrders(ledgerOf(withDissent)).ledger, { generation: '011' }).ledger;

  const shipped = completeWorkOrder(assigned, { generation: '011', outcome: 'approved' }).ledger;
  assert.equal(shipped.escalations[0].dissenters[0].contradicted.by, 'the accepted change shipped');
  assert.deepEqual(workOrderOutcomes(shipped)[0].contradictedDissenters, ['m9']);
});

test('an abandoned or crashed run vindicates nobody — no dissenter is marked', () => {
  // A failed run means the run failed, which is not the same as the
  // objection being right. Claiming otherwise would be the mirror image of
  // scoring silence as a verdict.
  const withDissent = entry({
    status: 'accepted',
    dissenters: [{ generation: '004', model: 'm9', provider: 'p2', note: 'this will break the guard' }],
  });
  const assigned = assignWorkOrder(queueWorkOrders(ledgerOf(withDissent)).ledger, { generation: '011' }).ledger;

  for (const outcome of ['abandoned', 'crashed', 'no-proposal']) {
    const after = completeWorkOrder(assigned, { generation: '011', outcome }).ledger;
    assert.equal(after.escalations[0].dissenters[0].contradicted, undefined, outcome);
  }
});

// --- the minority report (8c) -------------------------------------------------

test('minorityReport surfaces open, strongly-argued, unbacked entries, longest case first', () => {
  const short = entry({ id: 'esc-001', case: 'too short to be a case' });
  const strong = entry({ id: 'esc-002', case: 'y'.repeat(400) });
  const stronger = entry({ id: 'esc-003', case: 'z'.repeat(900) });
  const backed = entry({
    id: 'esc-004',
    case: 'q'.repeat(900),
    supporters: [
      { generation: '001', model: 'm1', provider: 'p1' },
      { generation: '001', model: 'm2', provider: 'p2' },
      { generation: '001', model: 'm3', provider: 'p1' },
    ],
  });
  const out = minorityReport(ledgerOf(short, strong, stronger, backed));
  assert.deepEqual(out.map((e) => e.id), ['esc-003', 'esc-002']);
  assert.equal(out[0].backing, 1);
});

test('minorityReport caps at three, and renders to null when there is nothing to report', () => {
  const many = Array.from({ length: 6 }, (_, i) => entry({ id: `esc-00${i + 1}`, case: 'y'.repeat(400 + i) }));
  assert.equal(minorityReport(ledgerOf(...many)).length, 3);

  assert.equal(renderMinorityReport([]), null);
  assert.equal(renderMinorityReport(minorityReport(emptyLedger())), null);
});

test('renderMinorityReport says why the owner is being shown these, and asks for nothing', () => {
  const text = renderMinorityReport(minorityReport(ledgerOf(entry({ case: 'y'.repeat(400) }))));
  assert.match(text, /majority filter/);
  assert.match(text, /No action is required/);
  assert.match(text, /esc-001 — A case/);
});

// --- the prompt side ----------------------------------------------------------

test('buildEscalationBrief marks only the entries awaiting judgement', () => {
  const brief = buildEscalationBrief(ledgerOf(entry({ id: 'esc-001' }), entry({ id: 'esc-002' })), {
    awaitingJudgement: [{ id: 'esc-002' }],
  });
  assert.doesNotMatch(brief.split('### esc-002')[0], /AWAITING JUDGEMENT/);
  assert.match(brief, /### esc-002 — A case — \*\*AWAITING JUDGEMENT\*\*/);
  assert.match(brief, /Answer it in ESCALATION REVIEW below/);
});

test('buildEscalationBrief with nothing awaiting judgement is byte-identical to the brief before any of this existed', () => {
  // The property that makes the whole component additive rather than a
  // rewrite of a prompt every model in the rotation has been answering.
  const ledger = ledgerOf(entry());
  assert.equal(
    buildEscalationBrief(ledger, { awaitingJudgement: [] }),
    buildEscalationBrief(ledger)
  );
  assert.doesNotMatch(buildEscalationBrief(ledger), /AWAITING JUDGEMENT/);
});

test('buildEscalationBrief tells the next model that an accepted case is already queued or in flight', () => {
  const queued = queueWorkOrders(ledgerOf(entry({ status: 'accepted' }))).ledger;
  assert.match(buildEscalationBrief(queued), /queued for a future ambitious generation/);

  const assigned = assignWorkOrder(queued, { generation: '011' }).ledger;
  assert.match(buildEscalationBrief(assigned), /assigned to generation 011/);

  const done = completeWorkOrder(assigned, { generation: '011', outcome: 'approved' }).ledger;
  assert.match(buildEscalationBrief(done), /implemented in generation 011 and the outcome was: approved/);
});

test('buildEscalationBrief reports a retired entry as the models\' verdict, not the owner\'s', () => {
  const retired = ledgerOf(entry({ status: 'retired', resolution: 'Retired automatically: 3 distinct models…' }));
  const brief = buildEscalationBrief(retired);
  assert.match(brief, /RETIRED — enough models independently judged this irrelevant/);
  assert.doesNotMatch(brief, /RETIRED by the project's owner/);
});

test('buildEscalationReviewField is null when nothing is due, and names the ids when something is', () => {
  assert.equal(buildEscalationReviewField([]), null);
  assert.equal(buildEscalationReviewField(null), null);

  const field = buildEscalationReviewField([{ id: 'esc-004' }, { id: 'esc-007' }]);
  assert.match(field, /^ESCALATION REVIEW:/);
  assert.match(field, /2 entries AWAITING/);
  assert.match(field, /esc-004, esc-007/);
  assert.match(field, /"I had not considered it" is not an answer/);
});

test('buildWorkOrderBrief tells the model the change is decided, and null when there is no order', () => {
  assert.equal(buildWorkOrderBrief(null), null);
  const brief = buildWorkOrderBrief(entry({
    status: 'accepted',
    resolution: 'Agreed.',
    supporters: [
      { generation: '001', model: 'm1', provider: 'p1' },
      { generation: '002', model: 'm2', provider: 'p2' },
      { generation: '003', model: 'm3', provider: 'p1' },
    ],
  }));
  assert.match(brief, /not to pick your own improvement/);
  assert.match(brief, /3 distinct models across 2 labs/);
  assert.match(brief, /already argued, agreed and decided/);
});
