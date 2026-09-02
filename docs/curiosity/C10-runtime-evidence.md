# C10 — Runtime evidence in the context pack

**Status:** ✅ **BUILT** (2026-09-02) · **Phase:** any — **independent of everything else here**
**Drawn in:** [D1](../../learning/diagrams/proposed-curiosity-run.mmd), node `runlog`

---

## What it is

What the tests, the deployment check and the probes **actually saw** — as
context, alongside the source. Not a verdict, not a score: the observation.

This is the one thing worth borrowing from
[hexo-ai/sia](https://github.com/hexo-ai/sia). Its improvement agent reads
`agent_execution_log.json` — what happened at runtime — while this harness's
improvement signal is *"review approved, tests green"*: a judgement about
code, made by reading code.

It is also independent of every other component here and improves **every**
proposal the harness makes, curiosity or not. Build it whenever.

> **Built.** `buildRuntimeEvidence()` in `context-pack.mjs` (the read side,
> exactly the interface below), `harness/lib/runtime-evidence.mjs` (the write
> side — fragment merging, TAP parsing, score-dropping),
> `harness/scripts/record-runtime-evidence.mjs` (the CLI the generated
> workflow runs last, `always()`), and `--evidence` on
> `verify-deployment.mjs` so the deploy check contributes what it observed
> rather than only its verdict. 16 tests.
>
> Two things worth knowing that the spec below does not say:
>
> - **The composite score is dropped at the point of WRITING, not only at
>   rendering.** A score that never reaches the file cannot leak into a
>   prompt through some later reader that forgot the rule.
> - **Your tests contribute, or they do not, and nothing pretends
>   otherwise.** The recorder reads a TAP stream at `$RUNNER_TEMP/tests.tap`
>   if one is there. Nothing writes it for you, because your test command is
>   yours: a runner that can emit TAP tees it there, any other project writes
>   a JSON fragment and passes `--fragment`, and a project that does neither
>   simply records less. The section shrinks rather than lying — and an
>   evidence file with nothing in it is never written at all, because
>   `buildRuntimeEvidence()` would otherwise count it as a run it had
>   evidence for.

## Why it matters more for curiosity than for anything else

A curiosity engine reading only source will ask questions about source.
Questions about *behaviour* are the ones worth a generation, and they are
unaskable from a file listing.

The evidence for that is already in this repository. The readiness
scorecard's **first run** found a defect 239 existing checks had never
noticed: two pages pulling a webfont from a third party over a
render-blocking import, stalling first paint by about thirteen seconds with
that host unreachable. Every gate was green throughout
(`learning/07-whats-actually-new.md` §3).

That defect was invisible to every model the harness ever asked, because
nothing in the prompt described what the product *did* — only what it *was*.

## What to include

| Source | Exists today | What to send |
|---|---|---|
| Test run | Yes, in CI | Which suites ran, counts, **and the names of anything skipped** — a skipped test is a lie the record tells by omission |
| `verify-deployment.mjs` | Yes | What the live check actually fetched and found, not just pass/fail |
| Readiness probe | Project-specific plugin | The raw per-dimension observations, **not** the composite score |
| Timing | Partly | Wall-clock of the slowest steps |

**Send the observation, not the score.** The `readingLevel` incident is the
argument: a single number invited optimisation of the number. The raw
observation — *"the probe drove real play and these were the draw calls"* —
cannot be gamed the same way, because there is no single quantity to move.

## Interface

```js
// harness/lib/context-pack.mjs
export function buildRuntimeEvidence({ repoRoot, evidenceDir, limit = 3 })  // → string | null
```

Reads the last `limit` runs' evidence files, formats compactly, returns
`null` when there are none — dropping the section entirely, per
[principle 18](../../learning/01-principles.md#18-never-claim-data-you-did-not-supply).

Written by a CI step:

```jsonc
// docs/runtime/gen-NNN.json
{
  "version": 1,
  "generation": "019",
  "date": "...",
  "tests":  { "suites": [{ "name": "...", "passed": 98, "failed": 0, "skipped": ["..."] }] },
  "deploy": { "url": "...", "checks": [{ "what": "...", "observed": "..." }] },
  "probe":  { "dimensions": [{ "name": "...", "observed": "...", "method": "..." }] },
  "timing": { "slowest": [{ "step": "...", "ms": 12800 }] }
}
```

`method` on a probe dimension exists because of the `readingLevel` lesson:
*how* a thing was measured is the part that turned out to matter, and it is
the part a model needs in order to notice the metric is blind.

## Budget

This competes for attention with source, history, themes, escalations and
questions.
[Principle 17](../../learning/01-principles.md#17-send-what-changes-the-decision-not-what-describes-the-project)
is explicit that the fix for weak context is never "send more."

Cap it at roughly 2,000 characters — the size of the test index, not the
size of the source bundle — and prefer **anomalies over totals**: the
skipped test, the slow step, the check that observed something unexpected.
"98 passed" changes no decision. "3 skipped, named X, Y, Z" might change
several.

## Where it plugs in

| File | Change |
|---|---|
| `harness/lib/context-pack.mjs` | `buildRuntimeEvidence()` |
| `harness/lib/verify-deployment.mjs` | Emit observations, not only a verdict |
| `harness/lib/orchestrator.mjs` | One `section()` — *"What the last runs actually observed"* |
| `harness/scripts/run-generation.mjs` | Wire into `context.runtime`; add to the `📚 Context:` log line |
| `harness/lib/adapter.mjs` | `contextConfig()` gains `runtimeEvidenceDir` |
| `examples/workflows/watch-releases.yml` | A step that writes the evidence file after tests and the deploy check |

## Failure behaviour

Absent directory, malformed file, or partial evidence → the section shrinks
or disappears. This is a helper: it fails safe, and a generation with no
runtime evidence is exactly today's generation.

## Tests to write

1. `buildRuntimeEvidence` returns `null` for a missing directory and for an empty one.
2. Malformed JSON in one file does not take the others down.
3. The character cap holds; anomalies survive truncation ahead of totals.
4. Skipped test names are always included when present.
5. The composite score is **not** rendered even when the file contains one.
