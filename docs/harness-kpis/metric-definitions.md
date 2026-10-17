# Metric definitions

## Measurement unit and cohorts

A generation is one identified harness run, including unsuccessful terminal
outcomes. A proposal is a candidate idea within a generation; a change is the
resulting patch. Give each a stable ID and join follow-up assessments to its
repository, base SHA, patch SHA and policy version.

Declare the repository, task class, model versions, time interval and observation
window before comparison. Report blocked runs and infrastructure failures
separately, with counts; do not quietly remove them to improve the success rate.
Use an explicit as-of timestamp. Later assessments can revise a cohort result.

Predeclare eligibility. By default, include every assigned generation record,
including over-budget, no-proposal, abandoned and failed runs, whether or not any
model produced an answer. Quiet/no-release cycles, pauses and failures before a
generation is assigned belong in a separate cycle inventory. Show their counts
and reasons; they are not successful generations. Report infrastructure-failure
strata separately without removing assigned generations from the primary
denominator. Any different eligibility rule must be declared before results are
seen, with excluded counts and rationale.

## Five primary KPIs

| KPI | Definition | Interpretation and evidence |
| --- | --- | --- |
| Tokens and cost per verified successful change | All input and output tokens spent in the cohort / verified successful changes. Report actual API spend / successes separately when billing evidence is available. | Include unsuccessful runs, exploration, retrieval, fan-out, ranking, implementation, retries, review and memory maintenance. Tokens are resource usage, not money. |
| Repeated failed idea rate | Assessed proposals repeating a recorded failed approach without new evidence or changed conditions / all proposals assessed for repetition. | Link the prior failure and explain equivalence. Legitimate retries under changed conditions are not failures of memory. Also report assessed / total proposals. |
| Missed dependency bug rate | Distinct assessed changes with an independently confirmed dependency defect that escaped approval / approved changes with completed dependency follow-up. | Inspect unchanged callers, interfaces, schemas, configuration and runtime interactions. Count affected changes once in the rate; report incident counts separately. Always show follow-up coverage. |
| Verified successful change rate | Verified successful changes / all eligible attempted generations in the declared cohort. | Report pending, failed and inconclusive counts alongside the rate. Pending outcomes are not verified successes. Show a separate matured-cohort rate when every included run has completed its declared observation window. |
| Review accuracy | False approval rate = incorrect approvals / independently labelled approvals. False rejection rate = incorrect rejections / independently labelled rejections. | These measure decision reliability conditional on each verdict. Also show the confusion matrix and label coverage. Do not confuse them with rates conditioned on actual defect status. |

Zero denominators produce **unavailable**, not zero. If no change succeeds, show
total resource consumption and zero successes; cost per success is undefined.
Missing billing evidence stays unknown, and partial usage stays explicitly
estimated or incomplete. Allocate shared indexing or memory work by a declared
rule and count it once, not once per proposal.

## What verified success means

The intended problem is addressed; required behaviour is preserved; the agreed
acceptance checks pass; and the observation window has completed with adequate
follow-up and no unresolved relevant regression. Specify the checks and window
per project and task class. A merge, model approval or green test suite alone is
insufficient. Absence of incident reports without follow-up is not verification.

Use assessment states:
- `pending`: observation or evidence gathering is unfinished.
- `verified_success`: the declared criteria and follow-up are satisfied.
- `verified_failure`: evidence shows the change did not meet those criteria.
- `inconclusive`: a final assessment cannot establish the outcome.

A later incident can supersede an earlier assessment. Keep the earlier record and
reason for revision. Distinguish process outcomes (no proposal, rejected,
abandoned, approved, merged, reverted) from these effectiveness assessments.

## Independently assessing review

Use seeded defects, known-good changes, blind human adjudication and confirmed
post-acceptance findings. Freeze the criteria before reviewing. Do not label a
rejection incorrect merely because its author disagrees, or an approval correct
because tests passed. Preserve `unknown` and `disputed` labels.

The unit is **one reviewer decision on one patch revision**, identified by
review ID, attempt ID and reviewed patch SHA. One generation may have several
decisions, including rejected attempts before approval. Preserve each decision
and label coverage by attempt; do not retain only the final verdict.
The [outcome template](templates/outcome.template.json) uses a `reviews` array
for this reason. Each entry is a template placeholder, not an observed decision.

Publish the full 2x2 table: approve/reject versus should-accept/should-reject.
Report label source, sample counts and coverage by verdict; an assessment set
containing only incidents would bias the result. The proposed conditional rates
are false discovery and false omission measures, not conventional
false-positive and false-negative rates.

## Supporting diagnostics

Track latency, attempts per generation, evidence-request frequency, context
composition, retrieval coverage, estimated-call share, policy/model versions,
reverts and project-specific benefit. Stratify by project and task difficulty.
A tiny CSS change and a cross-service migration should not be compared as
equivalent work.

These explain the primary measures. Prompt length and pass counts are diagnostic
signals, not standalone evidence that the harness improved.
