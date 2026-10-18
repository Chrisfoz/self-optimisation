# Installing the harness — every step, with the reasons

The [README's quickstart](../README.md#quickstart) is these same steps as five
commands. This is the long version: what each step does, why it is there, and
what goes wrong when it is skipped. It installs the harness into **your own
project**, not this repository. Fifteen minutes, most of it waiting for API
signups.

## Step 1 — Get the harness into your project

There's no published npm package yet, so "install" means copying one folder.
From a terminal, inside your project's root:

```bash
git clone https://github.com/Chrisfoz/self-optimisation.git /tmp/self-optimisation
cp -r /tmp/self-optimisation/harness ./harness
```

(On Windows PowerShell, replace `/tmp/self-optimisation` with a path like
`$env:TEMP\self-optimisation`, and `cp -r` with `Copy-Item -Recurse`.)

Or let the clone do the copy and start Step 6 in one go — the same entry
point an `npx` install will use once the package is published:

```bash
node /tmp/self-optimisation/bin/self-optimisation.mjs init --quick
```

It copies `harness/` in (never a key file), then runs `init` there. Later,
`git -C /tmp/self-optimisation pull` and
`node /tmp/self-optimisation/bin/self-optimisation.mjs upgrade` replace
`harness/` with the new version, keep `harness/.env.harness.local`, and
regenerate the workflow from your adapter. Local edits inside `harness/` are
not kept: the upgrade is the new version, whole.

Copying the folder is the whole install: there is no `npm install` step.
Everything in `harness/` uses only Node's own built-ins, apart from one YAML
parser (`js-yaml`), which is vendored at `harness/vendor/js-yaml.mjs` with its
licence beside it. Nothing is installed into your project, and nothing can
replace your project's own copy of any package.

You do need **Node.js 22.11 or newer** (the first 22.x LTS). `--env-file`
and the built-in test runner, both used below and both chosen specifically to
avoid needing a dependency for either, are older than that — but `npm test`
passes a glob to `node --test`, which Node 20 reads as a literal filename,
and 22.11 is the oldest version CI actually runs the suite on. Node 20 is
past end of life. Check with:

```bash
node --version
```

## Step 2 — Get API keys for the labs you want to watch

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

## Step 3 — Local testing: `harness/.env.harness.local` (never committed)

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

## Step 4 — Try it locally

Run the detector against just the labs you added keys for:

```bash
node --env-file=harness/.env.harness.local harness/scripts/check-model-releases.mjs --providers anthropic,openai
```

First run: every lab you named gets recorded as a **baseline** and nothing
is reported as "new" — there's nothing to compare against yet. That's
correct, not a bug. Run it again right now and you'll see `no new models`
for the same reason. It only reports something the first time a model id
shows up that wasn't in the snapshot last time — see
[`harness/lib/model-release-detector.mjs`](../harness/lib/model-release-detector.mjs)
for exactly how that comparison works, and
[`learning/01-principles.md`](../learning/01-principles.md) principle 1 for why
"triggers on real novelty" is the whole point rather than a detail.

A `.agent/model-snapshot.json` file appears after this run — that's the
detector's memory, and it's not optional to keep: **commit it**, the same
way the reference implementation does. GitHub Actions runners are ephemeral
— nothing persists between scheduled runs except what's in the repo — so
without this file committed, every monthly run would see an empty snapshot
and report every model in the catalogue as "new" simultaneously, every
time. Don't add `.agent/` to `.gitignore`; that's the one directory in this
walkthrough that's the opposite of `.env.harness.local` — it holds no secrets and it
*must* travel with the repo.
Both generated workflows commit it automatically on every run (Step 6 below).

The same snapshot is what the console's model picker reads when you connect
a repository: it is the only live list of models your account can actually
call that ever reaches a browser, because the console holds no lab key. To
refresh the shorter list the console ships with instead — for a deploy of
your own — run

```bash
node --env-file=harness/.env.harness.local harness/scripts/refresh-model-catalogue.mjs
```

which lists every lab you hold a key for and rewrites
[`harness/data/model-catalogue.json`](../harness/data/model-catalogue.json). A
lab with no key keeps whatever that file already had rather than being
emptied.

**Optional but recommended once you're past trying it once:** rather than
repeating `--providers` on every invocation, copy
[`harness/project-adapter.example.yml`](../harness/project-adapter.example.yml)
to `project-adapter.yml` at your project root and list your watched
providers there instead — `harness/lib/adapter.mjs` reads it automatically
(a CLI flag or env var still overrides it, in that order). This is also the
one file that will carry forward everything else the harness eventually
reads as more of it gets built — see
[`harness/project-adapter.example.yml`](../harness/project-adapter.example.yml)
for the full commented schema, and `ARCHITECTURE.md` for which
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

## Step 5 — GitHub setup: repository secrets

`harness/.env.harness.local` is for your machine only. For the detector to run on a schedule in
GitHub Actions, the same keys need to exist as **repository secrets** —
a completely separate mechanism, deliberately: a secret lives encrypted on
GitHub's side and is injected into a workflow run's environment; it is never
readable back out, never appears in logs, and has nothing to do with any
file in your repo.

**The short way,** once Step 6 has written `project-adapter.yml` and the
[GitHub CLI](https://cli.github.com/) is signed in (`gh auth login`):

```bash
node harness/cli/init.mjs --configure-github
```

It uploads exactly the keys this installation calls, from
`harness/.env.harness.local` (a blank one is reported, never uploaded), and
ticks the pull-request permission Step 6 describes, then reads it back and
fails if it did not save. Without `gh` it prints the steps below.

**By hand,** in your GitHub repository:

1. Go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name it exactly as the env var in the table above (e.g.
   `ANTHROPIC_API_KEY`) and paste the same key value from Step 2.
4. Repeat for each lab you're watching.

You're adding the *same values* as `harness/.env.harness.local`, into a *different place*, for a
*different consumer* (GitHub's runners, not your own machine). Neither file
references the other.

## Step 6 — Generate the workflow

```bash
node harness/cli/init.mjs --quick                      # five questions, then writes project-adapter.yml + the workflow
node harness/cli/init.mjs --from-adapter --force       # later: regenerate the workflow from the adapter you edited
```

`--quick` asks only what has no safe default: which labs, what may be edited,
how to test, how to install for the tests, and whether to merge without
asking. Everything else — the pinned models, the schedule, the frozen paths,
deployment checks, email — takes its default and stays editable in
`project-adapter.yml`. Plain `init` asks all of it.

When you think you're done, ask:

```bash
node harness/scripts/doctor.mjs            # add --offline to skip every network call
```

It checks Node, the adapter, the workflow, that the env file exists and is
git-ignored, that every key is present and accepted by its lab, the model
snapshot, the repository's secrets and pull-request permission (when the
GitHub CLI is signed in), and whether your copy of the harness is current.
Each failure prints the command that fixes it; it ends with **Ready** when
nothing does.

Before asking, `init` reads your project's own files (`package.json`,
`pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `*.csproj`, a
`Makefile`) and proposes the editable paths, the test command and the
command that installs what the tests need. Enter accepts a proposal.

That one workflow is the whole loop, and it also watches for releases, so
there is nothing else to install. If you want **only** the monthly notice that
a new model has shipped — an issue in your repository, no adapter, no model
ever called — run `node harness/cli/init.mjs --detector-only` instead; it
writes `.github/workflows/watch-releases.yml` with the secrets and the lab list
already in agreement.

**Or install it shared, once this repository is public.** Instead of keeping a
copy of `harness/` in your project, `node <path-to>/harness/cli/init.mjs
--shared <commit-sha> --shared-label v<version>` writes a short workflow that
calls this repository's shared workflow at that commit. Take both from a
[release](https://github.com/Chrisfoz/self-optimisation/releases): each one's
notes give its commit SHA and the exact command. Upgrading is then changing
the SHA and label to a newer release's, on purpose; nothing moves under you
when this repository changes. Test and dependency setup commands live in `project-adapter.yml`
(`evaluation.test_commands`, `evaluation.setup_commands`) and are read once per
run, from your default branch. While this repository is private, other
repositories cannot read it, so use the copied install above. See
[`console/DEPLOYMENT.md`](../console/DEPLOYMENT.md), "Shared harness".

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
carries the same records as metrics, and GitHub renders it.

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
| How ambitious each run may be | `project-adapter.yml` → `context.ambition` (`focused` / `earned` / `ambitious`), or per run from the Actions tab's **Run workflow** → `scope` | **Used immediately** — `run-generation.mjs` reads it every run. `earned` is the default; the gates are the same at every setting; see [`docs/Ambition-Control.md`](../docs/Ambition-Control.md) for the risks and for `revert-generation.mjs`, which exists because of this dial |
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
for the HINTS section. It can see your codebase in a way this guide can't;
you should still read what it wrote before committing it; wrong file
paths in `constitution.allowed_paths` will fail loud and fail safe (edits
targeting an unlisted path are just refused, same as `frozen_paths`), which
is a mistake worth catching before it costs a real run's budget rather than
mid-generation.

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
  which every workflow `init` generates already does on every
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
