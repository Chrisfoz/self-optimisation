# Evaluator plugins — the interface

A quality-dimension evaluator answers **"how much"** about a project, in a
dimension that its tests do not cover and cannot fail it on.

This is the category `visual-check.mjs` and `wordless-play.mjs` belong to.
`Portable-Harness-Design.md` §8.2 states the correction plainly:
"visual/wordless-play" was never the general case — it is one instance of
*domain-specific quality dimensions beyond pass/fail, evaluated non-gating*.
A canvas game measures whether a child who cannot read can still play it. A
Java service measures a Checkstyle count and a JaCoCo delta. A CLI measures
cold-start time. **None of those belong in this harness. All of them are the
same shape, and that shape is what does.**

---

## The contract

A plugin is an ES module with a default export:

```js
export default {
  name: 'source-weight',
  async evaluate({ repoRoot, generation, config }) {
    return [{ name: 'editable source', value: 1234, unit: 'lines', direction: 'lower' }];
  },
};
```

**Input**

| Field | What it is |
|---|---|
| `repoRoot` | Absolute path to the working tree **as the generation left it** — after the edits, before any merge. |
| `generation` | That generation's parsed `attempts.json`, or `null` if there isn't one. `filesChanged`, `outcome`, `proposalSummary` are the fields most plugins want. |
| `config` | Whatever the adapter passed under this plugin's `config:` key. Plain data, never validated by the harness — validate your own. |

**Output** — one metric, or an array of them, or nothing:

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Short, human-readable, stable across runs. It is a row label, not a sentence. |
| `value` | yes | A finite number, or a non-empty string. |
| `unit` | no | `'lines'`, `'ms'`, `'%'`. Omit when the name already carries it. |
| `direction` | no | `'lower'` or `'higher'` — which way is better. Omit when neither is. |
| `detail` | no | One sentence of context. Clamped to 500 characters: this text is read back into every subsequent suggestion prompt, and a plugin that returned a log file would quietly become the largest block in it. |

Return `[]` or `null` when there is nothing to measure this run. That is a
normal outcome, not a failure.

---

## Three rules, enforced by the runner rather than by your good behaviour

`harness/lib/evaluators.mjs` is what calls your plugin, and it is written on
the assumption that plugins are third-party code written by people who have
never read this harness.

1. **A plugin cannot fail a generation.** Every call is wrapped. Throw, hang
   past the timeout, or return nonsense, and the result is a recorded error
   and nothing else — the generation is unaffected, the merge or the pull
   request proceeds. *A measurement that can break the loop is a gate wearing
   a metric's clothes.* If you want a gate, add a test command; that is what
   `evaluation.test_commands` is for, and it is allowed to fail things.
2. **A plugin does not write.** You are handed a tree and a record and are
   expected to read them. Nothing in Node enforces this — there is no
   sandbox — so it is stated here instead: a plugin that edits the working
   tree is corrupting the diff a human is about to review, and the harness
   will not notice.
3. **Metrics are normalised on the way out.** Your shape is checked
   (`normalizeMetric()`); a malformed metric becomes a plugin error rather
   than something the digest or the next prompt has to survive.

There is a fourth rule that is nobody's to enforce, only to honour: **a
metric is not a target.** The brief these values are rendered into says so to
the model explicitly. A generation that makes a dimension worse for a good
reason is allowed to, and a project that wants otherwise should promote the
dimension into a real gate deliberately, by hand, as a test command — never
by letting a plugin start refusing things.

---

## Wiring one up

```yaml
# project-adapter.yml
evaluation:
  test_commands: [npm test]        # the gates — these CAN fail a generation
  evaluators:                      # the dimensions — these never can
    - module: harness/plugins/evaluators/source-weight/index.mjs
      config:
        paths: [src/**/*.js]
```

`module` is resolved relative to the project root, so a project's own plugin
lives in that project's repository (`tools/evaluators/my-thing.mjs`) and is
version-controlled with the thing it measures. Nothing has to be contributed
back here to be used.

Then run it after a generation:

```
node harness/scripts/run-evaluators.mjs
```

The generated workflow already does this. Results are written to
`<generationsDir>/gen-NNN/metrics.json`, and the **next** generation's
suggestion prompt reads the most recent one back — which is the whole point:
a dimension nobody ever sees measured is a dimension nobody is watching.

---

## What ships here, and what deliberately doesn't

`source-weight/` is the one shipped example. It measures how much editable
source a project has and how it is distributed — a real dimension for a
codebase that edits itself every month, and one that needs no tooling
whatsoever, which is why it can be the example.

These are **documented extension points, not v1 code** — each is a few dozen
lines against tooling that project already has, and none of them belongs in a
harness that has no opinion about your ecosystem:

| Ecosystem | A plugin worth writing |
|---|---|
| Java | Checkstyle violation count; JaCoCo coverage delta against the base branch |
| Python | `mypy` error count; `ruff` findings by category; coverage delta |
| C# | Roslyn analyzer warnings by severity |
| Web/canvas | The visual and wordless-play checks this category was generalised from: render the tree at a real viewport, attach the screenshots to the review call, instrument the draw calls to tell symbol from word |
| Anything shipped | Cold-start time; artifact size; bundle size delta |

If you write one, the only thing worth copying from `source-weight/` is its
shape. The dimension should be yours.
