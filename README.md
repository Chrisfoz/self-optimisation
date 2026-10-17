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
[Status in detail](#status-in-detail) for the per-component table.

## Harness KPIs and practical learning

[Harness KPIs](docs/harness-kpis/README.md) defines how to measure verified
product improvement, cost, repeated failures, dependency defects and review
accuracy, then test better harness operating strategies. This is a design and
implementation plan; live KPI collection and policy adaptation are not enabled.

---

## Download and run it locally

**This project is for downloading from GitHub and running on your own
computer.** Nothing is hosted for you: you clone it (or download the ZIP),
run it locally, and change whatever you like. It has two halves, and each is
set up in one place:

| Half | Folder | What it is | Configured in |
|---|---|---|---|
| **Frontend** | `console/` | The website: what the project does, how to run it, the ten-step installer, the privacy policy | Page files in `console/`; the shared header and footer in `console/partials/nav.html` and `footer.html`; routes in `PAGES` in `console/server.mjs`; styling in `console/console.css`; the browser-tab icon in `console/favicon.svg`; the port with `PORT`; GitHub sign-in (optional) with the variables in `console/.env.example` |
| **Backend** | `harness/` | The loop that asks each new model to improve a project, gates the change, and opens a pull request | `project-adapter.yml` (labs, editable paths, ambition, budget) and `.env` (API keys) in the project you install it into |

The quick version, with [Node.js 22.11+](https://nodejs.org) installed:

```bash
git clone https://github.com/Chrisfoz/self-optimisation.git
cd self-optimisation
npm install
npm start          # then open http://localhost:3000
```

**New to this, or building with an AI assistant?** Open
**http://localhost:3000/how-to-run** once it's running (the source is
[`console/how-to-run.html`](console/how-to-run.html)). It covers every step
in plain language: downloading the project, running the website, putting the
harness into your own project, where each setting lives, prompts you can
paste into Claude Code or Cursor, and fixes for the usual errors. The section
below is the same backend setup in more depth.

All ten installer steps, and downloading the files they generate, work
locally with no further setup. Connecting the installer to GitHub, so it can
read your repository and open the setup pull request, needs a GitHub App of
your own; [`console/DEPLOYMENT.md`](console/DEPLOYMENT.md) covers it. To host
the website somewhere else, `railway.json` is set up for Railway, and any
host that runs `npm start` works, with `/healthz` as the health check.

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

Copying the folder is not quite the whole install. Almost everything in
`harness/` uses only Node's own built-ins (`https`, `fs`, `path`,
`node:test`) — the provider router, edit-format, detector and reachability
probe need no `npm install` at all. **Two** files need a real YAML parser
(`js-yaml`, plus one small transitive dependency of its own), and the
difference between them decides whether you can skip this step:

- `harness/lib/adapter.mjs` imports it **lazily**, inside the function that
  parses `project-adapter.yml`. A command that never reads an adapter never
  needs it.
- `harness/lib/scaffold.mjs` imports it **at load**, because it writes YAML.
  `harness/cli/init.mjs` imports `scaffold.mjs`, so **Step 7 below fails with
  `Cannot find package 'js-yaml'` unless you run this first**:

```bash
npm install --prefix harness --no-save --no-package-lock js-yaml@5.3.0
```

That installs it into `harness/node_modules`, where only the harness looks
for it; your project's own `package.json`, lock file and installed packages
are left alone. Make sure your `.gitignore` covers `node_modules/`.

> **Don't install it at your project's top level.** Tested, a top-level
> install can quietly swap your project's own copy of js-yaml for this one,
> breaking code that uses the older API; delete packages you installed by
> hand; and, in a project with no `package.json`, install into the nearest
> parent folder that has one, which can be your home folder. A later
> `npm ci` also removes it again.

Every other kernel component works with zero dependencies whether or not you
ever run `npm install`. You do need **Node.js 22.11 or newer** (the first 22.x LTS). `--env-file`
and the built-in test runner, both used below and both chosen specifically to
avoid needing a dependency for either, are older than that — but `npm test`
passes a glob to `node --test`, which Node 20 reads as a literal filename,
and 22.11 is the oldest version CI actually runs the suite on. Node 20 is
past end of life. Check with:

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

### Step 3 — Local testing: `harness/.env.harness.local` (never committed)

Copy the example file, keeping the `.local` suffix:

```bash
cp harness/.env.harness.example harness/.env.harness.local
```

`node harness/cli/init.mjs` also writes this file for you, and never
overwrites one that already exists.

**Why not `.env`.** Most real applications already keep a `.env` at their
root — a database URL, a deploy token, their own model key — and copying
over it destroys that file. The two are separate on purpose: your web
server has no reason to hold nine labs' API keys, and this harness has no
reason to hold your database's service-role key. `.env.harness.local`
cannot collide with a project `.env`, whatever that project already does.

Open `harness/.env.harness.local` and paste in the keys from Step 2, next
to the matching variable name. Leave every line you don't have a key for
blank or delete it — an unwatched provider costs nothing.

**Put them in the `.local` file, not the `.example` one.**
`harness/.env.harness.example` is tracked by git and holds placeholders
only. Filling in the tracked one is how keys reach a commit, and the two
filenames exist to keep that from happening.

**This file must never be committed.** If you copied `harness/` into an
existing project, add this to your `.gitignore` now, before you forget —
`.env.*` with no leading slash, so it matches inside `harness/` too:

```
.env
.env.*
!.env.harness.example
```

Then prove it, rather than assuming:

```bash
git check-ignore -v harness/.env.harness.local   # must print a matching rule
git ls-files harness/.env.harness.local          # must print nothing
```

Unlike most Node setups, this harness reads the file **without a
dependency** — no `dotenv` package, no build step. Node loads it natively:

```bash
node --env-file=harness/.env.harness.local harness/scripts/check-model-releases.mjs
```

That one flag is also why this step is identical on Windows, macOS, and
Linux: the file is parsed by Node itself, not by your shell, so there's no
`export VAR=value` vs. `$env:VAR = "value"` difference to worry about here.

### Step 4 — Try it locally

Run the detector against just the labs you added keys for:

```bash
node --env-file=harness/.env.harness.local harness/scripts/check-model-releases.mjs --providers anthropic,openai
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
walkthrough that's the opposite of `.env.harness.local` — it holds no secrets and it
*must* travel with the repo. `examples/workflows/watch-releases.yml`
already commits it automatically as part of the workflow (Step 6 below).

The same snapshot is what the console's model picker reads when you connect
a repository: it is the only live list of models your account can actually
call that ever reaches a browser, because the console holds no lab key. To
refresh the shorter list the console ships with instead — for a deploy of
your own — run

```bash
node --env-file=harness/.env.harness.local harness/scripts/refresh-model-catalogue.mjs
```

which lists every lab you hold a key for and rewrites
[`harness/data/model-catalogue.json`](harness/data/model-catalogue.json). A
lab with no key keeps whatever that file already had rather than being
emptied.

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

Once `project-adapter.yml`, `constitution.allowed_paths`, and the two brief
files exist, `node harness/scripts/validate.mjs` checks the adapter for the
config mistakes that would otherwise only surface mid-run — an editable
path that doesn't exist, an allowlist that contradicts the frozen paths, an
unregistered provider — and `node --env-file=harness/.env.harness.local harness/scripts/rehearse.mjs`
runs the *whole* loop locally on a real branch: detect or campaign, probe,
preflight, the actual suggest → implement → review cycle, guard, your own
tests — everything the generated workflow does except push, open a pull
request, or merge. With no lab key configured it's a safe, deterministic
no-op; with keys, it's the fastest way to see a real generation before
turning the schedule on. `node harness/scripts/rehearse.mjs --models
claude-opus-5` forces a campaign generation on a model you name, rather
than waiting for a new release.

### Step 5 — GitHub setup: repository secrets

`harness/.env.harness.local` is for your machine only. For the detector to run on a schedule in
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

You're adding the *same values* as `harness/.env.harness.local`, into a *different place*, for a
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
**What this particular workflow does:** checks your chosen labs, commits the
updated snapshot, and opens a GitHub issue when a genuinely new model
appears. It deliberately stops there — it is the detector alone, useful on
its own as a monthly nudge that a model worth trying now exists. The **full**
loop (suggest → implement → review → guard → test → pull request → notify) is
built, and `harness/cli/init.mjs` generates the workflow that runs it; see
[`ARCHITECTURE.md`](ARCHITECTURE.md) for both diagrams and Step 7 below.

### Step 7 — The full loop

```bash
node harness/cli/init.mjs                              # asks, then writes project-adapter.yml + the workflow
node harness/cli/init.mjs --from-adapter --force       # later: regenerate the workflow from the adapter you edited
```

**Or install it shared, once this repository is public.** Instead of keeping a
copy of `harness/` in your project, `node <path-to>/harness/cli/init.mjs
--shared <commit-sha>` writes a short workflow that calls this repository's
shared workflow at that commit. Upgrading is then a one-line change to the
commit. Test and dependency setup commands live in `project-adapter.yml`
(`evaluation.test_commands`, `evaluation.setup_commands`) and are read once per
run, from your default branch. While this repository is private, other
repositories cannot read it, so use the copied install above. See
[`console/DEPLOYMENT.md`](console/DEPLOYMENT.md), "Shared harness".

Three things the generated workflow needs that are easy to miss:

- **The pull-request path needs one repository setting GitHub turns off by
  default:** Settings → Actions → General → Workflow permissions → **Allow
  GitHub Actions to create and approve pull requests**. Without it every
  generation passes its gates and then cannot open its pull request.
  - **It is on the repository, and not on the page you'd guess.** Open
    `https://github.com/OWNER/REPO/settings/actions`, or in the repository's
    **Settings** click **Actions** in the left sidebar, then **General**, then
    scroll to the **Workflow permissions** box at the bottom. **Settings →
    General** has a *Pull Requests* section (merge commits, squash, rebase,
    auto-merge) that looks like the right place and isn't. Your account's own
    settings don't have this switch either.
  - **The tickbox is the part that matters; the radio above it does not.**
    The generated workflow declares its own
    `permissions: contents: write, pull-requests: write`, and an explicit
    block overrides the repository default — so **Read repository contents
    and packages permissions** (read-only) is enough, and is the tighter
    choice, because the radio sets the default for *every other workflow in
    the repository* that doesn't declare its own. **Read and write** also
    works and is what most people pick. The tickbox is different: no workflow
    can grant itself permission to create pull requests, so without it every
    generation passes its gates and then cannot open one.
  - **Check it saved.** During the first real install, Read and write saved
    but the tickbox didn't, and nothing on the page said so. Check with
    `gh api repos/OWNER/REPO/actions/permissions/workflow`: you want
    `"can_approve_pull_request_reviews":true`. Or set both at once — this is
    the same command the generated `SELF-IMPROVE-README.md` gives, keeping
    the default read-only:
    `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.
- **A secret for every lab the workflow calls:** the watched labs and the
  labs your implement, review and rank models belong to. The generated
  `SELF-IMPROVE-README.md` lists exactly which. Add them under the
  repository's **Settings → Secrets and variables → Actions** as *repository*
  secrets. A digest email adds one more: `SENDGRID_API_KEY`, alongside a
  `notify:` block in `project-adapter.yml` and a regenerated workflow
  (`init.mjs --from-adapter --force`). Without that block, the workflow has
  no email step.
- **No GitHub personal access token.** The workflow pushes its branch and
  opens its pull request with GitHub's built-in `github.token`, using the
  permissions it declares. Nothing reads a `GH_PAT`, so don't create one and
  don't keep one in your key file. One side effect: GitHub does not start
  other workflows (such as your own CI) for pull requests opened with that
  built-in token. The loop runs your test commands itself before it opens the
  pull request, so the gate is still there.

**Where to see how it's going:** every run rebuilds
`docs/generations/index.html`, the run history, and commits it with the run's
record. It shows every generation newest first:
- which model suggested the change;
- the change in plain words;
- whether it shipped, is waiting for your review, or why it didn't ship,
  with each failed attempt and its reason;
- what it cost in tokens.

Pull requests waiting for you are listed at the top. It's one self-contained
file: open it from a checkout or a download. GitHub shows HTML as source, so
use GitHub Pages to browse it on the web. `docs/generations/REPORT.md`
carries the same records as metrics, and GitHub renders it. These are operational
measures of process outcomes and resource use. A kept or merged change is not a
verified successful change, and promotion precision is not review accuracy.
The [KPI design](docs/harness-kpis/README.md) describes the additional independent
assessment and follow-up that would be needed.

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
| Provider API keys | `harness/.env.harness.local` locally, GitHub Secrets in CI | **Used immediately** — the detector calls the real API the moment a key is present (Step 2–5) |
| Which labs to watch | `project-adapter.yml` → `providers.watched` | **Used immediately** — read by `check-model-releases.mjs` on every run |
| Frozen / append-only paths, frozen JSON fields, churn ceiling | `project-adapter.yml` → `constitution.frozen_paths` / `append_only_paths` / `frozen_fields` / `churn_ceiling` | **Used immediately** — `harness/scripts/check-guarded-paths.mjs` enforces these against a real git diff today |
| Which paths an agent may edit or create | `project-adapter.yml` → `constitution.allowed_paths` / `create_only_paths` | **Used immediately** — `run-generation.mjs` compiles this into `edit-format.mjs`'s allowlist and enforces it against every edit the orchestrator produces |
| Your actual test commands | Given to `harness/cli/init.mjs` when it scaffolds a new installation; echoed into `project-adapter.yml` → `evaluation.test_commands` (read back by `harness/scripts/rehearse.mjs` for a local run; the generated workflow uses its own baked-in copy, deliberately — one source of truth for what CI runs) | **Used immediately** — rendered straight into the generated workflow's preflight and post-guard test steps; if you add or change commands later, edit both the workflow and `evaluation.test_commands` by hand, since re-running `init` won't overwrite an existing workflow file |
| How ambitious each run may be | `project-adapter.yml` → `context.ambition` (`focused` / `earned` / `ambitious`), or per run from the Actions tab's **Run workflow** → `scope` | **Used immediately** — `run-generation.mjs` reads it every run. `earned` is the default; the gates are the same at every setting; see [`docs/Ambition-Control.md`](docs/Ambition-Control.md) for the risks and for `revert-generation.mjs`, which exists because of this dial |
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

- **env-file loading is identical everywhere** — see Step 3. This is a real
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
| Adapter loader (`harness/lib/adapter.mjs`, reads `project-adapter.yml`) | ✅ Built, tested — one of the two files in the harness with an npm dependency (`js-yaml`), and the one that loads it lazily, so a command that never reads an adapter never needs it installed |
| Adapter validation (`harness/lib/validate.mjs`, `harness/scripts/validate.mjs`) | ✅ Built, tested — every editable path exists, allowed paths never overlap frozen or append-only ones, `.github/**` is frozen unless deliberately overridden, brief files exist and are flagged for unfilled `[placeholder]`s, every watched or pinned lab is registered and warned about if its key is missing. Run by `init` (advisory), `rehearse` (blocking), and as the generated workflow's own first step — a failure reaches the digest as its own no-generation reason, never as a quiet cycle |
| Local rehearsal (`harness/lib/rehearse.mjs`, `harness/scripts/rehearse.mjs`) | ✅ Built, tested — the same chain the generated workflow runs (validate → preflight → detect or campaign → probe → a local `agent/gen-NNN` branch → the real orchestrator → guard → tests), as a thin sequencer over the same CLIs the workflow calls, so it can never drift from what the workflow does. Never pushes, opens a pull request, or merges; deterministic and network-free with no lab key configured |
| Context compiler (`harness/lib/context-pack.mjs`) | ✅ Built, tested (7 of 9 functions — screenshots/scorecard stay project-specific plugins) — wired: `run-generation.mjs` calls its builders to assemble every prompt |
| **Orchestrator** (`harness/lib/orchestrator.mjs` + `harness/scripts/run-generation.mjs`) | ✅ **Built, tested, and runnable** — suggest → implement → review → refine, end to end, against your own adapter and brief files |
| Independent reviewer (`harness/lib/review.mjs`) | ✅ Built, tested, wired into the orchestrator |
| Guard (`harness/lib/guard.mjs`, reads `constitution.*` from the adapter) | ✅ Built, tested — still awaiting a workflow step that runs it against a real PR from the orchestrator, since that's CI wiring, not harness code |
| Automated evaluator — test-command runner (`evaluation.test_commands`) | ✅ Built, in the two places it belongs. In CI it needs no harness *code*: a project's test commands are rendered straight into the generated workflow as steps, the same way the guard runs as one, so a run fails on the commands CI actually ran. `harness/scripts/rehearse.mjs` reads the adapter's own copy to run the identical gates locally — the one deliberate reader of that field, documented in `adapter.mjs`'s `evaluationConfig()` |
| Quality-dimension evaluator plugins (`harness/lib/evaluators.mjs`, `harness/plugins/evaluators/`) | ✅ Built, tested, wired — the measurements that are explicitly **not** gates. A plugin gets the working tree and the generation record and returns named metrics; it cannot fail a generation, however badly it behaves. One shipped example (`source-weight`), the interface documented, ecosystem-specific plugins (Checkstyle, mypy, Roslyn, the canvas checks) left as extension points |
| Probes that render, simulate or observe — and the two sockets that carry what they saw ([`docs/Tool-Use-Design.md`](docs/Tool-Use-Design.md) phase 1) | ✅ Built, tested — a plugin may now write into one given directory and return **images** and **observations**, not just numbers. Images from the last generation are attached to the next suggestion call (with their provenance stated, so "current" cannot mean a stale render); observations are read into its prompt. `evaluation.visual_capture` runs the same interface *inside* a generation so the **reviewer** sees a render of the change under review. This is where Blender, a physics probe or a headless browser belongs — the harness ships none of them and has no opinion about your ecosystem. Phases 2–5 (a tool contract, MCP, model-authored tools) are design only |
| Runtime evidence (`harness/lib/runtime-evidence.mjs`, `context-pack.mjs`'s `buildRuntimeEvidence()`) | ✅ Built, tested, wired (`docs/curiosity/C10`): what the tests, the deploy check and any project probe **actually observed**, read back into the next generation's prompt. Every other block in that prompt describes what the project *is*; this is the only one that describes what it *did*. Observations, never scores — and when the budget runs out it is the totals that go, not a skipped test's name |
| Escalation follow-through — work orders, resurfacing, the minority report (`harness/lib/escalations.mjs`, `orchestrator.mjs`) | ✅ Built, tested, wired (`docs/curiosity/C8`): an escalation a human accepts becomes a queued work order that the next ambitious generation is handed and told to deliver, and the outcome is written back — the first label in this project that scores its own *reasoning* rather than its code. An entry nobody has engaged with for N generations is put to the fan-out by name and must be answered AGREE / DISAGREE / IRRELEVANT, because silence was being scored as rejection |
| Failure & proposal memory — escalations ledger (`harness/lib/escalations.mjs`), themes review (`harness/lib/themes.mjs`, `generate-themes.mjs`, `harness/scripts/generate-themes-review.mjs`) | ✅ Built, tested, wired: the orchestrator folds every run's proposals into the ledger and reads it back into the next prompt, and every `memory.themes_review.cadence_generations` generations one model is asked what principle explains the last N — written to `docs/themes/review-NNN.json`, read back into every prompt after it |
| Staging & promotion — merge + tag (`harness/lib/promote.mjs`), deploy verification (`harness/lib/verify-deployment.mjs`) | ✅ Built, tested — all four `verify_strategy` values: `url` (poll + compare), `registry` (npm/PyPI/NuGet/Maven Central), `artifact` (build/path/smoke-run), `none`. Chained automatically by the generated workflow (`harness/templates/workflow.yml.tmpl`). |
| Notifier — plain-language digest with a reliable fallback (`harness/lib/notify.mjs`, `harness/scripts/send-digest.mjs`, `send-escalation-notice.mjs`) | ✅ Built, tested — sender is pluggable (`registerSender()`; SendGrid ships built in, Slack/webhook/another email API are added by registering one under its own name), calibration examples are optional project config, not hardcoded. Chained automatically by the generated workflow. |
| `init` CLI scaffolder (`harness/cli/init.mjs`) | ✅ Built — asks the Portable-Harness-Design.md §6 questions and writes `project-adapter.yml`, the generated workflow, brief-template copies, and an install README for a new project |
| Cost accounting + budget cap (`harness/lib/spend.mjs`, `budget.max_generation_tokens`) | ✅ Built, tested — every underlying request is metered (headroom and text-only retries each count) and reserves its estimated input plus its whole output allowance *before* it is sent, so a parallel fan-out or a retry cannot overshoot the cap; a refused call ends the attempt loop as `budget-exhausted`, never a crash. Every `attempts.json` carries `spend`, with failed and refused requests counted separately. Tokens, not money |
| Tests inside the repair loop (`harness/lib/test-runner.mjs`, `evaluation.test_in_loop`) | ✅ Built, tested, **proven on real runs** — a baseline on the untouched tree, then the project's own `test_commands` against each attempt before it is reviewed; a failure goes back to the implementer as its failing lines. The child process never sees a credential. In both real campaigns so far a suggester's own edits failed the tests and the loop repaired them ([`docs/campaigns/`](docs/campaigns/)) |
| Before/after measurement (`harness/lib/measure.mjs`, `run-evaluators.mjs --baseline`) | ✅ Built, tested — the same evaluators, fingerprinted, on the untouched tree and the changed one; `comparison.json` names benefits and regressions by each metric's declared direction, beside cost; `REPORT.md` adds what a person did with each change |
| Generation identity and records (`harness/lib/generation-id.mjs`, `persist-records.mjs`) | ✅ Built, tested against a real remote — the next number is one past any tag, agent branch or record; the branch is claimed with a lease; every record carries a run id and is committed to the default branch on every outcome, failures included. The agent branch carries code only |
| Strict review verdict (`review.mjs`'s `parseVerdict()`) | ✅ Built, tested — exactly one `VERDICT:`, exactly APPROVED or REJECTED, an approval must end `END OF REVIEW` and list no required fixes; truncated, contradictory or malformed responses are rejections, and an unreadable review is asked once more before an attempt is spent |
| Pull-request read-back (`harness/lib/pull-requests.mjs`, `harness/scripts/sync-pull-request-outcomes.mjs`) | ✅ Built, tested — merged / open / closed written into the record at the top of every cycle; a closed pull request breaks the clean streak and reaches the next prompt as CLOSED UNMERGED |
| Rollback (`harness/lib/rollback.mjs`, `harness/scripts/revert-generation.mjs`) | ✅ Built, tested against a real remote on both merge paths — reverts the shipped merge, records `reverted`, the next run reads it as a failure |
| The ambition dial (`context.ambition`, [`docs/Ambition-Control.md`](docs/Ambition-Control.md)) and scope-aware ranking | ✅ Built, tested — `focused` / `earned` (default) / `ambitious`, read at run time, per-run override from the Actions tab; the ranking rubric follows the scope; a lone ambitious failure no longer resets the streak |
| Seats (`harness/lib/seats.mjs`) — cross-family ranker, seat promotion | ✅ Built, tested — the rank seat defaults to another lab's model from the snapshot; a rotating model whose own edits keep being approved and kept can earn the implement seat (`roles.promotion`, off by default); the review seat is never auto-assigned |
| Harness KPIs and practical strategy learning ([`docs/harness-kpis/`](docs/harness-kpis/)) | Design and templates only. Existing spend, attempt and PR records are inputs; independent outcome assessments, a verified KPI scorecard and controlled policy adaptation are not implemented. |
| Operational report (`harness/lib/report.mjs` → `<generationsDir>/REPORT.md`) | ✅ Built, tested — the paper's §7 metrics from the records, regenerated every cycle, never hand-edited |
| Run history page (`harness/lib/run-history.mjs` → `<generationsDir>/index.html`) | ✅ Built, tested — one self-contained page for the owner: every generation newest first, the change in plain words, its outcome and pull request, failed attempts with their reasons, tokens and cache savings, pull requests waiting for review, open escalations. Rebuilt after every run with the record and at the start of each cycle once fates are read back. Every installation gets it; no configuration |
| Campaign mode (`harness/lib/campaign.mjs`, the workflow's `models` input) | ✅ Built, tested — a generation now, on models named by hand, recorded as `campaign: true` |
| The committed goal (`project.goal`, [`docs/curiosity/C1`](docs/curiosity/C1-committed-goal.md)) and the themes review's `UNKNOWN` field ([`C2`](docs/curiosity/C2-themes-review-cli.md) phase A) | ✅ Built, tested — the goal sits above the brief, the reviewer rejects drift from it, the guard refuses a diff that edits it; a review may name open questions, rendered as their own section and dropped when none |
| Kill switch, version stamp, pinned supply chain | ✅ Built, tested — `SELF_IMPROVE_PAUSED` repository variable; `harness/VERSION` in every adapter and record; actions by SHA, `js-yaml` exact with scripts disabled |
| Shared-workflow installation (`harness/lib/workflow-config.mjs`, `harness/scripts/render-shared-workflow.mjs`, `renderCallerWorkflow()`) | ✅ Built, tested — instead of copying `harness/`, the target repository gets a small caller workflow that calls this repository's `.github/workflows/self-improve.yml` at a pinned commit. Note the behavioural difference: in this mode `evaluation.test_commands` and `setup_commands` are LIVE (the shared workflow runs them) rather than RECORDED |
| `templates/` — generated workflow (`harness/templates/workflow.yml.tmpl`), agent brief, reviewer brief | ✅ Built, tested (`tests/lib/scaffold.test.mjs` parses every strategy combination's generated YAML back to confirm it's valid); guard config has no separate template — it's `constitution.*` in `project-adapter.yml` itself |

`Portable-Harness-Design.md` §10 has the full build order and reasoning for
what comes next and why.

---

## Where to go deeper

| If you want... | Read |
|---|---|
| What's actually built here, as a picture — and the reference implementation's real 7-job workflow alongside it | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| The design rules a change to this repository has to keep — the dependency rule, the three-way status agreement, where a new file goes | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| How real outcomes could improve the harness's own context, memory and review strategy | [`docs/harness-kpis/README.md`](docs/harness-kpis/README.md), including [workflow integration](docs/harness-kpis/workflow-integration.md) and [the proposed diagram](ARCHITECTURE.md#proposed-kpi-learning-loop) |
| The concepts, principles, and incidents this is built from — written to be lifted into any project | [`learning/`](learning/), starting with [`learning/README.md`](learning/README.md) |
| Copy-paste templates (agent brief, reviewer brief, guard config, edit format) | [`learning/06-starter-kit.md`](learning/06-starter-kit.md) |
| What's being ported from the reference implementation, what needs genericising, and the proposed repo/CLI structure | [`Portable-Harness-Design.md`](Portable-Harness-Design.md) |
| A real project's configuration written out in the adapter schema, and what that exercise found | [`examples/carrotgame/`](examples/carrotgame/) — for a blank template to actually copy, use [`harness/project-adapter.example.yml`](harness/project-adapter.example.yml) instead |
| The academic framing — the ten-component kernel, research questions, threat model, related work | [`Model-Release-Driven-Software-Improvement-Paper-Outline.md`](Model-Release-Driven-Software-Improvement-Paper-Outline.md) |
| The research corpus this draws on (AlphaEvolve, Darwin Gödel Machine, self-rewarding/self-adapting LMs, harness engineering) | [`docs/`](docs/), indexed in [`docs/SOURCES.md`](docs/SOURCES.md) |
| A proposal for a second longitudinal pass — one that asks what the project still doesn't understand about itself, rather than what pattern is repeating | [`docs/Curiosity-Engine-Design.md`](docs/Curiosity-Engine-Design.md), with a build spec per component in [`docs/curiosity/`](docs/curiosity/) |
| The working browser installer, its deployment requirements and limitations | [`console/DEPLOYMENT.md`](console/DEPLOYMENT.md), [`console/IMPLEMENTATION.md`](console/IMPLEMENTATION.md) |
| An outside review of the concept and the code, a SWOT, and the workplan additions it proposes to run this as a product | [`docs/Review-SWOT-2026-09.md`](docs/Review-SWOT-2026-09.md) |
| Whether the models should get tools — MCP, a renderer, a physics engine — which of the three kinds is worth building, and the per-seat rules that keep a gate a gate | [`docs/Tool-Use-Design.md`](docs/Tool-Use-Design.md) |
| A second review, two days later, and a proposed six-phase plan for a tenfold improvement against the portable-harness objective — reach, yield, magnitude, trust, each with a number to move | [`docs/Review-10x-2026-09.md`](docs/Review-10x-2026-09.md) |
| What happened when the model calls were real — four generations on two projects, the records as written, and the seven harness defects they found | [`docs/campaigns/`](docs/campaigns/) |
| The end-to-end test plan and its results — project selection, all nine labs, a nine-model generation, repair and refine, the curiosity mechanisms — run against a loopback stand-in for the labs, and what still needs real keys | [`docs/Harness-E2E-Test-Plan-2026-09.md`](docs/Harness-E2E-Test-Plan-2026-09.md) |

## How the three pieces fit together

This repository is really three things at three different stages, meant to
compose into one journey — read this before the per-piece docs above so the
status marks below don't read as contradictions:

1. **Install** (implemented; deployment configuration required): the console
   provides ten setup steps backed by the real generator, complete bundle
   downloads, GitHub App sign-in, repository discovery, secret-name checks,
   setup PR creation, rehearsal dispatch and gate-based activation PRs. Keys
   are entered directly on GitHub, never in the console. GitHub operations
   require the App variables in [`console/DEPLOYMENT.md`](console/DEPLOYMENT.md).
   Automated integration tests use fake GitHub responses; a live authenticated
   acceptance run is still required. Existing installations are not overwritten.
2. **Run** (✅ built): the generated workflow validates the adapter, checks
   the watched labs, and once a new model appears runs the real suggest →
   implement → review → refine → guard → test → **pull request** → notify
   loop end to end (autonomous merge, and the deployment verification that
   follows it, are the opt-in path). `harness/scripts/rehearse.mjs` runs the
   same chain locally on demand, so this stage can be exercised without
   waiting for a release — see the diagrams in
   [`ARCHITECTURE.md`](ARCHITECTURE.md). This is the only one of the three
   stages that runs unattended today.
3. **Learn** (🚧 partly built): `docs/curiosity/` designs a second, slower
   pass over the same run history — harvesting open questions from every
   proposal, promoting the corroborated ones into a themes review, and
   occasionally spending a whole generation on a sourced document instead of
   a diff. Four of its ten components are built (C1 the goal, C2's `UNKNOWN`
   field, C8 escalation follow-through, C10 runtime evidence); the rest wait
   on the A′ go/no-go (`WORKPLAN.md` 4.3a). Every component attaches onto a
   file the loop already writes and renders nothing when its input is
   absent, so a repository with no run history yet is unaffected — see "Cold
   start" in [`docs/curiosity/README.md`](docs/curiosity/README.md#cold-start-the-first-runs-must-work-with-none-of-this).
   Separately, [harness KPIs](docs/harness-kpis/README.md) proposes learning
   operating strategy from independently assessed real-world outcomes. It
   compares policies on held-out tasks and bounded project trials; live KPI
   collection and policy adaptation are not built. Curiosity raises questions;
   KPI experiments test whether a proposed way of working actually helps.

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

**Are they still shipping?** [AI Release Tracker](https://aireleasetracker.com/analytics)
provides an independent release-cadence view. The redesigned console explains
its own behaviour without embedding a third-party tracker or maintaining a
copy of its changing figures.

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
├── ARCHITECTURE.md                  # five diagrams: the project, the loop, inside the loop
├── WORKPLAN.md                      # the sequenced plan of record — what's next
├── CONTRIBUTING.md                  # the design rules a change here has to keep
├── Portable-Harness-Design.md       # the historical record of the port from carrotgame
├── Model-Release-Driven-Software-Improvement-Paper-Outline.md
├── railway.json                     # one host's deploy config for console/; any host
│                                     # that runs `npm start` works
├── .github/
│   └── workflows/
│       └── self-improve.yml         # NOT this repo improving itself — this is THE SHARED
│                                     # WORKFLOW, rendered from harness/templates/ by
│                                     # scripts/render-shared-workflow.mjs, and what a
│                                     # `--shared` install calls at a pinned commit
├── package.json                     # one dependency (js-yaml, for adapter.mjs/
│                                     # scaffold.mjs only); `npm test` runs harness/'s own suite
├── docs/                            # research corpus, the design documents,
│                                     # campaigns/ — real-model runs written up with their
│                                     # records, and curiosity/ — a second longitudinal
│                                     # pass, 4 of its 10 components built, the rest gated on A'
├── console/                         # working ten-step installer, HTTP API,
│                                     # GitHub App flow, pages and deployment guide;
│                                     # how-to-run.html is the local setup guide,
│                                     # partials/ holds the header and footer every
│                                     # page includes, and favicon.svg is the site
│                                     # icon, served from the asset table in
│                                     # server.mjs; optional legacy Supabase
│                                     # schema, not required
├── tests/                           # tests for the harness's OWN code (see above)
│   ├── lib/                         # one file per harness/lib/ module
│   ├── scripts/                     # the CLIs, driven as real child processes
│   ├── console/                     # configuration, GitHub boundary and real HTTP tests
│   └── e2e/                         # the whole chain, real git, real test runs
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
    ├── .env.harness.example         # copy to .env.harness.local beside it — see Step 3
    ├── lib/                           # pure logic — no process.exit, no stdio.
    │   │                               # `ls harness/lib/` for the current list; the
    │   │                               # load-bearing four, in dependency order:
    │   ├── llm-provider.mjs           # provider-blind registry, transport, retry/headroom
    │   ├── edit-format.mjs            # SEARCH/REPLACE parser, allowlist supplied by the caller
    │   ├── orchestrator.mjs           # runGeneration() — the four stages, composed
    │   └── adapter.mjs                # parses YAML (lazily; scaffold.mjs writes it)
    ├── scripts/                       # CLI wrappers — own the filesystem/env/stdio
    │   ├── validate.mjs               # check the adapter before anything is spent
    │   ├── rehearse.mjs               # the whole chain, locally, on a real branch
    │   ├── run-generation.mjs         # the loop itself; the workflow's "improve" step
    │   └── ...                        # detector, probe, guard, promote, verify, digest,
    │                                   # evaluators, themes, report, revert, PR read-back
    ├── plugins/
    │   └── evaluators/                # the non-gating quality dimensions: the interface,
    │                                   # and one shipped example (source-weight)
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

**This tree names a handful of files, not all of them, on purpose.** An
exhaustive list here would be a second inventory to keep in step with the
directory itself, and it has already drifted once — `ls harness/lib/` and
`ls harness/scripts/` are the current answer, and
[Status in detail](#status-in-detail) says what each component does and
whether it is built. That is the same call this repository made about test
counts: point at the command, don't hand-copy the number
([`learning/01-principles.md`](learning/01-principles.md) principle 23).

`Portable-Harness-Design.md` §10 has the build order and its revision log;
`ARCHITECTURE.md` has the diagrams showing how these pieces actually
run.

