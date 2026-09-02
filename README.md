# Self-Optimisation

A portable harness for model-release-driven software improvement: point it at
a project, and a governed suggest → implement → review → gate → promote loop
lets each newly released frontier model propose one improvement, gated by
that project's own tests before anything ships.

**Status: the whole loop is real, end to end, including the generated
workflow.** Suggest → implement → review → refine → guard → test → promote
→ verify → notify runs against your own project's adapter and brief
files — `harness/scripts/run-generation.mjs` is a working entry point, not
a design sketch, and `harness/cli/init.mjs` now scaffolds a new
installation's `project-adapter.yml` and
`.github/workflows/self-improve.yml` in one pass rather than requiring you
to wire each script's CI step together by hand. The reference
implementation is a separate, real project (two educational HTML games)
that has run this loop for 18+ real generations, including real incidents;
this repository is the work of extracting that into something
project-agnostic. Staging & promotion (`harness/lib/promote.mjs`,
`verify-deployment.mjs` — now all four `deployment.verify_strategy` values:
`url`, `registry`, `artifact`, `none`) and a notifier (`harness/lib/notify.mjs`)
that emails a plain-language digest of what happened, with a reliable
terse fallback if that call fails, are both real and both chained
automatically by the generated workflow now, not standalone CLIs waiting
for a human to invoke them in sequence. See [`ARCHITECTURE.md`](ARCHITECTURE.md)
for the full picture, and [Status in detail](#status-in-detail) for the
per-component table.

---

## Getting started

This walks through installing the harness into **your own project** — not
this repository. Fifteen minutes, most of it waiting for API signups.

### Step 1 — Get the harness into your project

There's no published package yet, so "install" means copying one folder.
From a terminal, inside your project's root:

```bash
git clone https://github.com/Chrisfoz/self-optimisation.git /tmp/self-optimisation
cp -r /tmp/self-optimisation/harness ./harness
```

(On Windows PowerShell, replace `/tmp/self-optimisation` with a path like
`$env:TEMP\self-optimisation`, and `cp -r` with `Copy-Item -Recurse`.)

That's the whole install. Almost everything in `harness/` uses only Node's
own built-ins (`https`, `fs`, `path`, `node:test`) — the provider router,
edit-format, detector and reachability probe need no `npm install` at all.
The one exception is `harness/lib/adapter.mjs`, which parses
`project-adapter.yml` and needs a real YAML parser to do it (`js-yaml`,
plus one small transitive dependency of its own) — deliberately scoped to
that single file rather than left implicit; every other kernel component
works with zero dependencies whether or not you ever run `npm install`.
You do need **Node.js 20.6 or newer**: that's the version that added
`--env-file` and the built-in test runner, both used below and both chosen
specifically to avoid needing a dependency for either. Check with:

```bash
node --version
```

### Step 2 — Get API keys for the labs you want to watch

You do not need all nine. Pick one or two to start — Anthropic and OpenAI
are a reasonable default if you're unsure. For each lab you pick, sign up
and generate an API key on that lab's own developer platform:

| Lab | Where | Env var |
|---|---|---|
| Anthropic | `console.anthropic.com` | `ANTHROPIC_API_KEY` |
| OpenAI | `platform.openai.com` | `OPENAI_API_KEY` |
| Google (Gemini) | `aistudio.google.com` | `GOOGLE_API_KEY` |
| xAI (Grok) | `console.x.ai` | `XAI_API_KEY` |
| DeepSeek | `platform.deepseek.com` | `DEEPSEEK_API_KEY` |
| Moonshot (Kimi) | Moonshot's developer platform — search "Moonshot AI API key" | `MOONSHOT_API_KEY` |
| Qwen (Alibaba) | Alibaba Cloud's DashScope / Model Studio console — search "DashScope API key" | `QWEN_API_KEY` |
| Meta | Meta's model API developer console — search "Meta Llama API key" | `META_API_KEY` |
| Z.ai (Zhipu GLM) | Zhipu's open platform — search "Zhipu GLM API key" | `ZAI_API_KEY` |

The first five are stable, well-known consoles. For the last four, search
rather than trust a URL from memory — smaller or regional platforms move
their signup pages more often than the majors do, and getting this wrong
sends you to the wrong site rather than just a 404.

Keep each key somewhere safe for a moment — the next two steps put copies of
it in two different places, for two different purposes, and mixing them up
is the single most common mistake here.

### Step 3 — Local testing: `.env` (never committed)

Copy the example file into your project root (not inside `harness/`):

```bash
cp harness/.env.example .env
```

Open `.env` and paste in the keys from Step 2, next to the matching
variable name. Leave every line you don't have a key for blank or delete it
— an unwatched provider costs nothing.

**This file must never be committed.** If you copied `harness/` into an
existing project, add this to your `.gitignore` now, before you forget:

```
.env
```

Unlike most Node setups, this harness reads `.env` **without a dependency**
— no `dotenv` package, no build step. Node 20.6+ loads it natively:

```bash
node --env-file=.env harness/scripts/check-model-releases.mjs
```

That one flag is also why this step is identical on Windows, macOS, and
Linux: the file is parsed by Node itself, not by your shell, so there's no
`export VAR=value` vs. `$env:VAR = "value"` difference to worry about here.

### Step 4 — Try it locally

Run the detector against just the labs you added keys for:

```bash
node --env-file=.env harness/scripts/check-model-releases.mjs --providers anthropic,openai
```

First run: every lab you named gets recorded as a **baseline** and nothing
is reported as "new" — there's nothing to compare against yet. That's
correct, not a bug. Run it again right now and you'll see `no new models`
for the same reason. It only reports something the first time a model id
shows up that wasn't in the snapshot last time — see
[`harness/lib/model-release-detector.mjs`](harness/lib/model-release-detector.mjs)
for exactly how that comparison works, and
[`learning/01-principles.md`](learning/01-principles.md) principle 1 for why
"triggers on real novelty" is the whole point rather than a detail.

A `.agent/model-snapshot.json` file appears after this run — that's the
detector's memory, and it's not optional to keep: **commit it**, the same
way the reference implementation does. GitHub Actions runners are ephemeral
— nothing persists between scheduled runs except what's in the repo — so
without this file committed, every monthly run would see an empty snapshot
and report every model in the catalogue as "new" simultaneously, every
time. Don't add `.agent/` to `.gitignore`; that's the one directory in this
walkthrough that's the opposite of `.env` — it holds no secrets and it
*must* travel with the repo. `examples/workflows/watch-releases.yml`
already commits it automatically as part of the workflow (Step 6 below).

**Optional but recommended once you're past trying it once:** rather than
repeating `--providers` on every invocation, copy
[`harness/project-adapter.example.yml`](harness/project-adapter.example.yml)
to `project-adapter.yml` at your project root and list your watched
providers there instead — `harness/lib/adapter.mjs` reads it automatically
(a CLI flag or env var still overrides it, in that order). This is also the
one file that will carry forward everything else the harness eventually
reads as more of it gets built — see
[`examples/carrotgame/project-adapter.yml`](examples/carrotgame/project-adapter.yml)
for the fuller schema, real values and all, and `ARCHITECTURE.md` for which
of its sections are actually consumed today versus still reserved.

### Step 5 — GitHub setup: repository secrets

`.env` is for your machine only. For the detector to run on a schedule in
GitHub Actions, the same keys need to exist as **repository secrets** —
a completely separate mechanism, deliberately: a secret lives encrypted on
GitHub's side and is injected into a workflow run's environment; it is never
readable back out, never appears in logs, and has nothing to do with any
file in your repo.

In your GitHub repository:

1. Go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name it exactly as the env var in the table above (e.g.
   `ANTHROPIC_API_KEY`) and paste the same key value from Step 2.
4. Repeat for each lab you're watching.

You're adding the *same values* as `.env`, into a *different place*, for a
*different consumer* (GitHub's runners, not your own machine). Neither file
references the other.

### Step 6 — Add the workflow

Copy the example workflow in, from the same temporary clone Step 1 made
(`/tmp/self-optimisation`, or your Windows equivalent — if you've already
deleted it, re-clone, or grab
[`examples/workflows/watch-releases.yml`](examples/workflows/watch-releases.yml)
from this repository on GitHub directly):

```bash
mkdir -p .github/workflows
cp /tmp/self-optimisation/examples/workflows/watch-releases.yml .github/workflows/watch-releases.yml
```

Open it and:

- Delete the `env:` line for any provider you didn't add a secret for in
  Step 5.
- Update the `--providers` list in the "Check for new releases" step to
  match.
- Commit and push.

The workflow runs monthly by default (matching the reference cadence — see
principle 1 again for why monthly, not weekly). Use the **Run workflow**
button under the Actions tab to try it immediately rather than waiting.
**What this workflow actually does today:** checks your chosen labs, commits
the updated snapshot, and opens a GitHub issue when a genuinely new model
appears. It does **not** implement, review, or merge anything — that part of
the loop isn't built yet (see below). This is deliberately still useful on
its own: a monthly nudge that a model worth trying now exists, with your
project already wired for the day the rest of the loop ships.

---

## What only you can provide

The harness never knows your project. Everything above installs the parts
that are the same for every installation; everything below is content only
you (or whoever knows the project) can supply. **The harness never runs any
of this for you — it just knows how to call whatever you name.** Precision
matters here, so each item below is marked with what actually happens if
you fill it in today, checked against the code rather than assumed:

| You provide | Where | What happens with it, right now |
|---|---|---|
| Provider API keys | `.env` locally, GitHub Secrets in CI | **Used immediately** — the detector calls the real API the moment a key is present (Step 2–5) |
| Which labs to watch | `project-adapter.yml` → `providers.watched` | **Used immediately** — read by `check-model-releases.mjs` on every run |
| Frozen / append-only paths, frozen JSON fields, churn ceiling | `project-adapter.yml` → `constitution.frozen_paths` / `append_only_paths` / `frozen_fields` / `churn_ceiling` | **Used immediately** — `harness/scripts/check-guarded-paths.mjs` enforces these against a real git diff today |
| Which paths an agent may edit or create | `project-adapter.yml` → `constitution.allowed_paths` / `create_only_paths` | **Used immediately** — `run-generation.mjs` compiles this into `edit-format.mjs`'s allowlist and enforces it against every edit the orchestrator produces |
| Your actual test commands | Given to `harness/cli/init.mjs` when it scaffolds a new installation; echoed into `project-adapter.yml` → `evaluation.test_commands` (still reserved — nothing reads it back out of the file yet, see `ARCHITECTURE.md`) | **Used immediately** — rendered straight into the generated workflow's preflight and post-guard test steps; if you add or change commands later, edit both the workflow and `evaluation.test_commands` by hand, since re-running `init` won't overwrite an existing workflow file |
| What "better" means for your project | your own filled-in `agent-brief.md`, at the path named by `project-adapter.yml` → `roles.agent_brief_path` | **Used immediately, and used whole** — `run-generation.mjs` reads the file and sends it as the suggestion stage's entire system prompt, not a summary of it |
| Where digest/escalation emails go, and how they're sent | `project-adapter.yml` → `notify.recipient` / `notify.from` / `notify.provider`, plus `<PROVIDER>_API_KEY` (e.g. `SENDGRID_API_KEY`) in `.env`/Secrets | **Used immediately** — `send-digest.mjs` / `send-escalation-notice.mjs` read these and actually send, once you (or your workflow) invoke them; SendGrid ships built in, other senders are added via `notify.mjs`'s `registerSender()` |
| Real, well-received email bodies from your own project's history | `project-adapter.yml` → `notify.calibration_examples` (optional file paths) | **Used immediately once present** — quoted into the digest's system prompt to calibrate register; a fresh project with none yet still gets a working prompt from the rules alone |

Filling in the bottom three rows today costs you nothing and loses nothing
— they're forward-compatible, not busywork you'll redo. But don't read
writing them down as switching anything on; check the table, not your
intuition, for what's actually live.

**A fast way to populate the ones that need real project knowledge:** hand
`harness/project-adapter.example.yml` and `harness/templates/agent-brief.md.tmpl`
to a coding agent you already use — Claude Code or similar — pointed at your
repository, and ask it to fill in the bracketed placeholders from what it
can see: your real file structure for `allowed_paths`, your real `package.json`
scripts (or equivalent) for `test_commands`, your project's own quality bar
for the HINTS section. It can see your codebase in a way this README can't;
you should still read what it wrote before committing it; wrong file
paths in `constitution.allowed_paths` will fail loud and fail safe (edits
targeting an unlisted path are just refused, same as `frozen_paths`), which
is a mistake worth catching before it costs a real run's budget rather than
mid-generation.

---

## OS-specific notes

Read this before assuming something that works on one platform works on all
three.

- **`.env` loading is identical everywhere** — see Step 3. This is a real
  design choice, not an accident: `node --env-file` sidesteps the classic
  `export` (bash) vs. `$env:VAR =` (PowerShell) split entirely, because Node
  parses the file, not your shell.
- **`node --test` on a bare directory is unreliable on at least one real
  Windows/Node combination** — confirmed while building this harness's own
  test suite: `node --test tests/` failed with a confusing
  `Cannot find module 'tests'` on Node 23.3.0 on Windows, in both Git Bash
  and PowerShell, while `node --test "tests/**/*.test.mjs"` (an explicit
  glob) worked correctly. `package.json`'s `test` script here uses the glob
  form for exactly this reason — if you add your own test files under
  `harness/`, prefer an explicit glob over a bare directory argument until
  you've confirmed the bare form on your own Node version.
- **GitHub Actions workflow steps should pin `shell: bash` explicitly**,
  which `examples/workflows/watch-releases.yml` already does on every
  multi-line step. `ubuntu-latest`'s default happens to be bash, so this
  looks optional until the day you (or a project's build needs) point
  `runs-on` at `windows-latest` — whose default shell is PowerShell, not
  bash, and would silently fail on the workflow's heredocs and `jq` calls
  otherwise. GitHub-hosted Windows and macOS runners both ship Git Bash, so
  pinning `shell: bash` is enough to make the same YAML work on any of the
  three runner images.
- **No native modules, no OS-specific build step.** Everything under
  `harness/` is pure JavaScript over Node built-ins, so there's nothing here
  that behaves differently by platform beyond the two points above.

---

## Testing this harness itself

`tests/lib/` covers each `harness/lib/` and `harness/providers/` module in
isolation — resolver correctness across real model ids, the edit-format's
all-or-nothing guarantee, every provider's catalogue parser against a
fixture shaped like that lab's real response — with model calls faked at
the narrowest boundary each test needs. `tests/e2e/` is a second, smaller
layer on top: `full-loop.test.mjs` drives the whole chain in the real
order the generated workflow uses — suggest → implement → review → guard →
test → promote (autonomous merge) → verify → notify — against a real git
remote (bare origin + working clone) and a real child-process test run,
faking only the three model calls, the one boundary a repository working
on itself can't cross from the inside. This is the automated version of the
one-off manual end-to-end run mentioned below, not a replacement for the
per-module suite — it exists to catch the failure the per-module tests
structurally can't: two pieces individually correct but disagreeing at the
seam (a field name, a branch/tag convention, what a gate result string
actually says once it reaches the digest).

```bash
npm test
```

Zero dependencies here too: `node:test` and `node:assert` are Node
built-ins, so there's no test framework to install. 258 checks as of this
writing, all passing.

**Why this exists, and why it's worth keeping current:** every check here
was, at first, a throwaway script written to confirm one piece of
genericised code actually behaved like its reference-implementation
original before committing it — real verification, but deleted afterward.
Converting them into a permanent suite is the harness practicing its own
first principle: *a gate that cannot fail is not a gate*
([`learning/01-principles.md`](learning/01-principles.md) principle 13).
Without this, a later change to `harness/lib/context-pack.mjs` or the
orchestrator could silently break `edit-format.mjs`'s all-or-nothing
guarantee and nothing would notice until a real, unattended run somewhere
shipped a broken patch. As `harness/` grows, add to this suite rather than
re-verifying by hand and discarding the proof — that discipline is the
entire point of `learning/01-principles.md` principle 23, "generate the
record; never hand-maintain it."

This is **not** the same thing as the `tests/` convention a target project's
own adapter expects (append-only, checked by a guard, run as the
`evaluation.test_commands` in `examples/carrotgame/project-adapter.yml`).
That convention is for the project *being improved*; this suite is for the
harness *doing the improving*. Keep the distinction — conflating them was
never intended.

---

## Status in detail

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for this same information as a
picture — what's built, what a human still does by hand, and how the two
connect. The table below is the same status kept in sync by hand; if it
ever disagrees with the diagram, trust whichever was edited more recently.

| Component | Status |
|---|---|
| Provider router (`harness/lib/llm-provider.mjs` + `harness/providers/`) | ✅ Built, tested |
| Bounded patch executor (`harness/lib/edit-format.mjs`) | ✅ Built, tested |
| Model-release detector (`harness/lib/model-release-detector.mjs`) | ✅ Built, tested |
| Reachability probe (`harness/lib/probe-models.mjs`) | ✅ Built, tested |
| Adapter loader (`harness/lib/adapter.mjs`, reads `project-adapter.yml`) | ✅ Built, tested — the one file in the harness with an npm dependency (`js-yaml`), scoped deliberately narrowly |
| Context compiler (`harness/lib/context-pack.mjs`) | ✅ Built, tested (7 of 9 functions — screenshots/scorecard stay project-specific plugins) — wired: `run-generation.mjs` calls its builders to assemble every prompt |
| **Orchestrator** (`harness/lib/orchestrator.mjs` + `harness/scripts/run-generation.mjs`) | ✅ **Built, tested, and runnable** — suggest → implement → review → refine, end to end, against your own adapter and brief files |
| Independent reviewer (`harness/lib/review.mjs`) | ✅ Built, tested, wired into the orchestrator |
| Guard (`harness/lib/guard.mjs`, reads `constitution.*` from the adapter) | ✅ Built, tested — still awaiting a workflow step that runs it against a real PR from the orchestrator, since that's CI wiring, not harness code |
| Automated evaluator — test-command runner (`evaluation.test_commands`) | ❌ Not built, and — now that the loop itself is real — turns out not to need any harness *code*: a project's test commands become CI steps directly, the same way the guard already runs as one |
| Quality-dimension evaluator plugins (`harness/lib/evaluators.mjs`, `harness/plugins/evaluators/`) | ✅ Built, tested, wired — the measurements that are explicitly **not** gates. A plugin gets the working tree and the generation record and returns named metrics; it cannot fail a generation, however badly it behaves. One shipped example (`source-weight`), the interface documented, ecosystem-specific plugins (Checkstyle, mypy, Roslyn, the canvas checks) left as extension points |
| Escalation follow-through — work orders, resurfacing, the minority report (`harness/lib/escalations.mjs`, `orchestrator.mjs`) | ✅ Built, tested, wired (`docs/curiosity/C8`): an escalation a human accepts becomes a queued work order that the next ambitious generation is handed and told to deliver, and the outcome is written back — the first label in this project that scores its own *reasoning* rather than its code. An entry nobody has engaged with for N generations is put to the fan-out by name and must be answered AGREE / DISAGREE / IRRELEVANT, because silence was being scored as rejection |
| Failure & proposal memory — escalations ledger (`harness/lib/escalations.mjs`), themes review (`harness/lib/themes.mjs`, `generate-themes.mjs`, `harness/scripts/generate-themes-review.mjs`) | ✅ Built, tested, wired: the orchestrator folds every run's proposals into the ledger and reads it back into the next prompt, and every `memory.themes_review.cadence_generations` generations one model is asked what principle explains the last N — written to `docs/themes/review-NNN.json`, read back into every prompt after it |
| Staging & promotion — merge + tag (`harness/lib/promote.mjs`), deploy verification (`harness/lib/verify-deployment.mjs`) | ✅ Built, tested — all four `verify_strategy` values: `url` (poll + compare), `registry` (npm/PyPI/NuGet/Maven Central), `artifact` (build/path/smoke-run), `none`. Chained automatically by the generated workflow (`harness/templates/workflow.yml.tmpl`). |
| Notifier — plain-language digest with a reliable fallback (`harness/lib/notify.mjs`, `harness/scripts/send-digest.mjs`, `send-escalation-notice.mjs`) | ✅ Built, tested — sender is pluggable (`registerSender()`; SendGrid ships built in, Slack/webhook/another email API are added by registering one under its own name), calibration examples are optional project config, not hardcoded. Chained automatically by the generated workflow. |
| `init` CLI scaffolder (`harness/cli/init.mjs`) | ✅ Built — asks the Portable-Harness-Design.md §6 questions and writes `project-adapter.yml`, the generated workflow, brief-template copies, and an install README for a new project |
| `templates/` — generated workflow (`harness/templates/workflow.yml.tmpl`), agent brief, reviewer brief | ✅ Built, tested (`tests/lib/scaffold.test.mjs` parses every strategy combination's generated YAML back to confirm it's valid); guard config has no separate template — it's `constitution.*` in `project-adapter.yml` itself |

`Portable-Harness-Design.md` §10 has the full build order and reasoning for
what comes next and why.

---

## Where to go deeper

| If you want... | Read |
|---|---|
| What's actually built here, as a picture — and the reference implementation's real 7-job workflow alongside it | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| The concepts, principles, and incidents this is built from — written to be lifted into any project | [`learning/`](learning/), starting with [`learning/README.md`](learning/README.md) |
| Copy-paste templates (agent brief, reviewer brief, guard config, edit format) | [`learning/06-starter-kit.md`](learning/06-starter-kit.md) |
| What's being ported from the reference implementation, what needs genericising, and the proposed repo/CLI structure | [`Portable-Harness-Design.md`](Portable-Harness-Design.md) |
| A real project's configuration written out in the adapter schema, and what that exercise found | [`examples/carrotgame/`](examples/carrotgame/) — for a blank template to actually copy, use [`harness/project-adapter.example.yml`](harness/project-adapter.example.yml) instead |
| The academic framing — the ten-component kernel, research questions, threat model, related work | [`Model-Release-Driven-Software-Improvement-Paper-Outline.md`](Model-Release-Driven-Software-Improvement-Paper-Outline.md) |
| The research corpus this draws on (AlphaEvolve, Darwin Gödel Machine, self-rewarding/self-adapting LMs, harness engineering) | [`docs/`](docs/), indexed in [`docs/SOURCES.md`](docs/SOURCES.md) |
| A proposal for a second longitudinal pass — one that asks what the project still doesn't understand about itself, rather than what pattern is repeating | [`docs/Curiosity-Engine-Design.md`](docs/Curiosity-Engine-Design.md), with a build spec per component in [`docs/curiosity/`](docs/curiosity/) |
| A proposal for a browser-based install flow — connect, configure, store keys, open the PR, rehearse — instead of running `init.mjs` by hand | [`console/DESIGN.md`](console/DESIGN.md) |

## How the three pieces fit together

This repository is really three things at three different stages, meant to
compose into one journey — read this before the per-piece docs above so the
status marks below don't read as contradictions:

1. **Install** (🚧 proposed): a user goes to the console, connects a repo,
   and fills in a form. `console/DESIGN.md` designs this; the front end
   itself doesn't exist. What the console would generate — a filled
   `project-adapter.yml` and a working `.github/workflows/` file — is
   already real code, though: `harness/lib/scaffold.mjs`, driven today by
   `harness/cli/init.mjs`'s terminal prompts rather than a web form. The
   console's real remaining work is a browser front end for a generator
   that already exists, not the generator itself.
2. **Run** (✅ built): the generated workflow schedules the detector, and
   once a new model appears, runs the real suggest → implement → review →
   refine → guard → test → promote → verify → notify loop end to end — see
   "What's actually built here, today" in [`ARCHITECTURE.md`](ARCHITECTURE.md).
   This is the only one of the three stages that runs unattended today.
3. **Learn** (🚧 proposed): `docs/curiosity/` designs a second, slower pass
   over the same run history — harvesting open questions from every
   proposal, promoting the corroborated ones into a themes review, and
   occasionally spending a whole generation on a sourced document instead of
   a diff. None of it is built; every component is designed to attach onto a
   specific file the loop already writes (`escalations.mjs`, `themes.mjs`,
   `context-pack.mjs`) rather than requiring a new one, so a repository with
   no run history yet is unaffected — see "Cold start" in
   [`docs/curiosity/README.md`](docs/curiosity/README.md#cold-start-the-first-runs-must-work-with-none-of-this).

**The seam between stage 1 and stage 2, now closed:** the generated workflow
used to always auto-merge an approved change (`harness/lib/promote.mjs`),
which is the opposite of what the console design calls for. It now renders
one of two paths from `constitution.approval_class` — open a pull request
(the default, and where any unrecognised value lands) or merge autonomously
(the opt-in) — and the `schedule:` block is optional, so an installation can
ship dispatch-only until a rehearsal has passed. See ARCHITECTURE.md's "The
merge model, reconciled" for the full account.

## The bet this depends on

This whole design rests on one external assumption, worth stating plainly
rather than leaving implicit: **frontier labs keep shipping, and each new
model is meaningfully better than the last.** Neither is something this
repository controls, and if either stops being true the loop quietly stops
proposing anything — which is the correct behaviour, not a failure. So it's
worth checking the bet against outside data rather than asserting it.

**Are they still shipping?** The console's
[about page](console/about.html) embeds a live release-cadence chart from
[AI Release Tracker](https://aireleasetracker.com/analytics?utm_source=embed&utm_medium=referral&utm_campaign=releases-by-lab)
— an independent third party, not affiliated with this project. It's an
`<iframe>`, so it renders there and not here: GitHub strips iframes from
markdown, and a screenshot pasted into this file would be a hand-maintained
copy that rots silently, which is exactly what
[`learning/01-principles.md`](learning/01-principles.md) principle 23
("generate the record; never hand-maintain it") warns against.

**Are they getting better in the way that matters here?** The most useful
public measure is METR's **50% task-completion time horizon**: how long a
task takes a skilled human, at the length where an AI agent completes it
successfully half the time. It matters for this project specifically because
it tracks *how much of a change a model can carry unattended* — which is the
thing a governed autonomous loop is actually buying.

| Model | 50% time horizon |
|---|---|
| Claude Opus 4.5 | 320 min |
| GPT-5 | 214 min |
| o3 | 121 min |

Doubling time of that horizon, measured across models released since 2024:
**~89 days**.

Figures from METR's Time Horizon 1.1 set, via
[metr.org/time-horizons](https://metr.org/time-horizons/) (page last updated
8 May 2026; quoted here rather than embedded because METR publishes no
embeddable chart). Carry METR's own caveats with the numbers: confidence
intervals are wide, the trend is sensitive to which tasks are in the suite,
and measurements above 16 hours are unreliable on the current one.

The connection to this repository is direct. A rotating suggest seat is only
worth the plumbing if a genuinely new mind arrives often enough to be worth
asking — that's the first chart. And the curiosity design in
[`docs/curiosity/`](docs/curiosity/) is a bet on the second: if models keep
getting better at long tasks, the binding constraint shifts from *can it
write the change* to *did anyone point it at the right question*.

## The shape of it, in one paragraph

A model release is the trigger, not the calendar. One seat rotates — whichever
lab shipped the newest model gets to propose the change, on its own API, with
fresh eyes. Every other seat (implement, review) stays pinned to a model
you already trust. Proposals are targeted, exact edits — never a full-file
rewrite — applied all-or-nothing and checked against a project's own test
suite before anything merges. An agent can argue that a frozen rule is wrong,
but it cannot change the rule itself; only a human can, and only after
independent models converge on the same complaint. Every run — including the
ones that ship nothing — writes down what it tried, and the next run reads
that back. `learning/01-principles.md` has the full list, each one anchored
to a real incident rather than stated as a bare rule.

## Repo layout (current, not final — see `Portable-Harness-Design.md` §4)

```
self_optimisation/
├── README.md                        # this file
├── Portable-Harness-Design.md       # what ports, what's generic, what's next
├── Model-Release-Driven-Software-Improvement-Paper-Outline.md
├── package.json                     # one dependency (js-yaml, for adapter.mjs/
│                                     # scaffold.mjs only); `npm test` runs harness/'s own suite
├── docs/                            # research corpus, plus curiosity/ — a proposed
│                                     # second longitudinal pass, design only, not built
├── console/                         # a proposed browser-based install flow — the UI
│                                     # (about/mockup/privacy.html, DESIGN.md) is design
│                                     # and wireframe only, not built; its Supabase schema
│                                     # (console/supabase/migrations/) is BUILT and live
│                                     # against a real project, ahead of the UI it backs
├── tests/                           # tests for the harness's OWN code (see above)
│   └── lib/
├── learning/                        # principles, blueprint, failure modes,
│                                     # starter kit, diagrams — ported from the
│                                     # reference implementation, written to
│                                     # need no project-specific knowledge
├── examples/
│   ├── carrotgame/                  # a real installation's config, hand-written
│   │                                 # in the proposed adapter schema, plus notes
│   │                                 # on where the schema had to grow
│   └── workflows/
│       └── watch-releases.yml       # copy-pasteable — see "Getting started" above
└── harness/
    ├── .env.example                 # copy to .env at your project root — see Step 3
    ├── lib/
    │   ├── llm-provider.mjs           # provider-blind registry, transport, retry/headroom
    │   ├── edit-format.mjs            # SEARCH/REPLACE parser, allowlist supplied by the caller
    │   ├── glob.mjs                   # adapter glob strings -> RegExp
    │   ├── model-release-detector.mjs # pure: snapshot-diff, ranking, no fs/env/console
    │   └── probe-models.mjs           # reachability + context-window fit check
    ├── scripts/                       # CLI wrappers — own the filesystem/env/stdio
    │   ├── check-model-releases.mjs, probe-models.mjs, run-generation.mjs
    │   ├── check-guarded-paths.mjs, promote.mjs, verify-deployment.mjs
    │   └── send-digest.mjs, send-escalation-notice.mjs
    ├── templates/                     # agent-brief.md.tmpl, reviewer-brief.md.tmpl,
    │                                   # workflow.yml.tmpl — filled in by cli/init.mjs
    ├── cli/
    │   └── init.mjs                   # scaffolds a new installation end to end
    └── providers/                     # one file per lab, each self-registering
        ├── anthropic.mjs, openai.mjs, google.mjs, moonshot.mjs,
        │   deepseek.mjs, qwen.mjs, xai.mjs, meta.mjs, zai.mjs
        ├── _openai-compatible.mjs     # shared factory for the 6 OpenAI-shaped labs
        ├── index.mjs                  # registers all 9; a project can import a subset instead
        └── CONTRIBUTING-A-PROVIDER.md
```

This tree omits several real, tested `harness/lib/` files for brevity
(`orchestrator.mjs`, `adapter.mjs`, `guard.mjs`, `context-pack.mjs`,
`review.mjs`, `promote.mjs`, `verify-deployment.mjs`, `notify.mjs`,
`escalations.mjs`, `themes.mjs`, `scaffold.mjs`, `api-errors.mjs`) and one
`harness/scripts/` file (`record-pull-request.mjs`) — see
[Status in detail](#status-in-detail) or `ls harness/lib/` for the complete,
current list rather than trusting this diagram to stay exhaustive.
`Portable-Harness-Design.md` §10 has the build order; provider router,
edit-format, the release detector and the reachability probe were step 4's
first four, in the dependency order §7's kernel table implies. Context
compiler is next, and is real design work rather than a port — see §8.2's
note on why `estimateContextSize()` doesn't reduce to a small standalone
function in the reference implementation.
