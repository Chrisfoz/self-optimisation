# Workplan

**The sequenced build plan for finishing the portable harness.** Written
2026-09-02 from the state of the repo at that date, and intended to be worked
from top to bottom — the order is the argument, not the tiers.

This file is the *plan of record*. The reasoning behind each item lives in the
document named beside it; those documents stay authoritative for **why**, this
one is authoritative for **what's next**. `Portable-Harness-Design.md` §10 is
now the historical build order — steps 1–5 are done. It isn't superseded, but
start here rather than there.

**How to use it:** tick a box only when the item's *done when* line is
actually true. Items are written so that a tick is a fact, not a judgement
call.

---

## Start here

**→ Tier 2.1, rehearse on a second project.** Tier 1 is done. 2.1 is now the
highest-value item in the file: it decides whether 2.2 is urgent or
theoretical, and nothing should claim multi-language support until it has
happened.

---

## Tier 1 — close the gaps inside what's already built

Everything here is a gap in shipped, tested code. None of it is new
architecture. All of it blocks Tier 3.

**Tier 1 is done** (2026-09-02).

- [x] **1.1 — Reconcile the merge model: pull request by default, autonomous merge as opt-in.**
  `harness/templates/workflow.yml.tmpl` only ever does autonomous merge — it
  commits to the agent branch, guards, tests, merges, tags. It does not open a
  pull request, and it bakes `schedule:` in immediately. `console/DESIGN.md`
  §Step 7 makes the opposite call for this exact file ("defaulting a
  non-technical user into autonomous merge is the single worst decision this
  console could make"), plus a two-phase onboarding (§Step 9: ship with
  `workflow_dispatch` only, rehearse once, then a second PR adds the cron).
  `harness/lib/orchestrator.mjs`'s `recordPullRequestUrl()` and
  `harness/scripts/record-pull-request.mjs` already exist to support the
  PR-opening step; nothing calls them.
  *See:* the template's own header comment, which states this gap in full.
  *Done when:* the template renders a PR-opening path, that path is the
  default, and `tests/lib/scaffold.test.mjs` parses both variants back with
  `js-yaml`.
  **Done.** `{{MERGE_STEPS}}` in the template; `mergeSteps()` in
  `scaffold.mjs` renders exactly one of the two paths, so which merge model
  a repository got is answerable by reading its workflow. The PR path uses
  `gh pr create` (no third-party action, no credential beyond the job's own
  token), then `record-pull-request.mjs` — the first thing to call it — and
  runs no deployment verification, because nothing is deployed until a
  person merges. `{{SCHEDULE_BLOCK}}` closes the other half of the same gap:
  `includeSchedule: false` renders a `workflow_dispatch`-only workflow with
  a commented cron, so §Step 9's "the schedule stays off until a rehearsal
  passes" is a fact about the file. Both variants are parsed back with
  `js-yaml` in `tests/lib/scaffold.test.mjs`.

- [x] **1.2 — Make `approval_class` actually do something.**
  It is parsed by nothing — `grep -rn "approval_class\|approvalClass" harness/ tests/`
  returns zero hits. It is the field that 1.1's two paths should switch on, so
  build it as part of 1.1 rather than after it.
  *Done when:* the adapter exposes it, `scaffold.mjs` selects the merge path
  from it, and an unrecognised value fails closed to the PR path rather than
  to autonomous merge.
  **Done,** as part of 1.1. `adapter.mjs` exports `approvalClass()`,
  `normalizeApprovalClass()`, `APPROVAL_CLASSES` and
  `DEFAULT_APPROVAL_CLASS`; it reads `constitution.approval_class` (where
  carrotgame already put it) and accepts a top-level one, since the example
  file documented it there while the field was RESERVED. Every value that
  is not literally `autonomous-merge` resolves to the human path — a typo,
  a boolean, an array, an older adapter, or something a future console
  writes. It is read at scaffold time only, never at run time: a script
  deciding its own merge model mid-run from a file the agent's branch could
  in principle have edited is the wrong shape for this field.

- [x] **1.3 — Decide the fate of the other RESERVED fields.**
  `cadence` and `evaluation` are parsed and never read back out of an existing
  `project-adapter.yml` — cadence is baked into the workflow's cron at scaffold
  time. That may be the right answer permanently; if so, say so in the schema
  rather than leaving them labelled RESERVED as though work were pending.
  *See:* `harness/project-adapter.example.yml:232`, and `console/DESIGN.md`
  §2.3 for the LIVE/RESERVED accounting.
  *Done when:* each field is either read by something or relabelled with the
  reason it never will be.
  **Done — the answer was "permanently, and here's why".** Both are now
  labelled RECORDED rather than RESERVED, in the closing section of
  `harness/project-adapter.example.yml`: a value baked into a generated file
  has exactly one source of truth at run time, which is that file. Reading
  it back from the adapter as well would create two that can silently
  disagree, and the disagreement would be invisible precisely when it
  mattered — a run failing on the commands in a YAML file rather than the
  ones CI actually ran. `buildAdapterObject()` now writes `cadence` as well
  as `evaluation`, including `cadence.scheduled`, which says whether the
  cron was rendered into the workflow or left commented out pending a
  rehearsal. `cadence.trigger` is documentation of intent with no mechanism
  behind it, and is described as such.

- [x] **1.4 — Build the themes-review CLI.**
  `harness/lib/generate-themes.mjs` holds a prompt and a parser that no script
  calls, and `memory.themes_review.cadence_generations` is parsed, unit-tested,
  and read by nothing. The blocker was never the compiler — it was real
  generation records existing, which `run-generation.mjs` now produces.
  *See:* `harness/lib/adapter.mjs:142`, `docs/curiosity/C2-themes-review-cli.md`.
  *Done when:* `harness/scripts/generate-themes-review.mjs` exists, follows the
  pure-logic-in-lib / model-calls-in-scripts split, and is the prerequisite
  Tier 4 needs it to be.
  **Done.** The cadence decision (`isThemesReviewDue()`), the filename
  padding (`padGeneration()` — `loadLatestThemesReview()` sorts filenames
  lexicographically, so `review-9.json` would have silently pinned a project
  to a stale review forever), the prompts and the output object are all pure
  and in `generate-themes.mjs`; the script owns the adapter, the filesystem,
  the API call and the exit code. Every failure path writes nothing and exits
  non-zero: a themes review becomes permanent standing context for every
  future generation, so a bad one is worse than none. "Not due" exits 0,
  because this runs after every generation and would otherwise train everyone
  to ignore a failing step. 7 of the new tests drive the CLI as a real child
  process, including the whole path up to the API boundary.
  Two things found while wiring it, both fixed here: the generated workflow
  committed only `constitution.allowed_paths`, so a project that (rightly)
  kept `docs/generations` out of the agent's editable surface never committed
  its own history and every future run read an empty one; and
  `buildThemesSystemPrompt()` hardcoded "ten generations", which would have
  told a project on a cadence of 5, or a first review with 3 records, to
  compare ten things it did not have.

---

## Tier 2 — turn "portable" from a claim into a fact

The largest outstanding body of work, and the one the design document is most
insistent about. `Portable-Harness-Design.md` §8.4 is explicit: none of these
gaps are solved by better documentation — they are missing code.

- [ ] **2.1 — Rehearse on a second project, chosen to be different on purpose.**
  `Portable-Harness-Design.md` §10 step 6. Different language, no visual
  surface, and a file count large enough to force the `context.strategy:
  scoped` question rather than let `full-dump` quietly keep working. This is
  the highest-value item in the file: it decides whether 2.2 is urgent or
  theoretical, and nothing should claim multi-language support until it has
  happened.
  *Done when:* `init` has been run against that repo and one generation has
  been rehearsed end to end, with the result written up honestly — including
  whatever broke.

- [ ] **2.2 — Implement `context.strategy: scoped`.**
  It has no implementation at all; `harness/cli/init.mjs:168` warns the user to
  their face when they pick it. `context-pack.mjs` sends every editable file in
  full because carrotgame's editable surface is ~7 files. §8.2 names the two
  candidate shapes: a lightweight per-ecosystem symbol index, or a two-pass
  pattern where stage 1 asks which files matter and only those are sent in
  full on the real call.
  *Depends on:* 2.1, which decides which shape is warranted.
  *Done when:* the strategy runs on the 2.1 project and `init` stops warning
  about it.

- [ ] **2.3 — Verify Mac and Linux, and a non-`ubuntu-latest` runner.**
  §8.3: this has only ever been exercised on Windows. Node makes portability
  *plausible*, not *verified*. `shell: bash` is already pinned on every step,
  which is what makes this a test rather than a rewrite.
  *Done when:* `init` plus one rehearsed generation have run on each of the
  three dev OSes and on at least one non-Ubuntu CI runner.
  **Partly done, and deliberately not ticked.** Linux is now a real second
  data point: the whole suite (including the e2e test, which drives the real
  chain against a real git remote and a real child-process test run) passes
  there, and `init` has been run against a fresh git repo end to end
  producing valid YAML. The LLM calls were NOT made — no lab API key in that
  environment — and neither macOS nor a non-`ubuntu-latest` runner has been
  touched. §8.3's first bullet asked for an actual audit of the control code
  rather than an assumption; that audit is done and written up there, with
  one real finding fixed (two scripts built the path they *record* with
  `path.join()`, so a Windows developer and CI would have written different
  strings for the same file, silently).

- [x] **2.4 — Reframe the evaluator plugins as a documented extension point.**
  §8.2: "visual/wordless-play" was never the general case — it is one instance
  of *domain-specific quality dimensions beyond pass/fail, evaluated
  non-gating*. Ship one example plugin and document the interface (input:
  working tree + generation record; output: a named metric, never gating
  unless a human later promotes it). Leave Checkstyle/mypy/Roslyn as
  documented extension points, not v1 code.
  *Done when:* the interface is documented and one plugin implements it.
  **Done.** `harness/lib/evaluators.mjs` is the runner,
  `harness/plugins/evaluators/README.md` is the interface, and
  `harness/plugins/evaluators/source-weight/` is the shipped example.
  The example is deliberately not the visual one: a canvas renderer cannot be
  exercised by this repository's own tests, and an example nobody can run is
  a specification wearing an example's clothes. The canvas checks join
  Checkstyle/mypy/Roslyn as documented extension points, which is what §8.2
  argued for anyway.
  Non-gating is enforced in the runner rather than trusted to each plugin,
  because a plugin is third-party code: throw, hang past the timeout, or
  return a malformed metric, and the result is a recorded error and nothing
  else. `run-evaluators.mjs` exits 0 even when every plugin it loaded blew
  up. Results land in `<generationsDir>/gen-NNN/metrics.json` and are read
  back into the NEXT generation's prompt through the section carrotgame's
  readiness scorecard used to occupy — which was a hardcoded `null` in
  `run-generation.mjs` until now.

---

## Tier 3 — the console

Phase 0 of `console/DESIGN.md` §5 is **effectively done** — the generator
exists as pure functions with tests — and as of 3.1 the document says so.
What phase 0 is still missing is `validateAnswers()` (§2.1): the invariant
checks over an answers object, which neither the CLI nor the console has.
That is a prerequisite for 3.3, not for 3.2.

- [x] **3.1 — Update `console/DESIGN.md` to the code that exists.**
  Correct §2.1, and point Phase 0 at `scaffold.mjs`/`init.mjs` by their real
  names. Cheap, and it stops the next reader planning work that is finished.
  *Done when:* no section of DESIGN.md describes the generator as unbuilt.
  **Done.** The status line, §2.1's heading, §5's phase table and its
  following paragraph, and §10 all now name `scaffold.mjs`/`init.mjs`. §2.1's
  original argument is kept, explicitly marked as the record of the argument
  that produced the code rather than a description of the tree. §2.3's table
  and §Step 7 were updated in the same pass (1.2 made `approval_class` LIVE;
  1.3 moved the other two rows to "recorded, by design"). What §2.1 says is
  still genuinely missing — `validateAnswers()` — is now the only thing it
  claims is missing.

- [ ] **3.2 — Build the phase-1 backend.**
  §8.5 changed the connection to a real GitHub App, which means every
  privileged call needs a short-lived installation token minted server-side
  from the App's own private key — and that key must never reach the browser.
  One function: holds one secret, mints a token, proxies the call it was asked
  for. §5 is explicit that "almost no backend" stopped being accurate the
  moment §8.5 was adopted.
  *Depends on:* Tier 1 — the console must not generate a workflow whose merge
  model contradicts its own §Step 7.

- [ ] **3.3 — Build the console front end.**
  All nine steps, sealed-box secrets, the PR, dispatch, and the run view
  (§8.4). `console/mockup.html` is the clickable sketch to build against.
  *Depends on:* 3.2.

---

## Tier 4 — curiosity

Ten specs in `docs/curiosity/`, **none built**. Every one is additive to a loop
that already runs, and renders nothing when its input is absent. Don't treat
this tier as optional-forever work — it is the answer to "the loop gets better
at fixing and never gets curious" — but do respect its own gate.

- [x] **4.1 — C8, escalation follow-through.**
  Independent of everything else and buildable today. The smallest and the
  highest value: an escalation that reaches consensus and is accepted
  currently changes a `status` field and schedules no work. Wiring acceptance
  to a work order produces this project's first genuine outcome label — *did
  the thing three models agreed on actually work?*
  **Done — all four parts.** 8a: acceptance queues a work order, the next
  ambitious run is handed it and told the change is already decided, and the
  outcome is written back — on approval, on abandonment, on a crash, and on a
  run that got no proposals at all, because an order left assigned forever
  drains the queue without recording why. `accepted` stays `accepted`;
  `work.completed` is what stops it being re-queued. 8b: an entry nobody has
  engaged with for `resurface_after` generations is put to the fan-out by
  name with an `ESCALATION REVIEW` field it must answer AGREE / DISAGREE /
  IRRELEVANT — "I had not considered it" is refused explicitly, because it is
  the honest answer that recreates the bug — and three distinct IRRELEVANT
  judgements retire it. 8c: the minority report rides along in the digest.
  8d: a dissenter the outcome contradicted is marked, on `approved` only.
  Two deliberate departures from the spec, both written up in the doc: the
  queue is drained here rather than waiting for C4 (a queue nothing drains is
  the disease this workplan keeps curing), and queueing happens at the top of
  a run so a decision made yesterday is acted on today rather than next
  generation.
  Every part is additive by construction, and
  `tests/lib/orchestrator.test.mjs` now asserts the cold-start prompt is
  byte-identical with the new blocks absent or null — 4.5's assertion, on the
  first component it applies to.

- [x] **4.2 — C10, runtime evidence.**
  Also independent and buildable today. Pure `context-pack.mjs` work, and it
  improves every proposal the harness makes, curiosity or not.
  **Done.** Not quite pure `context-pack.mjs` work in the end: the read side
  is (`buildRuntimeEvidence()`, the spec's interface exactly), but something
  has to write the file, so `harness/lib/runtime-evidence.mjs` +
  `harness/scripts/record-runtime-evidence.mjs` are the write side, and
  `verify-deployment.mjs` gained `--evidence` so the deploy check contributes
  what it *observed* rather than only its verdict.
  Two rules the tests pin down, both from incidents rather than taste:
  a composite score is dropped at the point of WRITING as well as rendering
  (a score that never reaches the file cannot leak into a prompt through some
  later reader that forgot the rule), and when the 2,000-character budget
  runs out it is the totals that go, never a skipped test's name — "98
  passed" changes no decision, "3 skipped, named X, Y, Z" might change
  several.
  What a project has to do itself, stated rather than assumed: tee a TAP
  stream to `$RUNNER_TEMP/tests.tap`, or write a JSON fragment. A project
  that does neither records less and the section shrinks; it never lies.

- [ ] **4.3 — Run the A′ go/no-go experiment before building anything else here.**
  `docs/curiosity/C9-retrospective-scoring.md` §"Phase A′, the cheap version".
  If the questions C2 produces are never cited by any subsequent generation,
  the ledger is a filing cabinet for noise and **the rest of the folder should
  not be built**. Honour this.
  *Depends on:* 1.4 (C2 needs the themes CLI — **done**; C2's phase A, the
  `UNKNOWN` field, is part of this tier and stays behind this gate) and enough
  real generations to score. The second dependency is the binding one now: no
  amount of harness code substitutes for a project that has actually run
  twenty-odd generations, which is 2.1's business.

- [ ] **4.4 — C3 → C4 → C5 → C6 → C7 → C9, in that dependency order.**
  Only if 4.3 says yes.

- [ ] **4.5 — The cold-start byte-identity test, on every component built.**
  *Standing, not finishable — left unticked on purpose.* Applied to every
  component built so far: `tests/lib/orchestrator.test.mjs`'s "a cold-start
  prompt is byte-identical whether the optional blocks are absent or null"
  covers `qualityMetrics`, `runtime`, `workOrder` and `escalationReview`
  together, and `tests/lib/escalation-followthrough.test.mjs` pins the same
  property on `buildEscalationBrief()` with nothing awaiting judgement. Add
  the next block to that first test when you add one; the test is written so
  that forgetting is the thing that fails.
  With no goal, no questions, no principles and no runtime evidence, the
  assembled suggestion prompt must be **byte-identical** to the one the harness
  produces today. It is the only assertion that proves the design is additive
  rather than merely intended to be, and its failure mode is why it's worth the
  effort: a stray newline is invisible in review, costs nothing measurable, and
  silently changes the prompt every model in the rotation has been answering.

---

## Proposed additions — from the 2026-09-02 review, not yet adopted

[`docs/Review-SWOT-2026-09.md`](docs/Review-SWOT-2026-09.md) §6 proposes
a Tier 0 (adoptability: licence, version, supply-chain pinning, kill
switch), a Tier 5 (operationalisation: cost accounting, a
different-family judge, reading the pull request's fate back, scope-aware
ranking, seat promotion, a generated ops report, source fencing,
rollback), and amendments to Tiers 2 and 4 — including one sequencing
hole: **4.3 depends on the `UNKNOWN` field, which is not built**, and the
review proposes running A′ retrospectively on carrotgame's history rather
than waiting for a fresh project to accumulate twenty generations.

Each proposed item is written in this file's *done when* style so that
adopting one is a copy into the tier above, not a rewrite. Nothing in
that document is a tick until it is here.

---

## Housekeeping, whenever a nearby file is open

- [x] Fold doc-drift fixes in as you touch things: `console/DESIGN.md` §2.1
      (3.1 above), and any remaining place that describes `init` as unbuilt.
      Done alongside 1.1–1.3 and 3.1: `ARCHITECTURE.md`'s diagram and its
      "Known gap" section, `README.md`'s "one known seam", and
      `Portable-Harness-Design.md`'s "one open seam" all described the merge
      model as unreconciled and no longer do. Keep folding new ones in.
- [ ] `Portable-Harness-Design.md`'s Status table and `ARCHITECTURE.md`'s prose
      hold the same information and are kept in sync by hand. If they ever
      disagree, trust whichever was edited more recently and fix the other.
- [ ] Every commit is written as though the repository is already public.

---

## Done — do not re-litigate

Recorded here so the list above can be read without wondering what's missing
from it.

- Bucket A (`learning/`) ported; `examples/carrotgame/` reconstructed as the
  adapter-schema test case (§10 steps 2–3).
- Bucket B genericised in dependency order: provider router, edit-format,
  release detector, reachability probe, adapter loader, guard, escalations,
  themes (read side), context-pack, orchestrator, independent reviewer
  (§10 step 4).
- The loop runs end to end — suggest → rank → implement → review → refine —
  via `harness/scripts/run-generation.mjs`.
- Staging and promotion, all four `deployment.verify_strategy` values
  (`url` / `registry` / `artifact` / `none`), and the notifier with its
  pluggable sender registry.
- `harness/cli/init.mjs` + `harness/templates/workflow.yml.tmpl` chain the
  whole thing into one generated workflow (§10 step 5).
- 434 tests (as of 2026-09-02), including `tests/e2e/full-loop.test.mjs` driving the real chain
  against a real git remote and a real child-process test run.
- Pinned implement/review/rank seats get their lab's API key wired even when
  that lab is not in `providers.watched`.
