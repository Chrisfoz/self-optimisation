# C7 — Memory consolidation and the principles tier

**Status:** PROPOSED · **Phase:** D · **Depends on:** [C2](C2-themes-review-cli.md) × several cadence boundaries
**Drawn in:** [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), nodes `rederived`, `prin`, `drop`

---

## What it is

The third memory tier, and the first thing in this harness that forgets on
purpose.

| Tier | Holds | Today |
|---|---|---|
| **Episodic** | `gen-NNN/attempts.json` — every attempt, rejection, crash | **Built.** Never pruned; `buildGenerationIndex()` keeps all of it compactly. |
| **Thematic** | themes reviews, escalation ledger, curiosity ledger | **Partial.** Accumulates. Only the *latest* themes review is read — forgetting by accident, not by rule. Escalations never expire. |
| **Principled** | the handful of things that keep turning out to be true | **Missing.** `learning/01-principles.md` is hand-written by a human. |

## The promotion rule

**Independent re-derivation.** A theme that a *later* review, reading a
*different* window of generations, arrives at again has been confirmed from a
fresh vantage by a different reader looking at different evidence. Promote it.

Note what that criterion is: **the escalation consensus logic with the axis
rotated from models to time.** Consensus asks *do several independent models
agree now?* Promotion asks *does the same conclusion keep being reached by
different readers of different evidence?* The project already trusts the
first for governance; the second is the same argument, and the corroboration
counting already exists.

This is also the mechanism
[principle 21](../../learning/01-principles.md#21-constraints-never-expire-hints-should)
has been missing. *"Constraints never expire, hints should"* is still mostly
an intention: lessons already decay (stale when their anchored files change,
`harness/lib/lessons.mjs`), but themes and open questions do not yet. This makes decay
automatic and evidence-driven rather than a human periodically deciding a
hint has gone stale.

## Matching two themes is the hard part

Two reviews will never phrase the same principle identically. Slug matching
(`escalations.mjs`'s approach) fails here, because a theme's text is a
paragraph rather than a title.

**Do not attempt fuzzy string matching.** Ask a model, on the same pass that
produces the review, with the previous reviews' `MEANS` fields in front of
it:

```
RE-DERIVED: <none, or the id(s) of principles from the list above that this
        theme is another statement of. Only claim one if the underlying
        principle is genuinely the same — a theme that merely touches the same
        area of the code is NOT a re-derivation, and a false match here
        promotes something to permanent context that nothing has actually
        confirmed twice.>
```

A model comparing two paragraphs for identity of principle is doing the thing
models are good at; a Levenshtein distance over prose is not. The cost is one
extra field on a call that already happens.

## Promotion, and the deliberately high bar

```
2 independent re-derivations, from reviews reading non-overlapping windows
```

Non-overlapping matters. Two reviews that both read generations 11–20 are one
reader; a review over 11–20 and one over 21–30 arriving at the same principle
are two. `windowSize` and `throughGeneration` in [C2](C2-themes-review-cli.md)'s
output exist for exactly this check.

The bar is high because promotion is **permanent** — a principle renders in
every future prompt forever, and a wrong one is worse than a wrong theme by
the ratio of their lifetimes.

## Retirement

| Artifact | Retired when | Where |
|---|---|---|
| Theme | No subsequent review restates it | Implicit today — only the latest review is loaded. Make it explicit: mark it `superseded` rather than letting it vanish silently. |
| Question | Nothing cites it in `retireAfter` generations | [C3](C3-curiosity-ledger.md) |
| Escalation | Nothing backs it after explicit re-surfacing | [C8](C8-escalation-follow-through.md) |
| **Principle** | **Never automatically.** A human only. | Here |

A promoted principle that turns out wrong is a human's problem to fix, and
that asymmetry is intentional: the tier that never decays must never be
edited by the loop either.

## Data shape

`docs/principles/principles.json`:

```jsonc
{
  "version": 1,
  "promotionBar": { "rederivations": 2, "nonOverlappingWindows": true },
  "howToResolve":
    "Promoted automatically by independent re-derivation. Retired by a human "
    + "only: set status to 'retired' with a reason. Never edited by the loop.",
  "principles": [{
    "id": "p-001",
    "statement": "...",                    // the MEANS text of the first derivation
    "status": "active",                    // active | retired
    "derivations": [
      { "review": "review-020.json", "throughGeneration": "020", "window": [11,20], "text": "..." },
      { "review": "review-030.json", "throughGeneration": "030", "window": [21,30], "text": "..." }
    ],
    "promoted": { "date": "...", "atGeneration": "030" },
    "retired": null
  }]
}
```

Keeping every derivation's own wording matters: a principle stated three ways
by three models is more legible to the next reader than one canonical
sentence, and it is the evidence that promotion was earned.

## Interface

```js
// harness/lib/principles.mjs
export function loadPrinciples({ repoRoot, path })
export function savePrinciples(principles, { repoRoot, path })
export function recordDerivations({ review, principles, bar })  // → {principles, promoted[]}
export function buildPrinciplesBrief(principles)                 // → string | null
export function nonOverlapping(windowA, windowB)                 // → boolean
```

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/principles.mjs` | **New file** |
| `harness/lib/generate-themes.mjs` | `RE-DERIVED` field in the prompt and parser; the prompt gains the current principles list |
| `harness/scripts/generate-themes-review.mjs` | Fold derivations in, save, log promotions |
| `harness/lib/orchestrator.mjs` | One `section()` — *"What this project has learned, and keeps re-learning"* — **before** the themes section |
| `harness/lib/notify.mjs` | A promotion is worth one line in the digest. It is the rarest event in the system. |

## Ordering in the prompt is not arbitrary

Principles render **before** themes, which render before questions. That is
descending order of confirmation: what keeps being true, then what was
noticed once, then what is not yet known. A reader — model or human — should
be able to stop at any point and have read the most-confirmed material.

## Tests to write

1. One derivation does not promote.
2. Two derivations from **overlapping** windows do not promote.
3. Two from non-overlapping windows do promote, at the second one's generation.
4. `nonOverlapping([11,20],[21,30])` true; `([11,20],[15,24])` false.
5. A promoted principle renders in `buildPrinciplesBrief`; a retired one does not.
6. `buildPrinciplesBrief([])` returns `null`.
7. `RE-DERIVED: none` and a malformed id are both non-fatal — the review still parses.
8. **The loop cannot retire a principle** — only a human-set status does.
