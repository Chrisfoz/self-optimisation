# Self-Optimisation

MIT licensed — see [`LICENSE`](LICENSE).

Browse the [prompt library](docs/prompt-library/README.md) for reusable project prompts, including the ReXGlue Xbox 360 → Windows example.

A portable harness for model-release-driven software improvement: point it at
a project, and a governed suggest → implement → review → gate → promote loop
lets each newly released frontier model propose one improvement, gated by
that project's own tests before anything ships.

**Status: the whole loop is real, end to end, including the generated
workflow.** Validate → detect → probe → preflight → suggest → implement →
review → refine → guard → test → pull request → notify runs against your own
project's adapter and brief files. `harness/cli/init.mjs` scaffolds a new
installation's `project-adapter.yml` and `.github/workflows/self-improve.yml`
in one pass, and `harness/scripts/rehearse.mjs` runs that entire chain
**locally, on demand**, on a real branch — so the loop can be exercised
without waiting for a lab to ship something. Autonomous merge and the
deployment verification that follows it (all four
`deployment.verify_strategy` values: `url`, `registry`, `artifact`, `none`)
are the opt-in path; opening a pull request and stopping is the default.

The reference implementation is a separate, real project (two educational
HTML games) that has run this loop for 18+ real generations, including real
incidents; this repository is the work of extracting that into something
project-agnostic.

**Real generations have now run through `harness/` itself** — on
2026-09-11, bounded campaigns with real model calls to eight labs (seven answered), on two
deliberately different projects (a children's browser game and a Python
CLI), locally via `rehearse.mjs`. They are written up, failures included, in
[`docs/campaigns/`](docs/campaigns/), and they found real defects in the
harness that the fake-model test suite never could; those are fixed. The
same day **the generated workflow ran three generations on GitHub Actions**
against a real repository — real secrets, a claimed generation number, a
pull request each, records on the default branch, and a pull request's state
read back into its record — and found four more, also fixed.
**What is still not true:** no person has reviewed any of those changes yet,
the read-back of a *merged or closed* pull request has not happened in a real
run, and the Actions runs are in a private repository rather than a public
example. See [`WORKPLAN.md`](WORKPLAN.md) Tier 6. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the five diagrams, and
[its status table](ARCHITECTURE.md#status-in-detail) for the per-component view.

## Harness KPIs and practical learning

[Harness KPIs](docs/harness-kpis/README.md) defines how to measure verified
product improvement, cost, repeated failures, dependency defects and review
accuracy, then test better harness operating strategies. This is a design and
implementation plan; live KPI collection and policy adaptation are not enabled.

---

## Quickstart

In your own project's root, with **Node 22.11 or newer**:

```bash
# 1. Copy the harness in. One folder; there is nothing to install.
git clone --depth 1 https://github.com/Chrisfoz/self-optimisation.git /tmp/self-optimisation
cp -r /tmp/self-optimisation/harness ./harness

# 2. Five questions, with defaults read from your project's own files. Writes
#    project-adapter.yml, the workflow, two brief files to fill in, and a checklist.
node harness/cli/init.mjs --quick

# 3. Paste your lab keys into harness/.env.harness.local, then prove they work.
node --env-file=harness/.env.harness.local harness/scripts/check-keys.mjs

# 4. Put the same keys on GitHub, and allow the workflow to open pull requests.
node harness/cli/init.mjs --configure-github

# 5. Check everything at once; then rehearse one real generation (spends tokens).
node harness/scripts/doctor.mjs
node --env-file=harness/.env.harness.local harness/scripts/rehearse.mjs
```

Then commit and push. Each generation opens a pull request for you to merge;
nothing merges by itself unless you chose that in step 2.

- **Windows PowerShell:** use `$env:TEMP\self-optimisation` for the clone and
  `Copy-Item -Recurse` for `cp -r`.
- **Keys:** which labs, where to sign up, and what each costs are in
  [Step 2 of the install guide](docs/INSTALL.md#step-2--get-api-keys-for-the-labs-you-want-to-watch).
- **Step 4 needs the [GitHub CLI](https://cli.github.com/)** signed in
  (`gh auth login`); without it, it prints the two settings to make by hand.
- **Only want a monthly issue when a new model ships?**
  `node harness/cli/init.mjs --detector-only` instead of step 2.
- **Upgrading later:** `git -C /tmp/self-optimisation pull`, then
  `node /tmp/self-optimisation/bin/self-optimisation.mjs upgrade` — it replaces
  `harness/`, keeps your key file, and regenerates the workflow.
- **Every step explained**, with the reasons and the failure each one
  prevents: [`docs/INSTALL.md`](docs/INSTALL.md).

## Download and run it locally

**This project is for downloading from GitHub and running on your own
computer.** Nothing is hosted for you: you clone it (or download the ZIP),
run it locally, and change whatever you like. It has two halves, and each is
set up in one place:

| Half | Folder | What it is | Configured in |
|---|---|---|---|
| **Frontend** | `console/` | The website: what the project does, how to run it, the ten-step installer, the privacy policy | Page files in `console/`; the shared header and footer in `console/partials/nav.html` and `footer.html`; routes in `PAGES` in `console/server.mjs`; styling in `console/console.css`; the browser-tab icon in `console/favicon.svg`; the port with `PORT`; GitHub sign-in (optional) with the variables in `console/.env.example` |
| **Backend** | `harness/` | The loop that asks each new model to improve a project, gates the change, and opens a pull request | `project-adapter.yml` (labs, editable paths, ambition, budget) and `harness/.env.harness.local` (API keys) in the project you install it into |

The quick version, with [Node.js 22.11+](https://nodejs.org) installed:

```bash
git clone https://github.com/Chrisfoz/self-optimisation.git
cd self-optimisation
npm start          # then open http://localhost:3000 — nothing to install
```

**New to this, or building with an AI assistant?** Open
**http://localhost:3000/how-to-run** once it's running (the source is
[`console/how-to-run.html`](console/how-to-run.html)). It covers every step
in plain language: downloading the project, running the website, putting the
harness into your own project, where each setting lives, prompts you can
paste into Claude Code or Cursor, and fixes for the usual errors. The
[quickstart](#quickstart) above is the same setup as five commands, and
[`docs/INSTALL.md`](docs/INSTALL.md) is it in more depth.

All ten installer steps, and downloading the files they generate, work
locally with no further setup. Connecting the installer to GitHub, so it can
read your repository and open the setup pull request, needs a GitHub App of
your own; [`console/DEPLOYMENT.md`](console/DEPLOYMENT.md) covers it.

**Without installing Node:** open the repository in a GitHub Codespace (or
locally with the Dev Containers extension) — [`.devcontainer/`](.devcontainer/)
brings Node 22 and the GitHub CLI — or run the console as a container:

```bash
docker build -t self-optimisation-console .
docker run -p 3000:3000 self-optimisation-console
```

To host it, `railway.json` is set up for Railway, the [`Dockerfile`](Dockerfile)
suits any host that runs images, and any host that runs `npm start` works,
with `/healthz` as the health check.

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
one-off manual end-to-end runs, not a replacement for the
per-module suite — it exists to catch the failure the per-module tests
structurally can't: two pieces individually correct but disagreeing at the
seam (a field name, a branch/tag convention, what a gate result string
actually says once it reaches the digest).

`tests/e2e/mock-labs.test.mjs` is the third layer, and the one that
crosses the boundary the other two stop at. It runs the **scripts** — the
detector, the probe, `rehearse.mjs` (validate → preflight → campaign →
probe → baseline measurement → suggest → rank → implement → in-loop tests →
review → refine → persist → guard → tests), runtime evidence, the themes
review and the report — as child processes on a scratch project, with
`HARNESS_LAB_ENDPOINT` pointing every lab at
[`tests/helpers/mock-labs.mjs`](tests/helpers/mock-labs.mjs): one loopback
server that answers in all nine labs' dialects, checks each lab's own auth
header, serves each lab's catalogue listing and reports usage. Only the
labs' *answers* are scripted; each provider file's real request reaches a
server and comes back through that provider's real parser. Three
generations run across all nine labs, with an in-loop test failure
repaired, a review rejection refined, an escalation reaching consensus,
another resurfaced and retired, a work order carried, and a themes review
whose open question lands in the next prompt. The override is honoured only
for a loopback address, because the request carries the key.

```bash
npm test
```

Zero dependencies here too: `node:test` and `node:assert` are Node
built-ins, so there's no test framework to install. The count is whatever
`npm test` prints — it is not repeated here, because a hand-typed number
drifted three ways before this sentence replaced it.

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
`evaluation.test_commands` in `harness/project-adapter.example.yml`).
That convention is for the project *being improved*; this suite is for the
harness *doing the improving*. Keep the distinction — conflating them was
never intended.

## Where to go deeper

| If you want... | Read |
|---|---|
| Every install step explained — keys, the env file, local testing, GitHub setup, what only you can provide, OS notes | [`docs/INSTALL.md`](docs/INSTALL.md) |
| The status of every component, how install / run / learn fit together, the bet on model releases, and the repo layout | [`ARCHITECTURE.md`](ARCHITECTURE.md#status-in-detail) |
| What's actually built here, as a picture — and the reference implementation's real 7-job workflow alongside it | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| The design rules a change to this repository has to keep — the dependency rule, the three-way status agreement, where a new file goes | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| How real outcomes could improve the harness's own context, memory and review strategy | [`docs/harness-kpis/README.md`](docs/harness-kpis/README.md), including [workflow integration](docs/harness-kpis/workflow-integration.md) and [the proposed diagram](ARCHITECTURE.md#proposed-kpi-learning-loop) |
| The concepts, principles, and incidents this is built from — written to be lifted into any project | [`learning/`](learning/), starting with [`learning/README.md`](learning/README.md) |
| Copy-paste templates (agent brief, reviewer brief, guard config, edit format) | [`learning/06-starter-kit.md`](learning/06-starter-kit.md) |
| What's being ported from the reference implementation, what needs genericising, and the proposed repo/CLI structure | [`Portable-Harness-Design.md`](Portable-Harness-Design.md) |
| The academic framing — the ten-component kernel, research questions, threat model, related work | [`Model-Release-Driven-Software-Improvement-Paper-Outline.md`](Model-Release-Driven-Software-Improvement-Paper-Outline.md) |
| The research corpus this draws on (AlphaEvolve, Darwin Gödel Machine, self-rewarding/self-adapting LMs, harness engineering) | [`docs/`](docs/), indexed in [`docs/SOURCES.md`](docs/SOURCES.md) |
| A proposal for a second longitudinal pass — one that asks what the project still doesn't understand about itself, rather than what pattern is repeating | [`docs/Curiosity-Engine-Design.md`](docs/Curiosity-Engine-Design.md), with a build spec per component in [`docs/curiosity/`](docs/curiosity/) |
| The working browser installer, its deployment requirements and limitations | [`console/DEPLOYMENT.md`](console/DEPLOYMENT.md), [`console/IMPLEMENTATION.md`](console/IMPLEMENTATION.md) |
| An outside review of the concept and the code, a SWOT, and the workplan additions it proposes to run this as a product | [`docs/Review-SWOT-2026-09.md`](docs/Review-SWOT-2026-09.md) |
| Whether the models should get tools — MCP, a renderer, a physics engine — which of the three kinds is worth building, and the per-seat rules that keep a gate a gate | [`docs/Tool-Use-Design.md`](docs/Tool-Use-Design.md) |
| A second review, two days later, and a proposed six-phase plan for a tenfold improvement against the portable-harness objective — reach, yield, magnitude, trust, each with a number to move | [`docs/Review-10x-2026-09.md`](docs/Review-10x-2026-09.md) |
| What happened when the model calls were real — four generations on two projects, the records as written, and the seven harness defects they found | [`docs/campaigns/`](docs/campaigns/) |
| The end-to-end test plan and its results — project selection, all nine labs, a nine-model generation, repair and refine, the curiosity mechanisms — run against a loopback stand-in for the labs, and what still needs real keys | [`docs/Harness-E2E-Test-Plan-2026-09.md`](docs/Harness-E2E-Test-Plan-2026-09.md) |
