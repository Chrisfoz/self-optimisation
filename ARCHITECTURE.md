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

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TD
  cron(["schedule / workflow_dispatch"]) --> detector

  subgraph today["Usable today — copy examples/workflows/watch-releases.yml"]
    detector["✅ Model-Release Detector<br/>harness/lib/model-release-detector.mjs"]
    probe["✅ Reachability Probe<br/>harness/lib/probe-models.mjs"]
    adapter["✅ Adapter Loader<br/>harness/lib/adapter.mjs (js-yaml)<br/>reads project-adapter.yml"]
    router["✅ Provider Router<br/>harness/lib/llm-provider.mjs<br/>+ 9 providers/*.mjs"]

    adapter -.->|"providers.watched"| detector
    detector --> probe
    probe --> router
  end

  detector -->|"new model found"| issue(["✅ open a GitHub issue<br/>(watch-releases.yml)"])
  detector -->|"nothing new"| idle(["stop. no cost,<br/>no commit"])

  issue -.->|"a human reads it and<br/>decides whether to try it"| human(["👤 you, today"])

  subgraph missing["NOT built yet — a human does this by hand, or it doesn't happen"]
    context["❌ Context Compiler<br/>harness/lib/context-pack.mjs<br/>real design work, not a port — see §8.2"]
    executor["✅ Bounded Patch Executor<br/>harness/lib/edit-format.mjs<br/>ready, but nothing upstream calls it yet"]
    propose["❌ Parallel Proposal Stage<br/>fan out to every new model,<br/>rank with authors withheld"]
    reviewer["❌ Independent Reviewer<br/>fresh-context approve/reject"]
    guard["✅ Guard<br/>harness/lib/guard.mjs<br/>ready, but nothing upstream calls it yet"]
    testrunner["❌ Test-command runner<br/>evaluation.test_commands<br/>in project-adapter.yml — not consumed by anything"]
    memory["❌ Failure & Proposal Memory<br/>escalations ledger, themes review"]
    promote["❌ Staging & Promotion<br/>merge, tag, verify-deployment"]

    context --> propose --> executor --> reviewer --> guard --> testrunner --> promote
    memory -.->|"read back next run"| context
    testrunner -.-> memory
  end

  human -.->|"the missing half of the loop,<br/>manually, for now"| context

  style today fill:#DCE7F0,stroke:#4A5C6A
  style missing fill:#F3E3D4,stroke:#9FB0BE
```

**Read this diagram as an honest gap, not a roadmap with checkboxes filled
in.** The blue box is real, tested, and runnable via
`examples/workflows/watch-releases.yml` right now. The tan box is the rest
of the campaign lifecycle from the paper's §4 — most of it doesn't exist,
so a human currently plays the part of those nodes by hand, reading the
issue the detector opened and deciding what to do next. `edit-format.mjs`
and `guard.mjs` are the two exceptions inside the tan box: both fully built
and tested, both waiting on the orchestrator that would actually call them
in sequence. Nothing yet reads `evaluation.test_commands` from
`project-adapter.yml` either — the field exists in the schema, but no
component runs a project's tests on the harness's behalf.

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
