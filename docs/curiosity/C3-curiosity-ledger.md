# C3 — The curiosity ledger

**Status:** PROPOSED · **Phase:** B · **Depends on:** [C2](C2-themes-review-cli.md), and the A′ evidence in [C9](C9-retrospective-scoring.md) · **Blocks:** C4, C5
**Drawn in:** [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) node `ques`, [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) nodes `free` → `inert`

---

> **Do not build this before phase A′.** If the questions [C2](C2-themes-review-cli.md)
> produces are never cited by any subsequent generation, this ledger is a
> filing cabinet for noise. The go/no-go is in [C9](C9-retrospective-scoring.md).

## What it is

`docs/curiosity/ledger.json` — open questions about this repository, raised
by models during ordinary runs, corroborated across labs, retired when
nothing ever touches them.

It is structurally near-identical to `escalations.mjs`'s ledger, and that is
not laziness: the lifecycle is genuinely the same shape — an item raised by
one model, independently backed by others, counted across distinct models
*and* distinct labs, rendered back into every future prompt. Four differences
matter, and they are in §"Where it differs" below.

## Why corroboration and not a score

The fan-out asks 2–5 models from different labs the same question over
identical context. When three of them independently say *"I cannot determine
X from what I was given"*, that is **an estimate of uncertainty in the
population of frontier models about this repository** — not a model rating
its own confidence.

That is what `α·Novelty + β·Uncertainty` in the original formula was reaching
for and structurally could not reach, and it is close to unique to this
harness. See [`../Curiosity-Engine-Design.md` §3.1](../Curiosity-Engine-Design.md).

## New response fields

Added to `SUGGEST_RESPONSE_FORMAT` in `orchestrator.mjs`, beside the
escalation fields it already requires:

```
OPEN QUESTION: <REQUIRED, and "none" is a good answer. One thing about this
        repository you could not determine from the context you were given,
        where knowing the answer would plausibly change which improvement is
        worth making. A gap in what is knowable from here — not a to-do, not
        a feature you want, not something you could answer by reading the
        source you were already shown.>
QUESTION SUPPORT: <none, or the id(s) of open questions above that you
        independently hit the same wall on, and what you could not determine.>
QUESTION ANSWER: <none, or the id of an open question this generation's work
        actually answers, and what the answer is.>
```

The negative examples in `OPEN QUESTION` are load-bearing. Without them the
field collects feature requests, which is what the escalation field is for.

## Data shape

```jsonc
{
  "version": 1,
  "consensus": { "models": 3, "labs": 2 },
  "retireAfter": 15,
  "howToResolve":
    "Questions are answered by the loop, not by a human. A generation that "
    + "answers one sets QUESTION ANSWER with its id. Questions nothing cites "
    + "within retireAfter generations are retired automatically. A human may "
    + "retire one early by setting status to 'retired' with a reason.",
  "questions": [{
    "id": "q-001",
    "slug": "why-review-rejects-timing-changes",
    "question": "...",
    "status": "open",              // open | corroborated | answered | retired
    "source": "fan-out",           // fan-out | themes-review | spike
    "opened":     { "generation": "014", "date": "...", "model": "...", "provider": "..." },
    "supporters": [ /* {generation, date, model, provider, note} */ ],
    "answered":   null,            // {generation, date, by, answer}
    "citedBy":    [],              // [{generation, outcome}] — written by C9
    "retired":    null             // {generation, date, reason}
  }]
}
```

`status` transitions: `open` → `corroborated` when the consensus bar is
reached (prominence only — see below); `open`/`corroborated` → `answered`
when a `QUESTION ANSWER` names it; → `retired` when `retireAfter`
generations pass with an empty `citedBy`.

## Where it differs from the escalation ledger

Each of these is load-bearing, not cosmetic:

**1. Nobody is interrupted.** An escalation crossing consensus flips to
`flagged` and fires `send-escalation-notice.mjs`. A corroborated question
changes nothing except its position in the next prompt. Curiosity is not a
governance queue and must never become a second notification channel — the
notifier is the one part of this system a human cannot ignore, and filling
it with questions burns it.

**2. Questions can be answered by the loop.** An escalation is settled only
by a human. `QUESTION ANSWER` is how the *"update beliefs"* step of the
curiosity cycle actually gets recorded, and it is the only self-closing
lifecycle in the harness.

**3. Questions expire; escalations never do.** `retireAfter` generations
with nothing citing it → retired, with the reason written in. This is
[principle 21](../../learning/01-principles.md#21-constraints-never-expire-hints-should)
applied exactly — an open question is a hint about where to look, and hints
must be deletable. Without expiry the prompt section degrades into noise,
which is the failure `context-pack.mjs`'s append-only-marker guard exists to
prevent elsewhere.

**4. Retirement is not deletion.** A retired question stays in the file with
its reason and its `citedBy` history. [C9](C9-retrospective-scoring.md) needs
the corpse: a question that was highly ranked and then retired unread is the
single most informative record this design produces about whether its own
ranking works.

## Interface

`harness/lib/curiosity.mjs` — pure with respect to the filesystem in the
same way `escalations.mjs` is: `recordRound` takes a ledger and returns a
new one; the caller decides when to write.

```js
export const DEFAULT_LEDGER_PATH = 'docs/curiosity/ledger.json';
export const CONSENSUS   = { models: 3, labs: 2 };
export const RETIRE_AFTER = 15;

export function emptyLedger()
export function loadLedger({ repoRoot, ledgerPath })
export function saveLedger(ledger, { repoRoot, ledgerPath })

export function parseQuestion(text)     // → {opened, supports[], answers[]}
export function recordRound({ generation, date, entries, ledger, threshold, retireAfter })
                                        // → {ledger, opened[], supported[], answered[], retired[]}
export function corroborationOf(entry, threshold)   // → {models, labs, modelIds, labIds, reached}
export function buildQuestionBrief(ledger, { threshold, limit })   // → string | null
```

**Reuse, do not re-implement:** `slugify`, `isNone`, the `already()`
duplicate guard, the `field()` block extractor and `consensusOf`'s distinct
counting all exist in `escalations.mjs` and are tested. Export them from
there and import, rather than growing a second copy that drifts.

## Prompt rendering, and the cap that matters

`buildQuestionBrief()` renders **at most `limit` questions (default 4)**,
ranked by corroboration then recency, and returns `null` when there are none
— dropping the section entirely, per
[principle 18](../../learning/01-principles.md#18-never-claim-data-you-did-not-supply).

The cap is the mitigation for the biggest risk in this design. Every open
question is text in every future prompt, competing with source, history,
themes and escalations for attention, and
[principle 17](../../learning/01-principles.md#17-send-what-changes-the-decision-not-what-describes-the-project)
is explicit that the fix for weak context is never "send more."

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/curiosity.mjs` | **New file** |
| `harness/lib/escalations.mjs` | Export `slugify`, `isNone`, `already`, `field`, `distinct` for reuse |
| `harness/lib/orchestrator.mjs` | Three new response fields; `recordQuestions()` beside `recordEscalations()`, **called from the same pre-ranking site at line 852** |
| `harness/lib/adapter.mjs` | `memoryConfig()` gains `curiosity: {ledgerPath, consensus, retireAfter}` |
| `harness/scripts/run-generation.mjs` | Load, render into `context.questions`, emit counts as GitHub outputs |

## The harvest site is not negotiable

`recordEscalations()` is called at `orchestrator.mjs:852`, deliberately
before ranking and before anything below can throw, with the comment that a
losing proposal's opinion is worth as much as the winner's. Questions are the
same and more so: [`../Curiosity-Engine-Design.md` §3.4](../Curiosity-Engine-Design.md)
argues the divergence between the N−1 discarded proposals is exactly where
sparse-evidence questions live. Harvest at the same site, in the same
`try`-free region, so an abandoned or crashed generation still contributes.

## Tests to write

1. `parseQuestion` on a full response; on `none`; on a missing field.
2. An identical question title against a live entry adds a supporter rather than a near-duplicate — the `findBySlug` behaviour `escalations.mjs` already has.
3. A model cannot back its own question twice in one generation.
4. Corroboration counts distinct models and distinct labs; 3 models from one lab does not reach a `{models:3, labs:2}` bar.
5. `QUESTION ANSWER` moves an entry to `answered` and it stops rendering.
6. Retirement fires at exactly `retireAfter` with an empty `citedBy`, and never for an entry with a citation.
7. A retired entry is still present in the file.
8. `buildQuestionBrief` returns `null` on an empty ledger and caps at `limit`.
9. **A crashed generation still records its questions** — the pre-ranking placement.
