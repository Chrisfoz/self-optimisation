# Curiosity Engine — implementation specs

Ten components, each one a separable piece of work with its own document.
The design argument lives in
[`../Curiosity-Engine-Design.md`](../Curiosity-Engine-Design.md); these are
the build instructions.

**Status: four of ten built** — C1, C2 (both halves: the CLI, and phase A's
`UNKNOWN` field), C8 and C10. The other six wait on the A′ go/no-go, which
`WORKPLAN.md` 4.3a proposes running on carrotgame's existing history.
Every spec here describes a change to a harness that runs today, and each
names the file it touches and what already exists there. Where a spec says a thing is LIVE, something reads it
now; RESERVED means it is parsed and nothing consumes it; PROPOSED means it
does not exist.

The `C n` numbers are the same numbers drawn on the diagrams in
[`../../learning/diagrams/`](../../learning/diagrams/), so a node in a
picture and a document on this page are the same thing.

---

## The index

| # | Component | What it does | Drawn in | Touches | Depends on | Phase |
|---|---|---|---|---|---|---|
| **[C1](C1-committed-goal.md)** | Committed goal | The user commits to a goal at install; it is frozen, argued-against-not-edited, and becomes the referent for "useful" | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | `adapter.mjs`, `guard.mjs`, `orchestrator.mjs`, `review.mjs` | — | −1 |
| **[C2](C2-themes-review-cli.md)** | Themes review CLI + `UNKNOWN` | The every-N-generations pass that nothing currently triggers, plus the third field that makes it produce questions | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) | `generate-themes.mjs`, `themes.mjs`, new CLI | real generation records | 0 → A |
| **[C3](C3-curiosity-ledger.md)** | Curiosity ledger | `OPEN QUESTION` harvested from every proposal, corroboration counted across labs, retirement of inert questions | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | new `lib/curiosity.mjs`, `orchestrator.mjs` | C2, A′ evidence | B |
| **[C4](C4-run-mode-selector.md)** | Run-mode selector | Turns the two-way scope switch into three modes, and makes AMBITIOUS draw from a queue instead of improvising | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | `context-pack.mjs`, `run-generation.mjs` | C3, C8 | C |
| **[C5](C5-the-spike.md)** | The spike | A generation that produces a sourced document instead of a diff — `outcome: 'investigated'` | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | `orchestrator.mjs`, `review.mjs`, `edit-format.mjs` | C1, C3, C4 | C |
| **[C6](C6-external-research.md)** | External research | Lets a spike reach outside the repo, behind the same hostile-input envelope player feedback already specifies | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | new `lib/research.mjs` | C5 | C |
| **[C7](C7-memory-consolidation.md)** | Memory consolidation | The principles tier, promotion by independent re-derivation, and the first thing in this harness that forgets on purpose | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) | `themes.mjs`, new `lib/principles.mjs` | C2 × several cadences | D |
| **[C8](C8-escalation-follow-through.md)** | Escalation follow-through | Re-surfacing so silence stops counting as rejection; accepted → work order; the minority report | [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | `escalations.mjs`, `notify.mjs`, `orchestrator.mjs` | — (independent) | any |
| **[C9](C9-retrospective-scoring.md)** | Retrospective scoring | The only honest score in the design: did a question get cited, did it survive review, did it ship | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | `orchestrator.mjs`, new `scripts/score-questions.mjs` | C3 | A′ → E |
| **[C10](C10-runtime-evidence.md)** | Runtime evidence | What the tests, the deploy check and the probes actually saw — so questions are about behaviour, not about source | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | `context-pack.mjs`, `verify-deployment.mjs` | — (independent) | any |

---

## If you are picking one up cold

**Start by reading what already runs.** The two that were independent of
everything else have both shipped, and they are the worked examples for how
an additive component lands here:

- **[C8](C8-escalation-follow-through.md)** was the smallest and the highest
  value. An escalation that reached consensus and was accepted used to change
  a `status` field and schedule no work; acceptance now queues a work order
  that a later run is handed and reports back on, which is this project's
  first genuine outcome label: *did the thing three models agreed on actually
  work?*
- **[C10](C10-runtime-evidence.md)** was pure context-pack work and improves
  every proposal the harness makes, curiosity or not.

**[C2](C2-themes-review-cli.md)**, which everything else runs through, has
shipped too: `harness/scripts/generate-themes-review.mjs` is the CLI that
`generate-themes.mjs`'s prompt and parser were waiting for,
`memory.themes_review.cadence_generations` is what decides when it is due,
and the generated workflow runs it after a generation that produced changes.
Phase A, the `UNKNOWN` field, is live in the suggestion prompt.

**Do not build C3 before running A′.** The go/no-go experiment is in
[C9](C9-retrospective-scoring.md) §"Phase A′, the cheap version": if the
questions C2 produces are never cited by any subsequent generation, the
ledger is a filing cabinet for noise and the rest of this folder should not
be built.

---

## Cold start: the first runs must work with none of this

**A repository with no history has no curiosity, and that is correct
behaviour, not a degraded mode.** Every component here is additive to a loop
that already runs, and every one of them renders *nothing* when its input is
absent. Verified against the code as it stands today:

| Call, on a repo with no records | Returns |
|---|---|
| `loadLatestThemesReview()` | `null` |
| `buildThemesBrief(null)` | `null` — section dropped |
| `buildEscalationBrief(loadLedger())` | `null` — section dropped |
| `buildGenerationIndex()` | `null` — section dropped |
| `buildGenerationHistory()` | `"- None yet; this is the first generation."` |
| `recommendScope()` | `focused`, "only 0 generation(s) on record" |

The run-1 suggestion prompt is therefore the repository map, the source, and
the task — **and no heading for anything that does not exist.** That is
[principle 18](../../learning/01-principles.md#18-never-claim-data-you-did-not-supply)
working: there is no state in which the prompt describes a question list, a
themes review or an escalation queue that is not there.

### What actually happens, generation by generation

Assuming the example cadence (themes every 10, ambitious needs 2 clean
merges, questions retire after 15, escalations re-surface after 5):

| Gen | Curiosity's contribution |
|---|---|
| **1** | Asks `OPEN QUESTION`; `"none"` is a fine answer. Nothing renders. Run is `focused` — `recommendScope()` forces it. |
| **2–3** | Questions begin accumulating in the ledger. Still nothing rendered: the brief is capped and ranked by corroboration, and one uncorroborated question is not worth the prompt space. |
| **~5** | First escalations become old enough to re-surface ([C8](C8-escalation-follow-through.md)). Still no spikes, no assignments. |
| **10** | **First themes review.** First `UNKNOWN` fields. The first time an *"Open questions"* section appears in a prompt at all. |
| **~11–15** | Corroboration can now cross 2. First spike becomes *possible* — but only if ambitious headroom is earned and no accepted escalation is queued ([C4](C4-run-mode-selector.md) rule ordering). |
| **~15+** | First retirements. The ledger starts shrinking as well as growing. |
| **20** | **Second themes review** — the earliest a principle can be promoted, and only if it is re-derived from a non-overlapping window ([C7](C7-memory-consolidation.md)). |
| **any** | Work orders, whenever a human accepts an escalation. That clock is the owner's, not the loop's. |

So the honest answer to *"when does curiosity start doing anything?"* is
**generation 10 for questions, and around generation 20 for principles** —
and everything before that is the ordinary loop, unchanged, quietly filling
the ledgers that make generation 10 worth having.

### The two things that are NOT deferred

Be clear about these rather than claiming the whole design sleeps:

**1. `OPEN QUESTION` is asked from run 1.** It is a required response field
from the first generation, costing a few hundred tokens per proposal. This is
deliberate and it is the same bargain `ESCALATION` already makes — required
from run 1, `"none"` accepted, and the ledger it fills is worthless unless it
started filling early. Nothing *renders* until there is something
corroborated to render.

**2. The goal ([C1](C1-committed-goal.md)) changes run 1 materially.** It is
in every prompt and the reviewer judges against it from the first generation.
That is the intended behaviour — a goal that only takes effect at generation
10 would have let nine generations drift first.

[C8](C8-escalation-follow-through.md) and [C10](C10-runtime-evidence.md) are
also live from run 1, but neither is curiosity: one is finishing a mechanism
that already exists, the other is context every proposal benefits from.

### The test this requires

**Every component in this folder owes a cold-start test**, and "it returns
null on empty input" is not sufficient on its own. The one that matters is
the byte-identity test:

> With no goal, no questions, no principles and no runtime evidence, the
> assembled suggestion prompt is **byte-identical** to the prompt the harness
> produces today.

That is the only assertion that proves the whole design is additive rather
than merely intended to be. Write it once, at the `buildSuggestSystemPrompt`
/ `buildSuggestUserPrompt` level, against a fixture of today's output — and
run it on every one of the ten components, not just the first.

Its failure mode is the reason it is worth the effort: a stray `\n` or an
empty heading is invisible in review, costs nothing measurable, and silently
changes the prompt every model in the rotation has been answering.

---

## Conventions every spec follows

**Fail closed on model output, fail safe on helpers.** A malformed themes
review, a malformed question block, an unparseable findings file — none of
these may write a wrong conclusion into standing context. Drop the section
instead. A helper that cannot decide (a ranker, a scorer) falls back to a
defensible default and logs. This is
[principle 14](../../learning/01-principles.md#14-the-safety-gate-fails-closed-helpers-fail-safe)
and the harness already holds to it in both directions.

**Never claim data you did not supply.** Every prompt section is dropped
entirely when its content is missing — `buildThemesBrief()` returning `null`
is the pattern. There is no state where the prompt describes a question list
that is not there. See
[principle 18](../../learning/01-principles.md#18-never-claim-data-you-did-not-supply).

**Pure logic separate from any call.** Prompt builders and parsers live in
`lib/` and are unit-tested against fixed strings; only a `scripts/` CLI
touches a model or the network. `generate-themes.mjs` and `probe-models.mjs`
are the existing examples.

**Every new artifact is JSON with a `version` field and a `howToResolve`
string**, so whoever opens the file next can read the rules without reading
the code. `escalations.mjs`'s `emptyLedger()` is the template.
