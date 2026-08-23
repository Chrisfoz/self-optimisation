# C1 — The committed goal

**Status:** PROPOSED · **Phase:** −1 · **Depends on:** nothing · **Blocks:** C4, C5, C9
**Drawn in:** [D1](../../learning/diagrams/proposed-curiosity-run.mmd), node `cons`

---

## What it is

The user states, once, what this project is trying to become. It is frozen
in the constitution rather than written into the agent brief, it is shown to
every stage, and the reviewer judges against it.

This is not a curiosity component. It is the prerequisite the rest of the
folder leans on, for one reason: `Usefulness` — the term that decides whether
a question is worth asking — has no referent without it. *Useful toward
what?* A harness whose success signal is "tests pass and a reviewer approved"
cannot answer that. See
[`../Curiosity-Engine-Design.md` §5.2](../Curiosity-Engine-Design.md).

## Why the constitution and not the brief

The brief is a prompt: models read it, argue with it through `BRIEF
FEEDBACK`, and a human edits it as models improve. That is correct for
*hints* and wrong for a goal, which must survive every model rotation
unchanged.

The constitution is already the frozen half — `allowed_paths`,
`frozen_paths`, `churn_ceiling` — enforced twice, in `edit-format.mjs`
in-process and in `guard.mjs` in CI
([principle 11](../../learning/01-principles.md#11-enforce-every-rule-twice-in-two-different-places)).
The goal belongs there, with the same double enforcement and the same escape
hatch: a model may open an escalation arguing the goal is wrong
([principle 10b](../../learning/01-principles.md#10b-a-frozen-rule-still-needs-a-way-to-be-wrong)),
and a human may change it. Nothing else may.

## Write it as direction plus constraints, never as a metric

[Principle 22b](../../learning/01-principles.md#22b-a-fitness-function-measures-what-it-can-reach-not-what-matters--and-the-loop-will-optimise-the-gap)
is the whole risk here: *a fitness function measures what it can reach, not
what matters, and the loop will optimise the gap.* A goal expressed as a
number will be gamed exactly the way `readingLevel` was.

So the goal is prose, and **the reviewer is the thing that judges alignment
to it** — not a scorer, not a threshold. That keeps the judgement where a
model's actual reading comprehension can be applied, and keeps it inside a
gate that already fails closed.

## Schema

`project-adapter.yml`:

```yaml
project:
  id: carrotgame
  description: two educational browser games for children aged 3-8

  # C1. Frozen. Models may argue against this through the escalation
  # ledger; no model may edit it. Changing it is a human editing this file.
  goal:
    statement: >
      Become the thing a nurse reaches for when a frightened child needs
      ten minutes of calm, on a shared hospital tablet, with nobody
      available to help them use it.
    # Optional. Each is a standing test the reviewer applies, in prose.
    holds:
      - A child who has never seen it before can start playing without being told how.
      - It works on the oldest tablet on the ward, offline, in one tap.
      - Nothing in it can frighten, rush, or shame a child.
    # Optional. What would count as drifting away from it.
    away_from:
      - Anything that rewards speed over calm.
      - Anything that needs an adult to explain it first.
```

`statement` is required if `goal` is present. `holds` and `away_from` are
optional lists, capped at 8 entries and 300 characters each.

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/adapter.mjs` | New `goalConfig(adapter)` accessor beside `constitutionAllowlist()` / `guardConfig()`. Returns `{statement, holds, awayFrom}` or `null`. Same null-default shape as the other accessors. |
| `harness/lib/guard.mjs` | Treat the adapter's `project.goal` subtree as a frozen field, the way `constitution.frozen_fields` already works. An agent editing its own goal is [principle 10](../../learning/01-principles.md#10-an-agent-that-can-edit-its-own-rules-has-no-rules) exactly. |
| `harness/lib/orchestrator.mjs` | `buildSuggestSystemPrompt()` renders the goal **above** the agent brief, labelled as the one thing that does not change. `buildSuggestUserPrompt()` gains no section — the goal is a constraint, not context. |
| `harness/lib/review.mjs` | The reviewer's system prompt gains the goal and one instruction: a change that is correct, safe and tested but moves away from the goal is a rejection with a reason, not an approval. |
| `harness/scripts/run-generation.mjs` | Read it, pass it through, and add it to the `📚 Context:` log line. |

## Interface

```js
// adapter.mjs
export function goalConfig(adapter) // → {statement, holds: string[], awayFrom: string[]} | null

// orchestrator.mjs
export function buildGoalSection(goal) // → string | null  (null drops it entirely)
```

`buildGoalSection` returns `null` when no goal is configured, and every
caller drops the section rather than emitting an empty heading — the
`buildThemesBrief()` pattern, and
[principle 18](../../learning/01-principles.md#18-never-claim-data-you-did-not-supply).

## Failure behaviour

- **No goal configured.** Everything works exactly as it does today. The
  section is absent, the reviewer's extra instruction is absent, and C4/C5/C9
  degrade to their goal-free behaviour rather than erroring. A goal is a
  strong recommendation, not a hard requirement, because the harness must
  stay installable in fifteen minutes.
- **Malformed goal** (present but no `statement`): fail loudly at adapter
  load, the way a missing `allowed_paths` already does. A half-specified goal
  silently ignored is worse than no goal.

## Tests to write

1. `goalConfig` reads a fully populated goal; returns `null` for an adapter with no `project.goal`.
2. `goalConfig` throws on `goal:` present with no `statement`.
3. `holds` / `away_from` are capped and clamped.
4. `buildGoalSection(null)` returns `null`; a populated goal renders the statement and both lists.
5. `buildSuggestSystemPrompt` with no goal is byte-identical to today's output. **This is the important one** — it proves the change is additive.
6. The guard refuses a diff that edits `project.goal` in the adapter.

## Open question for the owner

**When the goal and the consensus bar disagree, which wins?** Three models
can agree on something that does not serve the goal; one model can be right
about something that does. This decides whether the reviewer asks *"is this
good?"* or *"does this move us toward the stated goal?"*, and it decides
whether C8's work orders are gated on goal-alignment or only on consensus.

The recommendation is **the goal wins and consensus becomes evidence rather
than authority** — but it should be decided deliberately here, not
discovered the first time they conflict.
