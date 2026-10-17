# Implementation plan

This is a staged backlog, not functionality enabled by this folder.

## 1 Capture and join evidence

Reuse `spend.summary()` and `attempts.json`; do not implement a parallel token
ledger. Add versioned companion assessments and context-policy provenance without
rewriting historical attempt semantics. The example outcome template is a design
starting point, not an enforced schema. Version 2 uses a `reviews` array so
earlier rejections and later approvals on different patch revisions can each be
independently assessed. No runtime consumer is changed by that template revision.

Use the [workflow integration map](workflow-integration.md) to distinguish
existing emission points from collectors and joins that still need building.

Join by stable run, proposal and patch IDs. Preserve repository/base/patch SHAs,
model/provider versions, policy revision, context pack identifiers, timestamps
and evidence references. Record blocked or failed attempts even when no PR exists.
Reconcile approval, merge and deployment events without treating them as product
success.

The current spend ledger exposes totals, per-site/per-model breakdowns and
estimated calls. Its stage summaries do not establish complete whole-system
billing. Audit auxiliary calls and cache/reasoning token treatment before
claiming full cost coverage. Monetary reports need dated billing or pricing
evidence, currency and allocation rules; no static guessed price table.

## 2 Assess outcomes

Apply project-specific acceptance criteria and observation windows. Add
follow-up for dependency incidents, user/runtime benefit and independently
adjudicated reviewer decisions. Keep time-stamped revisions rather than silently
replacing assessments. Start with manual evidence where automation cannot
establish truth.

## 3 Publish a descriptive scorecard

Build a read-only aggregate over declared cohorts. Show numerators, denominators,
unknowns, coverage, spend completeness and maturity. Reconcile run counts and
token totals against source records. No composite score or automatic strategy
change in this phase.

Verification should cover zero successes, no labelled reviews, pending outcomes,
late incidents, legitimate retries, duplicate events, partial spend, missing
billing and superseded assessments. These cases matter because a plausible
dashboard can otherwise report improvements that did not happen.

## 4 Test context and memory policies

Compare baseline, selective retrieval, and retrieval plus curated memory on
pinned task/model cohorts. Use the
[experiment template](templates/experiment.template.md).
Budget helper work as part of the experiment. Keep held-out evaluations separate
from policy development and model prompts.

## 5 Adopt practical lessons

Only after measurement is trustworthy, trial policy changes through the existing
review and approval route. Record conditional findings and rollback evidence.
Test transfer on another project rather than assuming a result on one game
applies to every app.

## First useful milestone

A manually assessed cohort report that reconciles to actual generation records
and says which changes worked, what they cost, what was repeated, what review
missed, and what remains unknown. This provides a trustworthy basis for choosing
the next operating-strategy experiment.
