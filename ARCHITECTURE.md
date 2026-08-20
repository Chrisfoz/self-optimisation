# Architecture — what's actually built, in pictures

This page exists because the other diagrams in this repository each answer a
different question, and none of them answers "what does *self_optimisation
itself* actually have working today" — which is the one a first-time visitor
usually wants. Read this page for that. Read `learning/diagrams/` for the
portable pattern you'd lift into another project. Read
`Portable-Harness-Design.md` §7 for the prose mapping between the two.

## The three diagram layers, and which one you want

| Layer | Where | Shows |
|---|---|---|
| **This repo's real status** | Below, on this page | What's actually built in `self_optimisation`, annotated ✅/🚧/❌ — new, drawn for this question specifically |
| **Portable pattern** | [`learning/diagrams/generic-loop.mmd`](learning/diagrams/generic-loop.mmd), `generic-guardrails.mmd`, `generic-context.mmd` — embedded and viewable in [`learning/02-blueprint.md`](learning/02-blueprint.md) and [`learning/05-guardrails-and-trust.md`](learning/05-guardrails-and-trust.md) | The abstract loop and guardrail layers, project-neutral — what you'd draw for *any* installation, including one that isn't this harness at all |
| **Reference implementation, concretely** | [`learning/diagrams/worked-example-run.mmd`](learning/diagrams/worked-example-run.mmd), `worked-example-harness.mmd` — embedded below since GitHub doesn't render a bare `.mmd` file as a picture | The same pattern as it actually runs in the reference implementation (real job names, real check counts, real token costs) — useful for seeing what the abstraction looks like once it's hit a real, live system |

## What's actually built here, today

**The core loop is real as of this diagram's last edit.** Suggest →
implement → review → refine runs end to end via
`harness/scripts/run-generation.mjs`, against your own project's adapter
and brief files. What's missing now sits *around* the loop — CI wiring,
merging, notifying — not inside it.

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TD
  cron(["schedule / workflow_dispatch"]) --> detector

  subgraph detect["Detector — copy examples/workflows/watch-releases.yml"]
    detector["✅ Model-Release Detector<br/>harness/lib/model-release-detector.mjs"]
    probe["✅ Reachability Probe<br/>harness/lib/probe-models.mjs"]
    detector --> probe
  end

  detector -->|"nothing new"| idle(["stop. no cost,<br/>no commit"])
  probe -->|"survivors"| rungen

  subgraph loop["The loop — harness/scripts/run-generation.mjs, end to end, tested"]
    adapter["✅ Adapter + briefs<br/>harness/lib/adapter.mjs (js-yaml)<br/>project-adapter.yml + agent-brief.md + reviewer-brief.md"]
    rungen["✅ runGeneration()<br/>harness/lib/orchestrator.mjs"]
    router["✅ Provider Router<br/>llm-provider.mjs + 9 providers/*.mjs"]
    context["✅ Context Compiler<br/>context-pack.mjs (7/9 functions)"]
    propose["✅ Suggest + Rank<br/>gatherProposals() + rankProposals()<br/>fan out, authors withheld"]
    executor["✅ Implement<br/>edit-format.mjs — targeted edits,<br/>all-or-nothing"]
    reviewer["✅ Review<br/>review.mjs — fresh context,<br/>fails closed"]
    refine["✅ Refine<br/>rejected? restore to pristine,<br/>retry up to maxAttempts"]
    memory["✅ Memory<br/>escalations.mjs + themes.mjs<br/>folded in every run"]

    adapter --> context --> propose
    propose --> router
    propose --> executor --> reviewer
    reviewer -->|"rejected"| refine --> executor
    propose -.-> memory
    memory -.->|"read back next run"| context
  end

  rungen -.->|"composes all of this"| adapter

  reviewer -->|"approved"| approved(["✅ change on disk,<br/>attempts.json + proposal.md written"])
  refine -->|"attempts exhausted"| abandoned(["✅ tree restored to pristine,<br/>attempts.json written — real data,<br/>not a wasted run"])

  subgraph missing["NOT built yet"]
    guardstep["🔧 Guard as a CI step<br/>harness/lib/guard.mjs already works —<br/>no workflow step calls it against<br/>the orchestrator's own branch yet"]
    teststep["🔧 The project's own tests, as a CI step<br/>needs no new harness code —<br/>evaluation.test_commands become<br/>workflow steps directly"]
    promote["❌ Merge, tag, verify-deployment"]
    notify["❌ Notifier — email/Slack digest"]
    workflow["❌ templates/workflow.yml.tmpl<br/>+ the init CLI that generates it"]
  end

  approved -.->|"still needs"| guardstep --> teststep --> promote --> notify
  workflow -.->|"would generate all of the above,<br/>chained, for a new project"| loop

  style detect fill:#DCE7F0,stroke:#4A5C6A
  style loop fill:#DCE7F0,stroke:#4A5C6A
  style missing fill:#F3E3D4,stroke:#9FB0BE
```

**Read this diagram as an honest gap, not a roadmap with checkboxes filled
in.** Both blue boxes are real: the detector via
`examples/workflows/watch-releases.yml`, and the loop via
`harness/scripts/run-generation.mjs` run directly — 29 tests against fake
model responses, plus one real end-to-end run against a temp project with a
real adapter and real brief files (no API key configured, which correctly
produced a `no-proposal` outcome rather than crashing on a wiring bug — see
`Portable-Harness-Design.md`'s Bucket B table for that verification in
detail). What's left is real too, but it's smaller than it looks: the guard
and the project's own tests need no new harness *code*, only a workflow
step that calls what already exists — `check-guarded-paths.mjs` already
runs standalone against a real git diff. The genuinely unbuilt pieces are
merge/tag, `verify-deployment` (project-specific: url/registry/artifact per
the adapter), a notifier, and the `templates/workflow.yml.tmpl` + `init`
CLI that would chain all of this into one file for a new project instead of
someone running `run-generation.mjs` by hand.

`Portable-Harness-Design.md`'s Status table has the same information as
prose, kept in sync by hand — if the two ever disagree, trust whichever was
edited more recently and fix the other.

## The reference implementation, concretely

The abstract loop above, as it actually runs in the reference implementation
— real job names, real check counts. Two diagrams, embedded here because a
bare `.mmd` file renders as plain text on GitHub, not a picture (see
[`learning/diagrams/README.md`](learning/diagrams/README.md)'s "three
mechanical traps" for why sidecar files still exist despite that).

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TD
  cron["monthly cron<br/>1st, 00:00 UTC"] --> poll

  subgraph detect["job 1 · check-releases"]
    poll["poll 9 model<br/>catalogues"]
    poll --> fresh{"id absent from<br/>the snapshot?"}
  end

  fresh -->|"no"| idle(["ends without building"])
  fresh -->|"yes · id + provider"| pre

  pre["job 2 · preflight<br/>3 suites already green"] -->|"baseline proven"| br["job 3 · improve<br/>branch agent/gen-NNN"]

  subgraph proc["one Node process · Actions cannot loop jobs"]
    br --> pack["context-pack.mjs<br/>repo map, test index,<br/>failure history, screenshots"]
    pack --> s1["STAGE 1 · SUGGEST<br/>the NEW model,<br/>own lab's API"]
    s1 --> s2["STAGE 2 · IMPLEMENT<br/>new model's own edits,<br/>else claude-opus-5"]
    s2 --> chk{"each SEARCH<br/>matches once?"}
    chk -->|"no"| rev["restore pristine tree"]
    chk -->|"yes"| s3["STAGE 3 · REVIEW<br/>claude-opus-5, fresh context,<br/>diff AND pixels"]
    s3 -->|"rejected"| rev
    rev -->|"STAGE 4 · REFINE<br/>attempt < 3"| s2
  end

  s3 -->|"approved"| push["commit + push<br/>agent/gen-NNN"]
  rev -->|"3rd attempt exhausted"| rec["write attempts.json"]
  rec --> mem[("failure memory")]
  mem -.-> pack

  push --> guard["job 4 · guard<br/>frozen paths, append-only tests"]
  guard -->|"clean"| tests["job 5 · tests<br/>98 + 601 + 19 checks"]
  tests -->|"all green"| merge["job 6 · merge to main"]
  merge --> tag["tag gen-NNN"]
  tag --> live["verify LIVE site<br/>carries the change"]
  merge --> shots[("screenshots + scorecard")]
  shots -.-> pack
  live --> notify["job 7 · email digest"]

  guard -->|"frozen path touched"| held(["left unmerged"])
  tests -->|"any check red"| held
  held --> notify
```

That is the reference implementation's real 7-job workflow — 18+
generations run against it, including the incidents `learning/03-failure-modes.md`
catalogs. Every stage in it that isn't already ✅ in this page's status
diagram above is genuinely unbuilt in `self_optimisation` yet.
