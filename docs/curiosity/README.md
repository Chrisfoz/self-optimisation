# Curiosity Engine — implementation specs

Ten components, each one a separable piece of work with its own document.
The design argument lives in
[`../Curiosity-Engine-Design.md`](../Curiosity-Engine-Design.md); these are
the build instructions.

**Status: none of this is built.** Every spec here describes a change to a
harness that runs today, and each names the file it touches and what
already exists there. Where a spec says a thing is LIVE, something reads it
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
| **[C2](C2-themes-review-cli.md)** | Themes review CLI + `UNKNOWN` | The every-N-generations pass that nothing currently triggers, plus the third field that makes it produce questions | [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) | `generate-themes.mjs`, `themes.mjs`, new CLI | real generation records | 0 → A |
| **[C3](C3-curiosity-ledger.md)** | Curiosity ledger | `OPEN QUESTION` harvested from every proposal, corroboration counted across labs, retirement of inert questions | [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | new `lib/curiosity.mjs`, `orchestrator.mjs` | C2, A′ evidence | B |
| **[C4](C4-run-mode-selector.md)** | Run-mode selector | Turns the two-way scope switch into three modes, and makes AMBITIOUS draw from a queue instead of improvising | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | `context-pack.mjs`, `run-generation.mjs` | C3, C8 | C |
| **[C5](C5-the-spike.md)** | The spike | A generation that produces a sourced document instead of a diff — `outcome: 'investigated'` | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | `orchestrator.mjs`, `review.mjs`, `edit-format.mjs` | C1, C3, C4 | C |
| **[C6](C6-external-research.md)** | External research | Lets a spike reach outside the repo, behind the same hostile-input envelope player feedback already specifies | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | new `lib/research.mjs` | C5 | C |
| **[C7](C7-memory-consolidation.md)** | Memory consolidation | The principles tier, promotion by independent re-derivation, and the first thing in this harness that forgets on purpose | [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) | `themes.mjs`, new `lib/principles.mjs` | C2 × several cadences | D |
| **[C8](C8-escalation-follow-through.md)** | Escalation follow-through | Re-surfacing so silence stops counting as rejection; accepted → work order; the minority report | [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), [D3](../../learning/diagrams/proposed-curiosity-authorisation.mmd) | `escalations.mjs`, `notify.mjs`, `orchestrator.mjs` | — (independent) | any |
| **[C9](C9-retrospective-scoring.md)** | Retrospective scoring | The only honest score in the design: did a question get cited, did it survive review, did it ship | [D1](../../learning/diagrams/proposed-curiosity-run.mmd), [D2](../../learning/diagrams/proposed-curiosity-memory.mmd) | `orchestrator.mjs`, new `scripts/score-questions.mjs` | C3 | A′ → E |
| **[C10](C10-runtime-evidence.md)** | Runtime evidence | What the tests, the deploy check and the probes actually saw — so questions are about behaviour, not about source | [D1](../../learning/diagrams/proposed-curiosity-run.mmd) | `context-pack.mjs`, `verify-deployment.mjs` | — (independent) | any |

---

## If you are picking one up cold

Two are independent of everything else and can be built today, against the
harness as it stands:

- **[C8](C8-escalation-follow-through.md)** is the smallest and the highest
  value. An escalation that reaches consensus and is accepted currently
  changes a `status` field and schedules no work. Wiring acceptance to a
  work order produces this project's first genuine outcome label: *did the
  thing three models agreed on actually work?*
- **[C10](C10-runtime-evidence.md)** is pure context-pack work and improves
  every proposal the harness makes, curiosity or not.

Everything else runs through **[C2](C2-themes-review-cli.md)**, which is the
prerequisite the repository already owes itself — `generate-themes.mjs` holds
a prompt and a parser that no CLI calls, and
`memory.themes_review.cadence_generations` is parsed, unit-tested and read
by nothing.

**Do not build C3 before running A′.** The go/no-go experiment is in
[C9](C9-retrospective-scoring.md) §"Phase A′, the cheap version": if the
questions C2 produces are never cited by any subsequent generation, the
ledger is a filing cabinet for noise and the rest of this folder should not
be built.

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
