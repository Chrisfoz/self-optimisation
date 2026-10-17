# Learning from practical outcomes

## Record experience before optimising strategy

1. Capture the task, repository revision, policy and model versions, context
   selection and resource use.
2. Join the attempt to its patch, PR disposition, acceptance checks and later
   runtime or user evidence.
3. Independently assess effectiveness and reviewer decisions where evidence
   permits. Preserve pending and unknown outcomes.
4. Examine recurring patterns across comparable tasks, including failures.
5. Propose one bounded strategy change and test it against the existing policy.
6. Retain, narrow, reject or investigate the policy based on held-out evaluation
   and a bounded real-project trial. Persist the decision and its rationale.

This is learning through measured experience, not evidence that foundation-model
weights have changed. Policy selection and model-release-driven product
generations are separate mechanisms.

## From signal to experiment

| Observed pattern | Hypothesis to test | What could disprove it |
| --- | --- | --- |
| Prior failed ideas recur | Retrieving relevant failure records reduces repetition | Recall suppresses useful retries or distracts from current evidence |
| Unchanged dependencies break | Reviewer context should include callers and contracts | Extra evidence raises cost without reducing escaped defects |
| Repeated expensive retries | Stop or change retrieval after an unproductive attempt | Earlier stopping rejects recoverable, valuable changes |
| Independently valid changes are rejected | Review context or criteria need calibration | Apparent false rejections disappear on blind assessment |
| Cheap changes dominate | Task selection underweights meaningful improvements | More ambitious work increases defects or has no verified user benefit |

A correlation is a candidate explanation. Model changes, task mix, test coverage,
project maturity and reviewer selection can all produce apparent improvements.

## Controlled evaluation

Predeclare the hypothesis, target task class, allowed policy changes, primary
outcome, cost limits, observation window and rollback conditions. Compare pinned
baseline and candidate policies using the same task inputs and model versions,
with repeated trials and uncertainty reported. Isolate working copies and reset
memory between independent trials.

For cross-run learning, use identical initial memory snapshots in each arm,
allow each policy to accumulate experience only from its own training sequence,
and assess on a separate evaluation sequence. Hold out tasks or repositories
from policy development; never write their hidden expected outcomes into memory
or tuning prompts. Keep evaluator criteria and labels outside the candidate
policy's writable surface. Version and rotate the held-out set when development
has exposed it.

Include helper models, failed runs, indexing, curation and adjudication costs.
Equalise declared task budgets and report tasks that could not complete within
them. Choose promotion thresholds before seeing results; no default percentage
is assumed to suit every project.

## A verified lesson

Persist: claim; task class; conditions; counterexamples; originating runs and
experiment; source revisions; assessment method; resource/quality trade-off;
confidence and its basis; review date; superseded status.

Example of a useful hypothesis: "For changes to shared save-state schemas,
supply the reviewer with both serialisation and loading callers."
"Always send more files" is too broad to guide retrieval or falsification.

A model-written reflection begins as a candidate lesson. It becomes an adopted
policy only after independent evidence supports it and the existing promotion
route authorises the change. Similar failed attempts from several labs are not
independent proof when they share the same context defect.

## Adoption and continued observation

Keep the current gates, allowed paths, budget controls and configured approval
class in force. KPI evidence does not authorise the harness to weaken checks,
rewrite its evaluator, expand permissions or merge itself. A policy change is
versioned and tested through the same repository review process.

Trial an accepted policy in a bounded project cohort. Log rollback criteria and
the previous policy revision. Reassess after dependency changes, contradictory
evidence or sustained regression. Preserve failures and superseded lessons so
later runs understand why a strategy was abandoned.

Cross-project memory should contain explicitly reviewed general lessons.
Project code, personal information, secrets and project-specific assumptions
must not become shared knowledge by default.
