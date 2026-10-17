# Self-improvement install checklist — decompilation-learning-lab

Every item below went wrong in a real installation at least once. Tick them
all before the scheduled run starts.

**Who ticks what.** `(agent)` items are settled by a command — run it, read
the output, tick only on the stated result. `(you)` items live in a browser,
a billing console, or your own judgement: **an agent must never tick one on
your behalf**, even if it looks obvious. Leave those unticked and say plainly
what is still outstanding.

Nothing regenerates this file. A half-ticked checklist is a record of where
you got to, so keep it in git and let it change in pull requests.

## 1. What the agent may touch

This is the foundational decision. Every other gate in this checklist is
downstream of it: the allowlist is applied before a single edit is written,
and the guard re-checks the same split in CI after the fact. Get this wrong
and the rest of the list is guarding the wrong thing.

Read the four lists below as they actually stand in `project-adapter.yml`.

**Editable** — `constitution.allowed_paths`. The agent may rewrite these
freely, and they are bundled into the prompt so it has read them first:

- `candidate/score.c`

**Create-only** — `constitution.create_only_paths`. The agent may ADD a new
file matching these; it may never modify one that already exists, including
one it created on an earlier run:

_nothing — the agent may not add files_

**Append-only** — `constitution.append_only_paths`. New files may be added;
existing ones may not be changed or deleted. This is normally where the test
suites live, because a model that can edit its own gate is not gated:

_nothing_

**Frozen** — `constitution.frozen_paths`. Never writable, by anything, ever:

- `.github/**`
- `.claude/**`
- `reference/**`
- `oracle/**`
- `fixtures/**`
- `tests/**`
- `docs/evidence.md`
- `scripts/**`
- `lab.py`
- `project-adapter.yml`
- `harness/**`
- `harness.lock.json`
- `package.json`

- [ ] **(you)** **You have read those four lists and they are what you meant.**
      Not "they look reasonable" — you have checked that nothing you would mind
      losing is in the editable list, and that everything you would mind losing
      is in the frozen one. An agent can render this list; only you can say it
      is right, because only you know what this project cannot afford to break.
- [ ] **(you)** Anything with real-world consequence outside this repository is
      frozen: deployment config, infrastructure-as-code, CI definitions,
      secrets handling, billing, anything that sends email or messages, and
      anything that touches customer data. A change here is not undone by
      reverting the commit.
- [ ] **(you)** Your own safety net is frozen or append-only: the test suites,
      their fixtures and their helpers, the guard script, and the workflow. An
      agent that can weaken its own gate has no gate.
- [ ] **(agent)** `.github/**` is frozen — including the workflow that runs
      all this, which must not be able to rewrite its own schedule, its own
      permissions or its own gates.
- [ ] **(agent)** Both briefs describe the same split as `project-adapter.yml`.
      The adapter is what a script enforces; the briefs are what the model is
      told. When they disagree the model proposes work that the guard then
      rejects in CI, generation after generation, for a reason baked in at
      config time rather than found in the change.
- [ ] **(agent)** No path is in two lists at once — nothing editable is also
      frozen or append-only. `node harness/scripts/validate.mjs` reports this
      as an error; it must report none.
- [ ] **(agent)** Every editable path exists. A path the agent may edit but was
      never shown is a file it can be asked to write blind. `validate.mjs`
      checks this too; a directory that does not exist yet belongs in
      create-only, not editable.
- [ ] **(you)** You know how to widen this later, and that widening is the
      normal path: once a real file exists under a create-only glob, promoting
      that glob to `allowed_paths` lets later generations refine it. Start
      narrow. It is far easier to grant a path than to un-ship a change to one.

## 2. The installation is complete and on `main`

- [ ] **(agent)** `project-adapter.yml`, `.github/workflows/self-improve.yml`,
      `.claude/agents/improve.md`, `.claude/agents/review.md` and `SELF-IMPROVE-README.md` all exist.
- [ ] **(agent)** `node harness/scripts/validate.mjs` reports no errors. Each
      warning is read, and either fixed or a deliberate choice.
- [ ] **(agent)** No unfilled placeholder is left in either brief:
      `grep -n "\[.*\]" .claude/agents/improve.md .claude/agents/review.md` prints nothing. A model
      reads an unfilled placeholder verbatim as part of its instructions.
- [ ] **(you)** The briefs say what is true of **this** codebase — the goal,
      the constraints, the hints — and name only paths and suites that really
      exist. This is the item an agent cannot do for you: it can fill the
      shape, it cannot know what "better" means here.
- [ ] **(agent)** Everything is merged into `main`, and
      `project.default_branch` in `project-adapter.yml` names that same branch.

## 3. No key is anywhere git can see it

- [ ] **(agent)** `git ls-files harness/.env.harness.local .env .env.harness.local`
      prints **nothing**.
- [ ] **(agent)** `git check-ignore -v harness/.env.harness.local` prints a
      matching rule. If it prints nothing the file is not ignored — add
      `.env.*` (no leading slash, so it matches inside `harness/` too) plus
      `!.env.harness.example` to `.gitignore` before going any further.
- [ ] **(agent)** `harness/.env.harness.example` still holds placeholders only.
      Real keys belong in `.env.harness.local`; the `.example` file is tracked,
      and filling it in is the mistake the two names exist to prevent.
- [ ] **(you)** If a key was ever pasted into a tracked file, it is **rotated**,
      not merely deleted. Removing it from the working tree does not remove it
      from history, or from anywhere a push already reached.

## 4. GitHub has what the run needs

- [ ] **(you)** A repository secret for every lab this installation calls:
      `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
      Settings → Secrets and variables → Actions. `SELF-IMPROVE-README.md`
      lists which, and why each is needed.
- [ ] **(you)** Workflow permissions saved: **Read and write**, with **Allow
      GitHub Actions to create and approve pull requests** ticked, at
      Settings → Actions → General. Without the second tick, every generation passes its gates and then fails to open its pull request.
      This is the single most-missed setting in an installation, and the
      tickbox has been seen not to save silently.
- [ ] **(agent)** ...and confirmed, rather than remembered:
      `gh api repos/:owner/:repo/actions/permissions/workflow` prints
      `"default_workflow_permissions": "write"` **and**
      `"can_approve_pull_request_reviews": true`. Both, not either. Reporting
      that the owner said they saved it is not this check.
- [ ] **(you)** Every lab has **credit**, not just a key. A valid key on an
      account with no payment method fails as `402 billing_not_configured`
      mid-run, and the run carries on without that lab. Set a monthly spending
      limit with each lab while you are there.
- [ ] **(agent)** ...and every configured key actually reaches its lab:
      `node --env-file=harness/.env.harness.local harness/scripts/check-keys.mjs`
      reports every lab working, and no lab reports a zero or missing balance.
      This is the earliest point a dead key or an unfunded account shows up —
      the alternative is finding out mid-generation, after the fan-out has been
      priced.

## 5. You know what a run will do to your project

- [ ] **(agent)** `python3 -m unittest discover -s tests -q` passes on `main` right now. The harness
      judges a generation against this baseline; a suite that is already red
      makes every result unreadable.
- [ ] **(you)** You know what merging deploys. If your host deploys `main`
      on every push (Railway, Vercel and Netlify usually do), merging a
      generation's pull request puts it live. Check whether your host waits for
      CI first — on Railway that is each service's **Wait for CI** setting.
- [ ] **(you)** The merge model is the one you meant: **human-approval-required**. Every change waits for you in a pull request.
- [ ] **(you)** Nothing in section 1's editable list can reach production by
      itself. If it can, that is a deliberate choice you are making, not an
      oversight.
- [ ] **(agent)** The workflow's dependency install does not disturb this
      project's own. A copied install runs `npm install` at the repository root
      inside the Actions run; if this project depends on js-yaml 4 or earlier,
      or needs install scripts to have run, change that line to
      `npm install --prefix harness --no-save --no-package-lock js-yaml@5.3.0`.

## 6. The practice run, before anything is scheduled

- [ ] **(you)** You have agreed to spend real tokens on a rehearsal.
- [ ] **(agent)** `node --env-file=harness/.env.harness.local harness/scripts/rehearse.mjs`
      has been run once, by hand.
- [ ] **(you)** You have read what it proposed, what the reviewer said and what
      it cost — and the outcome makes sense to you. This is the last point at
      which stopping is free.
- [ ] **(you)** Only now, let the schedule run unattended.

## 7. You know where to look afterwards

- [ ] **(you)** `docs/generations/index.html` — the run
      history, rebuilt and committed after every run, with pull requests waiting
      for you at the top. Open it from a checkout; GitHub shows HTML as source.
- [ ] **(you)** You know how to undo one: `node harness/scripts/revert-generation.mjs NNN --reason "why"`.
- [ ] **(you)** You know how to stop it: set the repository **variable**
      `SELF_IMPROVE_PAUSED` to `true`.
