# The first real campaigns — 2026-09-11

**Four generations with real model calls, through `harness/` itself, on two
projects chosen to be different: a children's browser game and a Python
command-line tool.** Until this date every check in this repository faked the
three model calls. This is what happened when they were real, written up
failures and all, because the failures are the point.

The raw records are in [`2026-09-11/`](2026-09-11/) — every `attempts.json`,
the before/after measurements, each project's generated `REPORT.md`, and the
installation that produced them (adapter, briefs, evaluator plugins).

## What ran, and how

- **How:** locally, with `node --env-file=.env harness/scripts/rehearse.mjs
  --models …` — the same chain the generated workflow runs (validate →
  preflight → campaign → probe → claim a generation → baseline measurement →
  suggest → rank → implement → in-loop tests → review → refine → persist →
  guard → tests), in a scratch clone of each project with a local bare
  remote. **Not** on GitHub Actions; see *What is still not proven*.
- **Seats:** implement `claude-opus-5`, review `gpt-5.5` (a different lab from
  the implementer, on purpose), rank defaulted to `claude-opus-5`. Suggest was
  the models named for each campaign generation.
- **Budget:** 900,000 tokens per generation for the game, 600,000 for the CLI.
  Scope `focused`. Three implementer attempts.
- **The projects:**
  - **Germ Fighter** — one of the two games in carrotgame (the reference
    implementation), lifted into its own repository with its headless rules
    suite (`node tests/game-logic/germ-rules.test.js`). Editable surface: the
    one ~2,700-line HTML file. carrotgame is a private repository, so its
    source, the diffs and the proposal texts are **not** reproduced here —
    only the records that carry none.
  - **ICD mapper** — [`icd-conversion`](https://github.com/Chrisfoz/icd-conversion),
    a ~300-line Python tool that maps ICD-10 to ICD-10-AM codes. No visual
    surface, no tests of its own: characterisation tests (pytest) and a
    synthetic fixture in the real column layout were written at install
    time. The real mapping tables are licensed and were neither copied nor
    sent to any model.
- **Evaluators** (never gating, measured before and after every change):
  - Germ Fighter — a fixed autoplayer across five seeds (can easy level 1 be
    cleared), a three-germs-at-once contact scenario, tap-target size and
    overlap mid-game on a 390×844 touch screen in headless Chromium, and
    frame time at 4× CPU throttle (with a declared tolerance, since timing
    is noisy). Every non-local request blocked.
  - ICD mapper — how many of eight awkward but legitimate input files (BOM,
    CRLF, latin-1, padded codes, short rows, a blank line, an extra column)
    the reader recovers a row from, and how many crash it; the shipped
    `source-weight` plugin.

## The four generations

| | Suggest (asked) | Chosen | Attempts | Verdict | Tokens | Measured before → after |
|---|---|---|---|---|---|---|
| **Germ Fighter 001** | gpt-6-astra, gemini-3.8-flash, grok-4.6 | grok-4.6 | grok's own edits → **tests failed** → claude-opus-5 → approved | approved on attempt 2 | 298,196 | no change on 8 metrics — *see "blind spots"* |
| **Germ Fighter 002** | claude-fable-5-1, gemini-3.1-pro-preview, kimi-k3 *(ECONNRESET)* | claude-fable-5-1 | its own edits → approved | approved on attempt 1 | 193,554 | no change on 9 metrics |
| **ICD mapper 001** | kimi-k3 *(ECONNRESET)*, deepseek-v4-pro, glm-5.3 | glm-5.3 | glm's own edits → **tests failed** → claude-opus-5 → approved | approved on attempt 2 | 48,401 | **files that crash the reader 1 → 0; rows recovered 6 → 7**; source 298 → 313 lines |
| **ICD mapper 002** | gpt-6-astra, grok-4.6, muse-spark-1.3 | muse-spark-1.3 | muse's own edits → **rejected** → rejected → rejected → approved | approved on attempt 4 | 76,456 | **no robustness change**; source 313 → 323 lines |

**616,607 tokens in all, across 29 requests to 11 models from 8 labs** (7
answered; Moonshot's connection reset both times it was asked). 2 of the 29
requests are estimates rather than provider-reported usage: the two that
failed before any response.

What each change was:

- **Germ Fighter 001** — when several germs land on the player in one frame,
  only the first costs a life; the rest turn harmless and faded. (Grok
  proposed a two-second invulnerability window; its own implementation broke
  the rules suite, and the implementer delivered the same goal a different
  way.)
- **Germ Fighter 002** — the DASH button fills up while it recharges, so a
  child who cannot read can see *when* it will work again instead of tapping
  a control that silently ignores them.
- **ICD mapper 001** — the reader survives a UTF-8 BOM and a latin-1 export
  (which used to crash the whole file), and reports a short row by file and
  line instead of dropping it without a word.
- **ICD mapper 002** — a row whose trailing, optional target columns were
  omitted by the exporting system is padded back out and kept, instead of
  skipped.

## What it proved

- **The loop works with real models, end to end.** Every stage ran on real
  responses from eight labs, and every record landed on the default branch
  under its own claimed number with a run id — including the costs.
- **Tests inside the repair loop paid off immediately.** In two of the four
  generations the winning suggester wrote its own edits, they applied
  cleanly, and **the project's tests failed against them**. Before
  2026-09-11 that failure would have been found by the workflow's test step
  after the loop had finished, and the generation abandoned. Instead the
  reviewer was not paid for the broken tree, the implementer was handed the
  failing lines, and both generations shipped a passing change on the next
  attempt.
- **The reviewer does real work.** ICD mapper 002 passed its tests on every
  attempt, and `gpt-5.5` rejected three of them anyway, each on substance
  the tests could not see: padding could create mappings with a blank
  required code; a genuinely truncated descriptor would be blanked silently;
  and one version "does not work — every short row is still skipped". The
  fourth was approved.
- **Metering holds up on real traffic.** `gemini-3.8-flash` spent its whole
  32,000-token allowance on hidden reasoning, was retried at 64,000, and the
  record shows **two** calls and 67,359 output tokens — the old ledger would
  have shown one. The two dropped Kimi connections are recorded as failed
  requests at their estimated input, rather than as free.
- **The escalation channel is used for the right thing.** Two models argued,
  without editing anything, that a frozen file was in the way:
  `gemini-3.1-pro-preview` that the rules suite's rapid-hit assertion blocks
  an invulnerability window (the same wall Grok hit a generation earlier),
  and `grok-4.6` that the ICD characterisation tests never assert a
  recovered short row is kept, so the recovery could regress without a red
  build. Both are fair.

## What broke in the harness — and was fixed the same day

The fake-model suite (then 631 tests, green on Linux CI for Node 22.11 and
24) had seen none of these.

| Finding | Fix |
|---|---|
| The prompt's **"frozen test invariants" section was silently dropped for both projects**: the test-name extractor knew only `test()`/`it()`/`describe()`, and the game's suite uses a `check()` helper while the CLI uses pytest. No model was told what the tests protect. | `e7b3475` — reads `check()`, RSpec `it "…" do`, pytest, Go, Rust, JUnit/Kotlin and xUnit conventions |
| A failing test run was recorded by the **last 300 characters** of its output — pages of PASS lines, since that suite prints its one FAIL mid-run. | `8b7ad6a` — `failureExcerpt()` finds the lines that report a failure; the implementer is shown them first |
| A rehearsal's **commit was titled from the suggester's proposal**, which the implementer had delivered by a different mechanism — so the commit described code that was never written. | `8b7ad6a` — titled from the approved attempt, as the workflow already did |
| After a rehearsal persisted its record, the local copies blocked the **`git checkout <base>` the script tells you to run**. | `35f3040` — cleared once they are safely committed |
| **One transient `ECONNRESET` cost a lab its whole seat** — twice. The same model answered a 50,000-token request cleanly minutes later. There was no retry for transport failures at all. | `433d5f6` — one retry, metered, on a dropped connection or an overloaded gateway (never on our own timeout, a 4xx, or a 429); TCP keepalive on the socket |
| A run printed **"attempt 4/3"**. | `433d5f6` |
| The generated report said **"Release yield 100% — changes a person kept"** for changes nobody had reviewed: a record with no pull request was read as merged. | `89d7bac` — an approval from a local run is `rehearsed`, not kept; the reports in [`2026-09-11/`](2026-09-11/) now say 0 of 2 kept |

Not fixed, noted:

- On a campaign run with no model snapshot, the rank seat cannot find a
  different family and falls back to the implementer's (`seats.mjs` warns).
- The Germ Fighter tree started in good shape on every measure (all tap
  targets ≥ 44 px, 5/5 seeds cleared, p95 16.7 ms throttled) — so there was
  little for a measurement to move, which is a property of the project, not
  a flaw.

## What the measurements showed — and what they could not

- **They caught a change that did not do what it claimed.** ICD mapper 002's
  narrative is "recover rows with omitted trailing columns"; the robustness
  probe's short row (which also lacks a *required* column) is still dropped,
  so the measured effect is zero robustness gain for ten more lines. The
  measurement is right and the change is narrower than its summary.
- **They were blind to Germ Fighter 001.** The change softens what happens
  when a child is hit; the autoplayer never gets hit, so every metric read
  "no change". A contact scenario was then added to the project's evaluator
  and run retrospectively on the trees before and after the change:
  **three germs landing at once cost 3 lives before and 1 after.** The
  before/after mechanism is only as good as the project's evaluators — and
  finding out which dimension a change was invisible to is itself useful.
- **Visual clarity is judged, not scored.** Germ Fighter 002's DASH fill is a
  pure presentation change; it shows up in the mid-game screenshot the
  evaluator attaches for the next generation and the reviewer, and nowhere
  in the numbers — which is the honest place for it.

## What is still not proven

- **Nobody reviewed these changes.** Generation 001 of each project was
  merged by the campaign operator (an AI session) so that 002 could build on
  it, and labelled as such in each repository's history; 002 was never
  merged. No product owner has looked at any of them — which is exactly
  what the reports now say.
- **The generated workflow has not run on GitHub Actions against a real
  repository.** Its steps are executed under GitHub's own bash flags in the
  test suite (`tests/scripts/workflow-shell.test.mjs`,
  `tests/scripts/generation-identity.test.mjs`), but a real run — secrets,
  the real `GITHUB_TOKEN`, a real pull request — is the next step.
- **`context.strategy: scoped`** was not forced: both projects were small
  enough for `full-dump` (the game's editable file is ~120,000 characters,
  ~30,000 tokens). WORKPLAN 2.1's larger-repository question is still open.
- **n = 4.** Nothing here is a rate.

## Reproducing it

Each project's installation is in [`2026-09-11/<project>/installation/`](2026-09-11/).
With the harness vendored into a project and lab keys in `.env`:

```bash
node --env-file=.env harness/scripts/rehearse.mjs --models gpt-6-astra,gemini-3.8-flash,grok-4.6
```

The complete scratch repositories — every agent branch and record, including
Germ Fighter's private source — were kept outside this repository as git
bundles, with the raw run logs, by the person who ran them.
