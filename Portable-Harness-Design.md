# Portable Harness — Design Document

**Status:** planning only. Nothing described here has been moved or built yet.
This document exists to get agreement on *what* moves from `carrotgame`,
*how* it gets genericised, and *what* the new repo's own README should promise
a user, before any file crosses over.

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
| `scripts/check-model-releases.mjs` | 340 | Model-release detector | Snapshot-diff logic, "unknown never means no release" posture | ✅ **Ported** — `harness/lib/model-release-detector.mjs` (pure: no fs/env/console) + `harness/scripts/check-model-releases.mjs` (CLI, owns the snapshot file and env). The per-lab catalogue config (URL, parser) moved onto each provider's `registerProvider()` call as `listModels`, alongside its call-time config — see `getProvider()` in `llm-provider.mjs` for why that avoided reopening the "three parallel literals" bug `edit-format.mjs`'s own history warns about. `isChatModel()`'s keyword filter is now applied centrally after each provider's own `parseModels`, rather than repeated inside all nine. 61-check smoke test covers every provider's real catalogue-response shape, the ranking tie-break, the all-keys-missing skip path, and snapshot preservation on a failed check. |
| `scripts/probe-models.mjs` + `lib/probe-models.mjs` | 82 + 119 | Reachability check (feeds the detector) | The "send the real call shape, drop what 404s" method, `checkContextFit()` | ✅ **Ported** — `harness/lib/probe-models.mjs` (verbatim; it was already fully generic) + `harness/scripts/probe-models.mjs`. One deliberate gap: the reference CLI hard-imports `estimateContextSize()` from `context-pack.mjs`, which isn't ported yet (§7's still-open row below). The harness CLI takes an optional `--estimated-tokens`/`CONTEXT_ESTIMATE_TOKENS` instead and skips the context-fit check when it's absent — the same conservative default `checkContextFit()` already applies to any provider that reports no window at all, so this isn't a capability loss, just an honest placeholder until context-pack ships. |
| `scripts/lib/context-pack.mjs` | 819 | Context compiler | `buildGenerationIndex()` (full history, one line each), `buildGenerationHistory()` (recent-detail window), `recommendScope()`, `estimateContextSize()` | The specific blocks assembled (screenshots, player feedback, readiness scorecard) are carrotgame's own context recipe — becomes a **pluggable block list** per `04-context-recipe.md`'s checklist |
| `scripts/lib/edit-format.mjs` | 324 | Bounded patch executor | The whole SEARCH/REPLACE parser, exactly-once matching, all-or-nothing apply, CREATE-only-for-new-paths | ✅ **Ported** — `harness/lib/edit-format.mjs`. `EDITABLE_FILES` became `compileAllowlist({allowedPaths, createOnlyPaths})`, fed from the adapter (`constitution.allowed_paths` / `create_only_paths`, glob strings via the new `harness/lib/glob.mjs`) instead of a module constant. `EDIT_FORMAT_SPEC` became `buildEditFormatSpec()`, templated on an optional extra metadata field (carrotgame's `PILLAR`) and an optional CREATE section, so a project with no pillar taxonomy isn't forced to have one. 28-check smoke test covers allowlist edge cases, all-or-nothing failure, non-unique-SEARCH rejection, and create-at-existing-path rejection. |
| `scripts/invoke-self-improvement-agent.mjs` | 1,450 | Orchestrates suggest→implement→review→refine (the paper's whole §4 lifecycle in one file, because Actions can't loop jobs) | The 4-stage state machine, the fan-out/rank-with-authors-withheld pattern, the refine-loop-with-pristine-reset | The specific prompt content (game design pillars, child-safety framing) — becomes adapter-supplied prompt fragments |
| `scripts/invoke-code-review.mjs` | 237 | Independent reviewer | Fresh-context call, fail-closed parse | The reviewer's brief content — templated, see `06-starter-kit.md` §4 |
| `scripts/lib/visual-check.mjs` | 313 | Evaluator (visual dimension) | The render-then-attach-to-review-call pattern, best-effort-not-exception posture | Renders *this* project's two games at a phone viewport — becomes optional, only relevant to projects with a visual surface; needs a pluggable "how do I render this project" hook |
| `scripts/lib/wordless-play.mjs` | 759 | Evaluator (accessibility dimension) | Instrumented-draw-call method for telling symbol from word | Extremely game-specific (canvas instrumentation) — **do not port as a default**, keep as a worked example of "a fitness function that measures the real artefact, not a proxy of it" |
| `scripts/readiness-scorecard.mjs` | 463 | Evaluator (aggregate, non-gating) | The "measured, never gates" posture, retired-dimension handling | The six dimensions themselves are carrotgame's (hospital wifi, WCAG, touch targets) — becomes an adapter-defined metric list |
| `scripts/check-guarded-paths.mjs` | 118 | Guard / bounded authority | FROZEN / APPEND_ONLY / FROZEN_FIELDS / churn-ceiling mechanism | ✅ **Ported** — `harness/lib/guard.mjs` (pure, git runner injectable for tests) + `harness/scripts/check-guarded-paths.mjs`. Rules come from `constitution.frozen_paths`/`append_only_paths`/`frozen_fields`/`churn_ceiling` in `project-adapter.yml`, glob strings converted via the existing `glob.mjs`. 12 tests: 10 unit (fake git, every rule kind) + 2 against a real temporary git repository, proving the assumed `git diff --name-status --find-renames`/`--shortstat` output shapes are what real git actually produces rather than what the reference implementation's code merely assumed. |
| `scripts/lib/escalations.mjs` | 419 | Failure & proposal memory (the "argue without editing" channel) | The whole ledger + consensus-bar (3 models / 2 labs) + email mechanism | The lab-count threshold and recipient — becomes adapter config; mechanism ports directly |
| `scripts/build-generations-table.mjs` | 292 | Reporting / record generation | "Generate the record, never hand-maintain it" — table built from `docs/generations/` + ledger | Output format (the HTML deck) — keep as an optional renderer, not a requirement |
| `scripts/verify-production.mjs` | 157 | Staging & promotion — the live check | "Every other gate tests a branch; this one tests what a user opens" | `PRODUCTION_URL` and the specific host (Netlify) — becomes one config value; the *pattern* (fetch live, compare commit) generalises to any deploy target with a version-visible endpoint |
| `scripts/send-digest-email.mjs`, `send-escalation-email.mjs`, `lib/format-digest.mjs` | 247+128+77 | Reporting | Plain-language-via-LLM digest pattern, best-effort-with-reliable-floor posture | SendGrid + recipient — becomes a pluggable notifier (email/Slack/webhook), one interface |
| `scripts/lib/gh-output.mjs` | 30 | Plumbing | GitHub Actions `$GITHUB_OUTPUT` writer | GitHub Actions–specific; other CI targets (GitLab CI, Buildkite) need their own thin equivalent behind the same call sites |
| `scripts/lib/themes.mjs`, `generate-themes.mjs`, `generate-themes-review.mjs` | 84+84+89 | Longitudinal learning (the every-10th-generation abstraction step) | Entire mechanism — reads history, asks a pinned model for "what we noticed → what it means", feeds back into next context pack | Nothing carrotgame-specific; ports directly, cadence (10) becomes config |

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
│           ├── visual-canvas/       # ported visual-check.mjs + wordless-play.mjs,
│           │                        # relabelled as ONE example plugin, not the default
│           └── README.md            # the interface a quality-dimension plugin implements (§8.2)
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
used to verify each Bucket B port into a permanent suite (33 checks as of
this writing). This is deliberately a *second, separate* test surface from
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
| 3.5 Parallel Proposal Stage | Stage 1 fan-out inside `invoke-self-improvement-agent.mjs` (ranks with authors withheld) | same file, generalised |
| 3.6 Bounded Patch Executor | `scripts/lib/edit-format.mjs` | `harness/lib/edit-format.mjs` |
| 3.7 Independent Reviewer | `scripts/invoke-code-review.mjs`, fresh context, fails closed | `harness/scripts/invoke-review.mjs` |
| 3.8 Automated Evaluator | test suites (project-supplied) + `check-guarded-paths.mjs` + `readiness-scorecard.mjs` (measured, not gating) | test-command runner (adapter-driven) + optional scorecard plugin |
| 3.9 Failure and Proposal Memory | `docs/generations/gen-NNN/attempts.json` + `docs/escalations/ledger.json` + `buildGenerationIndex()` | `harness/lib/escalations.mjs` + a `record/` writer |
| 3.10 Staging and Promotion Layer | merge job + git tag per generation + `verify-production.mjs` | `harness/scripts/verify-deployment.mjs` + tag-on-merge |

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
  a plugin category.** The real abstraction is *domain-specific quality
  dimensions beyond pass/fail*, evaluated non-gating like carrotgame's
  readiness scorecard. Reframe `visual-check.mjs`/`wordless-play.mjs` as the
  one shipped example plugin (`harness/plugins/evaluators/visual-canvas/`,
  §4), document the interface a plugin implements (input: working tree +
  generation record; output: a named metric, never gating unless a human
  later decides to promote it), and leave the ecosystem-specific plugins
  (Checkstyle + JaCoCo delta for Java, mypy/ruff + coverage for Python,
  Roslyn analyzers for C#) as a documented extension point rather than
  something v1 ships.
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

**Revised as of the adapter-loading and diagrams work:** step 4 turned out to
have a real sub-order within it, surfaced by actually building rather than
only planning. Provider router, edit-format, model-release detector,
reachability probe, and now the adapter loader are done — five ports and one
genuinely new file (`adapter.mjs`, since no such component existed in the
reference implementation; the paper's §3.1 assumed it, carrotgame's
brief-as-a-file never needed one). Still open from Bucket B, and next in
line because each is flagged "ports directly" with no orchestrator
dependency — the same property that made the detector and probe tractable
before context-pack:

- **`harness/lib/escalations.mjs`** — the ledger mechanism and consensus bar.
  Establishes `docs/escalations/ledger.json` as a real, harness-managed
  convention rather than only a documented one.
- **`harness/lib/themes.mjs` + `generate-themes.mjs`** — same status, for
  `docs/themes/review-NNN.json`.
- **`harness/scripts/check-guarded-paths.mjs`** — the guard. Diffs a branch
  against the adapter's `frozen_paths`/`append_only_paths`/`frozen_fields`/
  `churn_ceiling`, all of which the schema already has fields for (§5); no
  orchestrator needed to exercise it standalone against any two refs.

`context-pack.mjs` and the orchestrator remain the two components that
actually require new design work rather than a port — see §8.2 and the
kernel table's remaining ❌ rows in `ARCHITECTURE.md`.
