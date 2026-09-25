# Suggestions: making the harness easier to deploy

A review of the end-user install path (2026-09-24): `README.md` "Getting
started", `harness/cli/init.mjs`, `harness/lib/scaffold.mjs`,
`harness/.env.example`, `harness/templates/workflow.yml.tmpl` and
`package.json`. These are proposals for review, not decisions; nothing here
has been implemented.

**Status:** tracked item by item as Tier 8 (D1–D10) in
[`WORKPLAN.md`](WORKPLAN.md), which is where the ticks are.

## Current friction

A new installation takes about seven manual steps:

1. Clone this repository to a temporary folder and copy `harness/` into the
   project.
2. Install `js-yaml` with a special `--prefix harness` command, because
   `scaffold.mjs` imports it at load (`README.md:102-130`).
3. Create `.env` (or `.env.harness.local`) and check `.gitignore` covers it
   by hand (`harness/.env.example:16-20`).
4. Add each lab key again as a GitHub repository secret, through the web UI.
5. Find and enable "Allow GitHub Actions to create and approve pull
   requests" — a setting the README spends about 30 lines locating, and which
   failed to save silently on the first real install (`README.md:342-369`).
6. Copy the detector-only workflow (Step 6), which Step 7 then supersedes.
7. Run `init.mjs` and answer about 20 questions, several with no
   project-aware default (editable paths default to empty,
   `init.mjs:184-187`).

The README is 807 lines; the steps above are interleaved with status
tables, design history and external benchmark figures.

## The ten suggestions

Ordered by expected impact on a first-time install.

### 1. Publish to npm and run via `npx`

`package.json` is `"private": true`, and the README says there is no
published package. `npx self-optimisation init` would replace the clone,
copy and dependency steps with one command, and upgrading would become a
version bump instead of re-copying a folder and running
`init --from-adapter --force`.

### 2. Remove the runtime dependency

`js-yaml` is the only reason for the `--prefix` install warning and the
generated workflow's dependency step (`scaffold.mjs:83`, WORKPLAN I10).
`scaffold.mjs` only *writes* YAML, which a small built-in emitter can do.
For reading, either vendor a minimal parser or accept
`project-adapter.json` as an alternative. A copied `harness/` would then need
no install step at all.

### 3. Make the repository public and default to the shared install

`--shared <sha>` already exists but cannot be used while this repository is
private (`README.md:335`). Once public, an installation is two files — a
short caller workflow pinned to a commit, and `project-adapter.yml` — with
no vendored `harness/` to drift. This also satisfies the open WORKPLAN item
asking for a public example.

### 4. Let `init` configure GitHub through `gh` when available

- Upload keys from the local env file as repository secrets
  (`gh secret set`), only for the labs the adapter actually uses.
- Set workflow permissions and the "create and approve pull requests"
  tickbox (`gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow ...`),
  then read the setting back and fail loudly if it did not save.

Fall back to the current printed instructions when `gh` is absent. This
removes Step 5 and the most common cause of a failed first run.

### 5. Detect project settings instead of asking for them

Before prompting, inspect the repository for `package.json` scripts,
`pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `*.csproj` or a
`Makefile`, and propose defaults for `evaluation.test_commands`,
`evaluation.setup_commands` and `constitution.allowed_paths` (e.g. `src/**`).
The user confirms or edits rather than typing from memory.

### 6. A short setup path

Offer `init --quick` (or make it the default) asking only:

- which labs to watch,
- editable paths,
- test command,
- pull request or autonomous merge.

Everything else (cron, runner, context strategy, deployment verification,
brief paths, notifications) takes its default and stays editable in
`project-adapter.yml`. Keep the current full questionnaire as
`init --advanced`. Also drop `scoped` from the context-strategy question
while it has no implementation.

### 7. One `doctor` command

Today the checks are spread across `validate.mjs`, `check-keys.mjs`,
`init --check-upgrade` and a manual `gh api` call. A single
`node harness/scripts/doctor.mjs` would check, in order:

- Node version (>= 22.11),
- `js-yaml` resolvable (until suggestion 2 lands),
- the env file exists and is gitignored (`git check-ignore`),
- keys present and working (reuse `check-keys`),
- GitHub secrets and PR permission set (via `gh`, when available),
- `.agent/model-snapshot.json` committed,
- adapter valid (reuse `validate`),
- harness version current (reuse `checkUpgrade`).

Each failure prints the exact command that fixes it.

### 8. Split the README; make Getting Started a command list

Move "Status in detail", "The bet this depends on", the repo layout tree and
the design narrative into `ARCHITECTURE.md` or `docs/`. Keep a five-step
quickstart of commands at the top of the README, with explanations linked
rather than inline.

### 9. Drop the separate detector-only workflow step

Step 6 installs `examples/workflows/watch-releases.yml`; Step 7 installs
`self-improve.yml`, which also detects releases. Users end up with two
workflows and two provider lists. Generate one workflow from `init`, with a
`--detector-only` option for anyone who wants only the release notice.

### 10. Template repository and one-click console deploy

- A public GitHub template repository with the generated workflow, a
  filled-in example adapter and brief templates: "Use this template", add
  secrets, run.
- A deploy button (Railway already has `railway.json`) and a
  `Dockerfile` / `.devcontainer` for `console/`, so non-technical users can
  reach the ten-step installer without running `npm start` locally.

## Suggested priority

| Priority | Suggestions | Why |
|---|---|---|
| First | 1, 3, 4 | Together they reduce install to roughly `npx … init` plus one confirmation |
| Next | 2, 5, 7 | Remove the remaining sources of first-run failure |
| Then | 6, 8, 9, 10 | Reduce reading and decision load |

4, 5 and 7 are self-contained changes to `harness/cli/init.mjs` and
`harness/scripts/`; 1 and 3 are publishing decisions for the owner.
