# C8 — Escalation follow-through

**Status:** PROPOSED · **Phase:** any — **independent of everything else here** · **Blocks:** C4
**Drawn in:** [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) nodes `stuck`/`resurf`, [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) nodes `silent` → `ship`

---

> **Build this first.** It is the smallest component in the folder, it
> depends on nothing else in it, and it produces this project's first genuine
> outcome label: *did the thing three models agreed on actually work?*

## Three gaps, one file

`escalations.mjs` is complete and well-built up to the moment a human says
yes. Three things are missing after that, and one before it.

---

## 8a — Acceptance is a status change, not a work order

**The gap.** Trace what happens today after consensus: `open` → `flagged` →
`send-escalation-notice.mjs` fires → a human sets `status: 'accepted'` →
`buildEscalationBrief()` renders it to future models so it is not re-argued.

**And then nothing.** No run is scheduled, no generation is assigned it, no
scope is unlocked by it. The idea sits in the prompt as context and hopes a
future model picks it up. The most expensive signal the system produces —
three frontier models across two labs agreeing, plus a human's decision —
terminates in a rendered paragraph.

**The fix.** An accepted escalation becomes a queued work order that
[C4](C4-run-mode-selector.md)'s selector drains on the next ambitious run.

```jsonc
// added to an escalation entry
"work": {
  "queued":    { "date": "2026-08-22", "by": "owner" },
  "assigned":  { "generation": "023" },       // set when a run picks it up
  "completed": { "generation": "023", "outcome": "approved", "pr": "..." }
}
```

**The label this produces is the point.** `outcome` on `work.completed` is
the first thing in this harness that scores the system's own *reasoning*
rather than its code. Three models agreed, a human accepted, a generation
implemented — and it was rejected by review, or it shipped and the deployment
check failed, or it worked. Twenty of those rows is a real finding about
whether cross-lab consensus predicts anything, and it is currently
unobtainable.

**Resolution semantics.** `accepted` stays `accepted` after the work
completes — the human's decision does not expire. `work.completed` is what
stops it being re-queued. Do not overload `status` to mean both.

---

## 8b — Silence is scored as rejection

**The gap.** `consensusOf()` (`escalations.mjs:194`) counts `supporters`
only. Dissenters are recorded, rendered into the brief, and included in the
owner notification — but they **do not subtract and do not block.** There is
no veto in the code.

What actually kills a lone idea is that other models **never mention it**. It
sits at 1/3 forever. A model that did not back an escalation may simply never
have considered it, and the mechanism scores inattention identically to
judgement.

Underneath that sits the structural problem: **a consensus bar is a majority
filter, and majority filters select for obviousness.** The most valuable
ambitious idea is close to definitionally the one fewest models thought of.

**The fix.** An entry below the bar for `resurfaceAfter` generations (default
5) is re-surfaced to the next fan-out with a direct question, and the answer
is recorded:

```
ESCALATION REVIEW: <REQUIRED when the list above contains any entry marked
        AWAITING JUDGEMENT. For each, answer with its id and one of:
        AGREE (and it becomes yours to back) · DISAGREE (and why) ·
        IRRELEVANT (it does not bear on this project's goal).
        "I had not considered it" is not an answer — consider it now.>
```

`IRRELEVANT` is the new state that did not exist, and it is the useful one.
Three models saying *irrelevant* is a real verdict; three models saying
nothing was never a verdict at all. An entry with 3 distinct `irrelevant`
judgements auto-retires with that reason, closing the loop that currently has
no ending.

---

## 8c — The owner never sees the minority report

**The gap.** `send-escalation-notice.mjs` fires only on `flagged`. The owner
— who is the tiebreak anyway — never sees the high-conviction idea that one
model argued hard for and nobody engaged with. That is precisely the item a
human spots faster than three models will.

**The fix.** The periodic digest (`notify.mjs`) gains a short section: open
entries with a strong case and low backing, capped at 3, ranked by case
length and openers' conviction. Not a notification — a paragraph in a digest
that already goes out.

---

## 8d — Dissent that was wrong is free calibration

**The gap.** Dissenters are recorded with a reason and a generation and are
never looked at again.

**The fix.** When an escalation completes (8a), any dissenter whose objection
the outcome contradicts gets a `contradicted` marker. *"Two models said this
would break; it shipped and the deployment check passed."*

The ledger already stores everything needed. This is a derived report, not
new data collection, and it is one of the few honest signals about model
judgement this system can produce for free.

---

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/escalations.mjs` | `work` subtree; `queueWorkOrder()`, `assignWorkOrder()`, `completeWorkOrder()`; `resurfaceDue()`; `parseEscalationReview()`; `irrelevant` judgements and auto-retirement; `contradictedDissenters()` |
| `harness/lib/orchestrator.mjs` | `ESCALATION REVIEW` response field; fold judgements in at the existing pre-ranking site; call `completeWorkOrder()` on a run that carried an assignment |
| `harness/lib/notify.mjs` | The minority-report section |
| `harness/lib/adapter.mjs` | `memoryConfig()` gains `resurfaceAfter` |
| `harness/scripts/run-generation.mjs` | Emit `work-order-completed` as a GitHub output |

`buildEscalationBrief()` gains an `AWAITING JUDGEMENT` marker on due entries
— the marker is what makes `ESCALATION REVIEW` answerable, and without it the
field is unanswerable noise on every other run.

## Failure behaviour

- **A model ignores `ESCALATION REVIEW`** → no judgements recorded, the entry
  stays due, it is asked again next run. Fail safe; never infer a judgement
  from silence, which is the bug being fixed.
- **A work order names an escalation that no longer exists or was declined**
  → drop it, log, fall back to an unassigned ambitious run.
- **Two runs race for one work order** → `assigned` is set before the run
  starts; a second run sees it and takes the next item or none.

## Tests to write

1. `accepted` queues a work order; `declined` does not.
2. A queued order is assigned exactly once; a second selector call skips it.
3. `completeWorkOrder` records the outcome and the entry stops being re-queued while staying `accepted`.
4. `resurfaceDue` returns entries below the bar for ≥ `resurfaceAfter`, and never a settled one.
5. `parseEscalationReview` handles agree / disagree / irrelevant / malformed.
6. `AGREE` adds a supporter and can carry an entry over the bar in the same run.
7. Three distinct `irrelevant` judgements auto-retire with that reason.
8. `contradictedDissenters` marks the right models and no others.
9. The minority report caps at 3 and is absent when there is nothing to report.
