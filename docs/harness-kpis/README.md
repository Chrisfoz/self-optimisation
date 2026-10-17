# Harness KPIs and practical learning

The harness should learn what produces useful, reliable changes in real projects.
Measure verified improvement against the effort and cost required to achieve it.
Smaller prompts alone are not success.

## Two connected improvement loops

| Loop | What changes | Evidence of improvement |
| --- | --- | --- |
| Product improvement | A game's behaviour, an app's features, usability or reliability | Project tests, acceptance evidence, runtime observations and subsequent outcomes |
| Harness improvement | How the harness investigates, retrieves context, uses memory, chooses models, implements and reviews | Controlled comparisons plus observed outcomes across projects |

The product loop supplies experience. The harness loop turns experience into
specific hypotheses, tests alternative operating strategies, and retains lessons
that survive independent evaluation. A lesson must say **what worked, for which
tasks, under which conditions, and with what evidence**.

For example, repeated dependency regressions could justify testing a policy that
shows reviewers unchanged callers and schemas. They do not establish that a
larger prompt will fix the problem. Compare the policy with the baseline, measure
all calls, and inspect the resulting changes.

## Status

This folder is a measurement and learning specification with reusable templates.
It does **not** install telemetry, calculate a live scorecard, schedule experiments,
or change prompts, models, review gates or merge permissions.

The current foundation includes:
- [Token accounting](../../harness/lib/spend.mjs), including per-stage usage,
  estimates, failures and retries.
- [Attempt records](../../harness/lib/orchestrator.mjs), which persist proposals,
  attempts, review results, tests and spend.
- [Context history](../../harness/lib/context-pack.mjs) and
  [recurring themes](../../harness/lib/themes.mjs).

These records are inputs, not proof of product benefit. Post-change outcomes,
independent review labels and policy experiment provenance still need wiring.

## Read and use

1. [Metric definitions](metric-definitions.md): exact denominators and unknowns.
2. [Learning loop](learning-loop.md): turn observations into tested policies.
3. [Implementation plan](implementation-plan.md): build on existing records.
4. [Outcome template](templates/outcome.template.json): capture an assessment
   without inventing measurements.
5. [Experiment template](templates/experiment.template.md): predeclare the
   comparison and write down the result.

Keep the five primary measures separate initially. Pair every rate with its
numerator, denominator, assessment coverage and observation period. Do not hide a
rise in escaped defects behind a lower token bill or a composite score.
