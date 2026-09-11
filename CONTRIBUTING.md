# Contributing

Thanks for looking. This repository builds a harness that other people's
repositories will eventually run **unattended, with write access to their own
code**. That single fact shapes every convention below: code merged here
becomes machinery someone else trusts without reading it.

Read [`README.md`](README.md) first for what the project is, and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for what's actually built today versus
what's still a design.

---

## The one idea everything else follows from

**The harness owns mechanism; the project owns content.**

`harness/lib/` and `harness/scripts/` must work for *any* project. Every
project-specific value — paths, models, cadence, deployment target, what
"better" means — arrives through `project-adapter.yml` via
[`harness/lib/adapter.mjs`](harness/lib/adapter.mjs)'s accessors, or through a
brief file the project wrote. A feature that only works for one shape of
project, or that puts a project's words in the harness's voice, is drifting
back toward the single codebase this was extracted from.

If you find yourself hardcoding a path, a model id, or a sentence about
someone's product inside `harness/`, that's the signal to add an adapter field
instead.

---

## Non-negotiables

These are real defects when broken, not style opinions. Each one exists
because of a specific failure — usually one that already happened.

1. **Zero npm dependencies outside two named files.**
   [`harness/lib/adapter.mjs`](harness/lib/adapter.mjs) and
   [`harness/lib/scaffold.mjs`](harness/lib/scaffold.mjs) may use `js-yaml`,
   because parsing and emitting YAML by hand is worse. Nothing else in
   `harness/` may import from `node_modules`. `adapter.mjs`'s own import is
   lazy — inside the function, after an existence check — so a project with no
   adapter file never needs `js-yaml` installed at all. If you need a utility,
   check Node's built-ins first; the whole install is "copy one folder," and
   every dependency erodes that.

2. **Edits are all-or-nothing.** [`edit-format.mjs`](harness/lib/edit-format.mjs)
   validates every edit in memory across every file before a single byte
   reaches disk. A partially-applied patch set is the failure mode this
   prevents — half a change is worse than none, because the tests may still
   pass.

3. **The safety gate fails closed; helpers fail safe.** An unparseable review
   verdict is a rejection, never an approval
   ([`review.mjs`](harness/lib/review.mjs)). A helper that can't decide — a
   ranker, a scorer, a digest writer — falls back to a defensible default and
   says so. Know which of the two you're writing before you choose a fallback.

4. **Never claim data you didn't supply.** A prompt section with no content is
   dropped entirely, heading and all. There must be no state in which a prompt
   describes a question list, a themes review, or a test index that isn't
   actually there. `buildThemesBrief()` returning `null` is the pattern to
   copy.

5. **No script injection in generated CI.** Anything model-generated or
   otherwise untrusted (a proposal summary, brief feedback) is passed through
   `env:` and read as `$VAR` inside the script — never interpolated into a
   `run:` block via `${{ }}`. See the header comment in
   [`harness/templates/workflow.yml.tmpl`](harness/templates/workflow.yml.tmpl).

6. **An agent may argue with a rule; it may never edit one.** The guard
   ([`guard.mjs`](harness/lib/guard.mjs)) enforces frozen paths against a real
   git diff. The escalation ledger is how a model makes its case. Nothing you
   add should give an agent a path around that.

---

## Where a file goes

| Directory | Holds | Rule |
|---|---|---|
| `harness/lib/` | Pure logic | No `process.exit`, no `console.log`, no direct filesystem or network access unless it's the file's whole purpose (and then inject it). Must be unit-testable without mocking I/O. |
| `harness/scripts/` | CLI wrappers | Owns stdio, `process.env`, `process.exit`, reading and writing files. Thin — the logic belongs in `lib/`. |
| `harness/providers/` | One file per lab | Self-registering. See [`CONTRIBUTING-A-PROVIDER.md`](harness/providers/CONTRIBUTING-A-PROVIDER.md). |
| `harness/templates/` | Files `init.mjs` fills in | Never read at runtime by the loop itself. |
| `harness/cli/` | The scaffolder | Prompting and file writing only; rendering lives in `lib/scaffold.mjs`. |
| `tests/lib/` | Per-module tests | One file per `harness/lib/` module. |
| `tests/e2e/` | Whole-chain tests | Real git, real child processes; only model calls faked. |
| `learning/` | Portable lessons | Written to be lifted into another project — must not depend on this repo's specifics. |
| `docs/` | Research corpus **and** this project's own designs | Keep the two distinct: third-party PDFs are gitignored; `docs/curiosity/` and `docs/Curiosity-Engine-Design.md` are ours. |
| `console/` | Browser installer, HTTP API, GitHub App client and design records | Current implementation: `console/IMPLEMENTATION.md`; deployment requirements: `console/DEPLOYMENT.md`. |

A file that doesn't fit one of these cleanly is worth raising in an issue
before it sets a precedent.

---

## Testing

```bash
npm test
```

Node's built-in runner — no framework to install. Two surfaces, deliberately
separate:

- **`tests/lib/`** proves each module in isolation, with model calls faked at
  the narrowest boundary the test needs.
- **`tests/e2e/`** proves the pieces *chain* — real git remote, real child
  process for the test gate, faking only the model calls. It exists to catch
  the failure per-module tests structurally cannot: two components each
  correct, disagreeing at the seam.

**Every behaviour change needs a test.** Not because of a coverage target, but
because of this project's own first principle: *a gate that cannot fail is not
a gate.* If you fixed a bug, the test should fail without your fix — check
that it does.

Prefer proving a thing against reality over asserting your assumption about
it. `guard.test.mjs` and `promote.test.mjs` both run against real temporary git
repositories for exactly this reason: the assumed output shape of
`git diff --name-status` is the kind of thing that's right until it isn't.

On Windows, use the explicit glob (`node --test "tests/**/*.test.mjs"`, which
is what `npm test` runs) rather than a bare directory — see README's
OS-specific notes for the Node/Windows combination that fails confusingly.

---

## Saying what's true

This repository's documentation is load-bearing — a human, and eventually an
agent, reads it and acts on it. Drift here isn't cosmetic.

- **Mark proposals as proposals.** Historical parts of `console/DESIGN.md` and `docs/curiosity/` describe
  work that is not implemented; current console status is in `console/IMPLEMENTATION.md`. Any diagram, table, or sentence about them must
  make that unmistakable. In diagrams the convention is dashed and warm-toned
  for proposed, solid for real.
- **Keep the three-way status agreement.** `README.md`'s Status table,
  `ARCHITECTURE.md`'s diagram and prose, and
  `Portable-Harness-Design.md`'s status/revision log describe the same facts.
  If they disagree, the stated tie-break is *trust whichever was edited most
  recently, and fix the others* — actually apply it rather than noting it.
- **Don't fix by weakening.** The cheapest way to make an inaccurate claim go
  away is to delete it. Correct the number instead — "many tests" is worse
  documentation than a wrong specific number, because nobody can check it.
- **Quote figures with a date and a link** when they come from outside
  (release cadence, benchmark numbers). They rot, and a reader needs to know
  how stale they are.

---

## Diagrams

Sources are `.mmd` files in [`learning/diagrams/`](learning/diagrams/), plus
mermaid blocks embedded directly in `ARCHITECTURE.md`.

**Render before committing a diagram change** — a diagram that fails to parse
looks identical to one nobody has looked at:

```bash
npx -y @mermaid-js/mermaid-cli -i learning/diagrams/<file>.mmd -o /tmp/out.svg
```

Where a diagram is both a sidecar `.mmd` and an embedded copy in
`ARCHITECTURE.md`, the two must stay byte-identical. They have silently
diverged before. Read
[`learning/diagrams/README.md`](learning/diagrams/README.md)'s "three
mechanical traps" before spending an afternoon on Mermaid.

---

## Commits and pull requests

- Write a subject line that says what changed and, where it isn't obvious,
  why. The existing log is the style guide — commit messages here carry real
  reasoning, including what was checked and what was found.
- Keep a pull request to one coherent change. A doc correction discovered
  while fixing a bug is fine to include; an unrelated refactor is not.
- Say what you verified and how. "Tests pass" is less useful than "added a
  test that fails without the fix; also ran init against a fresh git repo."
- If you changed something whose status is documented, update the docs in the
  same commit.

---

## Please open an issue first for

- **Anything that weakens a safety claim** — the guard, the allowlist, the
  fails-closed review, what the harness sends over the network or trusts
  unread. These are promises to every downstream install, not house style.
- **A new npm dependency**, for the reasons in Non-negotiables 1.
- **A new top-level directory**, or a change to the adapter schema.
- **Restructuring a document** wholesale, as opposed to correcting claims in
  it.

---

## Two things that are genuinely undecided

Raising these is welcome; assuming an answer is not.

- **The licence is MIT** (`LICENSE`, added 2026-09-02). Contributions are
  accepted under the same terms.
- **`console/DESIGN.md` §1.1 names governance as open**: branch protection, who
  gets merge rights, and how outside contributions get reviewed are all
  deliberately unsettled rather than rushed.

One point of possible confusion worth stating: `.agent/` is gitignored *in this
repository*, but README's install guide tells a target project to **commit**
it. Both are right — this repo is the tool, not an installation of it, so its
own `.agent/` is throwaway local rehearsal state.

