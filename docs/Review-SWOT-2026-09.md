# Review, SWOT, and proposed workplan additions — 2026-09-02

An outside read of the project as it stands on `main` at commit `186eac8`,
written to answer three questions: is the concept sound, where is it
strong and weak, and what would it take to run this as a product rather
than a research harness. Every claim about the code below was checked
against the code, with the file and line named, in the same spirit as
`Portable-Harness-Design.md` and `console/DESIGN.md`.

**Status of this document:** a review. Nothing in it is adopted until it
is moved into `WORKPLAN.md` as a ticked-or-unticked item. The "Proposed
additions" section at the end is written in the workplan's own *done
when* style so that moving an item across is a copy, not a rewrite.

---

## 1. What was reviewed, and how

- Every top-level document, `docs/curiosity/`, `learning/`, and
  `console/DESIGN.md`.
- `harness/lib/orchestrator.mjs`, `context-pack.mjs`, the workflow
  template, the brief template, `run-generation.mjs`, and greps across
  `harness/` for budget, usage, injection fencing, and the `UNKNOWN`
  field.
- `npm test`: 434 checks, all passing, on Linux, in 4 seconds.

Not done: no model call was made, and no target project was rehearsed.
The reference implementation (carrotgame) was read only through this
repository's account of it.

---

## 2. The concept

The harness bets that frontier labs keep shipping and that each new model
is worth asking. A release is the trigger; the newest model proposes one
change with fresh eyes; pinned models implement and review; the project's
own tests, a frozen-path guard, and a pull request stand between the
proposal and the default branch. Every run writes a record, and the next
run reads it. On top of that, a proposed curiosity pass asks not "what
should change" but "what does this repository not understand about
itself", because the observed failure was that models made small,
tactical, safe changes and never thought about how the project could run
differently.

**The concept is sound, and two parts of it are genuinely unusual.** The
release-driven clock (`learning/07-whats-actually-new.md` §4a) and the
cross-lab fan-out as a measured disagreement signal
(`docs/Curiosity-Engine-Design.md` §3.1) are both defensible claims that
do not obviously exist elsewhere. The governance story is more careful
than most of the self-improvement literature it cites: rules enforced
twice, a review that fails closed, an argue-but-never-edit channel, and a
default that opens a pull request rather than merging.

**One thing the concept should say more plainly.** The loop runs one
generation per cycle regardless of how many models were released. Eight
releases in a month means eight proposers and one implemented change. The
capability curve buys proposal *quality and diversity*, not *throughput*,
and cost scales with the number of proposers while output does not. That
is a fine trade; it is just not the trade a reader of "bets on the curve"
will assume.

---

## 3. Findings from the code

Numbered so the SWOT and the proposals can refer to them.

### F1. The tactical bias is built in, at four points

The user's observation, that models make small focused changes and do
not think creatively, is not only a model property. The harness pulls
toward small at every stage:

| Where | What it says | Effect |
|---|---|---|
| `harness/templates/agent-brief.md.tmpl:70-72` | "ONE focused improvement" and "a small number of localised edits ... Never a wholesale rewrite" are listed under **CONSTRAINTS — non-negotiable, and they never expire** | Contradicts the SCOPE section two headings below it and the ambitious scope text in `orchestrator.mjs:224-230`. A project that fills in the template as written has written "smaller is better" into the part that never expires, which principle 21 says not to do. |
| `harness/lib/orchestrator.mjs:393-401` | The ranking rubric: "genuinely implementable as a few localised edits", "Prefer a fix to something broken over an addition" | The ranker is scope-blind. In an ambitious generation it still selects the smallest, safest proposal from the fan-out. |
| `harness/lib/context-pack.mjs:659-684` | `recommendScope()`: ambitious headroom needs `required` consecutive first-attempt merges; any abandoned generation resets the streak | Ambitious work fails more often by nature, and an ambitious failure spends the next two generations rebuilding the streak. The gate uses the exact signal that ambition degrades, so the system dampens its own ambition. |
| `harness/lib/orchestrator.mjs:449-453` | "choose the smallest, most conservative reading" | Correct for an implementer, but it is the fourth conservative filter in a row. |

The curiosity design's answer to this, the spike (C5), sits behind
C1 → C3 → C4, and C3 sits behind the A′ go/no-go, which reads `UNKNOWN`
fields from themes reviews. **`UNKNOWN` is not built** (`grep UNKNOWN
harness/` returns nothing), so `WORKPLAN.md` 4.3 is not runnable as
written: phase A of C2 is an unstated prerequisite. At the reference
cadence of one generation per release cycle, two cadence boundaries after
that is on the order of twenty generations on one project.

### F2. Nothing counts cost

Every provider parses `usage` from the response (`providers/anthropic.mjs:59`,
`_openai-compatible.mjs:81`, `google.mjs:49`, `openai.mjs:51`) and the
orchestrator drops it. `attempts.json` records `contextSize` and no
tokens or spend. No adapter field caps a run. `learning/03-failure-modes.md`
Part 9 says so ("Nothing in the pipeline reads a budget") and advises a
cap at the provider. The paper's RQ6 and its "cost per accepted
improvement" metric cannot be answered from the record.

### F3. The judge shares a family with the implementer

`run-generation.mjs:118-119`: `rankModel` defaults to `implementModel`, and
both `reviewModel` and `implementModel` default to `claude-opus-5`.
`learning/07-whats-actually-new.md` §5 and §6 call ranking with a
different family "the most actionable finding from the whole review" and
"the highest remaining item". It is still open.

### F4. The human's decision on the pull request is discarded

`record-pull-request.mjs` writes the URL. Nothing reads back whether the
PR was merged, closed, or is still open. In the default merge model the
owner's merge-or-close decision is the best outcome signal the harness
has, and it feeds neither `landedCleanly()` nor the generation index nor
C9's "shipped?" label.

### F5. The generated workflow's supply chain is unpinned

`harness/templates/workflow.yml.tmpl:80` runs `npm install --no-save
js-yaml` at run time, unpinned, in a job that holds `contents: write`
(`scaffold.mjs:449-452`). `actions/checkout@v4` and `setup-node@v4` are
pinned by tag, not SHA. `learning/03-failure-modes.md` Part 9 names this
exact risk for the reference implementation. A harness whose pitch is
"governed" should not ship it.

### F6. Bookkeeping commits push straight to the default branch

The model snapshot (`workflow.yml.tmpl:103-110`) and runtime evidence
(`:280-292`) are pushed directly to the default branch. A cautious
installer who enables branch protection, which `console/DESIGN.md`
recommends, breaks the harness's own record-keeping on the first run.

### F7. Source is sent unfenced

Principle 19 ("anything a stranger typed is data") is applied to player
feedback. The source bundle, which is every file in `allowed_paths`, and
the architecture notes are sent as-is. On a repository with outside
contributors, a code comment is an instruction channel into a pipeline
that ends in a pull request. The PR default is the backstop; there is no
first line.

### F8. Three hand-typed test counts, three different numbers

`README.md:314` says 258, `WORKPLAN.md:363` says 302, `npm test` runs 434.
Principle 23 ("generate the record; never hand-maintain it") applied to
the harness's own docs. Small, but it is the failure mode the project
writes about most.

### F9. No licence, no version, no upgrade path

`CONTRIBUTING.md` names the missing `LICENSE` as undecided. Install is
"copy one folder"; nothing records which harness commit a project
vendored, so there is no way to tell an installer their copy has a fix
they need. For a product, these block adoption before anything technical
does.

### F10. No kill switch, no rollback script

The paper's §9 controls list both. Today, stopping an unattended loop
means editing YAML, and undoing a shipped generation means knowing that
`promote.mjs` tagged it and running `git revert` by hand. The digest does
not tell the owner either of those things.

### F11. Everything rests on one project

carrotgame is the only installation that has ever made a real model call
through this loop. The harness's own tests fake every model call, by
design. Tier 2.1 (a second project) is correctly the top item in the
workplan; until it happens, "portable" and "the bet pays" are both n=1.

---

## 4. SWOT

### Strengths

- **The loop is real.** Suggest → implement → review → refine → guard →
  test → PR/promote → verify → notify runs end to end, with an e2e test
  against a real git remote and a real child-process test run. 434
  checks, zero runtime dependencies outside two files.
- **Governance is the best part of the design.** Allowlist enforced
  twice, review fails closed, pull request by default with autonomous
  merge as opt-in, an escalation ledger that lets a model argue with a
  rule it cannot edit, and a "never claim data you did not supply" rule
  that is enforced by byte-identity tests rather than intention.
- **Incident-derived principles.** `learning/` is 23 principles each
  anchored to something that actually broke. That corpus is portable,
  rare, and a product asset in its own right.
- **Two defensible novelties** (§2): the release-driven clock, and
  cross-lab disagreement as a measured uncertainty signal.
- **An honest documentation culture.** LIVE/RESERVED/PROPOSED marking,
  *done when* lines, dashed boxes for the unbuilt. The docs mostly tell
  the truth about the code, which is unusual.

### Weaknesses

- **n=1** (F11). Portability, the value of the bet, and the curiosity
  gate all wait on evidence one project cannot produce quickly.
- **The tactical bias is structural** (F1), and the proposed cure is the
  slowest part of the roadmap.
- **No cost accounting** (F2), so the economics of the bet are unknown
  and a busy release month is an unbounded bill.
- **Same-family judge** (F3), a known bias the project itself documented
  and has not fixed.
- **No outcome signal after the gate** (F4). The loop is, by its own
  account, "a loop rather than a search": nothing selects on a score, and
  the free human label on every PR is thrown away.
- **Not yet adoptable** (F5, F6, F7, F9, F10): licence, version, upgrade,
  supply-chain pinning, branch-protection compatibility, injection
  fencing, kill switch, rollback.
- **The plan has a sequencing hole** (F1, last paragraph): 4.3 depends on
  an unbuilt field.
- **Status lives in three hand-synced places** and has already drifted
  (F8).

### Opportunities

- **Release cadence is rising**, by the README's own data. More
  proposers per run, at no design cost.
- **carrotgame's 18+ generations are an unused dataset.** A retrospective
  A′ can be run on them now: generate themes reviews with `UNKNOWN` over
  historical windows, then check uptake against the generations that
  followed. That collapses the curiosity gate's horizon from years to
  days.
- **The PR default makes every generation a labelled example.** Merged,
  closed, reverted: read it back and the harness has its first outcome
  label without a single new prompt.
- **Extend the bet to every seat.** The implement and review seats are
  pinned to a model that will age. A rotating model whose self-written
  edits keep being approved has earned a promotion; the harness already
  records exactly that (`selfImplemented`, `implementedBy`).
- **Three design-partner installs** on deliberately different repos
  (the paper's own RQ5 says three) would turn portability into evidence
  and produce the demand signal the console needs before it is built.
- **Distribution as a GitHub Action or `npx` package** replaces "copy a
  folder" and gives the upgrade path for free.
- **Publishable result.** The paper outline plus a second repository and
  the metrics in its §7 is a paper; the harness-engineering literature
  cited in `learning/07` is currently benchmark-graded, and a live-product,
  cross-lab, longitudinal dataset is a gap in it.

### Threats

- **The bet fails quietly.** The detector fires on novelty of a model id,
  not on capability. A lab shipping `mini`, `nano`, dated snapshots or a
  sidegrade triggers a full generation and nothing measures whether the
  new model was better than the last. If labs slow down, the loop simply
  stops, which is correct, but a product needs to say so to its owner.
- **Cost is a function of other people's release schedules** (F2), with
  no cap in the harness.
- **Interactive coding agents.** Claude Code, Codex and their peers will
  "improve my repo" on demand. Positioned carelessly, this harness looks
  like a slower Claude Code. Its real differentiator is *unattended and
  governed*, and every product decision should protect that.
- **Provider drift.** Six of nine labs share a dialect by convention, not
  contract. Contained per call, but a run's fan-out shrinks silently
  when a lab moves.
- **Credential blast radius** (F5, F6): one job holds every lab key and a
  write token.
- **Bus factor of one**, with load-bearing documentation.
- **Curiosity theatre** (the design's own §7.2) if the A′ gate is skipped
  under pressure to show the feature working.

---

## 5. The tactical-change problem, restated

Two separate things are true and should be kept apart:

1. **The harness is currently tuned to produce tactical changes** (F1).
   That is fixable in days, in three files, and the fixes are additive:
   move two lines in the brief template, give the ranker the scope, stop
   an ambitious failure resetting the streak. These should happen before
   any curiosity component is built, because otherwise the spike's
   findings will feed a ranker that still prefers the smallest diff.
2. **Even a well-tuned loop is not a search.** Nothing selects on a
   score, and N−1 proposals are discarded. The curiosity design is honest
   about this (§7.3). The cheapest step toward selection is not the
   curiosity ledger; it is reading the pull-request outcome back (F4) and
   keeping the losing proposals' text so a later pass can compare them.

The curiosity loop remains the right long-term answer to "how could this
project run differently", because it is the only mechanism that carries
a *question* across a model rotation rather than a hint. It should be
built in the order its own design specifies, gated by A′, but with A′
run on carrotgame's existing history rather than waiting for a fresh
project to accumulate twenty generations.

---

## 6. Proposed workplan additions

Written in the workplan's format. Tier numbering continues from the
existing file; items marked **(amend)** change an existing item.

### Tier 0 — make it adoptable (each under a day)

- [ ] **0.1 — Add a `LICENSE`.** Blocks every other form of adoption.
  *Done when:* the file exists and `README.md` names the licence in its
  first screen.
- [ ] **0.2 — Version the harness, and record which version an install
  carries.** `harness/VERSION` (or `package.json` `version`, bumped on
  every change to `harness/`), written by `init` into
  `project-adapter.yml` as `harness.version` and by
  `writeAttemptRecord()` into every `attempts.json`.
  *Done when:* a vendored copy can say which upstream commit it came
  from, and an `init --check-upgrade` reports whether upstream is newer.
- [ ] **0.3 — Pin the generated workflow's supply chain.** `npm install
  --no-save --ignore-scripts js-yaml@<exact>` in
  `harness/templates/workflow.yml.tmpl`; actions pinned by SHA with the
  tag in a comment. (F5)
  *Done when:* `tests/lib/scaffold.test.mjs` asserts the exact version and
  the SHA form.
- [ ] **0.4 — A kill switch a non-technical owner can flip.** First step
  of the generated workflow reads a repository variable
  (`SELF_IMPROVE_PAUSED`); when set, the run spends nothing and the
  digest says "paused by you". (F10)
  *Done when:* the e2e test proves a paused run makes zero model calls
  and still notifies.
- [ ] **0.5 — Stop hand-typing the test count.** Either a test asserts
  the number in `README.md` and `WORKPLAN.md`, or the sentences say
  "run `npm test`" and carry no number. (F8)
  *Done when:* `grep -n "checks as of\|[0-9]* tests" README.md WORKPLAN.md`
  returns nothing, or returns numbers a test pins.

### Tier 2 amendments — evidence, faster

- [ ] **2.1a (amend 2.1) — Three design-partner installs, not one.** One
  Python CLI (no visual surface, `verify_strategy: none`), one TypeScript
  service with more than 100 source files (forces `context.strategy:
  scoped`), one published library (`verify_strategy: registry`). The
  paper's RQ5 says three; the console needs the demand signal; and one
  project cannot separate "the harness is portable" from "this project
  was easy".
  *Done when:* three rehearsal reports exist, each naming what broke.
- [ ] **2.5 — Campaign mode, for accumulating evidence on purpose.**
  `cadence.trigger: campaign` runs a generation on demand against a
  chosen model list and stamps `campaign: true` into the record, so
  release-driven history stays distinguishable. Principle 1 is about the
  *product* loop; evaluating the harness needs a faster clock, and the
  twenty generations that 4.3 needs are two years at release cadence.
  *Done when:* `run-generation.mjs` accepts it, the index renders the
  stamp, and a design-partner repo has run ten campaign generations.

### Tier 4 amendments — close the sequencing hole

- [ ] **4.0 (insert before 4.3) — Build phase A: the `UNKNOWN` field.**
  `generate-themes.mjs` prompt and parser, `themes.mjs` brief, one
  `section()` in the orchestrator, with the byte-identity test. 4.3
  cannot run without it and the plan does not say so. (F1)
  *Done when:* a themes review carries `UNKNOWN` fields and 4.5's
  byte-identity test still passes with none.
- [ ] **4.3a (amend 4.3) — Run A′ retrospectively on carrotgame.**
  Generate themes reviews over carrotgame's existing generations in
  windows of ten, then run `check-question-uptake.mjs` against the
  generations that followed each window. This is the go/no-go, available
  now, on real history.
  *Done when:* the table in C9 §"Phase A′" has been printed for
  carrotgame and the verdict is recorded in `docs/curiosity/README.md`.
- [ ] **4.6 — C1, the committed goal.** The curiosity design calls it
  phase −1 and a prerequisite for C4, C5 and C9; it is absent from the
  plan. Build it, and decide the question C1 leaves open (goal versus
  consensus) before the first conflict rather than at it.
  *Done when:* `goalConfig()` exists, the reviewer judges against it, the
  guard refuses a diff that edits it, and the decision is written in C1.

### Tier 5 — operationalise

- [ ] **5.1 — Cost accounting and a budget cap.** Record `usage` from
  every call into `attempts.json` (`spend: {calls, inputTokens,
  outputTokens, byModel}`); adapter `budget.max_suggest_models` and
  `budget.max_generation_tokens`; the run stops before the fan-out when
  exceeded and the no-generation digest says why. (F2)
  *Done when:* every new `attempts.json` carries tokens, the e2e test
  proves the cap aborts, and `report.mjs` (5.8) prints cost per accepted
  improvement.
- [ ] **5.2 — A judge from a different family, by default.** `rankModel`
  and `reviewModel` default to a lab other than `implementModel`'s when a
  key for one is present; `init` warns when all three seats are one
  family. (F3)
  *Done when:* the scaffold test asserts the default, and
  `run-generation.mjs` logs the family split on every run.
- [ ] **5.3 — Read the pull request's fate back.** A
  `sync-pull-request-outcomes.mjs` step at the top of every run: for each
  `attempts.json` with a `pullRequestUrl` and no `pullRequest.state`, ask
  GitHub (job token, `gh`), write back `{state, mergedAt, closedAt}`.
  `landedCleanly()` and the generation index read it, so a closed
  unmerged PR reaches the next prompt as "rejected by the owner". (F4)
  *Done when:* the e2e test closes a PR without merging and the next
  generation's history section says so.
- [ ] **5.4 — A human verdict on shipped changes.** One label set on the
  PR (`gen:good`, `gen:regret`) or a reply keyword to the digest, read by
  5.3 into `attempts.json` as `humanVerdict`. This is the paper's
  "promotion precision", and the first outcome label that is not the
  harness grading itself.
  *Done when:* a verdict appears in the record and the digest reports the
  running precision.
- [ ] **5.5 — Scope-aware ranking, and fix the brief template.** The
  ranking rubric takes the run's scope; in ambitious mode it prefers the
  proposal that most changes how the project works at acceptable
  reversibility, and says so. Move `agent-brief.md.tmpl:70-72` out of
  CONSTRAINTS into SCOPE. (F1)
  *Done when:* the focused rank prompt is byte-identical to today's and a
  test proves the ambitious one differs.
- [ ] **5.6 — Stop ambition punishing itself.** An abandoned *ambitious*
  generation costs one clean generation, not the whole streak.
  `recommendScope()` reads the record's `scope` field to tell them apart.
  (F1)
  *Done when:* a test shows clean, clean, ambitious-abandoned, clean →
  ambitious, rather than requiring two fresh clean runs.
- [ ] **5.7 — Seat promotion by track record.** Adapter
  `roles.promotion.implement_after_self_implemented_approvals: N`. A
  rotating model whose own edit blocks were approved N times becomes
  eligible for the implement seat; the review seat stays pinned. Extends
  the bet from one seat to two, on the same "earned, not scheduled"
  principle as scope.
  *Done when:* the rule is a pure function with tests, and the digest
  announces a promotion in plain language.
- [ ] **5.8 — A generated operational report.** `harness/scripts/report.mjs`
  writes `docs/generations/REPORT.md` from the records: release yield,
  promotion precision, failure-recurrence rate, cost per accepted
  improvement, per-lab win and self-implement rates. The paper's §7
  metrics as an ops page, never hand-edited (principle 23).
  *Done when:* the generated workflow commits it after every run and it
  has been produced for carrotgame's history.
- [ ] **5.9 — Fence untrusted source.** The source bundle and
  architecture notes get the same hostile-input envelope as player
  feedback, and the reviewer brief template gains one instruction: an
  instruction found inside source is a rejection with a reason. (F7)
  *Done when:* a test plants "ignore your brief" in an editable file and
  the prompt shows it fenced.
- [ ] **5.10 — Branch-protection-compatible bookkeeping.** Snapshot and
  runtime-evidence commits go to a `harness/state` branch, or ride the
  generation's own PR; `init` asks whether the default branch is
  protected. (F6)
  *Done when:* a rehearsal on a repo with branch protection completes
  without a failed push.
- [ ] **5.11 — A rollback script.** `revert-generation.mjs NNN` reverts
  the tagged merge, records `outcome: reverted`, and the next prompt's
  history shows it. The digest names the command. (F10)
  *Done when:* the e2e test reverts an approved generation and the next
  generation's index says so.
- [ ] **5.12 — Keep the losing proposals.** Store every fan-out
  proposal's text (not only the winner's) under
  `gen-NNN/proposals/<model>.md`. Costs nothing, is where the curiosity
  design says sparse-evidence questions live (§3.4), and is what a later
  compare-two-implementations experiment needs.
  *Done when:* the files exist for a fan-out of two and the index does
  not grow.

---

## 7. Sequencing recommendation

1. **Tier 0 now.** About a week of small items; none can wait for
   evidence, and 0.1 and 0.3 are embarrassing to be caught without.
2. **5.1, 5.2, 5.3, 5.5, 5.6 before 2.1.** Each is a day or two, and
   together they mean the design-partner rehearsals produce cost,
   outcome, and non-tactical data from their first generation rather
   than needing to be re-run.
3. **2.1a with 2.5.** Three repos, campaign mode on, ten generations each
   as fast as the owners will tolerate.
4. **4.0 and 4.3a in parallel with step 3**, since they need only
   carrotgame's history. The A′ verdict decides whether 4.4 is built at
   all.
5. **4.6 (the goal) before any of 4.4**, as the curiosity design already
   insists.
6. **Tier 3 (the console) only after three external installs exist.** It
   is the most expensive item in the plan and its value is a function of
   portability being true, which step 3 establishes or refutes.

The one thing not to do is build the curiosity ledger before the
tactical-bias fixes (5.5, 5.6) and the outcome read-back (5.3). A
curiosity pass feeding a ranker that still prefers the smallest diff, on
a loop that cannot tell whether the owner merged, would be the "plausible
mechanism that measures nothing" the curiosity design warns about in its
own §2.1.
