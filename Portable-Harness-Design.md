# Portable Harness — Design Document

**Status:** planning only. Nothing described here has been moved or built yet.
This document exists to get agreement on *what* moves from `carrotgame`,
*how* it gets genericised, and *what* the new repo's own README should promise
a user, before any file crosses over.

**Scope note, added once other work landed alongside this one:** everything
below tracks the harness port specifically — the ten-component kernel and
its build order. It predates, and still says nothing about, `console/` (a
proposed browser-based install flow — [`console/DESIGN.md`](console/DESIGN.md))
or `docs/curiosity/` (a proposed second longitudinal pass —
[`docs/Curiosity-Engine-Design.md`](docs/Curiosity-Engine-Design.md)). Both
are real, separate streams of design work that build on top of what this
document tracks; see [`README.md`](README.md)'s "How the three pieces fit
together" for how all three relate.

## 1. What we're building

A standalone scaffold — call it `self-improve` for now — that a user can point
at *any* software project and get back a working, governed
suggest→implement→review→gate→promote loop wired to their own repo: their own
test commands, their own editable-file allowlist, their own choice of which
labs' newest models get the rotating "suggest" seat.

The operative UX is one command:

```bash
npx self-improve init
```

run from inside the target project. It asks a short set of questions (§6),
writes a project-adapter file plus a populated `.github/workflows/` job,
`.claude/agents/` (or equivalent) briefs, and a guard script — then leaves a
`README.md` in the target project explaining exactly what was installed, what
secrets it needs, and how to run the first rehearsal generation. The user
should be able to go from "I have a repo with a test suite" to "I have a
scheduled, gated, autonomous improvement loop" without reading source.

`carrotgame` is the one existing installation. It is simultaneously the
**reference implementation** (working code, 18+ real generations, real
incidents) and the thing the scaffold must be generic enough to no longer be
tied to. Everything below is organised around that split.

## 2. The paper already named the target shape

`Model-Release-Driven-Software-Improvement-Paper-Outline.md` (this repo)
independently arrived at a ten-component "improvement kernel" (§3) and a
project-adapter YAML (§5) before this document existed. That's not a
coincidence to smooth over — it means the academic framing and the working
code can be cross-checked against each other, and §7 below does exactly that,
component by component. Where the paper's component has no concrete
counterpart yet (independent multi-provider ranking, shadow/canary staging),
that gap is real and should stay visible rather than be papered over by this
doc.

## 3. What already exists in carrotgame, in three buckets

### Bucket A — already generic, written to be lifted

`carrotgame/learning/` is the surprise asset here: it was already written
"to be lifted and used somewhere else" (its own README's words) and its
authors state nothing in it depends on games, HTML, or the repository. Read
against that claim rather than taking it on faith — it holds up:

| File | Lines (approx) | Content | Verdict |
|---|---|---|---|
| `learning/README.md` | 116 | Framing: harness/loop/self-improvement vocabulary, "10 things if you read nothing else" | Port as-is, becomes this project's own conceptual intro |
| `learning/01-principles.md` | ~700 | 23 principles (+ sub-principles), each anchored to a real incident | Port as-is; incidents stay as *examples*, principles are already domain-neutral |
| `learning/02-blueprint.md` | ~300 | The 14 parts of one lap, build order, a "smallest useful version" | Port as-is — this is close to the harness's own architecture spec |
| `learning/03-failure-modes.md` | ~450 | 9 parts, every silently-broken gate/prompt/config found so far | Port as-is; this is the incident log the paper's §8 failure taxonomy should cite |
| `learning/04-context-recipe.md` | ~230 | What to send the model and why, a checklist | Port as-is |
| `learning/05-guardrails-and-trust.md` | ~200 | Layers, freeze list, escape valve, fail-closed vs fail-safe | Port as-is |
| `learning/06-starter-kit.md` | 372 | **Copy-paste templates**: agent brief, suggester output contract, edit format, reviewer brief, guard config, launch checklist, non-code adaptation table | This is the seed for the `init` command's template files — see §6 |
| `learning/07-whats-actually-new.md` | ~260 | Honest literature placement: what's mainstream, what's behind the frontier, what's genuinely unusual | Port as-is; directly usable as paper §2.6 source material |
| `learning/blog-post.md` | ~190 | Public-facing narrative version | Port, optional |
| `learning/diagrams/*.mmd` + `README.md` | — | `generic-loop.mmd`, `generic-guardrails.mmd`, `generic-context.mmd` (abstract patterns) plus `worked-example-*.mmd` (carrotgame's concrete instance) | The generic three port as the harness's own diagrams; the worked-example pair stays as *the* example, clearly labelled as one instantiation, not the harness itself |

This bucket needs essentially no rewriting — mostly file moves, a pass to
strip the few remaining "Mason the Carrot" asides, and reattachment to
`self_optimisation`'s own README hierarchy.

### Bucket B — generic pattern, project-specific values (the reference implementation)

`carrotgame/scripts/` + `scripts/lib/` (8,887 lines total). This is real,
battle-tested code, but every file mixes a portable mechanism with
carrotgame-specific literals. The genericisation work is per-file, not
uniform:

| File | Lines | Kernel role (see §7) | What's generic | What's carrotgame-specific and must become config |
|---|---|---|---|---|
| `scripts/lib/llm-provider.mjs` | 561 | Provider/model router | The `callModel()` / `callModelWithHeadroom()` contract, the truncation-retry mechanism, the "throw on unrecognised id" posture | ✅ **Ported** — `harness/lib/llm-provider.mjs` (provider-blind core, zero hardcoded labs) + `harness/providers/*.mjs` (all 9 labs, each a self-registering file, smoke-tested against real model ids from the generation log). Shipped all 9 rather than a 3-lab default subset — they're free as separate files, and the per-lab quirks (GLM's forced `reasoning_effort`, the DashScope/Zhipu id collision, OpenAI's legacy-field retry) are hard-won and expensive to rediscover. See `harness/providers/CONTRIBUTING-A-PROVIDER.md`. |
| `scripts/check-model-releases.mjs` | 340 | Model-release detector | Snapshot-diff logic, "unknown never means no release" posture | ✅ **Ported** — `harness/lib/model-release-detector.mjs` (pure: no fs/env/console) + `harness/scripts/check-model-releases.mjs` (CLI, owns the snapshot file and env). The per-lab catalogue config (URL, parser) moved onto each provider's `registerProvider()` call as `listModels`, alongside its call-time config — see `getProvider()` in `llm-provider.mjs` for why that avoided reopening the "three parallel literals" bug `edit-format.mjs`'s own history warns about. `isChatModel()`'s keyword filter is now applied centrally after each provider's own `parseModels`, rather than repeated inside all nine. 61-check smoke test covers every provider's real catalogue-response shape, the ranking tie-break, the all-keys-missing skip path, and snapshot preservation on a failed check. **Amended after the reference implementation lost a cycle to a defect this port had faithfully inherited** (see the revision log's last entry): the snapshot diff compared raw id strings, so a reseller re-listing an already-merged model under a vendor prefix counted as a new release. `harness/lib/model-aliases.mjs` now canonicalises a single `vendor/` prefix on both sides of the comparison, `harness/lib/unfixable-models.mjs` adds the `_unfixable` snapshot key so a diagnosed-permanent block stops being retried every cycle, and `releaseDetected` is emitted separately from `hasNewReleases` so a probe that drops every candidate cannot be mistaken for a quiet cycle. `checkReleases()` also gained an injectable `fetchModelsImpl`, matching `probe-models.mjs`'s injectable prober, because the candidate-filtering logic is where the interesting bugs live and it was previously unreachable in a test without a real network call. |
| `scripts/probe-models.mjs` + `lib/probe-models.mjs` | 82 + 119 | Reachability check (feeds the detector) | The "send the real call shape, drop what 404s" method, `checkContextFit()` | ✅ **Ported** — `harness/lib/probe-models.mjs` (verbatim; it was already fully generic) + `harness/scripts/probe-models.mjs`. One deliberate gap: the reference CLI hard-imports `estimateContextSize()` from `context-pack.mjs`, which isn't ported yet (§7's still-open row below). The harness CLI takes an optional `--estimated-tokens`/`CONTEXT_ESTIMATE_TOKENS` instead and skips the context-fit check when it's absent — the same conservative default `checkContextFit()` already applies to any provider that reports no window at all, so this isn't a capability loss, just an honest placeholder until context-pack ships. |
| `scripts/lib/context-pack.mjs` | 819 | Context compiler | `buildGenerationIndex()` (full history, one line each), `buildGenerationHistory()` (recent-detail window), `recommendScope()`, `estimateContextSize()` | ✅ **Ported (7 of 9 functions)** — `harness/lib/context-pack.mjs`: `buildSourceBundle`, `buildArchitectureNotes` (doc path + append-only marker now parameters, not `SELF-IMPROVEMENT.md` hardcoded), `buildGenerationIndex`, `buildGenerationHistory`, `buildTestIndex` (name extraction now pluggable — ships a `test`/`it`/`describe` default matching Node's own built-in runner, Jest, Mocha and Jasmine, plus the reference implementation's own `check(name, …)` extractor kept as a named export), `buildRepoManifest` (the `PURPOSES` map becomes a caller-supplied parameter — always project-specific, never was going to be otherwise), `recommendScope`. `estimateContextSize()` was redesigned rather than ported: the original called every builder itself; the port takes pre-built `{blocks}` text and an image count, because the builders now have genuinely different configuration needs (a generations dir, a test-file list, a purposes map) that one shared call signature would have had to hide or reinvent. **Not ported**, and marked as such rather than faked: `collectScreenshots()` and `buildScorecardBrief()` stay project-specific plugins (see the visual-canvas plugin entry below); `buildPlatformNotes()` isn't a function to port at all — it's a paragraph of prose, now plain adapter config (`context.platform_notes`). 23 tests, including one that pins down a real footgun in the ported arithmetic: `limit: 0` on `buildGenerationHistory` must return nothing, not everything — `.slice(-0)` in JS is `.slice(0)`, the whole array, unless explicitly guarded against. |
| `scripts/lib/edit-format.mjs` | 324 | Bounded patch executor | The whole SEARCH/REPLACE parser, exactly-once matching, all-or-nothing apply, CREATE-only-for-new-paths | ✅ **Ported** — `harness/lib/edit-format.mjs`. `EDITABLE_FILES` became `compileAllowlist({allowedPaths, createOnlyPaths})`, fed from the adapter (`constitution.allowed_paths` / `create_only_paths`, glob strings via the new `harness/lib/glob.mjs`) instead of a module constant. `EDIT_FORMAT_SPEC` became `buildEditFormatSpec()`, templated on an optional extra metadata field (carrotgame's `PILLAR`) and an optional CREATE section, so a project with no pillar taxonomy isn't forced to have one. 28-check smoke test covers allowlist edge cases, all-or-nothing failure, non-unique-SEARCH rejection, and create-at-existing-path rejection. |
| `scripts/invoke-self-improvement-agent.mjs` | 1,450 | Orchestrates suggest→implement→review→refine (the paper's whole §4 lifecycle in one file, because Actions can't loop jobs) | The 4-stage state machine, the fan-out/rank-with-authors-withheld pattern, the refine-loop-with-pristine-reset | ✅ **Ported** — `harness/lib/orchestrator.mjs` + `harness/scripts/run-generation.mjs`. The real design decision: **the harness owns mechanism, the project owns content.** The reference implementation's system prompts are carrotgame's own words as JS template literals, redeclared separately from (and duplicating) `.claude/agents/self-improvement.md`. The port instead makes the project's filled-in `agent-brief.md` the suggestion stage's system prompt *in full*, with only the genuinely mechanical, same-shape-for-any-project pieces added on top (current scope text, the edit-format contract). 34 tests, including the hardest one to get right: a crash after proposals exist still writes a real `attempts.json` before re-throwing, verified against an actually-thrown error. Verified end-to-end against a real temp project (real adapter, real briefs, no API key) producing a correctly-shaped `no-proposal` record. |
| `scripts/invoke-code-review.mjs` | 237 | Independent reviewer | Fresh-context call, fail-closed parse | ✅ **Ported** — `harness/lib/review.mjs`. Same split: the project's filled-in `reviewer-brief.md` is the entire system prompt. Visual capture is an injectable `captureVisual` hook defaulting to "not configured" rather than a dependency — carrotgame's visual-check.mjs stays the one worked example, not the default. 8 tests, including the fail-closed guarantee. |
| `scripts/lib/visual-check.mjs` | 313 | Evaluator (visual dimension) | The render-then-attach-to-review-call pattern, best-effort-not-exception posture | Renders *this* project's two games at a phone viewport — becomes optional, only relevant to projects with a visual surface; needs a pluggable "how do I render this project" hook |
| `scripts/lib/wordless-play.mjs` | 759 | Evaluator (accessibility dimension) | Instrumented-draw-call method for telling symbol from word | Extremely game-specific (canvas instrumentation) — **do not port as a default**, keep as a worked example of "a fitness function that measures the real artefact, not a proxy of it" |
| `scripts/readiness-scorecard.mjs` | 463 | Evaluator (aggregate, non-gating) | The "measured, never gates" posture, retired-dimension handling | The six dimensions themselves are carrotgame's (hospital wifi, WCAG, touch targets) — becomes an adapter-defined metric list |
| `scripts/check-guarded-paths.mjs` | 118 | Guard / bounded authority | FROZEN / APPEND_ONLY / FROZEN_FIELDS / churn-ceiling mechanism | ✅ **Ported** — `harness/lib/guard.mjs` (pure, git runner injectable for tests) + `harness/scripts/check-guarded-paths.mjs`. Rules come from `constitution.frozen_paths`/`append_only_paths`/`frozen_fields`/`churn_ceiling` in `project-adapter.yml`, glob strings converted via the existing `glob.mjs`. 10 tests: 8 unit (fake git, every rule kind) + 2 against a real temporary git repository, proving the assumed `git diff --name-status --find-renames`/`--shortstat` output shapes are what real git actually produces rather than what the reference implementation's code merely assumed. |
| `scripts/lib/escalations.mjs` | 419 | Failure & proposal memory (the "argue without editing" channel) | The whole ledger + consensus-bar (3 models / 2 labs) + email mechanism | ✅ **Ported** — `harness/lib/escalations.mjs`, nearly verbatim; this file was already fully generic. `LEDGER_PATH`/`CONSENSUS` became overridable options rather than module constants; `renderForEmail` renamed `renderForNotification` since the harness's notifier is channel-agnostic by design (email/Slack/webhook). 15 tests, including the specific behaviors worth locking down: distinct-model-not-raw-count consensus counting, a second model raising the *same* title backing rather than duplicating, flagging exactly once (a 4th supporter after the bar is cleared must not re-flag), and support/dissent against an already-resolved entry being ignored. No CLI wrapper yet — its only real caller is an orchestrator that doesn't exist. |
| `scripts/build-generations-table.mjs` | 292 | Reporting / record generation | "Generate the record, never hand-maintain it" — table built from `docs/generations/` + ledger | Output format (the HTML deck) — keep as an optional renderer, not a requirement |
| `scripts/verify-production.mjs` | 157 | Staging & promotion — the live check | "Every other gate tests a branch; this one tests what a user opens" | ✅ **Ported (the `url` strategy)** — `harness/lib/verify-deployment.mjs` + `harness/scripts/verify-deployment.mjs`, dispatching on the adapter's `deployment.verify_strategy`. The HTML-canonicalisation trick (compare `<script>` contents and visible text, since hosts commonly rewrite markup on the way out) is genuinely generic, not carrotgame-specific, and ported verbatim. `registry`/`artifact` strategies were named in the schema but not implemented at the time this row was written — both have since shipped (see the revision log's third entry below), bringing this file's own suite to 37 tests. 14 tests at the time, including a fake-clock pattern (advance time inside the injected `sleep`) that exercises the full poll-until-timeout loop without a single real millisecond of waiting. Alongside it, `harness/lib/promote.mjs` (merge + tag + push, plus branch cleanup) — never its own file in the reference implementation, which does this as inline bash in the workflow's merge job; made into real code for the same reason `guard.mjs` is real code rather than trusted-by-inspection bash. 6 tests against a **real two-repo setup** (a genuine bare "origin" plus a working clone, not simulated), including one that provokes an actual git merge conflict and confirms it throws rather than landing something broken. |
| `scripts/send-digest-email.mjs`, `send-escalation-email.mjs`, `lib/format-digest.mjs` | 247+128+77 | Reporting | Plain-language-via-LLM digest pattern, best-effort-with-reliable-floor posture | ✅ **Ported** — `harness/lib/notify.mjs` (`buildGenerationDigestEmail()`, `buildEscalationNoticeEmail()`, both plain-language-with-a-reliable-terse-fallback) + `harness/scripts/send-digest.mjs` / `send-escalation-notice.mjs` (CLI wrappers). The reference implementation hardcodes SendGrid directly inside the email-writing code; the port separates the two completely — a `registerSender(name, send)`/`getSender(name)` registry (mirroring `llm-provider.mjs`'s own `registerProvider()` pattern) means nothing above the registry ever imports `fetch` or knows SendGrid exists. `sendViaSendGrid` ships as the one built-in sender; a project adds Slack/a webhook/another email API by registering its own under its own name and pointing `notify.provider` at it in `project-adapter.yml` — no harness code changes. Two computed-not-guessed facts carried over unchanged from the reference implementation, because they exist to prevent a real incident it had: `gatesBlock()` and `blockedByLine()` compute "what actually blocked the merge" from real gate results in code and hand it to the model as a stated fact, never leaving it to infer — a real run once had an automated allowlist check fail while the AI review had genuinely APPROVED, and a digest-writing model invented "the reviewer said no" despite the true verdict being right there in its prompt. `calibrationExamples` (real, well-received email bodies from a project's own history, quoted into the system prompt to calibrate register) is optional config (`notify.calibration_examples`, a list of file paths) rather than the reference implementation's two examples hardcoded as JS string literals — a fresh project with no history yet still gets a working prompt from the rules alone. 23 tests, including the registry (`getSender('sendgrid') === sendViaSendGrid`, a project registering and immediately resolving its own sender), the fallback triggering on a thrown error / truncated response / unparseable response, and `blockedByLine()`'s five scenarios (merged, a failing gate with its own note, a failing gate with none, nothing failed but it still didn't merge, a skipped gate correctly not treated as a blocker).. **Amended for the same reason as the detector row above:** the generated workflow gated its digest step on a generation number existing, which made every no-generation outcome unreportable — a crashed release check, a lab shipping something nothing could reach, and a failed preflight all sent no email at all. `buildNoGenerationEmail()` and `NO_GENERATION_REASONS` now cover the four cases distinctly, `send-digest.mjs` sends one of them when `GEN_NUMBER` is absent instead of exiting, and the scaffolded step runs on `if: always()` with `CHECK_RESULT`/`PREFLIGHT_RESULT`/`RELEASE_DETECTED` passed in. |
| `scripts/lib/gh-output.mjs` | 30 | Plumbing | GitHub Actions `$GITHUB_OUTPUT` writer | GitHub Actions–specific; other CI targets (GitLab CI, Buildkite) need their own thin equivalent behind the same call sites |
| `scripts/lib/themes.mjs`, `generate-themes.mjs`, `generate-themes-review.mjs` | 84+84+89 | Longitudinal learning (the every-10th-generation abstraction step) | Entire mechanism — reads history, asks a pinned model for "what we noticed → what it means", feeds back into next context pack | ✅ **Ported (lib only)** — `harness/lib/themes.mjs` (read side, nearly verbatim) and `harness/lib/generate-themes.mjs` (prompt + response parser). One genuinely carrotgame-specific string found and fixed: the system prompt named "two children's browser games" directly; `buildThemesSystemPrompt()` now takes a `projectDescription` parameter instead. `generate-themes-review.mjs` (the CLI that actually calls a model) was held back until `run-generation.mjs` produced real `docs/generations/gen-NNN/` records to read — building a CLI around data nothing yet produces would be exactly the kind of fiction §8.4 and `ARCHITECTURE.md` argue against — and is **now ported**, as the write side: it decides whether a run is a cadence boundary (`isThemesReviewDue()`, pure), assembles the window with the same `buildGenerationHistory()` the suggestion stage uses, calls one model, fails closed on an unparseable response, and writes `<themesDir>/review-NNN.json`. This is what finally reads `memory.themes_review.cadence_generations`. 37 tests (8 in `themes.test.mjs`, 22 in `generate-themes.test.mjs`, 7 driving the CLI as a real child process). |

**Not portable, reference-only:** `scripts/lib/player-feedback.mjs` (Supabase
rating widget — a worked example of "only include real signal, omit the
section rather than fake it when unconfigured," not a component to ship),
`scripts/trial-kimi-agent.mjs` (one-off rehearsal script), `scripts/check-repo-consistency.mjs`
and `scripts/render-diagrams.mjs` (carrotgame's own docs-consistency tooling,
useful as an *example* of "generate the record" rather than a harness
component).

### Bucket C — not portable, stays behind in carrotgame

The games themselves, the agent brief's game-design pillars and hospital/child
context, `.claude/agents/self-improvement.md` and `code-review-engineer.md`
as literal files (their *shape* is Bucket B's template, their *content* is
carrotgame's), the workflow YAML as a literal file (its *shape* is the
template `init` emits, its *content* — job names, `masonthecarrot.netlify.app`
— is not), `netlify.toml`, `feedback.js`.

## 4. Repo structure this document proposes for `self_optimisation`

```
self_optimisation/
├── README.md                        # what this is, quickstart, links to the paper
├── Portable-Harness-Design.md       # this document
├── Model-Release-Driven-Software-Improvement-Paper-Outline.md   # existing
├── docs/                            # existing research corpus (papers, SOURCES.md)
│
├── learning/                        # Bucket A, ported ~verbatim
│   ├── README.md
│   ├── 01-principles.md … 07-whats-actually-new.md
│   ├── blog-post.md
│   └── diagrams/
│
├── harness/                         # Bucket B, genericised
│   ├── lib/
│   │   ├── llm-provider.mjs         # provider registry + callModelWithHeadroom()
│   │   ├── edit-format.mjs          # SEARCH/REPLACE parser, allowlist-driven
│   │   ├── context-pack.mjs         # pluggable context blocks
│   │   ├── escalations.mjs
│   │   ├── themes.mjs / generate-themes.mjs
│   │   ├── probe-models.mjs
│   │   └── notify/                  # email/slack/webhook behind one interface
│   ├── scripts/
│   │   ├── check-model-releases.mjs
│   │   ├── invoke-improvement-agent.mjs
│   │   ├── invoke-review.mjs
│   │   ├── check-guarded-paths.mjs
│   │   ├── verify-deployment.mjs    # generalised verify-production.mjs
│   │   └── build-record.mjs         # generalised build-generations-table.mjs
│   ├── providers/
│   │   ├── anthropic.mjs, openai.mjs, google.mjs   # shipped by default
│   │   └── CONTRIBUTING-A-PROVIDER.md              # the 06-starter-kit §"adding a provider" checklist, promoted to its own doc
│   └── plugins/
│       └── evaluators/
│           ├── source-weight/       # ✅ the ONE shipped example plugin — chosen because it
│           │                        # needs no tooling and this repo's tests can run it;
│           │                        # visual-canvas joins Checkstyle/mypy/Roslyn as a
│           │                        # documented extension point instead
│           └── README.md            # ✅ the interface a quality-dimension plugin implements (§8.2)
│
├── templates/                       # what `init` fills in and writes to the target repo
│   ├── agent-brief.md.tmpl          # ✅ built — from learning/06-starter-kit.md §1, with the
│   │                                # dual-purpose-file note (real prompt text AND a valid
│   │                                # Claude Code subagent) made explicit inline
│   ├── reviewer-brief.md.tmpl       # ✅ built — from §4. Notes a real inconsistency found while
│   │                                # building it: the reference implementation's reviewer brief
│   │                                # is hardcoded inline in invoke-code-review.mjs, NOT read from
│   │                                # its .claude/agents/ counterpart the way the suggest-stage
│   │                                # brief is — two sources of truth for one thing. The harness's
│   │                                # future orchestrator should read this file at runtime instead.
│   ├── guard-config.yml.tmpl        # from §5 — pending check-guarded-paths.mjs's port
│   ├── workflow.yml.tmpl            # GitHub Actions version of carrotgame's self-improvement.yml —
│   │                                # cannot be built honestly until the orchestrator, guard and
│   │                                # notifier exist; examples/workflows/watch-releases.yml is the
│   │                                # one real, complete slice today
│   └── README.installed.md.tmpl     # dropped into the TARGET repo after init
│
│   project-adapter.yml.tmpl's role is already filled — by
│   harness/project-adapter.example.yml, deliberately living under
│   harness/ rather than templates/, since a user copies it in Step 1 of the
│   README before `init` exists to generate anything.
│
├── cli/
│   └── init.mjs                     # `npx self-improve init` entry point (§6)
│
└── examples/
    ├── carrotgame/                  # the worked example — adapter file + notes
    │   ├── project-adapter.yml      # carrotgame's real config, reconstructed
    │   └── NOTES.md                 # what carrotgame's install had to add beyond the defaults (wordless-play, visual-check, feedback digest)
    └── workflows/
        └── watch-releases.yml       # ✅ built — a real, minimal CI job usable today: schedule +
                                      # detector + snapshot commit + issue-on-new-model. Not the
                                      # full loop (no implement/review/merge stage exists yet), but
                                      # honest and complete on its own terms — see the file's header.
```

Two more pieces exist now that weren't in the original sketch above, both
added in response to actually using the harness rather than only designing
it: a root **`package.json`** (`type: module`, zero dependencies, one script
— `npm test`) and **`tests/lib/`**, converting the throwaway smoke checks
used to verify each Bucket B port into a permanent suite (258 checks as of
this writing — 256 in `tests/lib/`, one per-module, plus 2 in `tests/e2e/`,
which drives the whole chain in the real generated-workflow order against a
real git remote; see README.md's "Testing this harness itself"). This is deliberately a *second, separate* test surface from
the one a target project's own adapter points `evaluation.test_commands` at
— that convention (`06-starter-kit.md` §5's append-only `tests/`) is for the
project *being improved*; this one is for the harness *doing the improving*,
and conflating them was never the intent. Root `README.md` was also
substantially rewritten around a step-by-step "Getting started" — clone,
API keys, `.env` vs. GitHub Secrets, try the detector locally, wire the
example workflow — since the audience for this repo is someone adopting the
harness into their own project, not only someone reading about the design.

## 5. Why a CLI and not just "copy these folders"

The starter-kit templates already assume a human fills in brackets by hand.
That works once. The stated goal — "users write a command and they have the
framework set up" — means `init` should do the mechanical parts a human would
otherwise get wrong quietly: deriving `EDITABLE_FILES` from one place instead
of typing it twice (the exact bug `04-context-recipe.md` documents as "a file
the agent may edit was never shown to it"), wiring every post-`improve` CI job
to check out the agent branch (the exact bug `03-failure-modes.md` documents),
and refusing to scaffold a workflow with no `verify` step. A generator can
enforce the invariants that `01-principles.md` had to learn from incidents;
copy-pasted templates cannot.

## 6. What `init` asks, and what it writes

Proposed prompts (mirrors the paper's §5 schema directly):

1. Project id / repo (git remote, auto-detected)
2. Editable paths (glob list) → `constitution.allowed_paths`
3. Frozen paths (workflow dir, this brief, guard script, deploy config —
   pre-filled with sane defaults, user extends) → `constitution.prohibited_actions`
4. Test commands (one or more shell commands that must exit 0) →
   `evaluation.test_commands`
5. Which providers to watch for new releases, and env var names for their keys
   → provider registry subset
6. Cadence (default: monthly, matches the paper's premise that model releases,
   not calendar ticks, are the trigger — a shorter cadence is offered but
   flagged as against the design)
7. Deployment verify strategy → `deployment.verify_strategy`: `url` (fetch +
   compare commit, carrotgame's approach), `registry` (PyPI/NuGet/Maven
   Central/npm — did the version bump), `artifact` (did the build produce a
   runnable output, smoke-run it), or `none` (library/internal tool — skip,
   promotion is git-tag-only)
8. CI runner → `ci.runner`: `ubuntu-latest` (default), `windows-latest`, or
   `macos-latest` — some ecosystems require a specific one (.NET Framework,
   Xcode/Swift); see §8.3
9. Context strategy → `context.strategy`: `full-dump` (send every editable
   file in full — carrotgame's approach, fine below roughly a few hundred KB
   of source) or `scoped` (repo map + relevant-file selection only — required
   above that, and genuinely unbuilt today; see §8.2). `init` estimates the
   target repo's editable-surface size and warns rather than silently
   defaulting to `full-dump` if it's too large for that to be sound.
10. Notifier: email (SendGrid key) / Slack webhook / none

Output: a filled `project-adapter.yml` in the target repo root, a
`.github/workflows/self-improve.yml` built from the template, an agent brief
and reviewer brief with the brackets in `06-starter-kit.md` filled from the
answers above, a guard config, and a `SELF-IMPROVE-README.md` in the target
repo that is this document's real deliverable: a short, concrete "what did I
just install, what secrets does it need, how do I rehearse it once before
turning on the schedule" page, written for the person who ran the command
rather than for someone reading harness source.

## 7. Kernel mapping — paper §3 against real code

| Paper component (§3) | carrotgame implementation | Harness module (proposed) |
|---|---|---|
| 3.1 Project Constitution | `.claude/agents/self-improvement.md` (brief) + `EDITABLE_FILES` in `edit-format.mjs` + `check-guarded-paths.mjs` config | ✅ **Partially real** — `harness/lib/adapter.mjs` actually parses `project-adapter.yml` now (the one file in the harness with an npm dependency, `js-yaml`, loaded lazily so a project without an adapter file never needs it installed — see the doc comment on `loadAdapter()`), and `harness/scripts/check-model-releases.mjs` reads `providers.watched`/`snapshot_path`/`max_fanout` from it. `constitution.allowed_paths`/`create_only_paths` are parsed too (`constitutionAllowlist()`) but nothing calls `edit-format.mjs` with them yet — no orchestrator exists to need them. The generated brief half of this row is still unbuilt (`templates/`). |
| 3.2 Context Compiler | `scripts/lib/context-pack.mjs` | `harness/lib/context-pack.mjs` |
| 3.3 Model-Release Detector | `scripts/check-model-releases.mjs` + `.agent/model-snapshot.json` | `harness/scripts/check-model-releases.mjs` |
| 3.4 Provider/Model Router | `scripts/lib/llm-provider.mjs` | `harness/lib/llm-provider.mjs` + `harness/providers/*` |
| 3.5 Parallel Proposal Stage | Stage 1 fan-out inside `invoke-self-improvement-agent.mjs` (ranks with authors withheld) | ✅ `harness/lib/orchestrator.mjs`'s `gatherProposals()` + `rankProposals()` |
| 3.6 Bounded Patch Executor | `scripts/lib/edit-format.mjs` | ✅ `harness/lib/edit-format.mjs` |
| 3.7 Independent Reviewer | `scripts/invoke-code-review.mjs`, fresh context, fails closed | ✅ `harness/lib/review.mjs` |
| 3.8 Automated Evaluator | test suites (project-supplied) + `check-guarded-paths.mjs` + `readiness-scorecard.mjs` (measured, not gating) | test-command runner (adapter-driven) + optional scorecard plugin |
| 3.9 Failure and Proposal Memory | `docs/generations/gen-NNN/attempts.json` + `docs/escalations/ledger.json` + `buildGenerationIndex()` | `harness/lib/escalations.mjs` + a `record/` writer |
| 3.10 Staging and Promotion Layer | merge job + git tag per generation + `verify-production.mjs` | ✅ `harness/lib/promote.mjs` (merge + tag) + `harness/lib/verify-deployment.mjs` (all four `verify_strategy` values: `url`, `registry`, `artifact`, `none`) |

Real gaps this exposes, worth stating rather than hiding: the paper's §2.6
table claims "independent review" and carrotgame delivers it (Claude, fresh
context, never the same call as implementation) — but the paper's aspiration
of reviewer/proposer model-family independence is only partial, since the
reviewer is *always* Claude regardless of which lab proposed. `07-whats-actually-new.md`
already names this ("the reviewer and the implementer share a mind") as
something the harness doesn't yet solve — carry that honesty into the harness
docs rather than resolving it by omission. Shadow/canary staging (§3.10,
§2.6's table implicitly) doesn't exist anywhere in carrotgame — merge-and-tag
is the only promotion mechanism. The harness should not claim capabilities
the reference implementation doesn't have.

## 8. Language and OS portability

Carrotgame is one data point, and it happens to be the easiest possible
case: no build step, no compiled language, no package registry, a handful of
small files. That made several genuinely hard problems invisible. This
section separates what the design already handles for any language and OS
from what still needs real work, rather than letting the plugin language in
§3–§7 imply more flexibility than exists today.

### 8.1 Already language-agnostic — no work needed

- **The patch executor** (`edit-format.mjs`) works on raw text via exact
  SEARCH/REPLACE matching. It has no idea whether the file it's editing is
  `.java`, `.cs`, `.py`, or `.html` — that's a *strength* of the design, not
  an accident, and it survives the port unmodified.
- **The evaluator's pass/fail gate** is just "run the project's own test
  command(s) and check the exit code." `pytest`, `mvn test`, `dotnet test`,
  `go test ./...` are interchangeable with `npm test` from the harness's
  point of view — it never parses the language, only the exit code. Note
  carrotgame's "does it parse as valid JavaScript?" review check was a
  workaround for having *no* compiler at all; a compiled language gets that
  check for free from its own build step, so the equivalent brief line for
  Java/C# is simply "does it build," not a bespoke syntax check.
- **The guard, ledger, themes review, and digest** all operate on paths,
  JSON, and text — none of them read source.
- **The provider/model router** never touches target-project source at all;
  it only calls model APIs.

### 8.2 What needs genuinely new work, not just config

- **The context compiler doesn't scale past a handful of small files.**
  `context-pack.mjs` sends every editable file in full because carrotgame's
  entire editable surface is ~7 HTML/CSS files. A Java or C# project can have
  hundreds of files across packages; dumping all of them blows the context
  window and dilutes attention on exactly the files that matter, the same
  failure `04-context-recipe.md` already warns about in miniature ("send what
  changes the decision, not what describes the codebase"). The paper's own
  §3.2 names the right shape — dependency graph, key symbols, targeted
  selection — but the reference implementation never had to build it. This is
  real unbuilt work: a `context.strategy: scoped` mode needs either a
  lightweight per-ecosystem symbol index (ctags-style, or the language's own
  LSP where one is scriptable), or a two-pass pattern where stage 1 first
  asks for the files it thinks are relevant and only those are sent in full
  on the real call. Don't ship a project claiming multi-language support
  until one of these exists and has been rehearsed on a real repo above the
  full-dump size threshold.
- **"Visual/wordless-play" was never the general case — it's one instance of
  a plugin category.** ✅ **Done.** The real abstraction is *domain-specific
  quality dimensions beyond pass/fail*, evaluated non-gating like
  carrotgame's readiness scorecard. `harness/lib/evaluators.mjs` is the
  runner, `harness/plugins/evaluators/README.md` is the interface (input:
  working tree + generation record + this plugin's own config; output: named
  metrics with a value, a unit and which direction is better — never gating),
  and `harness/plugins/evaluators/source-weight/` is the one shipped example.
  The shipped example is deliberately NOT the visual one: a canvas renderer
  cannot be exercised by this repository's own tests, and an example nobody
  can run is a specification, not an example. The canvas checks join
  Checkstyle + JaCoCo for Java, mypy/ruff + coverage for Python and Roslyn
  for C# as documented extension points, which is what §8.2 argued for
  anyway.

  Three things the runner enforces rather than trusting each plugin to
  honour, because a plugin is third-party code: a plugin that throws, hangs
  past its timeout, or returns a malformed metric produces a recorded error
  and nothing else (a measurement that can break the loop is a gate wearing a
  metric's clothes); metrics are normalised on the way out; and the brief
  those metrics are rendered into tells the model in as many words that they
  are not targets. Results land in `<generationsDir>/gen-NNN/metrics.json`
  and are read back into the NEXT generation's prompt through the section
  carrotgame's readiness scorecard used to occupy — which was hardcoded
  `null` until now.
- **"Did it actually ship" assumed a fetchable URL.** `verify-production.mjs`'s
  pattern — fetch the live thing, compare the commit — only applies to
  deployed web services. §6's new `deployment.verify_strategy` field
  generalises this to registry-version checks (did PyPI/NuGet/Maven
  Central/npm actually publish the bumped version) and artifact checks (did
  the build produce a runnable output, smoke-run it) with `none` as the
  honest answer for a library with no independent deploy step — falling back
  to "the tag exists" rather than pretending a check happened.

### 8.3 OS portability

- **The harness's own control code** (the `init` CLI, the orchestration
  scripts) runs on Node.js, which is genuinely cross-platform — but it needs
  an actual audit, not an assumption, before that claim is trusted: use
  `path.join`/`path.sep` rather than concatenated string paths, `os.tmpdir()`
  rather than a hardcoded `/tmp`, and avoid building shell command strings by
  concatenation (`child_process.exec` with interpolated text) — the same
  injection concern already flagged for the workflow YAML's `${{ }}`
  interpolation applies to any shell string built from model- or
  user-supplied text, on any OS.
- **The generated workflow YAML should pin `shell: bash` on every step.**
  GitHub-hosted `windows-latest` and `macos-latest` runners both ship Git
  Bash, so the existing heredoc/`jq`/`sed` patterns keep working across all
  three OS images without a rewrite — but this was implicit
  (`ubuntu-latest`-only) in the carrotgame original and needs to become
  explicit, and actually tested on the other two, before being called
  portable.
- **Runner OS should be an adapter field, not a fixed default.** Some
  ecosystems need a specific one — .NET Framework (as opposed to .NET Core)
  realistically requires `windows-latest`; Xcode/Swift requires
  `macos-latest`. `ubuntu-latest` stays the default because it's cheapest and
  covers the common case, but `init` should ask rather than assume (§6).
- **`jq` is preinstalled on all three GitHub-hosted runner images**, so the
  existing CI-side JSON manipulation is safe to keep as-is. If the harness
  also grows a "rehearse a generation locally" command, route its JSON
  handling through Node's native `JSON.parse`/`JSON.stringify` rather than
  shelling out to `jq` — Node already has this for free, and it removes a
  dependency the local path would otherwise silently assume is on the
  developer's PATH.
- **This has only been exercised on Windows so far** (this document's own
  authoring environment). Node cross-platform support makes portability
  *plausible*, not *verified* — treat "works on Mac and Linux too" as
  unconfirmed until `init` and one rehearsed generation have actually been
  run on each, not as a property that follows automatically from using
  Node.js.

### 8.4 Honesty note

None of §8.2's gaps are solved by better documentation — they're missing
code. The paper's own RQ5 (portability across heterogeneous repositories) is
exactly the open question this section names rather than closes. The
addition to §9's next steps below is deliberate: rehearse on a second project
that is different on purpose — a different language, no visual surface, a
larger file count — before this document or its README claims multi-language
support, rather than assuming the design transfers because it looks like it
should on paper.

## 9. Explicit non-goals of this document

- No files are moved by writing this document.
- No decision yet on package name, license, or whether `init` ships as an npm
  package vs. a `git clone` + script.
- No decision on how many providers ship as defaults vs. documented
  "bring your own" plugins (leaning toward Anthropic + OpenAI + Google
  shipped, others documented per `CONTRIBUTING-A-PROVIDER.md`, but that's a
  call for the next conversation).
- Bucket B's genericisation is real engineering work, not a rename pass —
  each file in §3's table needs an actual pass to extract the config surface.
  This document is the map of that work, not the work itself.

## 10. Proposed next steps, in order

1. Agree this document's bucket assignments and repo structure.
2. Port Bucket A (`learning/`) into `self_optimisation/learning/` — lowest
   risk, highest immediate value, mostly a copy + light edit pass.
3. Reconstruct carrotgame's own `project-adapter.yml` by hand from its real
   brief/guard/workflow, as `examples/carrotgame/` — this becomes the test
   case for whether the adapter schema is actually sufficient, before any
   scaffolding code is written against it.
4. Port and genericise Bucket B file by file, in the dependency order the
   kernel table in §7 implies (provider router and edit-format first — nothing
   else works without them; detector and context-pack next; orchestration
   last, since it composes everything before it).
5. Build `cli/init.mjs` against the now-genericised `harness/` and
   `templates/`, validated by re-generating carrotgame's own install and
   diffing it against the hand-built example from step 3.
6. Rehearse on a second project chosen to be different on purpose — a
   different language, no visual surface, a file count large enough to force
   the `context.strategy: scoped` question (§8.2) rather than let `full-dump`
   quietly keep working. Do not claim multi-language or multi-OS support in
   this document's own non-goals list (§9) or in the eventual README until
   this run has actually happened on Windows, Mac, and Linux dev machines and
   at least one non-`ubuntu-latest` CI runner (§8.3).

**Revised as of the orchestrator work:** step 4 turned out to have a real
sub-order within it, surfaced by actually building rather than only
planning. Done, in the order built: provider router, edit-format,
model-release detector, reachability probe, adapter loader, guard,
escalations ledger, themes review (read side), context-pack (7 of 9
functions), and now the orchestrator itself plus the independent reviewer
(`harness/lib/orchestrator.mjs`, `harness/lib/review.mjs`,
`harness/scripts/run-generation.mjs`). Ten ports and one genuinely new
file (`adapter.mjs` — no such component existed in the reference
implementation; the paper's §3.1 assumed it, carrotgame's
brief-as-a-file-on-disk never needed one).

**This is the milestone the whole build order was aimed at: the loop is
now real, tested, and runnable end to end.** Every component that used to
be "fully tested and wired to nothing" is now wired — `harness/scripts/run-generation.mjs`
reads a project's adapter and briefs, assembles context via
`context-pack.mjs`'s builders, and calls `runGeneration()`, which composes
the model-release detector's output, the provider router, edit-format,
the independent reviewer, the guard's own rule shapes (via the same
adapter fields), and the escalation ledger into the actual suggest →
implement → review → refine cycle. Verified two ways: 29 tests against
fake model responses covering the state machine's genuinely hard parts
(pristine-reset-before-every-retry, the refine loop carrying real
rejection feedback, exhaustion → abandoned with the tree restored, and a
crash after proposals exist still writing a real record before
re-throwing), and one real end-to-end run against a temp project with a
real adapter file and real brief files — no mocking below the network
call itself, which correctly failed for the mundane reason of no API key
being set, and produced a correctly-shaped `no-proposal` record rather
than crashing on a wiring bug.

The one real design decision this port required, worth restating because
it's the same decision that shaped everything before it: **the harness
owns mechanism, the project owns content.** The reference implementation's
system prompts are carrotgame's own words, hardcoded as JS template
literals and — worth noticing on its own — partially *redundant* with
`.claude/agents/self-improvement.md`, which the reference implementation
also reads and sends separately. The port removes that redundancy on
principle: a project's filled-in `agent-brief.md` (see
`harness/templates/agent-brief.md.tmpl`) *is* the suggestion stage's
system prompt, not a summary of it restated in the harness's own words a
second time. Same for the reviewer.

Held back at the time, and since built: `generate-themes-review.mjs` (the
CLI that calls a model to produce a themes review) needed real generation
history as input, which exists once a project has run `run-generation.mjs`
enough times to accumulate real `docs/generations/gen-NNN/` records — the
blocker was never the compiler (done) or the orchestrator (done), only real
records existing yet. They do, so it is built, and the generated workflow
runs it after every generation and lets it decide for itself whether that
generation is a cadence boundary.

**Revised again, after staging & promotion and the notifier:** both are now
✅ — `harness/lib/promote.mjs` + `harness/lib/verify-deployment.mjs` (the
`url` strategy at the time), and `harness/lib/notify.mjs`
together with its two CLI wrappers (`send-digest.mjs`, `send-escalation-notice.mjs`).
See the Bucket B table (§3) for what each actually does; the design choice
worth restating here is the same "harness owns mechanism, project owns
content" split that shaped the orchestrator: the notifier's core (compose a
plain-language email with a reliable terse fallback; compute *why* a merge
did or didn't happen from real gate results rather than asking a model to
guess) is genuinely portable and stayed a straight port. What wasn't
portable as-is — SendGrid, and two hardcoded calibration examples from
carrotgame's own history — moved to a `registerSender(name, send)` registry
(mirroring `llm-provider.mjs`'s own provider registry, so adding Slack or a
webhook never touches the email-writing code) and an optional
`notify.calibration_examples` adapter field (file paths, read by the CLI
wrapper and passed through) respectively.

Neither staging/promotion nor the notifier is wired to run *automatically*
after `run-generation.mjs` — each is a standalone, tested CLI a workflow's
own job calls, the same "built but not orchestrated into one command" state
the orchestrator itself was in before this section's previous revision.
`run-generation.mjs` now emits `escalations-opened`/`escalations-flagged`/
`escalations-flagged-json` outputs specifically so a workflow can wire them
straight into `send-digest.mjs`'s `ESC_OPENED`/`ESC_FLAGGED` and
`send-escalation-notice.mjs`'s `FLAGGED` env vars without a shell script
in between — that wiring itself still lives only in
`templates/workflow.yml.tmpl`, unbuilt.

**Revised a third time, after the registry/artifact verify strategies and
the workflow template + init CLI:** all of what the previous revision
called "what's left" is now built. `harness/lib/verify-deployment.mjs`
gained `verifyRegistry()` (npm, PyPI, NuGet, Maven Central — four real,
differently-shaped registry APIs, each polled the same way `verifyUrl()`
already polled a live site: check, retry within a timeout, report) and
`verifyArtifact()` (build command, confirm the output path exists,
optional smoke-run — three independent, all-optional checks). Neither had
a reference implementation to port from, since carrotgame ships no package
and no build step; both are genuinely new code, tested the same way the
`url` strategy was (fake `fetchImpl`/`exec` injected, no real registry or
shell command touched in the suite).

`harness/templates/workflow.yml.tmpl` is the workflow template §6
proposed: one job, sequential steps (GitHub Actions can't loop or
dynamically branch jobs — see ARCHITECTURE.md's reference-implementation
diagram for what that constrains), chaining detect -> probe -> preflight
-> improve -> guard -> test -> promote -> verify -> notify, with every
model-generated or otherwise untrusted step output (a proposal summary,
brief feedback) routed through `env:` rather than interpolated directly
into a `run:` script — the difference between a safe workflow and a
script-injection bug. `harness/cli/init.mjs` asks the questions this
section listed above, then writes `project-adapter.yml`, that workflow,
brief-template copies (never overwriting a project's real, already-filled
brief), and a short install README. Its rendering logic lives in
`harness/lib/scaffold.mjs` as pure functions — no filesystem or stdin
access of their own — so `tests/lib/scaffold.test.mjs` can parse every
strategy combination's generated adapter YAML and workflow YAML back with
`js-yaml` and assert they're valid, the same "generate the record, verify
it structurally" approach the rest of this harness already uses. Verified
a second way too: a real, fresh `git init` repo, `init.mjs --yes` run
against it, and the two generated files parsed back successfully — see
this section's own git history for that session's exact commands if you
want to reproduce it.

The **test-command runner** as an actual CI step needed no new harness
*code*, as this document already predicted — `init.mjs` renders a
project's answered test commands directly into the generated workflow's
preflight and post-guard steps, and (new) echoes them into the generated
`project-adapter.yml`'s `evaluation.test_commands` too, for the record,
even though nothing reads that field back out of the adapter file yet.

Every kernel component the paper's §3 table names, plus the notifier, plus
the workflow template and scaffolder that chain all of it together, is now
real. What's left is exactly §10 step 6: rehearsing this on a second,
genuinely different project, and running the generated workflow for real
in GitHub Actions rather than only against a local git repo and unit
tests — the one kind of verification a repository working on itself can't
provide from inside itself.

**That open seam, closed:** `workflow.yml.tmpl` used to always auto-merge an
approved change, where `console/DESIGN.md` (written afterward) argued for
opening a pull request by default and autonomous merge as an opt-in. The
template now renders whichever of the two paths `constitution.approval_class`
selects — the pull-request path calls `orchestrator.mjs`'s
`recordPullRequestUrl()` through `harness/scripts/record-pull-request.mjs`,
and anything unrecognised fails closed to it. See `ARCHITECTURE.md`'s "The
merge model, reconciled" for the full account.

Wiring the orchestrator's new adapter fields (`roles.*`, `context.*`) into
`harness/project-adapter.example.yml` surfaced one more real bug the same
way previous ones have all been found — by actually running the file
through `js-yaml`, not by reading it. `id: [your-project-name]` is *valid
YAML*: a one-element flow-sequence array, not a placeholder string.
`project.id`, `constitution.allowed_paths`, and the two new brief-path
fields (which get passed straight to `fs.readFileSync`) were all silently
the wrong type — a template a user copied verbatim would have handed
`path.join()` an array where it expected a string, several layers away
from the actual mistake. Fixed by switching the placeholder convention to
`<angle-brackets>`, which YAML has no opinion about, and verified by
re-parsing and checking every field's real type rather than eyeballing the
diff.

**Revised as of the first defects flowing back from the reference
implementation.** Every entry above this one records work flowing one way:
carrotgame had a mechanism, the harness gained a portable version of it. This
entry is the first going the other direction, and it is worth naming as a
category rather than a batch of fixes, because it is the whole reason for
keeping a reference implementation running at all.

Carrotgame lost generation 021 in full. Alibaba's DashScope re-listed
Moonshot's Kimi K3 in its own catalogue as `kimi/kimi-k3`; the detector
compared id strings, `kimi/kimi-k3` is not the string `kimi-k3`, and a model
that had already been suggested, implemented, reviewed and **merged** four
generations earlier was selected as that month's new release. It then failed,
because only the namespaced form is gated behind a separate product
activation — verified live, same host and key: bare `kimi-k3` answers,
`kimi/kimi-k3` returns 400 "product is not activated". That failure sent the
run down its unreachable-candidate path, where an expensive diagnostic pass
spent 42 web searches correctly diagnosing an endpoint that should never have
been called. Every mechanism downstream reported truthfully. The premise
handed to them was wrong before any of them ran.

Four defects, all of which this harness had faithfully inherited and none of
which its own 263 tests could see:

| # | Defect | Was | Now |
|---|---|---|---|
| 1 | Alias blindness | `models.filter((m) => !previousModels.includes(m.id))` — byte-identical to the line that cost the cycle | `model-aliases.mjs`, canonicalising one `vendor/` prefix on **both** sides |
| 2 | No permanent-block memory | Nothing matched `unfixable` anywhere; a dead candidate was re-probed every cycle forever | `unfixable-models.mjs` + the `_unfixable` snapshot key, carried forward across rebuilds |
| 3 | Collapsed release signal | `release.hasNewReleases = survivors.length > 0` overwrote the only flag, so "a lab moved its endpoint" read as "a quiet cycle" | `releaseDetected` set before the probe and never overwritten by it |
| 4 | Unreportable cycles | The digest step was gated on `steps.gen.outputs.number`, so a crashed check, an all-unreachable cycle and a failed preflight all sent nothing | `buildNoGenerationEmail()` + `NO_GENERATION_REASONS`; the step runs on `if: always()` |

Defect 4 deserves the extra sentence, because the code carried its own excuse.
The template's comment conceded the gap and justified it: *"that failure is
still visible as a red step in the Actions run itself, just not echoed to the
digest's recipient."* Carrotgame has now disproved that reasoning three
separate times — once per collapse, each found only after a month's email
failed to arrive, each fixed, and the next one shipped anyway. The third was
the worst: a crashed release check sent *"Checked all nine labs on schedule —
nothing new since the last run"* for a cycle in which nothing had been
checked. **An all-clear is strictly worse than silence, because silence
prompts a question.** Nobody is watching the Actions tab; that is what the
digest is for.

Two things the harness had already got right, recorded so they are not
regressed later. Its single-job workflow makes carrotgame's other generation-021
bug — a downstream job checking out an agent branch that was never pushed,
killing the digest before it ran — structurally impossible; splitting jobs for
parallelism would reintroduce it. And `gatesBlock(gates)` takes gate results as
data, so it cannot drift the way carrotgame's hardcoded test count did (every
digest it sent reported 606 checks against a real 774, because the file was
missing from the list that catches exactly that).

39 new tests, 263 → 302. The split is deliberate: unit tests for the two new
libraries, then `detector-alias-integration.test.mjs` driving `checkReleases()`
itself, then `no-generation-digest.test.mjs` asserting that the *generated
workflow* wires the new signals through. That last group is the one that
matters most. A correct library nothing calls is precisely the shape of bug
this entry is about — defect 4 was a wiring failure sitting above four
perfectly good email builders, and a suite that only tested the builders would
have stayed green through every missing email.

**Still open, and named rather than quietly implied:** nothing writes to
`_unfixable` yet. Carrotgame populates it from a diagnostic step
(`fix-unreachable-provider.mjs`) that has not been ported — it is the one
component allowed to edit provider dispatch code, under a second, one-file
allowlist, and porting it is a real design question about trust boundaries
rather than a rename. Until then `mergeUnfixable()` is available for a project
or a human to call deliberately, which preserves the invariant that matters:
only an actual diagnosis belongs in that list, never a probe failure. A probe
knows a call did not succeed; it does not know why, and "why" is the entire
difference between a candidate worth retrying and one that is dead.

The general lesson, which applies well beyond these four fixes and is the
reason the curiosity engine should care: **a gate can only be as right as the
premise handed to it, and the cheapest bugs to miss are the ones every
mechanism downstream reports correctly.**
