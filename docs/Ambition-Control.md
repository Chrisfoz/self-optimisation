# Ambition control — the dial, its risks, and why rollback sits beside it

The harness pulls every generation toward a small, localised change by
default, and the 2026-09 review ([`Review-SWOT-2026-09.md`](Review-SWOT-2026-09.md)
F1) found that pull built in at four points rather than chosen once. Three
of those are fixed in code. The fourth is a decision, not a bug: **how
ambitious should an unattended run be allowed to be?** That is the owner's
call, it varies by project, and it belongs on a dial the owner can see
rather than in a rubric they cannot.

This document is that dial: what each setting does, what it risks, and the
one thing that has to exist before the dial is safe to offer.

---

## 1. The dial

`project-adapter.yml`:

```yaml
context:
  ambition: earned        # focused | earned | ambitious
  scope_required: 2       # for "earned": clean first-attempt merges in a row
```

| Setting | What every generation attempts | When it is the right choice |
|---|---|---|
| `focused` | One small, localised change. Never structural. | A project in production with real users and a thin test suite; a project being rehearsed for the first time; any project where "did it get worse" is hard to tell. |
| `earned` (default) | Focused, until `scope_required` generations in a row merged on the first attempt. That earns **one** ambitious generation. A lone ambitious failure costs one focused generation; two in a row cost the streak. | Most projects. Ambition is granted by competence rather than by schedule, and withdrawn by evidence. |
| `ambitious` | Structural work on every run: several files, several hundred lines, one coherent idea. | A project whose owner reads every pull request, whose tests are strong, and who wants the models to think about how the project could run differently rather than what could be polished. |

Three ways to set it, highest precedence first:

1. **Per run**, from the Actions tab: **Run workflow** → `scope` →
   `focused` or `ambitious`. This is the console's per-run override too.
   It changes one generation and nothing else.
2. **Standing**, in `project-adapter.yml` → `context.ambition`. Read at
   run time by `run-generation.mjs`; a change takes effect on the next run,
   with no regeneration of the workflow.
3. **Default**: `earned`. Anything unrecognised resolves to `earned`,
   never to `ambitious`. A typo must not be the reason a project starts
   attempting structural change unattended.

What the dial does **not** change: the gates. Independent review, the
guarded-path check, the project's own tests, the churn ceiling, the token
budget and the merge model are identical at every setting. The dial
changes the size of what reaches the gates, not the gates.

---

## 2. What the models are told

The setting reaches the models in two places, and both are mechanism the
harness owns rather than words the project wrote:

- **The suggestion prompt's "Scope for this generation" section**
  (`orchestrator.mjs`, `DEFAULT_SCOPE_TEXT`). Focused: "one small,
  localised improvement, expressible as a small number of edits."
  Ambitious: "structural work is in scope; several files and several
  hundred lines; still one idea, still targeted edits."
- **The ranking rubric** (`orchestrator.mjs`, `RANK_RUBRIC`). Focused
  prefers a fix over an addition and a few localised edits. Ambitious
  prefers the largest genuine effect at acceptable reversibility and says
  in as many words that the smallest proposal is not the default winner.

The agent brief template no longer carries "a small number of localised
edits" under its never-expiring constraints, because that sentence
contradicted every ambitious run. If your project's filled-in brief still
has it, move it: the constraint is *one idea, targeted edits*; the size is
the scope.

---

## 3. The risks, by setting

Stated plainly, because the dial is only safe when the owner knows what
they are turning.

### `ambitious`, at every merge model

- **More rejected attempts.** A structural change is more likely to fail
  review, fail a test, or exceed the churn ceiling. Expect a higher
  abandoned rate and more tokens per generation. The budget cap
  (`budget.max_generation_tokens`) is what bounds the second; keep it on.
- **A harder diff to read.** An approved ambitious change is several
  hundred lines across several files. The reviewer saw it in full; a human
  skimming the pull request may not. The proposal's `WHY THIS ONE` and
  `RISK` fields and the review verdict are in `proposal.md` for a reason.
- **A change that passes every gate and is still wrong for the project.**
  Tests prove the project still works. Review proves the change is what
  the proposal said. Neither proves the owner wanted the project to work
  *that way*. This is the risk the gates cannot catch, and it is why §4
  exists.
- **Blast radius on the pinned seats.** An ambitious proposal is
  implemented by the pinned implementer, which was chosen for a smaller
  job. Its `maxTokens` and the refine loop cope, but a large edit set is
  where all-or-nothing application and truncation salvage earn their
  keep. Read the attempt record of the first few ambitious runs.

### `ambitious` with `autonomous-merge`

Everything above, landing on the default branch with nobody asked first.
`init` refuses this combination unless the owner types the word, and the
console should render it the same way. If you choose it anyway: keep
`verify_strategy` real (not `none`), keep the budget cap, keep the kill
switch variable within reach, and rehearse a revert before the first
scheduled run.

### `earned`

The streak logic is the risk. Two clean generations can be two trivial
ones, and the ambitious generation that follows is then a bigger jump than
the streak suggests. `scope_required` is the knob; 3 is a reasonable
setting for a project with weak tests.

### `focused`

The risk is the one the review named: the loop polishes and never thinks
about how the project could run differently. That is a fine trade for a
project that wants exactly that. It should be a choice, not the only
setting.

---

## 4. Rollback: the other half of the dial

A dial that lets an unattended run attempt more is only responsible
alongside a way to take a shipped change back that is as easy as the dial
was to turn. Every gate is a prediction; rollback is the correction.

```
node harness/scripts/revert-generation.mjs NNN [--reason "..."]
```

What it does, on either merge model:

1. Finds the merge that shipped generation NNN — the `gen-NNN` tag on the
   autonomous path, the pull request's merge commit on the default path.
2. Reverts it on the default branch (`git revert -m 1`, so the project's
   history keeps both the change and its undoing) and pushes.
3. Writes `reverted: {date, reason, commit}` into that generation's
   `attempts.json`, so the next run's history says REVERTED with the
   reason, the generation index says so, and the earned-ambition streak
   counts it as a failure. The models are told, in the record they read
   every run, that a person took this one back.

What it does **not** do: touch any other generation, delete the branch or
the tag, or rewrite history. A revert is a new commit, the way the
harness's own promotions are.

The console's run view should show a **Revert** button beside every merged
generation, wired to this script through a `workflow_dispatch`. **The
ambition dial should not be offered in a console that does not have the
button.**

---

## 5. What to watch after turning it up

The generated report (`harness/scripts/report.mjs`, when built) and the
digest carry the numbers that say whether ambition is paying:

- **Abandoned rate** for ambitious generations against focused ones. If
  ambitious runs almost never ship, the project's brief or tests are not
  ready for them; turn the dial back to `earned` and fix that first.
- **Closed-unmerged and reverted counts.** These are the owner's own
  verdicts, read back from the pull request and the revert script. A rise
  after turning the dial up is the signal the gates cannot give you.
- **Tokens per shipped change.** Ambition costs more per attempt and
  ships less often; the ratio is what to compare, not either number alone.

If all three move the wrong way, the dial is not the fix. The brief, the
tests, or the goal (`docs/curiosity/C1-committed-goal.md`) is.
