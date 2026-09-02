# Architecture — what's actually built, in pictures

This page exists because the other diagrams in this repository each answer a
different question, and none of them answers "what does *self_optimisation
itself* actually have working today" — which is the one a first-time visitor
usually wants. Read this page for that. Read `learning/diagrams/` for the
portable pattern you'd lift into another project. Read
`Portable-Harness-Design.md` §7 for the prose mapping between the two.

## The five diagram layers, and which one you want

| Layer | Where | Shows |
|---|---|---|
| **The whole project, today** | Below, on this page — new, added to answer "how do console/harness/curiosity relate" | Console + harness + curiosity as one picture, solid where built, dashed where proposed — the only diagram that spans all three |
| **This repo's real status (the harness alone)** | Below, on this page | What's actually built in the harness specifically, annotated ✅/🚧/❌ |
| **Portable pattern** | [`learning/diagrams/generic-loop.mmd`](learning/diagrams/generic-loop.mmd), `generic-guardrails.mmd`, `generic-context.mmd` — embedded and viewable in [`learning/02-blueprint.md`](learning/02-blueprint.md) and [`learning/05-guardrails-and-trust.md`](learning/05-guardrails-and-trust.md) | The abstract loop and guardrail layers, project-neutral — what you'd draw for *any* installation, including one that isn't this harness at all |
| **Reference implementation, concretely** | [`learning/diagrams/worked-example-run.mmd`](learning/diagrams/worked-example-run.mmd), `worked-example-harness.mmd` — both embedded below since GitHub doesn't render a bare `.mmd` file as a picture | The same pattern as it actually runs in the reference implementation (real job names, real check counts, real token costs) — useful for seeing what the abstraction looks like once it's hit a real, live system |
| **Proposed, not built** | [`learning/diagrams/proposed-curiosity-run.mmd`](learning/diagrams/proposed-curiosity-run.mmd), `proposed-curiosity-memory.mmd`, `proposed-curiosity-authorisation.mmd`, indexed at [`docs/curiosity/README.md`](docs/curiosity/README.md) | The curiosity design's own three diagrams — a second longitudinal pass, none of it built. Do not read as documentation of the harness. |

## The whole project, in one picture

Console, harness, and curiosity live at three different maturity levels, and
no other diagram in this repository shows them on the same page. Solid boxes
are real and running; dashed, warm-toned boxes are proposed and do not exist
yet — the same convention [`learning/diagrams/README.md`](learning/diagrams/README.md)
uses for the curiosity diagrams, applied here to the console too.

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TD
  subgraph console["PROPOSED · console/ — install flow"]
    connect["connect a GitHub repo,<br/>fill in a form"]
    scaffold["generate project-adapter.yml<br/>+ workflow YAML"]
    connect --> scaffold
  end
  style console fill:#F3E3D4,stroke:#9FB0BE,stroke-dasharray: 5 5

  scaffoldReal["harness/lib/scaffold.mjs<br/>+ harness/cli/init.mjs<br/>— the generator ALREADY EXISTS,<br/>console would be a browser front end for it"]
  scaffold -.-> scaffoldReal
  scaffoldReal ==>|"writes"| adapter["project-adapter.yml +<br/>.github/workflows/self-improve.yml"]

  subgraph harnessloop["BUILT · the harness loop — detailed below"]
    adapter --> loop["suggest -> implement -> review -> refine<br/>-> themes -> guard -> test -> notify"]
  end

  loop -->|"constitution.approval_class:<br/>human-approval-required (DEFAULT)"| pr["open a pull request —<br/>gh pr create, then<br/>recordPullRequestUrl()"]
  loop -->|"approval_class:<br/>autonomous-merge (opt-in)"| merge["autonomous merge<br/>promote.mjs, then verify"]

  loop -.->|"every proposal's<br/>OPEN QUESTION field"| curiosity["PROPOSED · docs/curiosity/<br/>curiosity ledger, open questions, spikes —<br/>attaches onto escalations.mjs,<br/>themes.mjs, context-pack.mjs"]
  curiosity -.->|"read back<br/>next run, once built"| loop
  style curiosity fill:#F3E3D4,stroke:#9FB0BE,stroke-dasharray: 5 5
```

Two things this picture makes visible that no prose paragraph had said in
one place before: the console's real prerequisite (the generator) already
exists under a different name than its own design doc guessed
(`harness/lib/scaffold.mjs`, not a new `install.mjs`) — see console/DESIGN.md
§2.1 for the now-superseded original argument; and curiosity has exactly
three attachment points onto the loop, all additive, none of them requiring
the loop itself to change shape.

## What's actually built here, today

**The core loop is real as of this diagram's last edit.** Suggest →
implement → review → refine runs end to end via
`harness/scripts/run-generation.mjs`, against your own project's adapter
and brief files. Staging & promotion, deployment verification (all four
strategies now), and the notifier are real too, each a standalone tested
CLI — and now `harness/cli/init.mjs` + `harness/templates/workflow.yml.tmpl`
chain the loop, the guard, the tests, promotion, verification and
notification into one generated workflow for a new project, so nothing
below is a human running each script by hand anymore.

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
    memory["✅ Memory<br/>escalations.mjs + themes.mjs<br/>folded in every run;<br/>generate-themes-review.mjs writes<br/>a new review every N generations;<br/>an accepted escalation becomes a<br/>work order a later run carries out"]
    evaluators["✅ Quality dimensions<br/>evaluators.mjs + plugins/evaluators/<br/>measured, never gating"]
    runtime["✅ Runtime evidence<br/>runtime-evidence.mjs — what the tests<br/>and the deploy check actually SAW"]

    adapter --> context --> propose
    propose --> router
    propose --> executor --> reviewer
    reviewer -->|"rejected"| refine --> executor
    propose -.-> memory
    memory -.->|"read back next run"| context
    reviewer -.-> evaluators
    evaluators -.->|"metrics.json, read back next run"| context
    runtime -.->|"docs/runtime/gen-NNN.json,<br/>read back next run"| context
  end

  rungen -.->|"composes all of this"| adapter

  reviewer -->|"approved"| approved(["✅ change on disk,<br/>attempts.json + proposal.md written"])
  refine -->|"attempts exhausted"| abandoned(["✅ tree restored to pristine,<br/>attempts.json written — real data,<br/>not a wasted run"])

  subgraph wired["Chained by the generated workflow"]
    guardstep["✅ Guard as a CI step<br/>harness/lib/guard.mjs, called against<br/>the orchestrator's own branch"]
    teststep["✅ The project's own tests, as CI steps<br/>evaluation.test_commands rendered<br/>straight into the workflow"]
    promote["✅ Merge + tag<br/>harness/lib/promote.mjs"]
    verify["✅ Deploy verification<br/>harness/lib/verify-deployment.mjs<br/>url + registry + artifact + none"]
    notify["✅ Notifier — plain-language digest<br/>harness/lib/notify.mjs<br/>pluggable sender"]
    workflow["✅ harness/templates/workflow.yml.tmpl<br/>+ harness/cli/init.mjs, the scaffolder<br/>that generates it"]
  end

  approved -.->|"chained by"| guardstep --> teststep --> promote --> verify --> notify
  workflow -.->|"generates all of the above,<br/>chained, for a new project"| loop

  style detect fill:#DCE7F0,stroke:#4A5C6A
  style loop fill:#DCE7F0,stroke:#4A5C6A
  style wired fill:#DCE7F0,stroke:#4A5C6A
```

**Added 2026-09-02, not yet drawn above:** every model call is recorded
(`spend.mjs`) and a generation has a token cap; the fate of every pull
request is read back at the top of each cycle (`pull-requests.mjs`) and a
shipped generation can be reverted (`rollback.mjs`), both of which the next
prompt and the earned-ambition check read; the owner sets how ambitious a
run may be (`context.ambition`, `docs/Ambition-Control.md`); the rank seat
defaults to a different family than the implementer and a rotating model
can earn the implement seat (`seats.mjs`); a generated `REPORT.md` carries
the paper's metrics (`report.mjs`); campaign mode runs a generation on
models named by hand; the committed goal (`project.goal`) sits above the
brief and the reviewer judges against it; and a themes review may name
what it cannot tell (`UNKNOWN`). Each is a `harness/lib/` module with its
own test file. See `WORKPLAN.md` Tier 0 and Tier 5.

**Read this diagram as what's real, not a roadmap with checkboxes filled
in.** Every box is real: the detector via
`examples/workflows/watch-releases.yml`, and the loop via
`harness/scripts/run-generation.mjs` run directly — 34 tests against fake
model responses, plus `tests/e2e/full-loop.test.mjs`: two automated tests
that drive the whole chain — suggest → implement → review → guard → test →
promote (autonomous merge) → verify → notify — in the generated workflow's
real order, against a real git remote and a real child-process test run,
faking only the three model calls. One proves the happy path merges and the
digest correctly says so; the other proves an exhausted-attempts run merges
nothing and the digest correctly says that too. This automates what used to
be a one-off manual run: a real end-to-end pass against a temp project with
a real adapter and real brief files (no API key configured, which correctly
produced a `no-proposal` outcome rather than crashing on a wiring bug — see
`Portable-Harness-Design.md`'s Bucket B table for that verification in
detail) — the manual run stays true as a record of what was checked before
the automated version existed. `check-guarded-paths.mjs` runs standalone against a real git diff;
`promote.mjs` (merge + tag) was verified against a real two-repo git setup
including an actual merge conflict; `verify-deployment.mjs` now implements
all four `deployment.verify_strategy` values — `url` (poll a live site,
compare canonicalised content, timeout), `registry` (poll npm/PyPI/NuGet/
Maven Central for the tagged version — four real, differently-shaped APIs,
not one faked shared shape), `artifact` (build, confirm the output path
exists, optionally smoke-run it), and `none`; `notify.mjs` sends a
plain-language digest with a reliable terse fallback, delivery behind a
`registerSender()` registry so SendGrid is one registered sender, not a
hardcoded dependency. What used to be "each piece real but nothing chains
them" is now chained: `harness/templates/workflow.yml.tmpl` renders detect
-> probe -> preflight -> improve -> themes -> guard -> test -> promote -> verify ->
notify as one sequential-steps GitHub Actions job (Actions can't loop or
dynamically branch jobs — see the reference-implementation diagram below
for what that constrains), and `harness/cli/init.mjs` asks the
Portable-Harness-Design.md §6 questions and writes that workflow plus a
filled `project-adapter.yml`, brief-template copies, and a short install
README for a new project — verified against a real, fresh git repo end to
end, and via `tests/lib/scaffold.test.mjs` parsing every strategy
combination's generated YAML back with `js-yaml` to confirm it's valid.

**The merge model, reconciled (was the known gap here):** the template used
to render only autonomous merge. It now renders one of two paths, chosen at
scaffold time from `constitution.approval_class` — a field that until this
change was parsed by nothing.

- **`human-approval-required`** is the default, and the fallback for any
  unrecognised value. Every gate runs against the agent branch; then the
  workflow opens a pull request with `gh pr create` and records its URL
  back into that generation's `attempts.json` via
  `harness/scripts/record-pull-request.mjs`. It runs no deployment
  verification, because nothing is deployed until a person merges.
- **`autonomous-merge`** is the opt-in: `promote.mjs` merges and tags, then
  `verify-deployment.mjs` checks what that shipped.

Exactly one path is written into the generated file, so which merge model a
repository got is answerable by reading its workflow rather than by
cross-referencing an adapter field against harness code. Unrecognised values
fail closed to the pull-request path (`harness/lib/adapter.mjs`'s
`normalizeApprovalClass()`), because a typo must never be the reason a
project starts merging its own changes unattended — `console/DESIGN.md`
§Step 7: "defaulting a non-technical user into autonomous merge is the
single worst decision this console could make."

The `schedule:` block is likewise now optional (`console/DESIGN.md` §Step 9's
two-phase onboarding): rendered by default for `init`, omitted — leaving a
`workflow_dispatch`-only workflow and a commented cron to add later — when
the installer asks for it. Until then there is no cron in the repository to
fire, which makes "the schedule stays off until a rehearsal passes" a fact
about the file rather than a promise about the process.

`Portable-Harness-Design.md`'s Status table has the same information as
prose, kept in sync by hand — if the two ever disagree, trust whichever was
edited more recently and fix the other.

## The reference implementation, concretely

The abstract loop above, as it actually runs in the reference implementation
— real job names, real check counts. Two diagrams, embedded here because a
bare `.mmd` file renders as plain text on GitHub, not a picture (see
[`learning/diagrams/README.md`](learning/diagrams/README.md)'s "three
mechanical traps" for why sidecar files still exist despite that). Both are
byte-for-byte the same structure as their `learning/diagrams/` sidecars —
keep it that way; a hand-edited copy here that quietly drifts from the
sidecar is the exact mistake this note exists to prevent.

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
    br --> pack["context-pack.mjs<br/>assemble the prompt"]
    pack -->|"~59k tokens + 3 images,<br/>once per new model"| s1["STAGE 1 · SUGGEST<br/>EVERY new model, each on<br/>its own lab's API, in parallel"]
    s1 -->|"N prose proposals<br/>no code"| rank{"more than one?"}
    rank -->|"no"| s2
    rank -->|"yes · authors stripped"| rk["STAGE 1b · RANK<br/>claude-opus-5 picks one"]
    rk --> s2["STAGE 2 · IMPLEMENT<br/>claude-opus-5"]
    s2 -->|"search/replace"| chk{"each SEARCH<br/>unique?"}
    chk -->|"no · all-or-nothing"| rev
    chk -->|"yes · written"| s3["STAGE 3 · REVIEW<br/>claude-opus-5,<br/>fresh context"]
    s3 -->|"REJECTED, or<br/>no verdict at all"| rev["restore the<br/>pristine tree"]
    rev -->|"STAGE 4 · REFINE<br/>attempt &lt; 3"| s2
  end

  s3 -->|APPROVED| push["commit + push<br/>agent/gen-NNN"]
  rev -->|"3rd attempt<br/>exhausted"| rec["write attempts.json"]
  rec -->|"own commit<br/>to main"| mem[("failure<br/>memory")]
  mem -.->|"read back next run"| pack

  push --> g1["job 4 · guard<br/>AGENT branch"]
  g1 -->|"no frozen path"| g2["job 5 · tests<br/>98 + 601 + 19"]
  g2 -->|"all green"| mg["job 6 · merge<br/>tag, log, snapshot"]
  mg --> shots[("screenshots<br/>per generation")]
  shots -.->|"shown next run"| pack
  mg --> mail(["job 7 · email digest"])

  g1 -->|"frozen path touched"| held(["left unmerged<br/>for inspection"])
  g2 -->|"any suite red"| held
  held --> mail
```

That is the reference implementation's real 7-job workflow — 18+
generations run against it, including the incidents `learning/03-failure-modes.md`
catalogs. Every stage in it that isn't already ✅ in this page's status
diagram above is genuinely unbuilt in `self_optimisation` yet.

The harness diagram — the same reference implementation, but token flow and
per-provider dispatch instead of the CI job sequence:

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TB
  src["editable source, in full<br/>2 games + index.html · ~57k tok"] --> pk
  map["repository map · ~0.6k tok"] --> pk
  idx["test index · assertion<br/>NAMES only · ~1.1k tok"] --> pk
  hist["history · merged AND<br/>abandoned · ~0.2k tok"] --> pk
  fb["player feedback · sanitised,<br/>or the section is omitted"] --> pk
  png["screenshots · 3 PNGs"] --> pk

  pk["one prompt · ~59k tok + 3 images"] ==> disp{"llm-provider.mjs<br/>resolve the lab from the model id"}

  disp -->|anthropic| a["source.base64"]
  disp -->|google| g["inlineData"]
  disp -->|"openai"| o["image_url<br/>max_completion_tokens"]
  disp -->|"moonshot · deepseek<br/>qwen · xai · meta"| m["image_url · max_tokens<br/>one shared factory"]
  disp -->|"zai"| z["image_url · max_tokens<br/>+ extraBody: reasoning_effort low"]

  a --> s1
  o --> s1
  g --> s1
  m --> s1
  z --> s1

  s1["STAGE 1 · every newly released<br/>model, asked in parallel"] -->|"image rejected ·<br/>matched by error SHAPE, not wording"| nov["drop images, retry once"]
  nov -.->|"a model without vision still runs"| s1
  s1 -->|"one lab errors"| drop(["dropped · the run<br/>continues on the rest"])
  s1 ==>|"N prose proposals"| rk["STAGE 1b · rank · claude-opus-5<br/>authors withheld"]
  rk ==>|"the winner"| impl["STAGE 2 · implement · claude-opus-5"]

  impl ==>|"SEARCH / REPLACE"| w1{"allowlist 1 · edit-format.mjs<br/>before any write"}
  w1 -->|"frozen path, or SEARCH<br/>matching 0 or 2+ times"| no(["refused · nothing reaches disk"])
  w1 ==>|"validated in memory for every file first"| tree[("working tree")]
  tree ==> w2{"allowlist 2 · check-guarded-paths.mjs<br/>in CI, on the agent branch"}
  w2 ==>|"the same rule again"| yes(["merge candidate"])
  w2 -->|"frozen path, or churn ceiling"| no
```

Both diagrams describe the reference implementation, carrotgame — the check
counts (98+601+19), token estimate (~59k), and provider-dispatch table are
its numbers, not `self_optimisation`'s own.
