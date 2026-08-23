# C4 — The run-mode selector

**Status:** PROPOSED · **Phase:** C · **Depends on:** [C3](C3-curiosity-ledger.md), [C8](C8-escalation-follow-through.md) · **Blocks:** C5
**Drawn in:** [D1](../../learning/diagrams/proposed-curiosity-run.mmd), node `mode` and the three branches below it

---

## What it is

Today `recommendScope()` returns `focused` or `ambitious`. This turns it
into a three-way decision — `focused`, `ambitious`, `investigate` — and,
more importantly, **gives the ambitious mode something to work from.**

## The problem it solves

`recommendScope()` (`context-pack.mjs:513`) already does the hard half well:
two generations that each merged on the first attempt unlock one ambitious
run, and a failure spends it. *The trigger is competence, not a schedule* —
[principle 21](../../learning/01-principles.md#21-constraints-never-expire-hints-should)'s
"make the ceiling a mode rather than a posture", already shipped.

What is missing is a backlog. When scope flips to `ambitious`, the prompt
says, in effect, *"be ambitious, pick one coherent big thing"* — and nothing
tells it **which** big thing three models already agreed on and a human
already accepted. The consensus machinery produces a decision that no run
consumes.

So:

> `recommendScope()` decides **when** ambition is allowed.
> The ledgers decide **what** it attempts.

This also means there is no second concurrent pipeline. Two agent branches
diverging from the same base would give the harness a merge problem its
all-or-nothing, pristine-tree guarantees have no story for. One track, three
modes, alternating.

## The decision

```js
export function selectRunMode({
  repoRoot, generationsDir, required = 2,
  escalationLedger, curiosityLedger, goal,
}) // → { mode, reason, assignment | question | null }
```

In order — first match wins:

| # | Condition | Mode | Carries |
|---|---|---|---|
| 1 | `recommendScope()` says `ambitious` **and** an accepted escalation is queued with no `work.completed` | `ambitious` | the escalation as an `assignment` |
| 2 | `recommendScope()` says `ambitious` and nothing is queued | `ambitious` | `null` — today's behaviour, unchanged |
| 3 | A question is authorised for a spike (see [C5](C5-the-spike.md) §"Authorisation") **and** no assignment is queued | `investigate` | the question |
| 4 | otherwise | `focused` | `null` |

Rule 3 sitting **below** rule 2 is deliberate: an accepted escalation is a
decision a human already made, and it outranks the loop's own curiosity.
A spike fills earned headroom that has nothing waiting for it — it never
displaces committed work.

Rule 3 also requires that the last N generations were not themselves spikes.
Two investigations in a row with no shipped change between them is the loop
talking to itself, and the cap (default: no spike within 3 generations of the
last one) is the cheapest guard against it.

## What each mode changes in the prompt

`DEFAULT_SCOPE_TEXT` gains a third entry, and the ambitious entry gains an
assignment branch:

```js
export const DEFAULT_SCOPE_TEXT = {
  focused:   /* unchanged */,
  ambitious: /* unchanged — used when no assignment is queued */,
  investigate: `- This generation produces a DOCUMENT, not a change. Do not
  write edit blocks; they will be refused.
- One question, investigated properly, is the whole output.`,
};

export function buildAssignmentSection(assignment) // → string | null
```

`buildAssignmentSection` renders an accepted escalation as what it is — *a
decision already taken, with the owner's own words attached* — and returns
`null` when there is no assignment, so the ambitious prompt falls back to
today's text unchanged.

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/context-pack.mjs` | `selectRunMode()` beside `recommendScope()`. **Keep `recommendScope()` exported and unchanged** — it is tested, it is the competence half, and `selectRunMode` calls it. |
| `harness/lib/orchestrator.mjs` | `DEFAULT_SCOPE_TEXT.investigate`; `buildAssignmentSection()`; `runGeneration()` accepts `mode` where it currently accepts `scope` |
| `harness/scripts/run-generation.mjs` | Call `selectRunMode()`; keep the `SCOPE` env override, extended to accept `investigate` |
| `harness/lib/adapter.mjs` | `contextConfig()` gains `spikeCooldown` (default 3) |

## Backwards compatibility

`runGeneration()` currently takes `{scope: {scope, reason}}` and throws
without it. The new shape is `{mode: {mode, reason, assignment, question}}`.
Accept both for one release: if `scope` is passed and `mode` is not, wrap it.
The written record's `scope` field keeps its name and gains `mode` beside it,
so `buildGenerationIndex()` and `landedCleanly()` keep working against
existing `attempts.json` files — of which there are already many, and none
of them can be rewritten.

## Failure behaviour

- **Ledgers missing or malformed** → `selectRunMode()` degrades to
  `recommendScope()`'s two-way answer. A helper that cannot decide falls back
  to the conservative default, per
  [principle 14](../../learning/01-principles.md#14-the-safety-gate-fails-closed-helpers-fail-safe).
- **`SCOPE=investigate` set by hand with no authorised question** → run it
  anyway, with the highest-corroboration open question, and log that it was
  forced. A human overriding is a human overriding.
- **No goal configured** ([C1](C1-committed-goal.md)) → rule 3 is disabled
  entirely. A spike with nothing to be relevant to is the exact failure this
  design is trying to avoid.

## Tests to write

1. Ambitious + queued assignment → `ambitious` carrying it.
2. Ambitious + empty queue → `ambitious` with `assignment: null`, and the prompt is byte-identical to today's.
3. Authorised question + queued assignment → `ambitious`, **not** `investigate` (the ordering rule).
4. Authorised question + nothing queued → `investigate`.
5. Spike cooldown: a spike two generations ago blocks another.
6. No goal → never `investigate`.
7. Malformed ledger → falls back to `recommendScope()`'s answer without throwing.
8. `runGeneration({scope})` still works — the compatibility shim.
