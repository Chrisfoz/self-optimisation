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

- [Replay provenance](../../harness/lib/assemble-context.mjs) in every attempt
  record: base commit, adapter, brief and prompt hashes, context sizes.
- The [replay bench](../Replay-Bench.md), which compares operating strategies on
  pinned commits with held-out oracle checks. It is the comparison tool KPI4
  needs, but no real cohort has been run with it yet.
- [Lessons](../../harness/lib/lessons.mjs) that stay candidates until a second
  generation or a person's verdict supports them.

- [Operational reporting](../../harness/lib/report.mjs) and
  [run history](../../harness/lib/run-history.mjs), which describe dispositions
  such as merged or kept, resource use and available evaluator comparisons.

These reports do not provide the new verified-success or independently labelled
review-accuracy measures. A model approval, merge or owner disagreement is not an
independent effectiveness label.

These records are inputs, not proof of product benefit. Post-change outcomes,
independent review labels and policy experiment provenance still need wiring.

## Read and use

1. [Metric definitions](metric-definitions.md): exact denominators and unknowns.
2. [Learning loop](learning-loop.md): turn observations into tested policies.
3. [Workflow integration](workflow-integration.md): existing evidence, missing
   collection points and when workflow changes become justified.
4. [Implementation plan](implementation-plan.md): build on existing records.
5. [Outcome template](templates/outcome.template.json): capture an assessment
   without inventing measurements.
6. [Experiment template](templates/experiment.template.md): predeclare the
   comparison and write down the result.

Keep the five primary measures separate initially. Pair every rate with its
numerator, denominator, assessment coverage and observation period. Do not hide a
rise in escaped defects behind a lower token bill or a composite score.

The [rendered two-loop diagram](../../ARCHITECTURE.md#proposed-kpi-learning-loop)
distinguishes the implemented product loop from the proposed learning process.
Its [Mermaid source](../../learning/diagrams/proposed-kpi-learning-loop.mmd) can
be reused in other documentation.
