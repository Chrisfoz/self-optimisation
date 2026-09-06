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
| **This repo's real status (the harness alone)** | Below, on this page — now **two** diagrams: one cycle end to end, then what happens inside the loop | What's actually built in the harness specifically. Everything drawn is real code with a test file; the warm-toned boxes are the ways a cycle ends without shipping, not unbuilt work |
| **Portable pattern** | [`learning/diagrams/generic-loop.mmd`](learning/diagrams/generic-loop.mmd), `generic-guardrails.mmd`, `generic-context.mmd` — embedded and viewable in [`learning/02-blueprint.md`](learning/02-blueprint.md) and [`learning/05-guardrails-and-trust.md`](learning/05-guardrails-and-trust.md) | The abstract loop and guardrail layers, project-neutral — what you'd draw for *any* installation, including one that isn't this harness at all |
| **Reference implementation, concretely** | [`learning/diagrams/worked-example-run.mmd`](learning/diagrams/worked-example-run.mmd), `worked-example-harness.mmd` — both embedded below since GitHub doesn't render a bare `.mmd` file as a picture | The same pattern as it actually runs in the reference implementation (real job names, real check counts, real token costs) — useful for seeing what the abstraction looks like once it's hit a real, live system |
| **Proposed, not built** | [`learning/diagrams/proposed-curiosity-run.mmd`](learning/diagrams/proposed-curiosity-run.mmd), `proposed-curiosity-memory.mmd`, `proposed-curiosity-authorisation.mmd`, indexed at [`docs/curiosity/README.md`](docs/curiosity/README.md) | The curiosity design's own three diagrams — a second longitudinal pass, none of it built. Do not read as documentation of the harness. |

## The whole project, in one picture

Console, harness, and curiosity live at three different maturity levels, and
no other diagram in this repository shows them on the same page. Solid boxes
are real and running; dashed, warm-toned boxes are not yet fully real — the
same convention [`learning/diagrams/README.md`](learning/diagrams/README.md)
uses for the curiosity diagrams, applied here to the console too. Curiosity
is dashed because most of it is unbuilt, not all: four of its ten components
have shipped, and the box says which.

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
    adapter --> loop["validate -> suggest -> implement -> review<br/>-> refine -> themes -> guard -> test -> notify"]
  end

  loop -->|"constitution.approval_class:<br/>human-approval-required (DEFAULT)"| pr["open a pull request —<br/>gh pr create, then<br/>recordPullRequestUrl()"]
  loop -->|"approval_class:<br/>autonomous-merge (opt-in)"| merge["autonomous merge<br/>promote.mjs, then verify"]

  loop -.->|"every proposal's<br/>OPEN QUESTION field"| curiosity["PART BUILT · docs/curiosity/<br/>4 of 10: the goal, UNKNOWN questions,<br/>escalation follow-through, runtime evidence.<br/>The ledger and spikes wait on the A-prime gate."]
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

**Two diagrams, because there are two questions.** The first is *what one
cycle does*, from the schedule firing to an email arriving — the order the
generated workflow actually runs, including all five ways a cycle can end
without shipping anything. The second is *what happens inside the loop*: the
one Node process where suggest → implement → review → refine lives, and
everything that feeds the prompt it starts from.

Everything in both is real code with its own test file. `harness/cli/init.mjs`
and `harness/templates/workflow.yml.tmpl` chain all of it into one generated
workflow for a new project, and `harness/scripts/rehearse.mjs` runs the same
chain locally, on demand — so nothing here is a human invoking each script by
hand any more.

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TD
  cron(["schedule · Run workflow · a models list typed by hand"]) --> pause{"SELF_IMPROVE_PAUSED?"}
  pause -->|"set"| stopPaused(["stop. nothing polled, nothing spent —<br/>and the digest says PAUSED"])

  pause -->|"not set"| validate["✅ Validate the adapter<br/>validate.mjs — every editable path exists,<br/>nothing allowed is also frozen, briefs filled in,<br/>every watched or pinned lab registered"]
  validate -->|"invalid"| stopInvalid(["stop. the digest says VALIDATE_FAILED —<br/>never reported as a quiet cycle"])

  validate -->|"valid"| trigger{"what starts this run?"}

  trigger -->|"a model id the snapshot<br/>has never seen"| detector["✅ Model-release detector<br/>model-release-detector.mjs<br/>+ model-aliases + unfixable-models"]
  trigger -->|"models named by hand"| campaign["✅ Campaign mode<br/>campaign.mjs — stamped campaign: true<br/>so release-driven history stays separable"]

  detector --> readback
  campaign --> readback["✅ Read back earlier pull requests<br/>pull-requests.mjs — merged / closed / open,<br/>then report.mjs regenerates REPORT.md.<br/>Runs on EVERY cycle, including a quiet one:<br/>a person's merge or close is the one verdict<br/>in this loop that is not the harness<br/>grading itself."]

  readback --> anything{"anything to run on?"}
  anything -->|"nothing new"| stopQuiet(["stop. no cost, no commit —<br/>the digest still reports the quiet cycle"])
  anything --> probe["✅ Reachability probe<br/>probe-models.mjs — the real request shape,<br/>drop whatever cannot answer it"]

  probe -->|"nothing reachable"| stopUnreachable(["stop. the digest says a lab shipped<br/>something nothing could reach"])
  probe --> preflight["✅ Preflight — the project's own tests<br/>the baseline must be green before<br/>anything is spent"]

  preflight --> loop["✅ THE LOOP · one Node process<br/>run-generation.mjs — see the next diagram"]

  loop -->|"nothing shipped"| held
  loop -->|"a change on disk"| guard["✅ Guard<br/>check-guarded-paths.mjs — frozen paths,<br/>append-only paths, frozen JSON fields,<br/>churn ceiling, and the committed goal"]

  guard -->|"a frozen path moved"| held(["✅ left unmerged for inspection —<br/>attempts.json written either way"])
  guard --> tests["✅ The project's own tests, again,<br/>against the agent branch"]
  tests -->|"any suite red"| held

  tests --> approval{"constitution.approval_class"}
  approval -->|"human-approval-required<br/>THE DEFAULT"| pr["✅ Open a pull request<br/>gh pr create, then record-pull-request.mjs<br/>writes the URL into attempts.json.<br/>Nothing is deployed until a person merges."]
  approval -->|"autonomous-merge<br/>opt-in only"| merge["✅ Merge + tag<br/>promote.mjs"]
  merge --> verify["✅ Deploy verification<br/>verify-deployment.mjs<br/>url · registry · artifact · none"]

  pr --> evidence
  verify --> evidence
  held --> evidence["✅ Runtime evidence<br/>record-runtime-evidence.mjs — what this run<br/>actually SAW, not what it decided"]

  evidence --> digest(["✅ Digest — notify.mjs<br/>plain language with a terse fallback.<br/>Runs on EVERY outcome above, including<br/>all four ways to reach no generation."])

  merge -.->|"shipped, and should not have"| revert["✅ revert-generation.mjs<br/>reverts the merge, records it,<br/>the next run reads it as a failure"]
  pr -.-> revert

  rehearse["✅ rehearse.mjs — the same chain,<br/>locally, on demand, on a real branch.<br/>Never pushes, never opens a PR, never merges."]
  rehearse -.->|"runs exactly these steps"| validate

  style stopPaused fill:#F3E3D4,stroke:#9FB0BE
  style stopInvalid fill:#F3E3D4,stroke:#9FB0BE
  style stopQuiet fill:#F3E3D4,stroke:#9FB0BE
  style stopUnreachable fill:#F3E3D4,stroke:#9FB0BE
  style held fill:#F3E3D4,stroke:#9FB0BE
```

**One cycle, above.** Every box is real code with its own test file. The
five rounded, warm-toned boxes are the ways a cycle ends without shipping
anything — and each of them still sends a digest saying *which* kind of
nothing happened, because "the loop checked and there was nothing to do"
and "the loop never ran" are the same silence from an inbox
(`learning/03-failure-modes.md` records three separate times that
distinction was collapsed, each found only after a month's email failed to
arrive).

**Inside the loop, below.** The box marked THE LOOP above is one Node
process, because a review → refine → review cycle has to be able to loop and
GitHub Actions cannot loop a job.

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontSize":"13px","primaryColor":"#E4E8EC","primaryTextColor":"#14212B","primaryBorderColor":"#9FB0BE","lineColor":"#4A5C6A","secondaryColor":"#DCE7F0","tertiaryColor":"#F3E3D4","clusterBkg":"#F6F8F9","clusterBorder":"#9FB0BE","edgeLabelBackground":"#EDF0F2","textColor":"#14212B"}}}%%
flowchart TD
  subgraph ctx["What the suggestion prompt is assembled from — every block dropped entirely when its input is absent"]
    goal["✅ The committed goal<br/>project.goal — frozen, sits above the brief"]
    brief["✅ The project's own agent brief<br/>IS the system prompt, whole, not a summary"]
    source["✅ Source bundle + repo manifest<br/>fenced as untrusted input"]
    index["✅ Every generation on record,<br/>recent ones in full — including the<br/>owner's merge or close on each PR"]
    ledger["✅ Escalation ledger, themes review,<br/>open questions, any work order<br/>a human accepted"]
    dims["✅ Measured dimensions + observations<br/>evaluators.mjs — measured, never gates"]
    shots["✅ Renders from the last generation<br/>loadVisualEvidence — with the provenance<br/>stated, so 'current' cannot mean stale"]
    runtime["✅ Runtime evidence — what the last<br/>runs OBSERVED, not what the code says"]
  end

  ctx ==> suggest["✅ STAGE 1 · SUGGEST<br/>every newly released model, in parallel,<br/>each on its own lab's API. One lab failing<br/>costs its proposal, not the generation."]

  suggest --> more{"more than one proposal?"}
  more -->|"no"| implement
  more -->|"yes · authors withheld"| rank["✅ STAGE 1b · RANK<br/>seats.mjs picks a model from a DIFFERENT<br/>family than the implementer"]
  rank --> implement["✅ STAGE 2 · IMPLEMENT<br/>the pinned model — or the suggester's own<br/>edits, tried first and free — or a rotating<br/>model that EARNED the seat"]

  implement --> apply{"✅ edit-format.mjs<br/>allowlist + each SEARCH unique,<br/>every file validated in memory<br/>BEFORE a byte reaches disk"}
  apply -->|"refused · nothing written"| refine
  apply -->|"applied all-or-nothing"| review["✅ STAGE 3 · REVIEW<br/>review.mjs — fresh context, pinned model,<br/>judged against the goal.<br/>No verdict is a REJECTION."]

  capture["✅ visual_capture — a render of THIS<br/>change, made for the reviewer"] -.-> review

  review -->|"REJECTED"| refine["✅ STAGE 4 · REFINE<br/>restore the pristine tree, hand back the<br/>real rejection text, try again"]
  refine --> implement

  review -->|"APPROVED"| shipped(["✅ the change on disk,<br/>proposal.md + attempts.json"])
  refine -->|"attempts exhausted"| abandoned(["✅ tree restored to pristine,<br/>attempts.json written — a failed<br/>run is data, not a wasted one"])

  budget["✅ spend.mjs — every call's tokens,<br/>projected before the fan-out and checked<br/>between attempts against budget.max_generation_tokens"]
  budget -.-> suggest
  budget -.-> implement

  shipped --> records[("✅ the record every future run reads")]
  abandoned --> records
  records -.->|"read back next generation"| ctx

  style ctx fill:#DCE7F0,stroke:#4A5C6A
```

**Read these diagrams as what's real, not a roadmap with checkboxes filled
in.** Every box is real: the detector via
`examples/workflows/watch-releases.yml`, the whole chain locally via
`harness/scripts/rehearse.mjs`, and the loop via
`harness/scripts/run-generation.mjs` run directly — `npm test` prints the
current check count against fake
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
them" is now chained: `harness/templates/workflow.yml.tmpl` renders validate
-> detect -> probe -> preflight -> improve -> themes -> guard -> test ->
pull request (or promote -> verify) ->
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
