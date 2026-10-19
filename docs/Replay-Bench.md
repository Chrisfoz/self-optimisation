# Replay bench

`harness/scripts/bench.mjs` compares two or more ways of running the harness
on the same tasks: same models, same budget, same memory, same commit. Use it
before changing a default, for example before switching a project from
`context.strategy: full-dump` to `scoped`. A change should be adopted because
it measurably saves something without losing correctness, not because it
sounds better.

## What a run does

For every task × variant × trial:

1. It makes a fresh clone of the task's repository and checks out
   `baseCommit`. That pins the source and the memory, because the generation
   records, ledgers, lessons and themes are committed there too.
2. It merges the variant's `adapter` patch into the project's adapter. A
   variant may change what the harness looks at: context strategy, history,
   index size, retrieval. It may not change `constitution`, `evaluation`,
   `deployment`, the review seat or the budget. The spec is rejected if it
   tries.
3. It runs one real generation through `run-generation.mjs`, with the task's
   `suggestModels`, as a campaign.
4. It runs the task's `oracleCommands`. These are held-out checks. Keep them
   in files beside the spec, outside the clone, and refer to them through
   `$BENCH_ORACLE_DIR`, so no model can read them. Like the loop's own test
   runner, they run with every secret scrubbed from the environment.
5. It deletes the clone. Nothing is pushed, and the task's repository is
   never written to.

Variants interleave within each trial, so a lab's bad hour lands on every
variant instead of on whichever ran last.

## Scoring

| Measure | Meaning |
|---|---|
| Verified success | Review approved the change **and** the oracle passed. Reported with a 95% Wilson interval. |
| Missed regression | Review approved the change, but the oracle failed. Review and the in-loop tests both let it through. |
| Tokens per verified success | The total spend of a variant divided by its verified successes, counting every call. |
| Bench errors | A clone, setup or harness failure. Counted, but never scored against a strategy. |

The decision for each candidate against the first (baseline) variant:

- **reject**: worse verified success (intervals do not overlap), or more
  missed regressions.
- **adopt**: better verified success (intervals do not overlap).
- **adopt-provisionally**: fewer tokens and no observed loss, at a sample
  size that cannot rule one out. Run a bounded trial on the real project
  before changing a default.
- **not-shown**: anything else. Overlapping intervals are never reported as
  "better".

## Writing tasks

Good tasks have an answer that the oracle can check and the models cannot
see:

- **A planted bug.** Commit a defect and leave a `TODO`-free brief. The
  oracle is a test that fails on the defect and passes on any correct fix.
- **A replayed generation.** Use a past generation's base commit
  (`provenance.baseCommit` in its `attempts.json`) whose later fate is known.
  The oracle is the check that later caught the regression, or the test a
  person added when they merged it.
- **A dependency trap.** Plant a change that breaks an unchanged caller.
  This tests whether review sees dependents
  (`harness/lib/review-evidence.mjs`).

Use several tasks and at least three trials. One task and one trial measure
noise.

```json
{
  "trials": 3,
  "budgetTokens": 600000,
  "tasks": [{
    "id": "planted-off-by-one",
    "repo": "../my-project",
    "baseCommit": "4f2a9c1",
    "suggestModels": [{ "id": "gemini-3.8-flash", "provider": "google" }],
    "setupCommands": ["npm ci"],
    "oracleCommands": ["node --test \"$BENCH_ORACLE_DIR/paging.hidden.test.mjs\""]
  }],
  "variants": [
    { "id": "full-dump", "adapter": { "context": { "strategy": "full-dump" } } },
    { "id": "scoped", "adapter": { "context": { "strategy": "scoped" } } }
  ]
}
```

```bash
node --env-file=harness/.env.harness.local harness/scripts/bench.mjs bench.json --out bench-out
```

The command writes `bench-out/REPORT.md` and `results.json`, plus every
trial's log and `attempts.json`. Each trial spends real tokens. Size
`budgetTokens` and `trials` before the first run.

## Limits

- The oracle is the only label here that does not come from the harness
  itself. A weak oracle makes every variant look good.
- Results hold for the tasks you wrote. Before a strategy becomes a default
  on another project, check that it transfers to that project.
- In this bench, the review seat and the in-loop tests are fixed. It measures
  how a strategy changes the harness's inputs, not changes to the gates
  themselves.
