# C5 — The spike

**Status:** PROPOSED · **Phase:** C · **Depends on:** [C1](C1-committed-goal.md), [C3](C3-curiosity-ledger.md), [C4](C4-run-mode-selector.md)
**Drawn in:** [D1](../../learning/diagrams/proposed-curiosity-run.mmd) nodes `res`/`find`/`doc`, [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) node `spike`

---

## What it is

**A generation that produces a document instead of a diff.**

That framing is the whole design. It is not a second pipeline, not a new
agent, not a supervisory layer. It is one new value of `outcome` on the loop
that already runs:

```js
outcome: 'investigated'   // wrote findings-NNN.md, changed no code
```

Same trigger, same context pack, same review gate, same record, same PR. The
reviewer's *question* differs; its posture does not.

## Why this shape

Curiosity wants to investigate, and investigation wants capabilities this
harness deliberately withholds — running arbitrary code, reading outside the
allowlist, probing production. The entire governance story rests on a narrow
action space
([principle 10](../../learning/01-principles.md#10-an-agent-that-can-edit-its-own-rules-has-no-rules),
the double-enforced allowlist, a review that fails closed).

A spike keeps that intact: **it generates questions and evidence, never
edits.** Investigation that changes code happens through the ordinary
channel, where a "spike" is just a normal generation whose change happens to
be instrumentation — reviewed, tested and merged like anything else.

The suggestion a spike produces does **not** ship from the spike. It enters
the next ordinary generation. Curiosity never bypasses a gate; it only
decides what the gates point at.

## Authorisation

From [`../Curiosity-Engine-Design.md` §4.5](../Curiosity-Engine-Design.md):

| Action | Bar |
|---|---|
| Open a question | Any model, any run. Free. |
| **Run a spike** | One model's high-conviction question, **or** corroboration ≥ 2. Deliberately **not** the full consensus bar. |
| Implement an ambitious change | 3 distinct models, 2 labs, **plus** a human accepting it. |
| Change a frozen rule | Human only. Forever. |

The asymmetry is the point: looking is cheap and should be easy to
authorise; committing is expensive and stays hard. It is also the answer to
the veto problem — a consensus bar is a majority filter, and majority filters
select for obviousness, so the lone ambitious model must not need to win a
vote before it is allowed to gather evidence. See
[`../Curiosity-Engine-Design.md` §2.5](../Curiosity-Engine-Design.md).

## The output artifact

`docs/curiosity/findings-NNN.md`, written by the run, reviewed before it is
committed:

```markdown
# Generation NNN — investigation

- **Question:** q-014 — <the question, verbatim from the ledger>
- **Raised by:** `model` (provider), generation 011
- **Corroboration at spike time:** 2 models across 2 labs
- **Investigated by:** `model` (provider)
- **Goal this bears on:** <one line, from C1's statement>

## What I found
<prose>

## What I could not determine
<prose — REQUIRED. An investigation that found everything it looked for
either asked a trivial question or is overclaiming.>

## Sources
- <url or repo path> — <what it established>

## What this suggests should change
<one concrete proposal, for the NEXT generation to implement. Not edits.>

## Does this answer the question?
<answered | partly | no, and here is the better question>
```

`What I could not determine` being required is the cheapest guard against a
confident, useless spike. `Does this answer the question?` is what closes the
ledger entry, and `no, and here is the better question` is a legitimate,
valuable outcome — a refined question is progress.

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/orchestrator.mjs` | `runSpike()` beside the implement/review path; `outcome: 'investigated'` in `writeAttemptRecord()`; `buildSpikeSystemPrompt()` / `buildSpikeUserPrompt()` |
| `harness/lib/edit-format.mjs` | **Refuse** edit blocks in spike mode — see below |
| `harness/lib/review.mjs` | `reviewFindings()` — a second reviewer entry point with its own criteria |
| `harness/lib/curiosity.mjs` | Record the spike against the question: `status`, `answered`, or a refined replacement |
| `harness/scripts/run-generation.mjs` | Branch on mode; emit `findings-path` as a GitHub output |

## Refusing edits is enforcement, not instruction

The prompt says "do not write edit blocks." **That is not the control.** The
parser must refuse them, the way the allowlist refuses a frozen path:
`parseResponse()` in spike mode throws if `edits` or `creates` is non-empty.

This is [principle 11](../../learning/01-principles.md#11-enforce-every-rule-twice-in-two-different-places)
— enforce every rule twice, in two different places — and it matters more
here than usual, because a spike's prompt contains text fetched from outside
the repository ([C6](C6-external-research.md)). An instruction smuggled into
a search result that persuades the model to emit edits must hit a parser that
does not care what the prompt said.

## What the reviewer asks

`reviewFindings()` shares `review.mjs`'s posture — pinned model, fresh
context, fails closed — with different criteria:

1. **Is it real?** Does the evidence support the finding, or is the finding a
   restatement of the question?
2. **Is it sourced?** Every external claim carries a source. Unsourced claims
   are removed, not summarised — and if that empties the document, reject.
3. **Is it relevant to the goal?** [C1](C1-committed-goal.md)'s statement is
   the test. An interesting finding about something the project is not trying
   to become is a rejection.
4. **Is the proposal implementable?** "What this suggests should change" must
   be concrete enough for a later generation to act on without guessing.

Rejection sends it back through `REFINE` exactly like a rejected diff, with
the same `maxAttempts` budget.

## Record shape

`attempts.json` for a spike:

```jsonc
{
  "outcome": "investigated",
  "mode": "investigate",
  "question": { "id": "q-014", "corroborationAtSpike": {"models": 2, "labs": 2} },
  "findingsPath": "docs/curiosity/findings-018.md",
  "answeredQuestion": true,
  "proposedNext": "one line, so buildGenerationIndex can show it",
  "filesChanged": []          // deliberately empty
}
```

`hasChanges` is **true** — the run produced a committable artifact and the
workflow's PR step must fire. But `filesChanged` is empty, so
`landedCleanly()` and `recommendScope()` need to be told a spike is neither a
clean merge nor a failure: **a spike is neutral for scope purposes.** It
neither earns nor spends ambition. Get this wrong and a run of spikes either
unlocks permanent ambition or locks the loop into `focused` forever.

## Tests to write

1. Spike mode: a response with edit blocks is **refused by the parser**, not merely unrewarded.
2. `outcome: 'investigated'` is written with `filesChanged: []` and `hasChanges: true`.
3. `landedCleanly()` treats a spike as neutral — not clean, not failed.
4. `recommendScope()` over a window containing spikes returns the same answer as over the same window with the spikes removed.
5. `reviewFindings` rejects a findings file with an unsourced external claim.
6. Rejection re-enters `REFINE` and respects `maxAttempts`.
7. `Does this answer the question?` = `no` leaves the ledger entry open and records the refined question.
8. A crashed spike still writes a record — the `crashState` guarantee applies unchanged.
