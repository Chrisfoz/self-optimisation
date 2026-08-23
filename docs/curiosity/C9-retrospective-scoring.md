# C9 — Retrospective scoring

**Status:** PROPOSED · **Phase:** A′ (the cheap version) → E (the full one) · **Depends on:** [C2](C2-themes-review-cli.md), then [C3](C3-curiosity-ledger.md)
**Drawn in:** [D1](../../learning/diagrams/proposed-curiosity-run.mmd) the `rec → th` edge, [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) nodes `cited`/`paid`

---

## What it is

The only honest score in this design, and **the component that decides
whether the rest of the folder should be built at all.**

Everything prospective — how novel a question is, how much information it
might yield — is a model rating its own guess on an unanchored scale. This is
the half that produces a real label: a question was raised at generation N,
and by generation N+k the record says whether anything ever used it.

## Build the check before building the score

That ordering is the point of this document. A score nothing checks will be
believed. If highly-ranked questions do not produce better-surviving proposals
than low-ranked ones, the prospective ranker is noise and should be **deleted
rather than tuned**.

---

## Phase A′ — the cheap version, and the go/no-go

**Before [C3](C3-curiosity-ledger.md) exists.** After two or three cadence
boundaries have produced themes reviews with `UNKNOWN` fields, run one script
that answers one question:

> Did any subsequent generation go anywhere near the questions the review
> raised?

```
harness/scripts/check-question-uptake.mjs
```

1. Read every themes review; collect the `UNKNOWN` fields with the generation
   each was raised at.
2. Read every `attempts.json` and `proposal.md` written *after* that point.
3. For each question, ask one model: *did any of these proposals engage with
   this question — not merely touch the same file, but address what the
   question was actually uncertain about?*
4. Print a table. Do not write anything into standing context.

**The decision:**

| Result | What it means | Do |
|---|---|---|
| Most questions engaged | The review is producing live questions | Build [C3](C3-curiosity-ledger.md) |
| Some engaged, some inert | Normal. Note which kinds died | Build C3, with the retirement rule tuned to what you saw |
| **None engaged** | The questions are plausible and inert | **Stop.** Do not build the ledger. Fix the prompt, or accept that the harness is not curious and say so in the paper |

This costs one script and one model call, and it can kill weeks of work. It
is the cheapest experiment in the whole design and the easiest to skip.

---

## Phase B+ — the labels

Once [C3](C3-curiosity-ledger.md) exists, citation is explicit rather than
inferred. `writeAttemptRecord()` gains one field:

```jsonc
"citedQuestion": { "id": "q-014", "how": "the proposal's own words about why" }
```

and `orchestrator.mjs` writes back onto the ledger entry:

```jsonc
"citedBy": [{ "generation": "019", "outcome": "approved" }]
```

Four labels per question, all derivable from the record with no new judgement:

| Label | From |
|---|---|
| **Cited?** | any `citedBy` entry |
| **Survived?** | a `citedBy` entry with `outcome: 'approved'` |
| **Shipped?** | that generation's `pullRequestUrl` merged |
| **Latency** | generations between `opened` and first citation |

## The metrics that survive

From [`../Curiosity-Engine-Design.md` §6](../Curiosity-Engine-Design.md) —
what to count, and what to refuse to count:

| Metric | Definition | Ship? |
|---|---|---|
| **Question provenance rate** | merged generations citing a question / all merged generations | **Yes.** The headline. The operational form of "discovery rather than optimisation". |
| **Question mortality** | answered / retired-unread / still open after N | **Yes.** Detects the main failure mode: plausible, inert questions. |
| **Differential survival** | review pass rate of question-cited proposals vs. others | **Yes.** Interesting either way — if curiosity-driven proposals are rejected *more*, that is a real finding about exploration cost, not a bug. |
| **Corroboration depth** | distinct labs independently raising the same question | **Yes.** Free from the ledger, and the novel quantity: an inter-lab uncertainty measure over one artifact. |
| **Rank calibration** | did high-ranked questions get cited more? | **Yes, and it is the one that judges this design.** |
| Information gain per experiment | — | **No.** There is no posterior. Any number is an opinion with a unit. |
| Uncertainty reduction (Bayesian) | — | **No.** Corroboration is the honest proxy. |
| Novel defects discovered | — | **By hand.** Real, valuable, not automatable — it needs a human to say "nothing else would have found this", the same judgement that recorded the webfont incident. |

## Interface

```js
// harness/lib/question-scoring.mjs — pure; takes loaded records, returns numbers
export function labelQuestions({ ledger, generations })  // → [{id, cited, survived, shipped, latency}]
export function provenanceRate(generations)
export function mortality(ledger, { asOfGeneration })
export function differentialSurvival(generations)
export function rankCalibration(ledger, generations)     // → {spearman, n} | null when n < 10

// scripts/score-questions.mjs — CLI: reads the repo, prints the table, emits JSON
```

`rankCalibration` returning `null` below n=10 is deliberate. A correlation
over four questions is decoration, and this design's whole argument is
against numbers whose precision exceeds their evidence.

## Where it plugs in

| File | Change |
|---|---|
| `harness/scripts/check-question-uptake.mjs` | **New** — phase A′, throwaway if the answer is "none" |
| `harness/lib/question-scoring.mjs` | **New** — pure metrics |
| `harness/scripts/score-questions.mjs` | **New** — the CLI |
| `harness/lib/orchestrator.mjs` | `citedQuestion` in the record; write-back to the ledger |
| `harness/lib/notify.mjs` | One digest line when a question is cited or answered |

## The failure this exists to catch

**Curiosity theatre.** A model asked for an open question will always produce
one, and it will always sound good. Mortality is the detector: a ledger of
twenty open questions that nothing ever cited is a clear verdict, and without
this component it is an invisible one — the questions would keep rendering
into every prompt, looking exactly like insight.

## Tests to write

1. `labelQuestions` over fixture records produces the right four labels.
2. A question cited by a rejected generation is `cited: true, survived: false`.
3. `provenanceRate` with no citations is 0, not `NaN`.
4. `mortality` counts retired-unread separately from answered.
5. `rankCalibration` returns `null` below n=10.
6. `differentialSurvival` handles a zero-denominator arm.
7. The A′ script writes nothing into `docs/` — it only prints.
