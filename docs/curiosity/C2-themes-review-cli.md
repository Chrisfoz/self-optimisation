# C2 — The themes review CLI, and the `UNKNOWN` field

**Status:** BUILT (both halves) · **Phase:** 0 → A · **Depends on:** real generation records · **Blocks:** C3, C7

Phase 0, the CLI, shipped as `harness/scripts/generate-themes-review.mjs`
(WORKPLAN 1.4), and the generated workflow runs it after a generation that
produced changes. Phase A, the `UNKNOWN` field, shipped as WORKPLAN 4.0.
The sections below are kept in the tense they were specified in; the file
table at the end says what each change became.
**Drawn in:** [D2](../../learning/diagrams/proposed-curiosity-memory.mmd), nodes `trev` and `unknown`

---

## What it is

Two things, in order:

**Phase 0 — the CLI that does not exist.** `harness/lib/generate-themes.mjs`
holds the prompt builder and the response parser for a themes review, fully
tested. `harness/lib/themes.mjs` holds the read side and is wired into every
suggestion prompt. **Nothing calls a model with them.** The CLI that would
was deliberately not ported, because it needs generation history as input and
that only exists once real `docs/generations/gen-NNN/` records accumulate
(`Portable-Harness-Design.md` §3, Bucket B table). And
`memory.themes_review.cadence_generations` is parsed at `adapter.mjs:157`,
unit-tested, and **read by nothing** — RESERVED, and `adapter.mjs:141` says
so in a comment.

**Phase A — the third field.** The review currently produces `NOTICED` (the
association) and `MEANS` (the abstraction). Add `UNKNOWN`: the frontier of
the abstraction — what the principle implies that no generation has tested.
One prompt field, one parse rule, one prompt section. That is the entire
curiosity change at this stage.

## Phase 0 — `scripts/generate-themes-review.mjs` (built)

A CLI in the shape of every other one here: read the adapter, assemble input
from the repo, call one model, parse, write, emit GitHub outputs.

```
Environment:
  THEMES_MODEL      optional; defaults to roles.review.model, then claude-opus-5
  GEN_NUMBER        the generation just completed — decides whether a review is due
  FORCE_REVIEW      "true" to run regardless of cadence (for a first run, or a backfill)
```

Behaviour:

1. Load the adapter. Read `memory.themes_review.{dir, cadence_generations}`.
2. **Decide whether a review is due.** Due when `genNumber % cadence === 0`
   and no `review-NNN.json` already covers that generation. Not due → exit 0,
   print why, set `ran=false`. A cadence check that is cheap to run every
   generation is better than a second schedule to keep in sync.
3. Assemble the window: `buildGenerationHistory({limit: cadence})` from
   `context-pack.mjs`. This is the same function the suggestion stage uses —
   do not write a second history formatter.
4. Call the model with `buildThemesSystemPrompt(projectDescription)` and
   `buildThemesUserPrompt(historyText, throughGeneration)`.
5. Parse with `parseThemesResponse()`. **On any parse error, write nothing
   and exit non-zero.** The module's own comment states the rule: a themes
   review is permanent standing context for every future generation, so a
   bad one is worse than none.
6. Write `<themesDir>/review-NNN.json`, where NNN is `throughGeneration`
   zero-padded to match the existing `loadLatestThemesReview()` sort, which
   is a plain lexicographic sort on filename and therefore **requires
   consistent padding**. Use the same width as `GEN_NUMBER`.

Output file:

```jsonc
{
  "version": 1,
  "throughGeneration": "020",
  "date": "2026-08-22",
  "windowSize": 10,
  "model": "claude-opus-5",
  "provider": "anthropic",
  "themes": [
    { "noticed": "...", "means": "...", "unknown": "..." }   // unknown optional — see below
  ]
}
```

`throughGeneration` and `date` are already read by `buildThemesBrief()`.
`windowSize`, `model` and `provider` are new and exist for C7: promotion by
re-derivation needs to know two reviews read *different* windows.

## Phase A — the `UNKNOWN` field

### Prompt

`buildThemesSystemPrompt()` gains a third field, and one instruction that
matters more than the field:

> UNKNOWN: the question this principle exposes and does not answer — what
> you would have to find out to know whether it holds, or what it implies
> that no generation has yet tested. **Optional. If the principle is settled
> and nothing about it is genuinely open, write `none` and move on.** A
> question invented to fill this field is worse than an empty field, because
> a later pass will spend a whole generation on it.

Optionality is not politeness. It is the same reasoning the existing prompt
applies to the theme count — *"if you cannot find a genuine one, it is better
to return fewer than to pad the count"* — and the failure mode it guards
against is the one that kills this whole design (see
[C9](C9-retrospective-scoring.md)'s mortality metric).

### Parser

`parseThemesResponse()` gains an `UNKNOWN` capture. Rules, matching the
existing `NOTICED`/`MEANS` guards:

| Case | Behaviour |
|---|---|
| Field absent | `unknown: null`. Not an error. |
| `none` / `(none)` / `none.` | `unknown: null`. Reuse `escalations.mjs`'s `isNone()` — do not write a second one. |
| Present, < 15 chars | **Throw.** Too short to be a real question; same bar as `NOTICED`. |
| Present, ≥ 15 chars | `unknown: <text>`, clamped to 1000 chars. |

The field ordering in the response format is `NOTICED` → `MEANS` →
`UNKNOWN`, and the existing `MEANS` regex is `/^MEANS:\s*([\s\S]*)$/m` —
**greedy to end of block.** Adding a field after it means `MEANS` must now
stop at `\nUNKNOWN:`, exactly as `NOTICED` already stops at `\nMEANS:`. This
is the one place a careless change silently swallows the new field into the
old one, and test 4 below exists to catch it.

### Read side

`buildThemesBrief()` renders questions as their **own section**, not as a
trailing sentence on each theme. A lesson already learned and a question
still open are different kinds of context and should not read as one
paragraph:

```
export function buildThemesBrief(review)          // unchanged shape, themes only
export function buildOpenQuestionsBrief(review)   // new; null when no theme has one
```

`orchestrator.mjs:251` gains one `section()` call — *"Open questions this
project has not answered"* — placed after the themes section and before
escalations.

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/generate-themes.mjs` | Third field in the prompt; `UNKNOWN` capture and `MEANS` boundary fix in the parser |
| `harness/lib/themes.mjs` | `buildOpenQuestionsBrief()`; `loadLatestThemesReview()` unchanged |
| `harness/lib/orchestrator.mjs` | One `section()` at the user-prompt assembly |
| `harness/scripts/generate-themes-review.mjs` | **Built** — phase 0, the new file |
| `harness/scripts/run-generation.mjs` | Pass the new block into `context.openQuestions` |
| `examples/workflows/watch-releases.yml` | A step that runs the CLI after a generation completes |

## Failure behaviour

- Parse error → nothing written, non-zero exit, workflow step fails visibly.
  The generation itself already succeeded; this is a separate step and must
  not roll it back.
- Model call fails → same. A missed review is a missed review; the next
  cadence boundary picks it up.
- Malformed file on disk → `loadLatestThemesReview()` already logs and
  returns `null`, dropping the section. Unchanged.

## Tests to write

1. Cadence: due at 10/20/30, not due at 11; `FORCE_REVIEW` overrides.
2. Cadence: not due when a review already covers that generation.
3. `parseThemesResponse` with no `UNKNOWN` → `unknown: null`, no throw.
4. **`MEANS` does not swallow `UNKNOWN`** when both are present.
5. `UNKNOWN: none` → `null`; `UNKNOWN: too short` → throws.
6. `buildOpenQuestionsBrief` returns `null` when no theme has a question.
7. Filename padding: `review-9.json` and `review-10.json` sort correctly — or, better, prove the writer never produces the unpadded form.
