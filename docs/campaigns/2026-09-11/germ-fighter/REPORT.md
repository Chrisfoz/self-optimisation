# Self-improvement — operational report

Generated 2026-09-11 by `harness/scripts/report.mjs` from every `docs/generations/gen-NNN/attempts.json`. **Do not edit by hand** — the next run overwrites it. The definitions are the paper's §7 metrics (`Model-Release-Driven-Software-Improvement-Paper-Outline.md`).

| Metric | Value | Definition |
|---|---|---|
| Generations on record | 2 (2 in campaign mode) | one per cycle that produced a record |
| Release yield | 0% (0 of 2) | generations whose change a person kept: approved, merged, not reverted |
| Promotion precision | n/a (0 of 0 landed) | of the changes that reached the default branch, how many were not reverted |
| Closed by the owner | 0 | approved by review, but the pull request was closed unmerged — the reviewer and the owner disagreed |
| Failure recurrence | no abandoned generations | an abandoned proposal whose summary repeats an earlier abandoned one (crude: first 60 characters, normalised) |
| Tokens spent | 491,750 across 2 generation(s) | input plus output, every model call, from provider-reported usage |
| Tokens per kept change | n/a | tokens spent (where recorded) ÷ kept changes among those generations |

## Outcomes

| Outcome | Count |
|---|---|
| approved | 2 |

Of the 2 approved: 0 merged and kept, 0 still open as pull requests, 0 closed unmerged, 0 reverted, 2 approved only in a local rehearsal and never put to a person.

## By scope

| Scope | Runs | Approved | Kept |
|---|---|---|---|
| focused | 2 | 2 (100%) | 0 (0%) |

## By lab

Asked = proposals requested in a fan-out. Chosen = won the ranking. Approved = the chosen proposal passed review. Kept = it merged and stayed. Self-implemented = the suggesting model's own edit blocks shipped.

| Lab | Asked | Chosen | Approved | Kept | Self-implemented |
|---|---|---|---|---|---|
| anthropic | 1 | 1 | 1 | 0 | 1 |
| google | 2 | 0 | 0 | 0 | 0 |
| moonshot | 1 | 0 | 0 | 0 | 0 |
| openai | 1 | 0 | 0 | 0 | 0 |
| xai | 1 | 1 | 1 | 0 | 0 |

## Measured effect

The project's own evaluators, run on the untouched tree before each generation and on the changed tree after it — same evaluators, same config, or the pair is not compared. Benefits and regressions follow each metric's declared direction; a metric with no direction is only "changed". Nothing here gates. Fate is what a person did with the change afterwards.

2 measured change(s): 0 moved something the right way, 0 moved something the wrong way.

| Generation | Fate | Tokens | Benefits | Regressions | Changed (no direction) |
|---|---|---|---|---|---|
| 001 | rehearsed | 298,196 | — | — | — |
| 002 | rehearsed | 193,554 | — | — | — |
