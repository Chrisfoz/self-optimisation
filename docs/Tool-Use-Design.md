# Tool Use — Design Document

What it would mean for the models in this harness to *do* things — render a
scene, run a physics step, query a documentation server, call an MCP tool —
rather than only read source and emit text.

**Status: proposal, with phase 1 built (2026-09-06).** Phase 1 —
artifact-returning evaluator plugins, and the two visual sockets that have
been wired to nothing since the port — is real code with tests. Phases 2–5
are design only. Written to the same standard as
[`Portable-Harness-Design.md`](../Portable-Harness-Design.md) and
[`console/DESIGN.md`](../console/DESIGN.md): every claim about what the code
does today is checked against the code with the file and line named, and
every field is marked **LIVE** (something reads it) or **PROPOSED** (nothing
does, yet).

Read §2 and §6 before §9. The idea is right and the examples that motivated
it (Blender for a game, a physics engine for something that touches the real
world) are the right examples — but three separable things are bundled
inside "tools," they have wildly different risk, and the highest-value one
needs no tool-use machinery at all.

---

## 1. Why tools, for this harness specifically

The general argument for tool use is that a model that can act is more
capable than one that cannot. That argument is true and it is not the
argument for building this here.

**The binding constraint in this harness is what a model can NOTICE, not
what it can write.** The evidence is in this repository's own history. The
reference implementation's readiness scorecard found, on its first run, a
defect that 239 existing checks had never noticed: two pages pulling a
webfont over a render-blocking third-party import, stalling first paint by
about thirteen seconds when that host was unreachable
([`learning/07-whats-actually-new.md`](../learning/07-whats-actually-new.md)
§3). Every gate was green throughout. Every model the harness had ever
asked was blind to it, because nothing in the prompt described what the
product *did*.

[`docs/curiosity/C10-runtime-evidence.md`](curiosity/C10-runtime-evidence.md)
is the same finding stated as a principle: every other block in the
suggestion prompt describes what the project *is*; runtime evidence is the
only one that describes what it *did*. Tools are how that block gets
richer. A tool that lets a suggesting model *look at the rendered game*
changes what it proposes. A tool that lets it *write to Slack* does not.

So the ordering principle for this document: **observation first, action
second, world-reaching action last and mostly not at all.**

## 2. Three things, three risk profiles

| # | Category | Examples | Risk | Where it belongs |
|---|---|---|---|---|
| **A** | **Observation** — the model sees something it could not read from source | Render a Blender scene and look at it; run 200 steps of a physics sim and report the trajectory; screenshot the running game; measure cold-start time | Very low. Cannot change the product, cannot reach the network unless it is given it, cannot fail a generation. | The **evaluator plugin** category, which already exists |
| **B** | **Bounded action inside the loop** | `read_file` outside the allowlist, `search`, `run_tests` | Medium, well understood. Every write still goes through `applyEdits()` and the allowlist. | An agentic implement stage — [`Review-10x-2026-09.md`](Review-10x-2026-09.md) P1.3, gated on P1.2's sandbox |
| **C** | **Reaching the world, or making new capability** | Arbitrary MCP servers, model-authored tools, network access, writes to external systems | High, and it is the category that breaks the governance story if done naively | Behind the contract in §4, mostly read-only, with §7's authorship rule |

The user's motivating examples split across this table in a way worth
naming: **Blender and a physics engine are category A**, not C. "The model
needs Blender" almost always means "the model needs to see what the scene
looks like" or "the model needs to know whether the character clears the
gap" — an observation, produced by a tool the *project* runs, not an action
the model takes. That is a much cheaper thing to build and a much safer one
to ship.

## 3. What already exists, and three sockets wired to nothing

Checked against the code as of `249d381`:

| Thing | Where | Status |
|---|---|---|
| Evaluator plugins — third-party code, run after a generation, cannot gate anything, results read into the next prompt | [`harness/lib/evaluators.mjs`](../harness/lib/evaluators.mjs), [`plugins/evaluators/README.md`](../harness/plugins/evaluators/README.md) | **LIVE**. Timeout, error isolation, and normalisation all enforced by the runner rather than trusted to each plugin |
| Screenshots in the suggestion prompt | `orchestrator.mjs:290-292` — `buildSuggestUserPrompt()` takes `screenshots`, renders "The N image(s) attached to this message show the current state of the project" | **LIVE, and fed nothing.** `run-generation.mjs:266` passes `{ images: [], source: null }` with the comment *"visual capture: project-specific plugin, not wired by default"* |
| Visual capture in the review call | `review.mjs:83,93` — `captureVisual` is a project-supplied hook whose images are attached to the review request | **LIVE, and fed nothing.** Defaults to `noVisualCapture()` (`review.mjs:33`), which reports "no visual capture configured for this project" |
| Images over the wire, per lab | `llm-provider.mjs:222` — `images: [{mime, data}]`, with each provider file encoding its own content parts, and a text-only retry when a model turns out to have no vision | **LIVE, tested** |
| The hostile-input envelope | `context-pack.mjs:84` — `fenceUntrusted(label, text)` | **LIVE**, applied to the source bundle and architecture notes |
| Tool use / function calling of any kind | — | **Absent.** `grep -rn "tool_use\|tools:" harness/ --include=*.mjs` returns nothing |

**The most important line in this document:** the highest-value half of
"give the models tools" is not a tool-use feature at all. It is the
evaluator plugin category, which already runs project-supplied code against
the tree a generation produced, already cannot fail a generation, and
already feeds the next prompt — plus two sockets that were built for exactly
this and never filled in.

What that category could not do before phase 1: **return an artifact.**
`normalizeMetric()` (`evaluators.mjs:98`) accepts a name and a number or
string. A Blender plugin has a PNG to hand back, and there was nowhere to
put it.

## 4. The contract

One contract for every category, so MCP is a *source* of tools rather than a
parallel concept — the same shape as `registerProvider()` for labs
(`llm-provider.mjs`) and `registerSender()` for notification channels
(`notify.mjs`). The harness owns the contract, the enforcement and the
record; **the project owns which tools exist.**

### 4.1 Phase 1 — the evaluator artifact (LIVE)

A plugin's `evaluate()` may now return artifacts alongside metrics, and is
given a directory it is allowed to write into:

```js
export default {
  name: 'level-render',
  async evaluate({ repoRoot, generation, config, artifactsDir }) {
    // Render with whatever this project already has — Blender, Playwright,
    // a physics harness, a build step. The harness has no opinion.
    execFileSync('blender', ['-b', 'level.blend', '-o', `${artifactsDir}/frame#`, '-f', '1']);
    return {
      metrics: [{ name: 'draw calls', value: 812, direction: 'lower' }],
      artifacts: [
        { kind: 'image', file: 'frame1.png', label: 'level 3, player spawn' },
        { kind: 'observation', label: 'reachability', text: 'apex 1.9m; the gap at x=44 needs 2.1m — unreachable' },
      ],
    };
  },
};
```

Rules the runner enforces, not the plugin:

- **`artifactsDir` is the only path a plugin may write to.** The interface's
  existing rule 2 (*"a plugin does not write"* —
  `plugins/evaluators/README.md:65`) existed because a plugin editing the
  working tree corrupts the diff a human is about to review. A renderer has
  to write *something*, so it gets one directory outside the tree's editable
  surface, and the rule sharpens rather than loosens.
- **A plugin still cannot fail a generation.** Unchanged. Throw, hang, or
  return nonsense and the result is a recorded error.
- **Artifacts are normalised and capped**, the same way metrics already are:
  a bounded number per plugin, a bounded image size, `label` and `text`
  clamped. A plugin that returns a hundred 4MB renders must not become the
  largest thing in the next prompt.

### 4.2 Phase 2 — the tool contract (PROPOSED)

```yaml
# project-adapter.yml — PROPOSED, nothing reads this yet
tools:
  sources:
    - module: tools/sources/blender.mjs      # project-owned, like an evaluator
    - mcp: { command: "npx", args: ["-y", "@acme/docs-mcp"], network: false }
  seats:
    suggest:   [render_scene, physics_probe]  # read-only observation
    implement: [read_file, search, run_tests]
    review:    [read_file, run_tests]         # a DIFFERENT, smaller set — §5
    rank:      []
  budget:
    max_calls_per_attempt: 12
    max_wall_clock_seconds: 900
```

Every tool declares `{ name, description, inputSchema, readOnly: true|false, handler }`.
The harness ships **zero** built-in tools; `harness/` gains the seam and
nothing else, for the same reason `providers/` ships nine lab files and
`llm-provider.mjs` hardcodes none.

## 5. Per-seat asymmetry — the decision that matters most

Giving every seat the same tools would be the mistake. The four seats want
different things, and the paper's own design principles 6 (separation of
duties) and 7 (evaluator integrity) fall out as concrete rules here.

| Seat | Tools | Why | Cost |
|---|---|---|---|
| **Suggest** (rotating) | Observation, strictly read-only | Changes *what gets noticed* — the §1 argument. This is where Blender and the physics probe pay off. | × the fan-out. A tool call here is paid N times, once per newly released model |
| **Implement** (pinned) | `read_file`, `search`, `run_tests`, `edit` | Changes *whether the change is correct*. Biggest mechanical win; this is P1.3. | × attempts (up to `maxAttempts`) |
| **Review** (pinned) | A **different, smaller, read-only** set | A reviewer that can run the thing is a far better gate than one reading a diff — `learning/03-failure-modes.md`'s "a review gate that had never been shown a picture" is exactly this. | × 1 per attempt |
| **Rank** | None | A cheap judgement over prose. Tools here buy nothing and cost per fan-out. | — |

Two rules that follow, and both are load-bearing:

1. **The review seat's tools must not overlap the implement seat's.** A gate
   that shares its instruments with the thing it gates is correlated with
   it, which is the same failure `seats.mjs` already guards against for
   model families (*"a shared blind spot stays blind"*).
2. **The implementer must not be able to influence what the reviewer's tools
   report.** If a proposal can write a file that the reviewer's probe then
   reads and reports as fine, the gate is gone and nothing will say so. In
   practice: the reviewer's tools read from a tree the implementer wrote,
   which is unavoidable — so they must report *observations* ("the render
   shows X") and never *verdicts* ("looks good"), and any file the probe
   itself is configured by must be a frozen path.

## 6. The five rules that keep this safe

### 6.1 A tool result is a stranger's text

Every tool result goes through `fenceUntrusted()` (`context-pack.mjs:84`)
before it reaches a prompt — no exceptions, including MCP results, including
a render's own metadata. Principle 19 (*anything a stranger typed is data,
not instructions*) is not weakened by the text having come from a tool the
project configured: an MCP server is an instruction channel into a pipeline
that ends in a pull request, and a filename inside a rendered scene is
attacker-controllable on any repository with outside contributors.

The reviewer brief template already treats text addressed to an AI as an
injection attempt to reject. That clause extends to the tool log.

### 6.2 The instrument rule

**A generation may not modify a tool and then be judged by that tool.**

This is the failure mode that actually worries me, and it needs no bad
intent at all. Once tools exist, the loop can raise its score by improving
the *instrument* rather than the product. Principle 22b already records the
harmless version: `readingLevel` scored text a canvas game could not
display, so three models across three labs independently proposed
simplifying an About page instead of fixing a hazard — *"each one correctly
solving the problem as measured."* A model-influenced tool is the same
failure with the optimiser's hands on the measuring device.

The paper states the mitigation as a requirement already: *"The product
code, constitution, and evaluator must not all be modifiable within the same
campaign."* Concretely, and checkably: a diff that touches `tools/**` or
`evaluation.evaluators` takes effect **next** generation. `check-guarded-paths.mjs`
is where that check goes, beside the frozen-goal check it already runs.

### 6.3 Tools run in the sandbox, or they do not run

Tools inherit [`Review-10x-2026-09.md`](Review-10x-2026-09.md) P1.2's
`evaluation.sandbox`: no network by default, no environment passed through,
the working tree mounted and nothing else. This is a prerequisite for phase
2, not a nice-to-have — the job that would run a tool is the same job that
holds nine lab API keys and a token that can write to the default branch
(F15).

### 6.4 Every call is recorded

`attempts.json` gains a `toolCalls` block: which seat, which tool, the
arguments, a hash of the result, wall-clock, and whether it errored. Without
it, "the model looked at the render" and "the render failed and the model
reasoned around the hole" are indistinguishable afterwards — which is
principle 20's whole argument, and the shape of the
`learning/03-failure-modes.md` Part 2 incidents where a prompt promised data
it never supplied.

### 6.5 Tools have a budget, and it is not the token budget

`budget.max_generation_tokens` bounds tokens. A Blender render or an Unreal
build is bounded by neither tokens nor `maxAttempts`. Phase 2 adds
`tools.budget.max_calls_per_attempt` and `max_wall_clock_seconds`, checked
the same two ways the token cap already is: projected before the fan-out,
and enforced between attempts (`spend.mjs`).

## 7. Model-authored tools

The honest answer to *"can they create tools aligned to their suggestions?"*
is **yes, and never in the generation that wrote them.**

Make `tools/**` a **create-only path** (`constitution.create_only_paths`,
which `edit-format.mjs` already enforces — a CREATE block may only target a
path that does not exist yet). A model proposes a new probe; it is reviewed,
tested, guarded, and merged by a human like any other change; it becomes
callable in the **next** generation.

This is not a new mechanism. It is
[`docs/curiosity/C5-the-spike.md`](curiosity/C5-the-spike.md)'s own rule,
applied one level out: *"a spike is not a new privilege; it is a normal edit
that adds a counter."* The alternative — a model that writes a tool and
calls it in the same breath — is arbitrary code execution wearing a
feature's clothes, and it defeats principle 10 completely, because the tool
it writes could be `evaluate: () => [{name: 'quality', value: 100}]`.

What this buys, and it is worth stating as a research claim rather than an
implementation detail: **the loop stops only improving the project and
starts growing the project's own ability to see itself, one reviewed pull
request at a time.** Capability accretion as a governed, longitudinal
process is a genuinely publishable result and it is on-brand with everything
else here.

## 8. MCP specifically

MCP is a transport for exposing tools. It should be **one source behind §4.2's
contract**, not a first-class concept — otherwise the harness grows a second
registry that can disagree with the first.

| | Position |
|---|---|
| **Read-only MCP** (docs lookup, a symbol index, reading an issue tracker) | Yes, sandboxed, fenced, recorded. Genuinely useful and cheap. |
| **Write MCP** (deploy, post to Slack, file a ticket, change a Jira) | **No, by default, in an unattended loop.** Every gate in this harness assumes the change is reversible, and `rollback.mjs` only knows how to revert git. Nothing here can un-post a message or un-deploy. A project that wants this should have to write the sentence "this action cannot be rolled back by the harness" into its own adapter to enable it. |
| **Credentials** | An MCP server's secrets must not be reachable from the step that holds the lab keys and the write token. Separate step, separate `env:`. |
| **Server trust** | An MCP server is third-party code with network access. It is pinned by exact version, like `js-yaml@5.3.0` and the SHA-pinned actions already are (`scaffold.mjs`'s `JS_YAML_VERSION`, workflow `uses:` lines) — for the same reason. |

## 9. Cost, plainly

Unreal is not `npm test`. A full engine build is tens of minutes and tens of
gigabytes, times the fan-out, on a runner billed by the minute. The tools
that pay for themselves first are the cheap observational ones: a 512px
headless render, 200 physics steps, a cold-start timing. Start where the
ratio is good and let the bench say whether the expensive ones earn their
place.

Deliberately unmeasured, and the reason phase 5 exists: **whether a
tool-equipped suggest seat actually produces better proposals is an
empirical question, not an architectural one.** The bench
([`Review-10x-2026-09.md`](Review-10x-2026-09.md) P5.1) answers it by running
the same repositories with tools on and off and comparing what got noticed.
Until then this document is a bet, and it should be read as one.

## 10. Phases

### Phase 1 — artifacts and the two empty sockets ✅ BUILT (2026-09-06)

- [x] **T1.1 — Evaluator plugins may return artifacts.** `{metrics, artifacts}`
  alongside the existing bare-array return; `artifactsDir` handed to every
  plugin as the one path it may write; artifacts normalised, capped and
  recorded in `metrics.json`.
  *Done when:* a plugin can return an image and an observation, and both
  survive a round trip through `metrics.json`. **Done** —
  `normalizeArtifact()`, `runEvaluators()`, `run-evaluators.mjs`.
- [x] **T1.2 — The suggestion prompt's `screenshots` socket is fed.**
  `loadVisualEvidence()` reads the most recent generation's image artifacts
  and hands them to `run-generation.mjs`'s previously-empty
  `{ images: [], source: null }`.
  *Done when:* a project whose plugin renders a PNG has that PNG in the next
  generation's suggestion call, and a project with no artifacts produces a
  byte-identical prompt to before. **Done.**
- [x] **T1.3 — The review call's `captureVisual` hook is fed.**
  `evaluation.visual_capture` names a plugin, loaded the same way evaluators
  are, run against the tree the edits produced, images attached to the review
  request.
  *Done when:* the reviewer receives a render of the change under review, and
  a project that configures none gets `review.mjs`'s existing
  "not available" line unchanged. **Done.**

### Phase 2 — the tool seam (PROPOSED)

- [ ] **T2.1 — The contract and registry.** `registerToolSource()`, the
  adapter's `tools:` block, per-seat allowlists, `fenceUntrusted()` on every
  result, `toolCalls` in `attempts.json`. Ships with zero built-in tools.
  *Done when:* a project-supplied read-only tool is callable from the suggest
  seat, its result is fenced, and the record says what was called.
  *Depends on:* P1.2's sandbox.
- [ ] **T2.2 — The instrument rule as a guard check.** A diff touching
  `tools/**` or `evaluation.evaluators` cannot be judged by the tools it
  changed.
  *Done when:* `check-guarded-paths.mjs` refuses it, with a test that fails
  without the check.
- [ ] **T2.3 — The tool budget.** `max_calls_per_attempt`,
  `max_wall_clock_seconds`, projected and enforced like the token cap.

### Phase 3 — the harness's own four (PROPOSED)

- [ ] **T3.1** — `read_file`, `search`, `run_tests`, `edit` for the implement
  seat. This is `Review-10x-2026-09.md` P1.3 expressed through T2.1's
  contract rather than as a bespoke loop.

### Phase 4 — MCP as a source (PROPOSED)

- [ ] **T4.1** — An MCP client behind T2.1's contract. Read-only by default,
  pinned by exact version, network off unless a named server is opted in,
  credentials in their own step.

### Phase 5 — authorship and evidence (PROPOSED)

- [ ] **T5.1** — `tools/**` as a create-only path, effective next generation
  (§7).
- [ ] **T5.2** — Bench the claim: the same bench repositories with tools on
  and off, comparing what each notices and what survives review (§9).

## 11. Risks

- **The instrument rule is the whole safety case for phase 2.** If it is
  skipped or weakened, everything else in this document becomes a way for
  the loop to score itself.
- **Tool results widen the injection surface a great deal.** The fence is
  the first line; enforce it in the assembler, not in the prompt, the same
  way `parseResponse()` refuses edit blocks rather than asking politely.
- **Per-seat allowlists will be tempting to collapse** into one list "for
  simplicity." §5 is the reason not to.
- **Cost is a function of other people's engines.** A project that points
  this at Unreal has signed up for build minutes the harness cannot bound
  from inside; the wall-clock budget is a backstop, not a plan.
- **A tool that fails silently is worse than no tool.** `evaluators.mjs`'s
  existing discipline — record the error, report it, step over it — must
  hold for every source, including an MCP server that returns a plausible
  answer to a call that actually failed.
