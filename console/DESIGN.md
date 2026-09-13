# Console — Design Document

A front end for installing and configuring the harness, so that the person
who benefits from a self-improving repository doesn't have to be the person
who can hand-write `project-adapter.yml`.

**Status: proposal, with phase 0 built.** The console itself — sign-in, the
form, the pull request, the run view — is not built; the one service that
will host it is (`console/server.mjs`, serving the four pages below — §11
records where it runs and what was decided about it). Everything underneath it
is: `harness/lib/scaffold.mjs` + `harness/cli/init.mjs` generate the files,
`harness/lib/validate.mjs` checks the answers (§2.1's `validateAnswers()`,
shipped 2026-09-06), and `harness/scripts/rehearse.mjs` runs the whole chain
locally — which is most of what §Step 9's "rehearse before the schedule is
turned on" asks a user to do. `tests/lib/scaffold.test.mjs` and
`tests/lib/validate.test.mjs` cover them. This document is written to the
same standard as `Portable-Harness-Design.md` — every claim about what the
harness does today is checked against the code, and every field the console
would expose is marked LIVE (something reads it) or RESERVED (nothing does,
yet). Read §2 before §5: the console's remaining prerequisite is answer
validation on the generator that exists, plus the phase-1 backend §8.5
made necessary.

Four pages sit beside this file, each a body fragment. None carries its own
nav or footer: those live once in [`partials/`](partials/) and the server
inlines them wherever a page has an `<!-- include:nav -->` or
`<!-- include:footer -->` marker.

| File | What it is |
|---|---|
| [`about.html`](about.html) | The public face: the objective, one run drawn end to end, and the nine setup steps. |
| [`how-to-run.html`](how-to-run.html) | Step-by-step local setup for someone who builds with an AI assistant: download, run the website, install the harness into their own project, where each setting lives, and troubleshooting. |
| [`mockup.html`](mockup.html) | A clickable wireframe of §4's nine steps, with the generated `project-adapter.yml` updating live beside the form — the design's central claim rather than a garnish. |
| [`privacy.html`](privacy.html) | A draft privacy policy, written now so §2.2's no-custody rule is a commitment rather than an intention. |

---

## 1. The idea, restated

> Go to a URL. Connect your repository. Add the self-optimisation template.
> Fill in a form — API keys, which labs to watch, which files must never be
> touched, what "better" means for this project, how often to run. Done.

That's the shape. It's the right shape, and the reason it's the right shape
is not "forms are friendlier than YAML." It's that **the install is
currently a sequence of six manual steps with at least four silent failure
modes**, and a generator can enforce invariants that a copy-pasted template
cannot. `Portable-Harness-Design.md` §5 already made this argument for a
CLI. The console is the same argument carried one step further, to people
who will not open a terminal.

Today's install, from `README.md` "Getting started":

| Step | What a human does | Silent failure available |
|---|---|---|
| 1 | `git clone` the harness, `cp -r harness ./harness` | vendored copy rots; no upgrade path |
| 2 | Sign up for lab APIs, generate keys | — |
| 3 | Write `.env` | — |
| 4 | Hand-fill `project-adapter.yml` from a 180-line commented example | a path in `allowed_paths` that doesn't exist → every edit refused, mid-run, after paying for the tokens |
| 5 | Add repository secrets in GitHub's UI | secret name typo → provider reported "skipped", run continues |
| 6 | Copy a workflow file, hand-edit `--providers` to match step 4 | the two lists drift; the adapter says one thing, the workflow another |

Steps 4 and 6 are the same information typed twice. That's the exact class
of bug `learning/04-context-recipe.md` documents ("a file the agent may edit
was never shown to it") and the exact thing a generator exists to prevent.

So: **yes, this makes sense.** With three corrections to the framing, below.

### 1.1 Two products, not one

Two different people arrive at this differently, and this document has so
far only been designing for one of them.

**Path A — the repository.** Public, cloneable, already documented in
`README.md`'s "Getting started": copy `harness/` into a project, fill in
`project-adapter.yml` by hand or with a coding agent, run it in your own CI.
No account, no console, no product — just a git repository someone can read
end to end before trusting it with write access to their own project. This
is the path for the person who wants to see every line before it runs, and
it is finished today in the sense that matters: it works, it's documented,
phase 0's generator (§2.1) makes it less tedious but doesn't change its
shape.

The one open item on this path isn't build work, it's governance: as this
repository's author, the plan is to eventually open it to outside
contributions — issues, pull requests, other people's commits — and review
those the way any maintainer does. Nothing about that needs deciding now
(branch protection, a `CONTRIBUTING.md`, who else gets merge rights are all
easy to add later and easy to get wrong by rushing), but it's worth naming
as the second half of "the repo" so it doesn't get silently conflated with
Path B below. They're genuinely different postures: Path A is "trust the
code because you can read it"; Path B is "trust us because of what we
technically cannot do."

**Path B — the hosted console.** Everything else in this document. Someone
who will not clone a repository or hand-edit YAML goes to a URL, connects a
GitHub repository, and gets the same harness configured for them. "Connects
a GitHub repository" is doing real work in that sentence — §8.5 is about
making that connection the way a trustworthy product does it, not a bare
OAuth prompt.

Both paths install the *same* harness and the *same* generator (§2.1) under
the hood — Path B is Path A with the tedium designed away, not a different
product with different guarantees. Everything below this point is Path B
unless it says otherwise.

---

## 2. Three corrections before any of this gets built

### 2.1 The console is a front end for `init` — and `init` now exists

**Update, two days after this section was written:** `init` now exists, and
the rest of this section is kept only as the record of the argument that
produced it. Read the update; the "original argument, for the record" below
describes a state of the repository that is no longer true.
`README.md`'s status table no longer ends with two ❌ rows for it — both are
✅ Built: `harness/cli/init.mjs` (the CLI itself) and `harness/lib/scaffold.mjs`
(the pure-function generator underneath it — `renderAdapterYaml()`,
`renderWorkflowTemplate()`, `renderReadme()`), exercised by
`tests/lib/scaffold.test.mjs`. That's the same `harness/lib/install.mjs`
this section goes on to propose below, just already built under a different
name and reachable today only via a terminal, not a browser form. The
argument below for *why* a shared, pure, testable generator has to exist
before any front end is still correct and is exactly what got built —
`generateAdapter`/`generateWorkflow` map onto `renderAdapterYaml`/
`renderWorkflowTemplate` roughly 1:1. What's still genuinely missing, checked
against `scaffold.mjs`'s real exports: no `generateAgentBrief`/
`generateReviewerBrief` equivalent (`init.mjs` copies the `.tmpl` files
as-is rather than rendering them from answers).

**The `validateAnswers()` half of this argument has since shipped**, as
`harness/lib/validate.mjs`'s `validateAdapter()` — the invariant checks this
section argues are "the whole value of the thing": every editable path
exists, allowed never overlaps frozen or append-only, `.github/**` is frozen
unless deliberately overridden, brief files exist and carry no unfilled
`[placeholder]`s, every watched or pinned lab is registered. It runs from
`init.mjs` on what it just scaffolded, from `rehearse.mjs` before a local
run, and as the generated workflow's own first step. So the console's
remaining prerequisite is narrower still than this section's revised framing:
not "build a generator" and no longer "add answer-validation to it" — just
"wrap the generator and its validator in a browser form instead of
`init.mjs`'s prompts."

The original argument, for the record:

`README.md`'s own status table used to end with two ❌ rows:

| `init` CLI scaffolder | ❌ Not started |
| `templates/` (generated agent brief, reviewer brief, guard config, workflow) | ❌ Not started |

Everything the console would *write* comes out of those two rows. Building a
web form first means building the generator inside a browser app, where it
can't be unit-tested by `npm test`, can't be reused by the CLI, and will
drift from the adapter schema the moment `harness/lib/adapter.mjs` gains a
field.

The correct order is generator → CLI → console, with all three sharing one
pure-function library. (What actually got built is this shape under
different names — `harness/lib/scaffold.mjs` and `harness/cli/init.mjs`, not
`install.mjs` and `scripts/init.mjs` — and without `validateAnswers()`. The
sketch below is the proposal, not a description of the tree.)

```
harness/lib/install.mjs          ← proposed name; shipped as scaffold.mjs
  generateAdapter(answers)       → string (project-adapter.yml)
  generateAgentBrief(answers)    → string
  generateReviewerBrief(answers) → string
  generateWorkflow(answers)      → string (.github/workflows/self-improve.yml)
  validateAnswers(answers)       → { errors[], warnings[] }
        │
        ├── harness/scripts/init.mjs   (CLI: prompts → files on disk)
        └── console/                   (web: form → GitHub API writes)
```

`validateAnswers()` is where the invariants live, and it is the whole value
of the thing. It is testable in `tests/lib/install.test.mjs` on day one, by
both front ends, forever. Some invariants worth encoding immediately:

- every path in `constitution.allowed_paths` exists in the repo
- `allowed_paths` and `frozen_paths` do not overlap
- `.github/**` is frozen unless the user explicitly overrode it
- the brief paths in `roles.*_brief_path` are files the generator actually wrote
- `providers.watched` matches the secrets that were actually set
- a workflow is never emitted without a verify step (`Portable-Harness-Design.md` §5)

### 2.2 Never let a user's API key touch our server

The idea as described — "the user could enter their api keys in here" — is
the one part that has to be designed carefully rather than implemented
literally. These are keys with live spend attached. A console that receives
them in a POST body becomes a credential custodian, which is a security
posture, an incident-response obligation, and a reason for a security-aware
user to close the tab.

It doesn't have to. GitHub already provides encrypted secret storage for the
repository, and its API is designed for exactly this: you `GET
/repos/{owner}/{repo}/actions/secrets/public-key`, encrypt the value in the
browser with libsodium's sealed box, and `PUT` the ciphertext. The plaintext
key exists only in the user's own tab and in GitHub's encrypted store.

**The console can offer the "paste your API key here" UX with no server-side
custody at all.** The key goes browser → GitHub, encrypted before it leaves
the page. We never hold it, never log it, never need to rotate it after a
breach we didn't have. This should be stated on the page itself, next to the
input, because it is both true and reassuring.

Corollary: no "test this key works" button that proxies through us. If we
want key validation, dispatch the harness's existing reachability probe
(`harness/lib/probe-models.mjs`) as a workflow run in the user's own repo,
using the secret they just stored, and read the result. Same answer, zero
custody.

### 2.3 A toggle for something nothing reads is worse than no toggle

The idea lists cadence ("we use monthly, but users could choose") and, by
implication, test commands and approval class. Checked against the code:

| Field | Reads it today |
|---|---|
| `providers.watched`, `snapshot_path`, `max_fanout` | ✅ `check-model-releases.mjs` |
| `constitution.allowed_paths`, `create_only_paths` | ✅ `run-generation.mjs` → `edit-format.mjs` |
| `constitution.frozen_paths`, `append_only_paths`, `frozen_fields`, `churn_ceiling` | ✅ `check-guarded-paths.mjs` |
| `roles.*`, `memory.*`, `context.*` | ✅ `run-generation.mjs` |
| `deployment.*`, `notify.*` | ✅ `verify-deployment.mjs`, `promote.mjs`, `send-digest.mjs` |
| `constitution.approval_class` | ✅ `scaffold.mjs` — selects the generated workflow's merge path |
| **`cadence.schedule_cron`** | ⚪ **nothing, by design** — baked into the workflow's cron at scaffold time |
| **`evaluation.test_commands`** | ⚪ **nothing, by design** — baked into the workflow's test steps at scaffold time |

A form that renders a friendly cadence dropdown writing into
`cadence.schedule_cron` would produce a user who believes their loop runs
monthly when nothing schedules it. That's a worse outcome than the README,
which at least says so.

**Two of the three rows have since moved, in opposite directions.**
`approval_class` is now LIVE: `scaffold.mjs` reads it and renders one of two
merge paths into the workflow, with anything unrecognised failing closed to
the pull-request one (§Step 7 is therefore implementable as written).
`cadence.schedule_cron` and `evaluation.test_commands` have been relabelled
from RESERVED to **recorded, by design** — the decision is that nothing will
ever read them back, because both are baked into the generated workflow and
a value baked into a generated file should have exactly one source of truth
at run time. The closing section of `harness/project-adapter.example.yml`
carries that reasoning. For the console this is a real distinction: a
RESERVED field is a promise not yet kept, a recorded one is an honest echo
of something that already took effect elsewhere, and they should not render
the same way.

Two consequences for the console:

1. **Cadence is written into the workflow file, not the adapter.** GitHub
   Actions' `on.schedule.cron` is the thing that actually runs on a
   schedule. The dropdown is real the moment the console generates a
   workflow — which it must anyway. (Keep mirroring it into
   `cadence.schedule_cron` for forward-compatibility; just don't rely on it.)
2. **Reserved fields render visibly differently.** Greyed, or badged "saved,
   not yet wired," with a link to `ARCHITECTURE.md`. The harness's whole
   documentation style is refusing to claim more than it does; the console
   inherits that or it undoes it. This is not a nice-to-have — a console
   that overstates the system is a faster way to lose trust than no console
   at all.

---

## 3. One structural recommendation that changes the install

Right now, "install" means vendoring ~40 files of `harness/` into the user's
repo. For a console-driven install that's a bad foundation: the console
would have to write 40 files through the GitHub API, and every one of them
is frozen in time at install date. A user who installs in March gets March's
orchestrator forever.

**Publish the harness as a reusable workflow and an npm package**, and the
console's write set collapses from ~40 files to three:

```
.github/workflows/self-improve.yml   ← ~20 lines, calls the reusable workflow
project-adapter.yml                  ← generated from the form
.claude/agents/improve.md            ← generated from the meta-goal answers
.claude/agents/review.md             ← generated
```

```yaml
jobs:
  improve:
    uses: Chrisfoz/self-optimisation/.github/workflows/self-improve.yml@v1
    secrets: inherit
```

This is worth doing regardless of whether the console ever ships:

- upgrades become a version bump, not a re-vendor
- the console's GitHub App needs to write 3–4 files, not a tree
- `npx self-optimisation init` becomes possible (no clone step)
- security fixes to the harness reach existing installs

It also makes the console's job honest. The console isn't installing a copy
of our code into your repo; it's writing your configuration and pointing at
ours. That's a much easier thing to explain to a non-technical user, and a
much easier thing to uninstall — which matters more than it sounds, because
"can I get rid of this cleanly" is a question people ask before they say yes.

---

## 4. What the console asks

Nine steps, mapping onto `Portable-Harness-Design.md` §6's ten `init`
prompts. Each is annotated with what it writes and whether that write is
live today.

### Step 1 — Connect

Sign in, then **Install** the GitHub App — GitHub's own installation
picker, not this console's UI: "All repositories" or "Only select
repositories," the same dialog every GitHub App uses (Vercel, Dependabot,
Claude Code's own GitHub integration). Landing back in the console, the
newly granted repository is already selected. §8.5 is why this is an App
install rather than an OAuth prompt, and what that costs to build.

For the repository selected, the console reads its languages, top-level
tree, `package.json`/equivalent, and existing `project-adapter.yml` if one
is there (see §6.2 on round-tripping) — using an installation token scoped
to exactly that repo, never the signed-in user's own account-wide access.

### Step 2 — Labs to watch

Nine cards, one per provider in `harness/providers/`: Anthropic, OpenAI,
Google, Moonshot, DeepSeek, Qwen, xAI, Meta, Z.ai. Each with a key input
(encrypted client-side per §2.2), a "where do I get this" link, and a
live/skipped state after validation.

Writes: `providers.watched` (LIVE) + repository secrets. Selecting fewer
than all nine is the normal case, not a degraded one — the copy should say
so, because a grid of nine empty key fields reads as nine required fields.

Default: Anthropic + OpenAI, matching the README's advice.

### Step 3 — Which stages run

The stages the harness can perform, as toggles: release detection,
proposal fan-out, ranking, implementation, independent review, refinement,
guard enforcement, promotion, notification. Off means the generated
workflow omits that job.

Two honest constraints on this step: review and guard cannot be toggled off
(a gate that can be disabled from a settings page is not a gate —
`learning/01-principles.md` principle 13), and promotion/notification are
standalone CLIs today, so toggling them on means the generated workflow
gains a job that calls them, which is exactly the missing wiring the README
names.

*Open question — see §9: "the 9 modules" may mean these stages or may mean
the nine provider labs. The console needs both steps regardless; this
section assumes stages and Step 2 covers labs.*

### Step 4 — What may change, what may never

The step that most needs a UI rather than a text field. A file tree of the
repository with three states per node:

- **may edit** → `constitution.allowed_paths` (LIVE)
- **may create here** → `constitution.create_only_paths` (LIVE)
- **never touch** → `constitution.frozen_paths` (LIVE)
- (unmarked = not editable; the allowlist is an allowlist, not a denylist)

Pre-frozen by default, with the user opting *out* of protection rather than
into it: `.github/**`, both brief paths, the lockfile, and `package.json`'s
`scripts` field (`frozen_fields`) — the last because, as the example adapter
puts it, "rewriting the test command would defeat every other gate."

Churn ceiling (`max_files`, `max_lines`) as two numbers with the example's
defaults, under an "advanced" fold.

Selecting a directory writes a glob; the console shows the glob it derived
and how many files currently match, so a non-technical user gets the
feedback a glob normally denies them.

### Step 5 — What "better" means

Three long-form fields that become the agent brief at
`roles.agent_brief_path` (LIVE, and used *whole* — `run-generation.mjs`
sends the file as the suggestion stage's entire system prompt):

- **Meta-goal** — what this project is for and what improvement means for it
- **Constraints** — what must remain true no matter what
- **Hints** — the quality bar, house style, known sharp edges

Each with a real placeholder drawn from `examples/carrotgame/`, not lorem.
This is the step where the console earns its existence or doesn't: it is the
one input no template can supply, and the one a blank textarea will get a
two-word answer for. Phase 3 idea in §5.

### Step 6 — Cadence

Monthly (default, and labelled as the design's intent — the trigger is a
model release, not the calendar), weekly, or manual-only. Anything shorter
than weekly gets a warning, per `Portable-Harness-Design.md` §6.6.

Writes: `on.schedule.cron` in the generated workflow (LIVE — Actions reads
it), mirrored into `cadence.schedule_cron` (RESERVED, rendered as such).

### Step 7 — Approval

- **Open a pull request, I'll merge it** (default)
- **Merge automatically once tests and review pass** (advanced; gated behind
  a green rehearsal, and arguably behind N successful generations)

Writes: the generated workflow's merge steps, plus
`constitution.approval_class` — both LIVE as of the merge-model
reconciliation. Defaulting a non-technical user into autonomous merge is the
single worst decision this console could make, so the generator does not
merely default to the pull-request path: it *falls back* to it for any value
it doesn't recognise (`harness/lib/adapter.mjs`'s `normalizeApprovalClass()`).
A console bug that sends a malformed answer opens a pull request; it does not
start merging.

### Step 7b — Ambition

- **Small, focused changes only**
- **Earn it: one ambitious generation after a clean streak** (default)
- **Ambitious every run** (advanced; shown with its risk statement, and
  refused in combination with autonomous merge unless the user types the
  word)

Writes `context.ambition` (LIVE, read at run time by `run-generation.mjs`
— unlike `approval_class`, which is baked into the workflow, because this
changes what a run *attempts*, not what it is *permitted* to do; every
setting passes the same gates). Anything unrecognised resolves to `earned`
(`harness/lib/adapter.mjs`'s `normalizeAmbition()`), never to ambitious.

The run view (§8.4) gets a per-run override of the same thing — the
workflow's existing `scope` dispatch input — so an owner can say "this
once, be ambitious" without changing the standing setting.

**Rollback is the other half of this step.** An ambitious change can pass
independent review, the guard and every test and still be a change the
owner does not want. `harness/scripts/revert-generation.mjs NNN` undoes a
shipped generation and records it as reverted, which the next run reads
back as a failure; the console's run view should show a **Revert** button
beside every merged generation, wired to that script via a dispatch. The
dial should not be offered without the button. `docs/Ambition-Control.md`
is the risk table this step renders from.

### Step 8 — Budget

`budget.max_generation_tokens` (LIVE) — a per-generation token cap, checked
before the fan-out and between refine attempts; default 2,000,000. Rendered
as a number with a one-line explanation of what a typical generation costs,
and a reminder that this bounds one run, not a month — a spending limit at
each provider is still needed.

`max_fanout` (LIVE) — a real ceiling on how many newly released models one
run may fan out to, which is the actual blast-radius control this harness
has. What this step deliberately does *not* do is show a dollar figure:
per-lab pricing moves independently of this console and a guess presented
as a number is worse than no number, the same lesson §8.4 draws from
dropping `runs.estimated_cost_usd`. Instead the copy says plainly that the
spend is the user's own, on their own keys, scaling with fanout × labs
watched — and that the console will tell them the moment a key looks
invalid or a lab reports insufficient billing (§8.4's `apiIssues`), rather
than pretend to price the run in advance.

### Step 9 — Review, merge, rehearse, then switch on

The rehearsal is the friction-killer and the thing that turns this from a
form into a product. `Portable-Harness-Design.md` §6 already names its output
as the real deliverable: a short "what did I just install, what does it need,
how do I try it once" page. The console can *be* that page, live, with the
run's actual output in it.

It takes three moves rather than two, because of a GitHub constraint that is
easy to design straight past: **`workflow_dispatch` only works for a workflow
file that is already on the default branch.** A workflow sitting in an
unmerged pull request cannot be dispatched at all, so "open a PR, then
rehearse before you merge" is not a thing the platform permits.

Turn that constraint into the safety property instead:

1. **Open a pull request** with all four files — but the workflow is written
   with `on: workflow_dispatch` only, no `schedule:` block. The console never
   pushes to the default branch itself. (Built: `renderWorkflowTemplate()`
   omits the `schedule:` block, leaving a commented cron and a line saying
   how to switch it on, when its answers carry `includeSchedule: false`.)
2. **Merge it.** Now the workflow exists on the default branch and can be
   dispatched, but nothing runs on its own. Merging has switched nothing on.
3. **Rehearse once** — the console dispatches a run, polls it, and shows what
   came back.
4. **Switch on the schedule** — only offered once a rehearsal has actually
   passed, as a second one-line pull request adding the `schedule:` block.

This makes "the schedule stays off until a rehearsal passes" literally true
rather than aspirational: until step 4, there is no cron in the repository to
fire. It also means an install that is abandoned halfway leaves behind a
workflow that does nothing until someone asks it to, which is the right
failure mode for a tool that spends money.

---

## 5. Phasing

The console is the product, not a later front end onto a CLI. Everything a
user does — connect, configure, store keys, open the PR, rehearse, read what
happened — happens in the browser. The phases below are ordered so that each
one is something a person can actually use, with the CLI dropped off the
critical path entirely.

| Phase | Deliverable | Depends on |
|---|---|---|
| **0** | ✅ **Built** as `harness/lib/scaffold.mjs` + `harness/templates/` + `tests/lib/scaffold.test.mjs` — the generator, as pure functions. Still missing: `validateAnswers()` (§2.1) | — |
| **1** | **The console.** Sign-in, repo picker, all nine steps, sealed-box secrets, the PR, dispatch, and the run view (§8.4) | phase 0 |
| **2** | Reusable workflow + published package (§3) — install shrinks to a four-file write | phase 0 |
| **3** | Escalation decisions from the console (§7) | phase 1 |
| **4** | "Draft my brief for me" (§7), multi-repo view | phase 1 |
| — | `npx self-optimisation init` — the same generator behind a CLI, for people who prefer one | phase 0, whenever |

**Phase 0 came first, and it was not front-end work.** The console needed
something to generate `project-adapter.yml`, two briefs and a workflow from
nine answers, and that thing belonged in a pure-function library with a test
file — not inside a browser app where `npm test` can't reach it and where the
invariants in §2.1 can't be checked. It is `harness/lib/scaffold.mjs`:
`renderAdapterYaml()`, `renderWorkflowTemplate()`, `renderReadme()`,
`requiredProviders()`, driven by `harness/cli/init.mjs`. What phase 1 still
has to add to it is `validateAnswers()` — the invariant checks §2.1 calls the
whole value of the thing, which neither front end has yet.

**Phase 1 needs a small backend, and that's a real revision, not a rounding
error.** The original version of this section said "almost no backend,"
reasoning from a plain OAuth connection: the GitHub REST API is
CORS-enabled, so file writes, workflow dispatch and run reads could all
happen straight from the page once Supabase Auth handled the one step that
genuinely couldn't (§8.1, the OAuth handshake — GitHub's token endpoint
sends no CORS headers).

§8.5 changes the connection itself to a GitHub App — "connect your
repository" becomes a real installation picker, the same one every GitHub
App uses, rather than a broad OAuth grant — and that is worth the cost it
adds: every privileged call now needs a short-lived installation token
minted server-side from the App's own private key, which must never reach
the browser. That minting step is the backend. It's small (one function,
holds one secret, mints a token, proxies the one call it was asked for) and
it does not change who runs the loop or who holds a model-lab key — §2.2 and
§8.4's closing rule are untouched — but "almost no backend" stops being an
accurate description of phase 1 the moment §8.5 is adopted, and the plan
should say so rather than quietly outgrow its own claim.

**What the user still supplies, and always will:** their own API keys. That
is not friction to be designed away — it is the property that keeps their
spend on their account, their code under their terms with each lab, and this
product free of any credential worth stealing. The console's job is to make
supplying them take one paste per lab and explain what happens to each one.

---

## 6. Risks, and what to do about them

### 6.1 Non-technical user + autonomous merge

The frictionless framing and the autonomy of the loop pull against each
other. Someone who cannot read a diff should not be one dropdown away from
letting nine models merge to `main` unattended.

Mitigations, all cheap: PR-by-default (§4.7); autonomous merge unlocked only
after a green rehearsal; the guard's frozen set pre-populated and opt-out;
`churn_ceiling` defaults kept conservative; a plain-language "here's what
this can and cannot change to your repository" summary on the review step,
generated from the actual allowlist rather than written as marketing copy.

### 6.2 Config drift between console and repo

If a user edits `project-adapter.yml` by hand — and they will — the console
must not clobber it. The repository is the source of truth, always; the
console loads current config on open and round-trips it.

Technical note: `harness/lib/adapter.mjs` uses `js-yaml`, which does not
preserve comments. The example adapter is ~180 lines and *most of it is
comments that carry the reasoning*. A console that round-trips through
js-yaml would strip all of it on first save. The console's writer needs a
comment-preserving YAML round-trip (the `yaml` package's document API) —
this is a real constraint on phase 0's `generateAdapter()`, not a detail to
discover in phase 3.

### 6.3 Permission scope

Writing `.github/workflows/*` requires the `workflows` permission, which is
a high-trust ask and will make some users pause. Under a GitHub App (§8.5)
this is requested once, as part of the App's fixed permission set, at
install time — a GitHub App doesn't support asking for one permission at
sign-in and another later the way this section originally proposed, so that
plan is corrected here rather than left standing. What *is* incremental, and
does the same trust-building work: **which repositories** the permissions
apply to. Nothing is granted org-wide by default; a user installs on one
repository to try it and adds more only when they mean to. The other half of
the mitigation is unchanged and still does real work — the console opens a
pull request rather than pushing, so a permission that's been granted is
still an action the user reviews and approves before it takes effect.

### 6.4 We become the thing we're describing

A hosted console with accounts, a dashboard and run history is a product
with a support burden, an uptime expectation, and a cost. Phases 0–3 have
none of those: static page, user's own GitHub, user's own keys, user's own
Actions minutes. Phase 4 is where that changes, and it should be a separate
decision made against real phase-3 demand, not assumed now.

### 6.5 The console outpaces the harness

Every ❌ in the README's status table is a step in §4 that can only be
rendered greyed-out. If the console ships before the missing wiring, it is
mostly a well-designed form for a system that still needs a human to run
three CLIs in order. That's not fatal — phase 0's generator makes the wiring
easier, not harder — but the console's honest launch date is *after* the
workflow generator, not before.

---

## 7. What this unlocks that the CLI doesn't

Worth naming, because it's the argument for phase 4+ existing at all:

- **The brief-drafting problem.** Step 5 is the highest-value, highest-blank
  form field in the product. The console can offer "look at my repo and
  draft this," and can do it *inside the user's own Actions run with the key
  they just stored* — no backend, no custody. That's a real answer to the
  README's suggestion that you hand the template to a coding agent yourself.
- **The digest has a home.** `harness/lib/notify.mjs` writes a
  plain-language summary of each run and emails it. A console gives it a
  page, with the diff and the escalation ledger next to it.
- **Escalations get a decision surface.** The ledger
  (`docs/escalations/ledger.json`) exists so that when independent models
  converge on "this frozen rule is wrong," a human decides. Today that
  human reads JSON. A console is where an approve/reject button belongs —
  and it is the one place in this whole design where a UI is not a
  convenience but the missing half of a mechanism.

That last one is the strongest reason to build this beyond frictionless
onboarding. The harness's central constraint is *an agent can argue a rule
is wrong but cannot change it; only a human can*. Right now the human side
of that is a JSON file and an email. The console is where the rest of it
goes.

---

## 8. The product database

The repository is the open harness; the console is a product built on it, and
a product needs to know who is asking. That's a Supabase project —
`self-optimisation-console`, Postgres 17, ap-southeast-2 — holding identity
and the minimum around it.

**Since decided (§11): Supabase is optional.** Everything below still
describes our hosted instance, which may keep it as a listing cache, but a
console someone deploys for themselves needs no database at all. §8.1's
reason for Supabase — no server to finish the OAuth handshake — stopped
holding when §8.5 added a server.

### 8.1 It closes §5's one real gap

§5 said everything in phase 3 works from a static page except the OAuth
handshake, because GitHub's token endpoint sends no CORS headers, so the
code-for-token exchange needs a server. Supabase Auth *is* that server, with
GitHub as the provider. We write no auth backend, store no client secret of
our own, and get session management for free.

Keep this distinct from §8.5's GitHub App: this section is about **who is
signed in** — establishing a `profiles` row and a session, nothing more.
Which repositories that person's console can touch is a completely separate
grant, made by installing the App, with its own token type and its own
server-side piece. A user can sign in without ever installing the App
(there's simply nothing to configure yet), and the App's installation
outlives any one sign-in session.

Be honest about what this changes, though. Phase 3 was "static page, no
accounts, nothing of yours on our side." It is now "static page, hosted
identity, a row per user." That is the first thing in this design we operate
rather than borrow, and §6.4's warning — that a hosted product brings a
support burden and an uptime expectation — starts applying at phase 3 rather
than phase 4. Worth taking on. Not worth taking on silently.

### 8.2 What it holds

| Table | One row per | Why it exists |
|---|---|---|
| `profiles` | signed-in user | GitHub login, display name, avatar. Email stays in `auth.users` rather than being duplicated. |
| `installations` | configured repository | Which repo, what state it's in, and a **cache** of its `project-adapter.yml`. |
| `runs` | generation | Outcome, which model proposed, the PR link, any billing/key issue flagged — including runs that shipped nothing. |
| `escalations` | disputed rule | §7's decision surface: an agent argues a rule is wrong, a person decides. |
| `config_writes` | console write | Append-only: what we wrote to a repository, and who asked. |

### 8.3 What it must never hold, and how that's enforced

Three things, per §2.2: **no provider API keys**, **no source code, diffs or
prompts**, and **not the truth about a project's configuration** — that stays
in the repo's `project-adapter.yml`; `installations.config_cache` is a render
cache carrying the blob sha it was read from, so we can always tell when it
went stale.

Two mechanisms rather than a convention:

- **Row-level security on all five tables**, scoped to the owning user, with
  no public or shared read path anywhere in the schema. `config_writes` has
  select and insert policies and deliberately no update or delete policy, so
  an audit row cannot be rewritten by the person it records.
- **A `CHECK` constraint** on `config_cache` calling `looks_like_secret()`,
  which rejects a write whose JSON looks like it carries a credential. It
  rejects rather than scrubs, so a console bug that starts sending keys fails
  loudly on the first attempt instead of quietly accumulating them. A gate
  that cannot fail is not a gate (`learning/01-principles.md`, 13).

One smaller call worth recording: `cadence_cron` and `approval_class` are
Postgres **generated columns** derived from `config_cache`, not stored
alongside it. They stay indexable and queryable for a listing view, and they
cannot drift from the cache they came from.

### 8.4 Decided: run history comes out of the repository

The earlier draft of this section listed three ways to get a run into the
dashboard and recommended the least-credentialed one. Reading the harness
settles it more cleanly than any of them, because **the data already exists,
already structured, already in the user's repository.**

`harness/lib/orchestrator.mjs`'s `writeAttemptRecord()` writes
`docs/generations/gen-N/attempts.json` on every run, and it already contains
almost exactly the dashboard's row:

| `attempts.json` field | Dashboard column |
|---|---|
| `generation`, `date` | which run, when |
| `outcome` | `approved` / `abandoned` / `crashed` / `no-proposal` — the harness's own four values, not a paraphrase |
| `suggestModel`, `fanOut` | who proposed, out of how many |
| `implementModel`, `implementedBy`, `selfImplemented` | who wrote the edits |
| `proposalSummary` | the one-line "what it tried" |
| `scope`, `scopeReason` | why it was allowed to be ambitious or not |
| `attempts` | the refine loop, attempt by attempt |
| `escalations` | what it argued was wrong |

`docs/escalations/ledger.json` (`harness/lib/escalations.mjs`) is the same
story for §7's decision surface. Both are ordinary files the user can read
without us.

So the console reads run history with `GET /repos/{owner}/{repo}/contents/...`
using the signed-in user's own token, exactly as it reads everything else.
Consequences worth stating plainly:

- **No credential of ours ever enters a user's repository.** Not a
  service-role key, not a scoped token, not a webhook secret. Nothing to
  rotate, nothing to leak, nothing to explain in the privacy policy.
- **Supabase's `runs` table becomes a listing cache**, populated on read so a
  dashboard with twelve installations doesn't make forty API calls to render.
  The repository stays the source of truth, exactly as `config_cache` does
  for configuration (§8.3). If the cache and the repo disagree, the repo
  wins and the cache is wrong.
- **A user who deletes their account loses nothing.** Their history was never
  ours; it's in their repo, in git, in files they can read.

Two gaps this exposed, both now closed in the harness — see
`harness/lib/api-errors.mjs`, the two throw sites it touches in
`llm-provider.mjs`, and `writeAttemptRecord()`/`recordPullRequestUrl()` in
`orchestrator.mjs`:

1. **No cost was recorded, and — on reflection — shouldn't be.** The spend
   is the user's own, on their own keys, and pricing moves independently of
   this schema; a console-side dollar guess is a number people stop
   trusting the first time it's wrong. What actually matters is narrower and
   now real: `classifyStatusCode()` turns a 401, a 402, or a 403/429 whose
   body says "insufficient credit," into a `kind` —
   `missing_key` / `invalid_key` / `billing` — attached to the thrown
   `ApiError` as a real field, not left for something downstream to regex
   out of a message string. `writeAttemptRecord()` carries the actionable
   ones forward as `apiIssues`, deduplicated by provider so nine labs
   sharing one expired card produce one row, not nine. `runs.estimated_cost_usd`
   is gone (migration `20260821000003`); `runs.api_issues` replaces it.
2. **No pull request link — now written down in a second, small step.**
   `writeAttemptRecord()` runs before the PR exists, so it can't know the
   URL; `recordPullRequestUrl()` is the write that fills it in afterward,
   called by `harness/scripts/record-pull-request.mjs` — a workflow step
   dropped in right after whatever action opens the PR (e.g.
   `peter-evans/create-pull-request`). A generation that didn't ship never
   calls it, and the field stays `null`, honestly.

One related rule that does not change: Supabase hands back a GitHub
`provider_token` on sign-in. Use it in the session and do not persist it — a
stored provider token is a credential of the user's that we would then be
holding, which is the thing §2.2 exists to prevent.

### 8.5 Connecting like Claude Code does: a real GitHub App

"Connect your repository" has been standing in for a plain OAuth prompt so
far — sign in, get a token scoped to whatever the OAuth App requests, use it
for everything. That's the ordinary shape of "log in with GitHub," and it's
also the wrong shape for this product: an OAuth token like that is
account-wide (or as close to it as the requested scope allows), it's issued
*to the browser*, and there is no way for a user to say "only this one repo,
not the forty others in my org" without the console building that
restriction itself, by convention, with nothing on GitHub's side enforcing
it.

A **GitHub App** is the mechanism built for exactly this, and it's what
"like Claude Code" actually names: install the app, pick "All repositories"
or specific ones in GitHub's own dialog, and the grant that results is
scoped by GitHub itself to those repositories — the console literally cannot
touch a repo the user didn't select, because the token it's handed only
works on those repos. This is the right upgrade, and it changes real things
about the architecture in §8.1–§8.4, worth working through rather than
waving at.

**Two tokens, two purposes, easy to conflate:**

| | OAuth (§8.1) | GitHub App installation |
|---|---|---|
| Answers | "who is this person?" | "which repos may this app touch?" |
| Scope | the signed-in user's account | exactly the repos granted at install |
| Lifetime | the session | until uninstalled |
| Who mints it | Supabase Auth, browser-side exchange | **us**, server-side, from the App's private key |

The sign-in flow in §8.1 doesn't change — it still answers "who is this,"
nothing more. Every privileged action against a repository (reading its
tree, writing the four config files, storing a secret, dispatching a
rehearsal, listing runs) now goes through the installation instead.

**What this requires that didn't exist before:**

- **The App's own private key**, generated once when the App is registered
  on GitHub, held only in server-side secret storage (a Supabase Edge
  Function's environment, never in a repository, never in the browser). This
  is a real credential we hold — say so plainly rather than let §2.2's "we
  hold nothing" become inaccurate by omission. It is categorically different
  from what §2.2 and §8.4 promise never to hold, though: it is *our own
  identity as an application*, not a user's secret or a model-lab key. Every
  GitHub App works this way — this isn't a compromise specific to this
  design, it's the mechanism GitHub built for third-party tools to act on a
  user's repos without impersonating the user. Its blast radius is also
  bounded in a way a stolen OAuth token's isn't: the key can only mint
  tokens for repositories where the App is installed, those tokens expire in
  an hour, and the permissions on them are fixed to what the App declared —
  contents, secrets, actions, metadata, nothing else.
- **A token-minting endpoint.** Given an installation ID, sign a short-lived
  JWT with the App's private key, exchange it with GitHub for an
  installation access token (∼1 hour), and either hand back that token for
  the one call the console needs or make the call server-side and return
  the result. Small, stateless, and — per §5's revised claim — the one piece
  of real backend phase 1 now needs.
- **A webhook receiver**, for the events GitHub sends when an installation
  changes: `installation` (created/deleted) and
  `installation_repositories` (added/removed). This is what keeps
  `installations` accurate without depending on the user ever reopening the
  console — someone can remove a repo from the App's access entirely inside
  GitHub's own settings, and the row updates because GitHub told us, not
  because we polled. `installations` gains one column for this,
  `gh_installation_id`, and its RLS/ownership model is unchanged — the
  webhook writes are the one place a service-role-equivalent write is
  actually correct, because the event is GitHub's own authoritative record
  of what changed, not user input.

**What does not change:** the loop still runs in the user's own GitHub
Actions, on their own model-lab keys, per the decision this session settled
before writing this section. The App changes how the console *connects* —
reads the tree, writes the config PR, dispatches a rehearsal, lists run
history — not who executes the harness once it's configured. §2.2's promise
about lab API keys is untouched by any of this; those still go browser →
GitHub secrets, encrypted, never through us, exactly as before. The App's
own private key is a new thing this design holds, and the honest framing is
"we now hold one credential, ours, revocable per-repo by the user, with a
tightly bounded blast radius" — not "we hold nothing," which stopped being
true the moment this section was adopted.

**Revocation gets better, not worse.** Uninstalling the App — from GitHub's
own **Settings → Applications → Installed GitHub Apps**, or per-repository
from that same screen — is a single, GitHub-native action that immediately
invalidates every installation token for that repo. Compare this to an
OAuth grant, which a user revokes from a different settings page and which,
depending on scope, may have covered repos they'd forgotten were included.
The App model gives a cleaner story for `privacy.html`'s "Removing it"
section: the state a user needs to inspect and undo is exactly the
repository list GitHub itself shows them, not something to trust the
console's own account settings to represent accurately.

**Still to register by hand, the same way Supabase's GitHub OAuth provider
was called out in `console/supabase/README.md`:** creating the App itself
on GitHub (name, homepage, permissions: `contents:write`,
`secrets:write`, `actions:write`, `metadata:read`; webhook URL and secret;
generate and download the private key) is a manual, one-time step only the
account owner can do. Nothing in this repository can do it for you — this
section documents the shape so that step is informed, not blind.

---

## 9. Open questions

1. **"9 modules" — labs or stages?** There are exactly nine providers in
   `harness/providers/`, and roughly nine pipeline stages. §4 assumes both
   and gives each its own step; if only one was meant, the other step
   shrinks or merges.
2. **Who is the target user, precisely?** "Non-technical" spans a maintainer
   who dislikes YAML and someone who has never opened a pull request. Phase 1
   serves the first well. The second is blocked on step 9 requiring them to
   merge a pull request before they can rehearse — which is a real thing to
   solve in the copy, not with more UI.
3. **What is the free tier?** The bill is no longer hypothetical: the
   Supabase project is $10/month before a single user signs in, and it grows
   with sign-ins rather than with usage, since we run none of the compute. A
   free tier is affordable for a long time. Deciding *whether* this is free
   forever, and what changes if it isn't, is easier now than after people
   depend on it.
4. **Does the console configure one repo or many?** Everything above assumes
   one. `project-adapter.yml` is per-repo by design and the schema already
   supports N installations per user, so multi-repo is a listing view rather
   than a migration — but nothing in §4 is designed for it yet. §8.5's App
   install already supports granting several repos at once, which makes this
   question more pressing, not less: the console needs a "which of your
   installed repos are you configuring right now" step the day multi-repo
   grants become possible, or step 1 gets ambiguous the first time someone
   installs on three repos and only means to set up one.
5. **Who does the GitHub App belong to?** A personal GitHub account or an
   organisation — this decides who can rotate the private key, who GitHub
   shows as the App's publisher on every install screen, and what happens to
   every existing installation if that account is ever unavailable. Worth
   deciding once, deliberately, before the first real install exists to be
   disrupted by changing it. **Decided 2026-09-11: the author's personal
   GitHub account**, for our hosted instance. A self-hosted console registers
   its own App under whichever account deploys it (§11).

---

## 10. Recommendation

The generator this section originally recommended building next is built:
`harness/lib/scaffold.mjs`, driven by `harness/cli/init.mjs`, covered by
`tests/lib/scaffold.test.mjs`. Every screen in the console is a caller of it.
`validateAnswers()` (§2.1) is no longer missing either: it shipped as
`harness/lib/validate.mjs`'s `validateAdapter()`, in the library rather than
in a browser app, for exactly the reason this paragraph gives — the
invariants stop being testable the moment they live in one.

Then build the console as phase 1, end to end, and skip the CLI until someone
asks for it. Three rules make it a front end this harness can stand behind
rather than one that oversells it:

- **Keys go browser → GitHub, never through us** (§2.2). The database has a
  `CHECK` constraint enforcing it, and the privacy policy is short because
  of it.
- **A control nothing reads is rendered as such** (§2.3). `approval_class`
  is LIVE now; `cadence.schedule_cron` and `evaluation.test_commands` are
  recorded echoes of something already baked into the generated workflow,
  which is a different thing from a field awaiting work and should look
  different. A cheerful dropdown over a dead field is how a tool loses a
  user's trust in one step.
- **The repository is the truth; we hold a cache** (§8.3, §8.4). Config,
  history and escalations all live in the user's repo as files they can read
  without us. That is what makes deleting an account cost them nothing, and
  it is worth more to this product than any dashboard feature.

---

## 11. Hosting, and deploy-your-own

Decided 2026-09-11. The goal is frictionless in two directions at once: a
person with a project and a repository connects it and runs the harness,
and anyone who would rather not trust our instance deploys the same console
themselves — the repository ships with a working front end, not just a
harness and a design for one.

**One service, deployable anywhere.** The console is a single Node process,
`console/server.mjs`, zero-dependency like the harness it fronts, started by
`npm start`. Our instance runs on Railway, configured by the repository's
`railway.json` (start command, `/healthz` health check, restart policy); any
host that runs a Node process runs the same thing. A "Deploy on Railway"
button and a Dockerfile follow once there is more to deploy than pages.

**It scales because it never runs the loop.** The harness runs in each
user's own GitHub Actions on their own lab keys (§8.5, "What does not
change") — the service configures and triggers, it does not execute. That is
why a thousand users cost about what ten do, and why a self-hoster's bill is
a few dollars a month: no model call and no test run ever happens on it.
Running the harness server-side against uploaded folders was considered and
rejected on the same page: it needs a git repository the harness can branch
and record into, it would put lab keys and source on our server (§2.2,
§8.3), and `evaluation.test_commands` would make us a host for strangers'
code.

**Supabase is optional.** §8.1 brought it in because the OAuth code exchange
needs a server and there wasn't one. §8.5 added one. A GitHub App can sign a
user in itself (user-to-server tokens), and §8.4 already puts config, run
history and escalations in the user's repository — so a self-hosted console
is one service plus one GitHub App, with no database. Our own instance may
keep the Supabase project as §8.4's listing cache; nothing may require it.
Every extra account a self-hoster has to create is friction.

**The App registers itself.** §8.5's "register the App by hand" becomes
GitHub's App manifest flow: a fresh deployment's first page offers "Create
your GitHub App," the deployer confirms on GitHub, and the App's id,
private key and webhook secret come back to the service. Our instance's App
belongs to the author's personal account (§9, question 5).

**Connect means repository and branch.** Repositories come from the App's
installation — only what the user granted in GitHub's own dialog. The
branch fills `project.default_branch`, which `scaffold.mjs` already bakes
into the generated workflow as `BASE_BRANCH`. One GitHub rule shapes the
picker: a scheduled run, or a `workflow_dispatch` "Run" button, only fires
from a workflow file on the repository's *default* branch. So the picker
defaults to it, and choosing another branch means "pull requests target
this branch" — the workflow file itself still lands on the default branch.

**§3's reusable workflow moves ahead of the form.** Without it, "connect and
run" means the console committing roughly forty harness files into every
repository, frozen at install date. With it, three or four. That makes it a
prerequisite for the frictionless path rather than phase 2's later
convenience.

The order, each step usable on its own:

| Step | Deliverable | State |
|---|---|---|
| 1 | The service, serving the four pages, on Railway | ✅ built (`console/server.mjs`, `tests/console/server.test.mjs`); not yet deployed |
| 2 | GitHub App via the manifest flow; sign-in; repository and branch picker | — |
| 3 | The reusable workflow (§3) | — |
| 4 | The nine steps, sealed-box secrets (§2.2), the setup PR, Run, the run view (§8.4) | — |
| 5 | "Deploy on Railway" button and Dockerfile | — |

The service already refuses the easy mistake a console folder invites: it
serves an explicit route table, never a directory, so `DESIGN.md`, the
migrations and the rest of the repository are unreachable by construction,
and a path it does not name is a 404.
