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

**→ A person's verdict, then 2.1a.** The generated workflow has now run real
generations on GitHub Actions (Tier 6, 2026-09-11,
[`docs/campaigns/`](docs/campaigns/)). What has not happened is a human
merging or closing one of its pull requests and the next cycle reading that
back — three are open in `Chrisfoz/icd-mapper-harness-campaign`. After that,
2.1a: a larger repository, to force the `context.strategy: scoped` question.

*2026-09-18:* **the loop has produced a merged change on a second project.**
Hospital of the Future, generation 001, campaign mode on `gemini-3.8-flash`:
detect → probe → preflight → suggest → implement → review (rejected twice,
approved on the third attempt) → guard → tests → pull request → record →
digest email, all of it on GitHub Actions with real keys. The owner merged
it. That closes the "a person's verdict" item below in substance — the
read-back of that merge into the next cycle has not run yet. Three harness
defects the install found are fixed and shipped (I9, I10, I11, plus the
campaign `lab:model-id` form); the cost evidence it produced is recorded
against 2.2, which is now the best-supported unbuilt item in this plan.

**Before the next copied install, read Tier 7.** It holds the newest open
items (I8–I13), and **I10** is directly in the path of one: a copied install's
generated workflow still runs `npm install js-yaml` at the target repository's
root, which during the NetworkinAI install silently became that project's own
dependency install. Nothing in the README, the example adapter or the
generated `SELF-IMPROVE-README.md` warns about it yet. (The *local* install
path was a second instance of the same problem and is now fixed: README Step 1
installs js-yaml with `--prefix harness`, because `scaffold.mjs` imports it at
load and `init.mjs` therefore cannot run without it.)

*2026-09-17:* the first install into an existing project
([`docs/campaigns/2026-09-17-networkinai-install.md`](docs/campaigns/2026-09-17-networkinai-install.md))
gives 2.1a its first data point. 1.03 million characters of editable source
still fit `full-dump`, but cost 250–510k input tokens per suggesting model,
so at six models the prompt was most of a 2M budget. Two harness defects it
found are fixed: the suggestion prompt demanded two incompatible response
formats, and `init.mjs` recorded the current branch as `default_branch`. It
also records one design question that is still open. The copied-in
workflow's root `js-yaml` install is silently the project's dependency
install, so isolating it needs `evaluation.setup_commands` for copied
installs first. Its GitHub runs add a cost finding. A generation that shipped cost ~393k tokens, under $1 for the Anthropic seat. Two runs that crashed cost ~$9. Two savings were built for it the same day: the implementer is sent only the files a proposal names, and the Anthropic implementer uses prompt caching. Neither has been measured on a real generation yet. None of this closes the "person's verdict" item above,
because the merged change came from a rehearsal branch rather than a
workflow-opened pull request.

*Superseded 2026-09-11 — kept for the record:*
**→ Tier 0.5's one open item: a real generation through `harness/`, then
Tier 2.1a.** [`docs/Review-10x-2026-09.md`](docs/Review-10x-2026-09.md)
(2026-09-04) found the finding everything else waits on: no generation
with a real model call has ever run through `harness/` (F12) — the
reference implementation runs its own scripts, the e2e test fakes the
three model calls, and the one real run had no key. Tier 0.5 below closed
the two parts of that finding buildable without an API key (a local
`rehearse` command, and adapter validation); P0.1 — an actual real
generation, which needs the owner's own lab keys and authorization to
spend against them — is still open and is genuinely the next thing to do,
ahead of 2.1a: a design-partner rehearsal is worth far more once it's
known the loop works against a real model at all.

Tier 0, Tier 1 and the buildable half of Tier 5 are done (2026-09-02). The
harness now records cost, reads the owner's verdict back from every pull
request, ranks with a different family, no longer pulls every run toward
the smallest change, and can be turned up and rolled back. What it does not
have is a second project: every number it can now report is still n=1.
2.1a decides whether 2.2 is urgent or theoretical, and nothing should claim
multi-language support until it has happened. 4.3a (A′ on carrotgame's
history) can run in parallel, since it needs only records that exist.

---

## Tier 0.5 — a rehearsal door and adapter validation

From [`docs/Review-10x-2026-09.md`](docs/Review-10x-2026-09.md) Phase 0
(P0.1–P0.3). The finding: every check this repository has ever run fakes
the three model calls, so a change to a prompt, a rubric or the edit
format is validated only against the fixtures it was written against
(F12, F20) — and install has never had the structural validation
`console/DESIGN.md` §2.1 calls "the whole value of the thing" (F18).

- [x] **P0.3 — Adapter schema validation.** `harness/lib/validate.mjs`'s
  `validateAdapter()`: every `constitution.allowed_paths` entry exists,
  `allowed_paths` never overlaps `frozen_paths`/`append_only_paths`,
  `.github/**` is frozen unless deliberately overridden, brief files
  exist and are flagged for unfilled `[placeholder]`s, `providers.watched`
  and every pinned seat resolve to a registered provider, and a warning
  names any needed lab whose key isn't set in the given environment.
  `harness/scripts/validate.mjs` is the CLI; `init.mjs` runs it on what it
  just scaffolded and prints the result without failing the scaffold.
  *Done when:* an adapter with an editable path that does not exist fails
  before any model is called, with the path named. **Done** — also wired
  as the generated workflow's first real step (`id: validate`,
  continue-on-error, gating the campaign/check steps on its success), and
  the digest's no-generation reasons gained `VALIDATE_FAILED`, checked
  ahead of `CHECK_FAILED` so an invalid adapter is never reported as a
  quiet cycle.
- [x] **P0.2 — `harness rehearse`.** `harness/scripts/rehearse.mjs`: the
  same chain the generated workflow runs — validate, preflight, detect or
  campaign, probe, a local `agent/gen-NNN` branch, `run-generation.mjs`,
  commit, guard, tests, a printed verdict — as a thin sequencer over the
  same CLIs the workflow calls, so it can never drift from what the real
  workflow does. Never pushes, never opens a pull request, never merges.
  With no lab API key configured it is fully deterministic (no network
  call happens at all — a watched provider with no key reports `skipped`)
  and exits 0 having changed only the model snapshot, which is what makes
  it safe to run in CI as a test rather than only by hand.
  *Done when:* the e2e test drives the chain through this command rather
  than by calling each library in sequence. **Partly done** — `rehearse.mjs`
  exists, is tested at the CLI level for every deterministic path (missing
  or invalid adapter, dirty tree, no keys, a bad campaign id, a failing
  preflight), and reuses `run-generation.mjs` itself rather than
  reimplementing it; `tests/e2e/full-loop.test.mjs` still drives the chain
  by calling each library directly rather than through this command, which
  is the one piece of the original *done when* not yet true.
- [ ] **P0.1 — A real generation through `harness/`.** *Mostly done
  2026-09-11 — see Tier 6.* Four real generations ran through
  `rehearse.mjs` on two projects, every record with `spend.estimatedCalls`
  of 0 except the two requests whose connection dropped before any
  response; written up in [`docs/campaigns/`](docs/campaigns/). What the
  *done when* below still asks for and has not happened: a record committed
  to a **public example repository** and a **workflow run** linked from the
  README — both wait on Tier 6's GitHub Actions item. A scratch
  repository, a filled adapter and briefs, two lab keys, one campaign
  generation (`node harness/scripts/rehearse.mjs --models <id>`) on a
  current model. Fix whatever breaks. **Blocked on the owner's own API
  keys and authorization to spend against them** — nothing in this
  environment can do this step; run it locally or in a session with real
  keys configured. (F12)
  *Done when:* a `gen-001/attempts.json` with `spend.estimatedCalls: 0`
  is committed to a public example repository, and the workflow run (or
  `rehearse.mjs` invocation) that produced it is linked from `README.md`.
  **What is left here is a publishing decision, not engineering.** Four such
  records exist and are committed — but in this repository, which is private,
  and the Actions runs were in a private campaign repository. This item
  cannot be ticked until something is public; nothing more needs building
  for it.

---

## Tier 0 — make it adoptable

From [`docs/Review-SWOT-2026-09.md`](docs/Review-SWOT-2026-09.md) §6.
**Tier 0 is done** (2026-09-02), with one item that is the owner's to
confirm.

- [x] **0.1 — Add a `LICENSE`.** MIT, with the owner named as copyright
  holder. **The licence choice is the owner's decision, not the
  reviewer's** — it is on the branch to be confirmed or changed before
  merge; `CONTRIBUTING.md` now says MIT and should be corrected with it.
- [x] **0.2 — Version the harness, and record which version an install
  carries.** `harness/VERSION`, `harness/lib/version.mjs`; `init` writes
  `harness.version` into the adapter, every `attempts.json` carries
  `harnessVersion`, and `init --version` / `init --check-upgrade` read the
  local and upstream files.
- [x] **0.3 — Pin the generated workflow's supply chain.** Actions by
  commit SHA (checkout v4.2.2, setup-node v4.4.0, resolved with
  `git ls-remote`), `js-yaml` at the exact version `package.json` pins with
  `--ignore-scripts`; the scaffold test asserts both, and that the two
  pins agree.
- [x] **0.4 — A kill switch a non-technical owner can flip.** The
  `SELF_IMPROVE_PAUSED` repository variable, read by a first step that
  gates the release check; the digest still runs and sends a `paused`
  email saying nothing was spent and how to resume.
- [x] **0.5 — Stop hand-typing the test count.** README and this file
  point at `npm test` instead of carrying a number.

---

## Tier 0.6 — what a model can see

From [`docs/Tool-Use-Design.md`](docs/Tool-Use-Design.md), which answers
"should the models get tools, MCP, a way to make their own" and finds that
three separable things were bundled in the question. Phase 1 — the one that
needed no tool-use machinery at all — is done (2026-09-06); phases 2–5 are
design only and **2 onward depends on the sandbox that does not exist yet**
(`Review-10x-2026-09.md` P1.2).

The argument in one line: the binding constraint here is what a model can
NOTICE, not what it can write — the readiness scorecard found a
thirteen-second first-paint stall on its first run that 239 green checks had
never seen, because it was the first thing that actually looked at the
running product.

- [x] **T1.1 — Evaluator plugins may return artifacts.** `{metrics,
  artifacts}` alongside the old bare-array return, which stays valid
  forever; `artifactsDir` is the one path a plugin may write to; images and
  observations normalised, capped (8 per plugin, 4 MB per image, 3 images
  per prompt) and recorded in `metrics.json`.
  *Done when:* a plugin can return an image and an observation and both
  survive a round trip through `metrics.json`. **Done** — including through
  the real CLI against a plugin that writes a real PNG.
- [x] **T1.2 — The suggestion prompt's `screenshots` socket is fed.**
  `loadVisualEvidence()` reads the most recent generation that actually has
  images (not merely the newest folder — a failed generation creates a
  folder with no renders in it, which is how the reference implementation
  silently served a stale baseline while telling every model it was
  current), and the prompt now states which generation they came from.
  *Done when:* a project whose plugin renders has that render in the next
  suggestion call, and a project with none gets a byte-identical prompt.
  **Done.**
- [x] **T1.3 — The review call's `captureVisual` hook is fed.**
  `evaluation.visual_capture` names a plugin of the same interface, run
  inside the generation against the tree the edits produced. Fails safe: a
  renderer that throws, hangs or draws nothing leaves the reviewer on the
  diff alone.
  *Done when:* the reviewer receives a render of the change under review,
  and a project configuring none gets `review.mjs`'s existing "not
  available" line unchanged. **Done.**
- [ ] **T2.1 — The tool contract and registry.** `registerToolSource()`,
  the adapter's `tools:` block, per-seat allowlists (§5 — the review seat's
  tools must not be the implementer's), `fenceUntrusted()` on every result,
  `toolCalls` in `attempts.json`. Ships with zero built-in tools.
  *Depends on:* `Review-10x-2026-09.md` P1.2's sandbox.
- [ ] **T2.2 — The instrument rule, as a guard check.** A generation may not
  modify a tool and then be judged by that tool — the paper's own "product
  code, constitution and evaluator must not all be modifiable within the
  same campaign", and the whole safety case for T2.1.
  *Done when:* `check-guarded-paths.mjs` refuses it, with a test that fails
  without the check.
- [ ] **T2.3 — A tool budget** (`max_calls_per_attempt`,
  `max_wall_clock_seconds`), projected and enforced like the token cap. An
  engine build is bounded by neither tokens nor `maxAttempts`.
- [ ] **T4.1 — MCP as one source behind the contract.** Read-only by
  default, pinned by exact version, network off unless a named server is
  opted in, credentials in their own step. **Write-MCP stays out** while
  `rollback.mjs` can only revert git.
- [ ] **T5.1 — `tools/**` as a create-only path.** A model may propose a new
  probe; it is reviewed, tested, guarded and merged like any other change,
  and becomes callable the generation *after* the one that wrote it.
- [ ] **T5.2 — Bench the claim.** Whether a tool-equipped suggest seat
  actually notices more is empirical, not architectural. Same bench repos,
  tools on and off (`Review-10x-2026-09.md` P5.1).

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
  *See:* `harness/project-adapter.example.yml` §RECORDED/RESERVED, and `console/DESIGN.md`
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
  *Partly done 2026-09-11:* two generations rehearsed on a Python CLI with no
  visual surface (the ICD mapper), written up with what broke — the test-name
  extractor knew no pytest, and the prompt lost its whole test section. Not
  yet true: the adapter was written by hand rather than by `init`, and the
  project is ~300 lines, so the `context.strategy: scoped` question was not
  forced. A larger repository is still needed for that half.

- [ ] **2.1a — Three design-partner installs, not one.** One Python CLI
  (no visual surface, `verify_strategy: none`), one TypeScript service with
  more than 100 source files (forces `context.strategy: scoped`), one
  published library (`verify_strategy: registry`). The paper's RQ5 says
  three; the console needs the demand signal; and one project cannot
  separate "the harness is portable" from "this project was easy".
  *Done when:* three rehearsal reports exist, each naming what broke — **in
  those three shapes**, which is the part the count alone does not check.
  Four write-ups now exist (germ-fighter, icd-mapper, icd-mapper on Actions,
  and the NetworkinAI install), so the *count* is met. The Python CLI shape
  is covered by icd-mapper. NetworkinAI is a large web app but `full-dump`
  still fit, so it does not settle the `scoped` question. **The missing shape
  is a published library with `verify_strategy: registry`** — that, not a
  fourth report, is what closes this.

- [x] **2.5 — Campaign mode, for accumulating evidence on purpose.**
  **Done.** The generated workflow's `models` dispatch input runs a
  generation now on models named by hand; `harness/lib/campaign.mjs` writes
  the same `release-check.json` the detector would, so probe, preflight and
  improve run unchanged; the snapshot is untouched; the record is stamped
  `campaign: true` and the index and report say so. Principle 1 is about
  the product loop; evaluating the harness needs a faster clock.

- [ ] **2.2 — Implement `context.strategy: scoped`.**
  It has no implementation at all; `harness/cli/init.mjs`'s `scoped` warning tells the user to
  their face when they pick it. `context-pack.mjs` sends every editable file in
  full because carrotgame's editable surface is ~7 files. §8.2 names the two
  candidate shapes: a lightweight per-ecosystem symbol index, or a two-pass
  pattern where stage 1 asks which files matter and only those are sent in
  full on the real call.
  *Depends on:* 2.1, which decides which shape is warranted.
  *Done when:* the strategy runs on the 2.1 project and `init` stops warning
  about it.

  **2026-09-18 — the first real evidence, from a generation that shipped.**
  Hospital of the Future, generation 001, campaign on `gemini-3.8-flash`
  suggesting and `claude-opus-5` implementing and reviewing. It reached a
  pull request with every gate passed, so this is the cost of a GOOD run
  rather than a wasted one:

  | | |
  |---|---|
  | Editable surface | ~1.66M characters, 98 files (`shared/vendor/three.min.js` already excluded) |
  | Total tokens | 1,103,928 |
  | Input | 1,050,350 — **95% of the run** |
  | Output | 53,578 |
  | Served from cache | 117,969 |
  | Attempts | 3 (rejected, rejected, approved) |

  Two things that argue for building this, and one that argues against
  building it hastily:

  - **Input dominates, and it is the same input every time.** One suggesting
    model reading the whole editable surface is ~474k tokens before anything
    is proposed; the run above spent a million on input to produce 53k of
    output. On a project this size the budget cap (`2,000,000` here) is
    reached by about four suggesting models, which caps `max_fanout` at 3 —
    not by choice but by arithmetic. Scoped context is what would let a
    project this size watch nine labs and fan out properly.
  - **The reviewer re-reads full modified files, per attempt.** Three
    attempts against a 310k-character file is the same file read three times
    at Opus rates. A two-pass shape that narrows what the IMPLEMENTER and
    REVIEWER see may matter as much as narrowing what the suggester sees.
  - **But the run worked.** `full-dump` on 1.66M characters produced a
    merged, on-goal change on the first campaign. The failure mode here is
    cost and fan-out ceiling, not capability — so the shape should be chosen
    against measured savings, not assumed. The prompt-cache read of 117,969
    tokens is the other lever already partly working.

  *See:* `docs/campaigns/` for the write-up, and the record itself in that
  project's `docs/generations/gen-001/attempts.json`.

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
The `validateAnswers()` half (§2.1) — the invariant checks over an answers
object — has since shipped too, as `harness/lib/validate.mjs`'s
`validateAdapter()`; `console/DESIGN.md` §"Phase 0" says so at length. So
3.3's remaining prerequisite is narrower than this preamble used to claim:
wrap the generator and its validator in a browser form.

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
  *Done when:* a privileged GitHub call is made with a token minted
  server-side from the App's private key, that key never reaches the browser,
  and a test proves the browser path cannot obtain it.
  *Depends on:* Tier 1 — the console must not generate a workflow whose merge
  model contradicts its own §Step 7.

- [ ] **3.3 — Build the console front end.**
  All ten steps, sealed-box secrets, the PR, dispatch, and the run view
  (§8.4). `console/mockup.html` started as the clickable sketch and is now
  the working installer itself, served at `/console`.
  *Done when:* all ten steps accept real input, the generated bundle passes
  `validateAdapter()`, and a setup pull request has been opened against a
  real repository by a live authenticated run. The first two are true;
  `console/IMPLEMENTATION.md` is explicit that the third has not happened,
  which is why this stays unticked.
  *Depends on:* 3.2.

---

## Tier 4 — curiosity

Ten specs in `docs/curiosity/`; **four built** — C1 (4.6), C2's `UNKNOWN`
field (4.0), C8 (4.1) and C10 (4.2). Every one is additive to a loop
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

- [x] **4.0 — Build phase A: the `UNKNOWN` field.** **Done.** 4.3
  depended on it and the plan did not say so. `generate-themes.mjs` asks
  for it as optional per theme and fails the review on a present-but-short
  one; `themes.mjs`'s `buildOpenQuestionsBrief()` renders the questions as
  their own section, numbered `q1..qN` for citation, and returns null for
  every review without one, so the cold-start prompt stays byte-identical
  (4.5's test now lists it).

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

- [ ] **4.3a — Run A′ retrospectively on carrotgame.** Generate themes
  reviews over carrotgame's existing generations in windows of ten (the
  CLI's `FORCE_REVIEW`), then run `check-question-uptake.mjs` (C9, still
  to write) against the generations that followed each window. This is the
  go/no-go, available now, on real history — it does not have to wait for
  2.1a.
  *Done when:* the table in C9 §"Phase A′" has been printed for carrotgame
  and the verdict is recorded in `docs/curiosity/README.md`.

- [ ] **4.4 — C3 → C4 → C5 → C6 → C7 → C9, in that dependency order.**
  Only if 4.3 says yes.

- [x] **4.6 — C1, the committed goal.** **Done.** `project.goal` in the
  adapter; rendered above the brief; the reviewer rejects a correct, safe,
  tested change that moves away from it; `check-guarded-paths.mjs` refuses
  a diff that edits it; `init` asks for the statement. The open question
  C1 left is decided in the doc: the goal wins, consensus is evidence.

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

## Tier 5 — operationalise

From [`docs/Review-SWOT-2026-09.md`](docs/Review-SWOT-2026-09.md) §6,
adopted 2026-09-02. Everything ticked here shipped in one pass on the
`claude/self-optimization-swat-259scx` branch, each item its own commit
with tests. What is not ticked needs either a second project or a design
decision.

- [x] **5.1 — Cost accounting and a budget cap.** `harness/lib/spend.mjs`;
  every `attempts.json` carries `spend` (calls, tokens, per model, per
  stage, how many are estimates); `budget.max_generation_tokens` is
  projected before the fan-out (`over-budget`, nothing called) and
  checked between attempts (`budget-exhausted`, abandoned); the digest
  states the spend. Tokens, not money.
- [x] **5.2 — A judge from a different family, by default.** The rank
  seat: `harness/lib/seats.mjs` picks another lab's model from the
  snapshot when the adapter names none. **The review seat is deliberately
  not auto-picked** — it fails closed and must be a model someone chose —
  but every run logs the family split and warns when review shares the
  implementer's family, and `init` prompts for a different lab.
- [x] **5.3 — Read the pull request's fate back.**
  `harness/lib/pull-requests.mjs` + `sync-pull-request-outcomes.mjs`, run
  at the top of every cycle. A closed-unmerged pull request breaks the
  clean streak and reaches the next prompt as CLOSED UNMERGED.
- [ ] **5.4 — A human verdict on shipped changes.** *Half done.* Closing
  a pull request and reverting a generation are both read back and both
  count as the owner's verdict (5.3, 5.11). What is not built is a verdict
  on a change the owner kept — a `gen:good` / `gen:regret` label or a
  reply keyword — which is what "promotion precision" needs beyond
  "not reverted".
  *Done when:* a kept change can carry a human verdict in its record and
  the report counts it.
- [x] **5.5 — Scope-aware ranking, and the brief template fix.**
  `RANK_RUBRIC` by scope; focused is the original text byte for byte; the
  brief template's "small localised edits" moved out of the constraints
  that never expire.
- [x] **5.6 — Stop ambition punishing itself.** A lone ambitious failure
  costs one focused generation and is set aside from the window; two in a
  row count in full.
- [x] **5.6a — The ambition dial.** `context.ambition` (`focused` /
  `earned` / `ambitious`), read at run time, per-run override from the
  Actions tab, unrecognised values fall to `earned`; `init` refuses
  ambitious plus autonomous merge unless the owner types the word.
  [`docs/Ambition-Control.md`](docs/Ambition-Control.md) is the risk table
  and states the rule the console design now carries as Step 7b: the
  dial is not offered without the Revert button.
- [x] **5.7 — Seat promotion by track record.**
  `roles.promotion.implement_after_self_implemented_approvals`; a rotating
  model whose own edits were approved and kept N times takes the
  implement seat; the review seat is never promoted. Off by default.
- [x] **5.8 — A generated operational report.** `harness/lib/report.mjs`
  → `<generationsDir>/REPORT.md`: release yield, promotion precision,
  closed-by-owner, failure recurrence, tokens and tokens per kept change,
  per lab, per scope. Regenerated every cycle; never hand-edited.
- [x] **5.9 — Fence untrusted source.** `fenceUntrusted()` wraps the
  source bundle and the architecture notes; the review prompt and the
  reviewer brief template treat text addressed to an AI as an injection
  attempt to reject.
- [ ] **5.10 — Branch-protection-compatible bookkeeping.** *Not built —
  a design decision first.* The snapshot, the pull-request read-back, the
  report and the runtime evidence all push straight to the default branch,
  which branch protection refuses. Two shapes: a `harness/state` branch
  the next run checks out into a worktree (clean, but every reader of the
  records has to know), or bookkeeping riding the generation's own pull
  request (simple, but a cycle that opens no PR records nothing). Decide
  on the first design-partner repo that has protection on.
  *Done when:* a rehearsal on a repo with branch protection completes
  without a failed push.
  *Narrowed 2026-09-11:* generation records now reach the default branch
  through one script, `harness/scripts/persist-records.mjs --base <branch>`,
  in its own worktree (Tier 6, R4). A `harness/state` branch is now that
  flag plus the readers learning the branch name — not a redesign. The
  snapshot and pull-request read-back steps still push directly.
- [x] **5.11 — A rollback script.** `harness/lib/rollback.mjs` +
  `revert-generation.mjs NNN`: reverts the tag's merge or the pull
  request's merge commit, records `reverted`, and the next run reads it as
  a failure. Tested against a real bare origin on both merge paths.
- [x] **5.12 — Keep the losing proposals.** Every fan-out proposal under
  `gen-NNN/proposals/<model>.md`; the prompt and the index are unchanged.

---

## Tier 6 — the September reliability review (2026-09-11)

An outside review found six defects that each let the loop lose, misread or
overspend on exactly the runs it most needs to learn from, and proposed
three capability steps. Each defect below was reproduced before it was
fixed, and has a test that fails against the old code. Written up, with
the real campaigns that tested the fixes, in
[`docs/campaigns/2026-09-11-first-real-campaigns.md`](docs/campaigns/2026-09-11-first-real-campaigns.md).

- [x] **R1 — CI actually runs the tests.** Node 20 read `npm test`'s glob
  as a literal path, so every run on `main` failed before a test executed.
  `engines` is `>=22.11.0`; CI runs that exact minimum and current LTS;
  `tests/lib/ci-config.test.mjs` fails if the four places a version is
  stated disagree. *Done when:* CI is green on the declared minimum —
  **true**, 631/631 on 22.11.0 and 24 at the time, none skipped. `npm test`
  prints the current count.
- [x] **R2 — The generated workflow's blockers.** The probe step had no
  keys; the gate-summary helper exited 1 under `bash -e` on the unrendered
  merge path (both modes) and wrote multi-line JSON to `GITHUB_OUTPUT`; the
  digest had no key for its model. `tests/helpers/gha-shell.mjs` runs
  rendered steps under GitHub's own bash flags. *Done when:* the steps pass
  under those flags — **true**; 8 of the 11 tests fail on the old template.
- [x] **R3 — The reviewer rejects incomplete or contradictory verdicts.**
  `parseVerdict()`: exactly one verdict, an approval must be complete
  (`END OF REVIEW`) and list no fixes; truncated, contradictory, malformed
  all fail closed; an unreadable review is asked once more.
- [x] **R4 — Durable identity and history.** Numbering from any trace
  (tag, branch, record), branch claimed with a lease and a unique claim
  commit, a concurrency group, a run id in every record, and every
  outcome's record committed to the default branch
  (`persist-records.mjs`). The agent branch carries code only.
- [x] **R5 — The working tree is restored after a crash**, and on
  SIGINT/SIGTERM. Not done: a worktree per attempt (would also survive
  SIGKILL).
- [x] **R6 — Every model request metered and reserved.** Retries recorded
  as their own calls; each request reserves input plus its whole output
  allowance before it is sent; a refused call is `budget-exhausted`, not a
  crash.
- [x] **C1 — Tests inside the repair loop.** Baseline, then the project's
  tests against each attempt before review, failing lines handed to the
  implementer, credentials scrubbed from the child. *Proven on real runs:*
  2 of the 4 campaign generations were repaired this way.
- [x] **C2 — Measure against a reproducible baseline.** The same
  (fingerprinted) evaluators before and after; `comparison.json`; benefits,
  regressions, cost and fate in `REPORT.md`.
- [x] **C3 — Prove the harness with real campaigns.** Four rehearsed
  generations on two different projects, then three generations run by the
  generated workflow on GitHub Actions (`Chrisfoz/icd-mapper-harness-campaign`,
  private) — each a pull request, the records on `main`, a PR's state read
  back into its record. Eleven findings fixed the same day, one of them a
  record the first Actions run lost. *Done when:* one campaign dispatch has
  produced a pull request and its record on the default branch, linked from
  the README — **true**, via [`docs/campaigns/`](docs/campaigns/).
  **Left for the owner:** review the three open pull requests; a merge or
  a close, then one more cycle, is the real read-back test not yet run.
- [ ] **C4 — Scoped context retrieval and tool use, guided by the
  campaigns.** Not started, deliberately: the campaigns did not force
  `context.strategy: scoped` (both projects fit `full-dump`), so the
  evidence to choose between 2.2's two shapes still has to come from a
  larger repository (2.1a).

## Tier 7 — the first install into an existing project (2026-09-17)

The harness installed into NetworkinAI, a live private web app. There was one
local rehearsal, then four runs on GitHub Actions: two crashed, and two went
through every gate to a pull request. Written up in
[`docs/campaigns/2026-09-17-networkinai-install.md`](docs/campaigns/2026-09-17-networkinai-install.md).
Most of what broke was the install path and the cost of runs, not the loop.

- [x] **I1 — GitHub setup that actually works first time.** The permissions
  page, a check that it saved, no personal token, SendGrid in three places,
  not overwriting an app's `.env`, and merge order. *Done when:* README,
  the generated install README, `console/DEPLOYMENT.md` and
  `how-to-run.html` say so. **True** (#19).
- [x] **I2 — The notify scripts register the labs.** Every digest had fallen
  back to its terse form. *Done when:* a test fails any model-calling script
  without the import. **True** (#20).
- [x] **I3 — One response format, and the right default branch.** **True** (#22).
- [x] **I4 — Runs that cannot finish don't get paid for, and don't show
  green.** Pinned seats are probed first, a crash turns the run red, the
  digest's gates are honest, and the implementer's output allowance and effort
  are configurable. **True** (#23).
- [x] **I5 — Users are told what a run costs.** This is framed as cost per
  merged change against a person's time. **True** (#24).
- [x] **I6 — The implementer reads less.** It gets scoped context and
  Anthropic prompt caching, and cache tokens are recorded. **True** (#25).
- [x] **I7 — A run history page for every installation.** **True** (#26).
- [ ] **I8 — Measure I6 on a real generation.** *Done when:* a GitHub run's
  `attempts.json` shows the implementer's input well below full context,
  or `cacheReadTokens` above zero on a retry, and the write-up says by how
  much.
- [x] **I9 — The digest says a waiting pull request is waiting.** Under
  `human-approval-required` it still said "⚠️ NOT MERGED", and the
  plain-language version said "we don't know why". *Done when:* an approved
  generation with an open pull request gets a subject naming the pull request
  as waiting for review, with a test.
  **Done.** Three outcomes now, not two: `📋 WAITING FOR YOU` sits between
  merged and not-merged, keyed on the pull request URL being present — which
  is absent by construction on the autonomous-merge path, because that step
  is not in the generated file at all. `blockedByLine()` learned the same
  thing and stops calling the default outcome "genuinely unclear". Both the
  pull request and the workflow run are linked near the top of the email, in
  the plain-language version and in the terse fallback, because a decision
  that needs the reader to go and find the pull request is a decision that
  happens next week. `scaffold.mjs` passes `PR_URL` into the digest step;
  five tests in `tests/lib/notify.test.mjs` pin it, including that a real
  gate failure still outranks a waiting pull request — `waiting` uses the
  same precedence `blockedByLine()` does, so a `records` gate that fails on a
  push race *after* the pull request is open cannot produce a "waiting for
  you" banner above a gate block showing a failure. The URL is validated as
  an https URL before it is printed (`run-history.mjs`'s rule, kept local),
  so a non-URL degrades to no link rather than a link to somewhere else, and
  `tests/lib/scaffold.test.mjs` pins the env line that makes the whole thing
  work in production — the one line whose deletion left all 862 tests green.
- [x] **I14 — What the pull-request step does when `gh` does not return a
  URL.** Raised as "the pipe to `tail` swallows gh's exit status, so a failed
  pull request reports a successful gate". **That premise was wrong, and the
  correction is the useful part of this item:** GitHub runs `shell: bash` as
  `bash --noprofile --norc -eo pipefail`, and a plain `url=$(... | tail -n 1)`
  assignment propagates the pipeline's status under `pipefail`. Run for real
  against the generated step with a `gh` that exits 1: the step dies, writes
  no output, and `continue-on-error` records `outcome: failure`, so the gate
  list already says `pull-request failure` and the digest already names it.
  Nothing was broken.
  **The neighbouring case was broken.** `gh` exiting **0** without printing a
  URL — a trailing warning line, or a version that prints the URL somewhere
  other than last — left `$url` holding prose, which was written to
  `GITHUB_OUTPUT` and from there into `attempts.json` and the run history page
  as that generation's "pull request". Measured, not imagined: a `gh` that
  echoes a warning and exits 0 produced `url=Warning: using default branch`.
  **Done.** The step now refuses anything that is not an `https://` URL and
  exits non-zero with the captured text in the log, which makes it a failed
  gate with a reason rather than a broken link found weeks later. Three
  outcomes of that step — opened, `gh` failed, `gh` returned no URL — are now
  executed for real in `tests/scripts/workflow-shell.test.mjs` under GitHub's
  own bash flags, including the pipefail behaviour that was load-bearing and
  untested. Verified by removing the guard and watching the test fail.
- [x] **I10 — Copied installs get an explicit dependency step.** The root
  `npm install js-yaml` is silently the project's own dependency install,
  with `--ignore-scripts`. *Done when:* the copied workflow runs
  `evaluation.setup_commands` and then an isolated harness install, and a
  project with no setup commands is told what to add.
  **Half done.** The isolation half shipped while installing into Hospital of
  the Future, because it is one line and that project has js-yaml 3.14.2
  hoisted under `@istanbuljs/load-nyc-config` — the ordinary jest shape —
  which a root install would have replaced for the rest of every run. The
  generated copied workflow now installs with `--prefix harness
  --no-save --no-package-lock`, and `tests/lib/scaffold.test.mjs` fails on a
  bare root install. It was hand-edited into that install's workflow first,
  and regenerating promptly overwrote it — twice, once per job — which is the
  argument against leaving it as a per-install hand-edit.
  **Done — the other half too**, forced by the first real campaign on Hospital
  of the Future: preflight exited **127**, command not found, because a copied
  workflow had no step that installs the project's own dependencies and its
  test command is `npm run test:unit`. The gate worked exactly as designed —
  it refused to spend, and the digest email said why — but no generation could
  ever have run. `evaluation.setup_commands` now renders into the copied
  workflow ahead of the harness install (`npm ci` deletes `node_modules`, so
  the order is load-bearing), the step disappears entirely when a project
  needs no install, and it never reaches the check-keys job, which calls lab
  APIs and nothing else. `validate.mjs` warns when a test command needs
  dependencies and nothing installs them, and names the fix. Both halves
  verified by breaking them and watching the tests fail.
- [ ] **I11 — A key check in the harness, with balance where a lab allows
  it.** NetworkinAI's own `scripts/verify-harness-keys.mjs` does the catalogue
  check. DeepSeek (`GET /user/balance`) and Moonshot
  (`GET /v1/users/me/balance`) also return a balance with an ordinary key.
  Anthropic and OpenAI report spend only, with an admin key. *Done when:*
  `harness/scripts/` has the check, the generated workflow offers it as a
  manual job, and it reports balance for the labs that expose one.
- [ ] **I12 — The budget estimate learns each lab's tokenizer.** Characters
  ÷ 4 undercounted Anthropic's count of HTML by about 1.5×. *Done when:* the
  reservation uses each provider's ratio of real to estimated input from past
  records, with a test.
- [ ] **I13 — The unexplained digest fallback.** Generation 004's
  plain-language digest failed once on GitHub ("No BODY: section found") and
  did not reproduce locally. *Done when:* the raw response of a failed
  compose is kept in the run log, and the cause is known.

## Tier 8 — make the install easy (2026-09-26)

From [`suggestion.md`](suggestion.md) (#36), a review of the end-user install
path: about seven manual steps and an 807-line README stood between a new
project and its first run. Numbered as in that file (D1 = suggestion 1), and
listed in the order they are being built — each one makes the next smaller.
Items marked **owner** are publishing decisions the code can be made ready
for but cannot take.

- [x] **D2 — No runtime dependency.** *Done when:* a copied `harness/` runs
  `init` and `validate` with no `node_modules` anywhere, the generated
  workflows install nothing from npm, and a test fails if anything in
  `harness/` or `console/` imports a package.
  **Done.** js-yaml 5.3.0's `dist/js-yaml.mjs` is vendored at
  `harness/vendor/` with its licence, pinned by hash in
  `tests/lib/vendor.test.mjs`, which also copies `harness/` into an empty
  directory and runs `init --yes` and `validate` there. Both generated
  workflows lost their install step, `package.json` has no dependencies, and
  the README, how-to-run, the console quick start and CONTRIBUTING's first
  non-negotiable no longer mention `--prefix harness`. Vendoring rather than
  a hand-written parser: the adapter is safety configuration, and a
  home-grown YAML subset that misreads it is worse than 126 KB of the real
  thing.
- [x] **D9 — One workflow, not two.** *Done when:* the README installs only
  the generated `self-improve.yml`, and `init --detector-only` renders the
  release-notice workflow for anyone who wants only that.
  **Done.** README Step 6 (copy the example, then hand-edit its `env:` lines
  and `--providers` to agree) is gone; the old Step 7 is now Step 6.
  `renderDetectorWorkflow()` generates both lists from one answer, pins
  actions by SHA like the full workflow, and passes lab-supplied names to
  `gh` through `env:`. The example file is now that function's output for
  all nine labs, and `tests/lib/detector-workflow.test.mjs` fails if anyone
  edits one without the other.
- [x] **D5 — Detect project settings instead of asking.** *Done when:* `init`
  proposes test commands, setup commands and editable paths from
  `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` / `pom.xml` /
  `*.csproj` / `Makefile`, with a test per ecosystem.
  **Done.** `harness/lib/detect-project.mjs` reads (never runs) the
  manifests and proposes defaults; `tests/lib/detect-project.test.mjs` has a
  fixture per ecosystem plus an `init --yes` run whose adapter comes out with
  `src/**`, `npm test` and `npm ci --ignore-scripts` and no empty-paths error.
  `init` also now asks for **setup commands** at all — before this, a CLI
  install never wrote `evaluation.setup_commands`, so its copied workflow had
  no dependency step unless the adapter was edited by hand (the I10 failure).
  Install proposals carry `--ignore-scripts`, because the job holds a write
  token; a project whose build needs install scripts removes the flag.
- [x] **D6 — A short setup path.** *Done when:* `init --quick` asks only labs,
  editable paths, test command and merge model, everything else takes its
  default, and the context-strategy question no longer offers `scoped`.
  **Done, with one addition:** five questions, not four — setup commands
  stay in, because a copied install without them cannot run its tests (I10),
  and D5 proposes them anyway. Everything else takes the same default the
  full questionnaire offers. The context-strategy question is gone from both
  paths rather than trimmed: nothing in the harness reads `context.strategy`,
  so the adapter records `full-dump`, which is what every run does.
  `tests/scripts/init-quick.test.mjs` drives a real `init --quick` prompt by
  prompt and asserts exactly which five were asked. Kept as a flag rather
  than made the default, so the documented full questionnaire is unchanged;
  the README now leads with `--quick`.
- [x] **D4 — `init` configures GitHub through `gh`.** *Done when:* with `gh`
  present and authenticated, `init --configure-github` sets the needed
  secrets from the local env file (only the labs the adapter uses), sets the
  workflow permission and the pull-request tickbox, reads both back and fails
  loudly if either did not save; without `gh` it prints today's instructions.
  **Done, with one deliberate narrowing:** it ticks the pull-request box but
  leaves the repository's default workflow permission as it finds it — that
  radio governs every *other* workflow in the repository, and the generated
  one declares its own permissions, so it works under either. On the
  autonomous-merge path it does not touch permissions at all.
  `harness/lib/github-setup.mjs` sends secret values to `gh` on stdin, never
  in argv; reports a blank key rather than uploading it; and reads the
  tickbox back after saving. `tests/lib/github-setup.test.mjs` drives it
  against a fake `gh`, including a save that does not stick (the first real
  install's failure), and runs the CLI with an empty `PATH` for the fallback.
  The response shapes were checked read-only against this repository. Not
  yet run end to end against a real repository's settings — that write is
  the first real install's to make.
- [ ] **D7 — One `doctor` command.** *Done when:* `harness/scripts/doctor.mjs`
  checks Node, env file present and git-ignored, keys working, GitHub secrets
  and permission (via `gh`), snapshot committed, adapter valid and harness
  current, and each failure prints the command that fixes it.
- [ ] **D8 — A README that starts with commands.** *Done when:* Getting
  Started is a short command list at the top, and the status tables, the
  bet, the layout tree and the design narrative live in `ARCHITECTURE.md` or
  `docs/`, linked rather than inline.
- [ ] **D10 — One-click console, and a template repository.** *Done when:*
  `console/` has a `Dockerfile` and a `.devcontainer`, and the README has a
  deploy button. The template repository itself is **owner** (it needs D3).
- [ ] **D1 — Run via `npx`.** *Done when:* `package.json` has a `bin` that
  copies `harness/` into the current project and runs `init`, `npm pack`
  contains exactly what an install needs, and a test runs the packed tarball.
  Publishing to npm is **owner**.
- [ ] **D3 — Public repository, shared install by default.** **Owner:** the
  repository is private until the owner says otherwise. *Done when:* it is
  public and `init` defaults to `--shared` at the current release.

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
- A test suite (`npm test` prints the count; it is not repeated here on purpose), including `tests/e2e/full-loop.test.mjs` driving the real chain
  against a real git remote and a real child-process test run.
- Pinned implement/review/rank seats get their lab's API key wired even when
  that lab is not in `providers.watched`.
