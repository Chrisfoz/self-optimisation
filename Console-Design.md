# Console — Design Document

A front end for installing and configuring the harness, so that the person
who benefits from a self-improving repository doesn't have to be the person
who can hand-write `project-adapter.yml`.

**Status: proposal.** Nothing in this document is built. It is written to
the same standard as `Portable-Harness-Design.md` — every claim about what
the harness does today is checked against the code, and every field the
console would expose is marked LIVE (something reads it) or RESERVED
(nothing does, yet). Read §2 before §5: the console's real prerequisite is
not front-end work, it's the generator that `Portable-Harness-Design.md` §6
already specified and nobody has written.

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

---

## 2. Three corrections before any of this gets built

### 2.1 The console is a front end for `init`, and `init` doesn't exist

`README.md`'s own status table ends with two ❌ rows:

| `init` CLI scaffolder | ❌ Not started |
| `templates/` (generated agent brief, reviewer brief, guard config, workflow) | ❌ Not started |

Everything the console would *write* comes out of those two rows. Building a
web form first means building the generator inside a browser app, where it
can't be unit-tested by `npm test`, can't be reused by the CLI, and will
drift from the adapter schema the moment `harness/lib/adapter.mjs` gains a
field.

The correct order is generator → CLI → console, with all three sharing one
pure-function library:

```
harness/lib/install.mjs          ← new. Pure functions, no I/O, no network.
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
| **`cadence.schedule_cron`** | ❌ **nothing** |
| **`evaluation.test_commands`** | ❌ **nothing** |
| **`approval_class`** | ❌ **nothing** |

A form that renders a friendly cadence dropdown writing into
`cadence.schedule_cron` would produce a user who believes their loop runs
monthly when nothing schedules it. That's a worse outcome than the README,
which at least says so.

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

GitHub auth, then repository picker. Reads the repo's languages, top-level
tree, `package.json`/equivalent, and existing `project-adapter.yml` if one
is there (see §6.2 on round-tripping).

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

*Open question — see §8: "the 9 modules" may mean these stages or may mean
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

Writes: the generated workflow's merge job, plus `approval_class`
(RESERVED). Defaulting a non-technical user into autonomous merge is the
single worst decision this console could make.

### Step 8 — Budget

`max_fanout` (LIVE) with an estimated per-run cost shown live from current
per-lab pricing and `roles.suggest.max_output_tokens`. Someone signing up
for recurring autonomous LLM spend deserves a number before the first run,
not after the first invoice. This is a first-class step, not an advanced
fold.

### Step 9 — Review and rehearse

A diff of every file about to be written, then two buttons:

- **Open a pull request** — the console never pushes to the default branch
- **Rehearse once** — `workflow_dispatch` a dry run and stream the result

The rehearsal is the friction-killer, and the thing that turns this from a
form into a product. `Portable-Harness-Design.md` §6 already names its
output as the real deliverable: a short "what did I just install, what does
it need, how do I try it once" page. The console can *be* that page, live,
with the run's actual output in it.

---

## 5. Phasing

| Phase | Deliverable | Depends on |
|---|---|---|
| **0** | `harness/lib/install.mjs` + `templates/` + `tests/lib/install.test.mjs` | nothing — buildable today |
| **1** | `npx self-optimisation init` (CLI over phase 0) | phase 0 |
| **2** | Reusable workflow + published package (§3) | phase 0 |
| **3** | Static console on GitHub Pages: auth, tree picker, sealed-box secrets, writes a branch + PR | phases 0–2 |
| **4** | Rehearsal + run history + cost meter (needs a GitHub App and a small backend) | phase 3 |
| **5** | Multi-repo / org view; "draft my brief for me" (§7) | phase 4 |

Phase 1 ships real value to the people who can already use the harness, and
de-risks every later phase, because by then the generator is proven by use.
Phase 3 is the milestone the idea is actually about.

**Phase 3 needs almost no backend.** Everything except the OAuth handshake
works from a static page: the GitHub REST API is CORS-enabled for
browser-side calls, secret encryption is client-side, and file writes are
`PUT /repos/{owner}/{repo}/contents/{path}`. The exception is real and worth
stating: GitHub's OAuth token endpoint does not send CORS headers, so the
code-for-token exchange needs a server. That's roughly fifty lines in a
serverless function which holds no database and no user secret — it is not a
backend in the sense that matters for §2.2. (A dev-preview can skip even
that by accepting a fine-grained PAT paste, which is fine for us and wrong
for the target user.)

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
a high-trust ask and will make some users pause. Two things help: request it
at the moment it's needed rather than at sign-in, and open a pull request
rather than pushing — a PR the user merges is a permission they can audit
before it takes effect.

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
of that is unbuilt. The console is where it goes.

---

## 8. Open questions

1. **"9 modules" — labs or stages?** There are exactly nine providers in
   `harness/providers/`, and roughly nine pipeline stages. §4 assumes both
   and gives each its own step; if only one was meant, the other step
   shrinks or merges.
2. **Who is the target user, precisely?** "Non-technical" spans a maintainer
   who dislikes YAML and someone who has never opened a pull request. The
   first is served by phase 3. The second needs phase 4's rehearsal and
   digest pages, plus considerably more hand-holding at Step 5.
3. **Hosted at whose expense?** Phases 0–3 cost nothing to run. Phase 4's
   GitHub App has a real bill. Worth deciding whether this is a free adjunct
   to an open-source harness or something else, before phase 4 rather than
   during.
4. **Does the console configure one repo or many?** Everything above assumes
   one. `project-adapter.yml` is per-repo by design, so multi-repo is a
   listing view over N installs, not a schema change — but it changes the
   phase-4 data model.

---

## 9. Recommendation

Build phase 0 next, regardless of what happens to the console. It is the top
unbuilt item in the README's status table, it's pure functions with a test
file, and it converts "copy this folder and hand-fill 180 lines" into one
command. Phase 1 falls out of it in an afternoon.

Put the console on the roadmap at phase 3, after the reusable workflow (§3)
makes the install a three-file write instead of a forty-file vendor. Design
it to §2.2's rule — keys go browser → GitHub, never through us — and to
§2.3's rule — a control nothing reads is rendered as such — and it will be a
front end this harness can stand behind rather than one that oversells it.
