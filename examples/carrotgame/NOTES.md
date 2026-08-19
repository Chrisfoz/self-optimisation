# Notes on reconstructing carrotgame's adapter

`project-adapter.yml` in this folder was built by reading carrotgame's real
enforcement code — `check-guarded-paths.mjs`, `edit-format.mjs`,
`escalations.mjs`, `context-pack.mjs`, the workflow YAML — not by paraphrasing
`SELF-IMPROVEMENT.md`. That was deliberate: prose drifts from the code that
actually runs (carrotgame's own docs have drifted before — see
`03-failure-modes.md` under "The documentation described a system that no
longer existed"), and a reconstructed-from-code file is either right or it
fails loudly when someone points the (not-yet-built) harness at it. Per
`Portable-Harness-Design.md` §10 step 3, the purpose of this exercise is to
find out whether the adapter schema can actually represent a real
installation — before any scaffolding code gets written against it. It
mostly can, with the gaps below.

## The schema had to grow well past the paper's §5 sketch

`Model-Release-Driven-Software-Improvement-Paper-Outline.md` §5 sketches six
top-level blocks with one or two fields each — enough to illustrate the idea
of a project adapter, not enough to hold carrotgame's actual configuration.
Concretely, the paper's `constitution.prohibited_actions` (one field) had to
become four in the real file — `frozen_paths`, `append_only_paths`,
`frozen_fields`, `churn_ceiling` — because carrotgame's guard genuinely
enforces four different *kinds* of rule (never touch, add-only, byte-identical
field, sprawl ceiling), and collapsing them back into one field would lose
the distinction the enforcement code actually makes. Likewise
`evaluation.quality_metrics` (the paper) had to split into `quality_plugins`
(pointers to code) and `scorecard` (a measured, non-gating dimension list) —
see below for why those are not the same thing.

This is worth stating plainly as a finding for the harness design, not just
noise: **a project adapter for a real, run installation needs roughly 2–3x
the fields the paper's illustrative schema sketched**, concentrated in the
constitution and context blocks. The kernel-level fields (`roles`, `scope`,
`memory`) barely existed in the paper's sketch at all — §5 focused on what
varies per-project (paths, commands, thresholds) and didn't attempt to
represent the campaign lifecycle's own configuration surface, which turned
out to need representing too once a real installation had to be written down
in one file.

## Two things stayed as code, not schema, on purpose

`visual-check.mjs` and `wordless-play.mjs` are referenced in
`evaluation.quality_plugins` as names, not expanded into declarative config.
They can't be: `wordless-play.mjs` instruments the 2D canvas draw calls
themselves to tell a drawn symbol from a drawn word, and `visual-check.mjs`
renders the working tree at a specific phone viewport and attaches the
screenshots to the review call. Neither reduces to a metric threshold — they
*are* small programs, specific to a canvas-based, wordless-play-relevant
product. This confirms `Portable-Harness-Design.md` §8.2's framing:
`quality_plugins` has to be a pointer to a plugin implementing a documented
interface, not a config list, and neither of carrotgame's two plugins should
ship as a harness default — they're the one worked example of the category,
not the category itself.

`player-feedback.mjs` (the Supabase ratings digest) is more interesting: it's
not a plugin the harness runs, it's one block in `context.blocks` that is
*conditionally present* — included only when `SUPABASE_URL` and
`SUPABASE_ANON_KEY` are both set, omitted entirely otherwise, never faked.
That's a real requirement on the context-compiler's design that the paper's
context-compiler bullet list (§3.2) doesn't currently capture: some blocks
are unconditional, some are config-gated, and a gated block must disappear
cleanly rather than degrade to a lie. Worth a line in §3.2 later.

## Two fields are genuinely unresolved — flagged, not decided

`scope.required_clean_streak: 2` and `memory.escalation_consensus` (3
models, 2 labs) are constants in carrotgame's code
(`recommendScope()`, `escalations.mjs`'s `CONSENSUS`), reproduced here as
adapter fields on the assumption that a different project might reasonably
want a different streak length or a different consensus bar. That's a
judgment call this reconstruction is making, not one the reference
implementation actually validates — carrotgame has only ever run with these
two exact numbers. A future project's adapter could just as easily inherit
them as fixed kernel policy instead of per-project config. Leaving both in
the adapter for now; revisit once a second real installation gives a reason
to want a different number.

## One gap this reconstruction surfaced in the *reference implementation*, not the schema

`deployment.ci.runner: ubuntu-latest` is correct, but writing it down here
made a real gap visible: `Portable-Harness-Design.md` §8.3 recommends every
workflow step pin `shell: bash` explicitly so the same YAML works unmodified
on `windows-latest`/`macos-latest` runners too. Carrotgame's actual workflow
does not do this — it relies on the implicit default shell of
`ubuntu-latest`, which happens to be bash. That's not a schema problem, it's
a portability gap in the thing being ported. Recording it here rather than
quietly fixing it in carrotgame: fixing carrotgame's workflow is outside this
porting effort's scope, and the harness's own generated workflow template
(not yet built) is the right place to make `shell: bash` the default rather
than something the reference implementation happens to have gotten right by
accident.

## What this validates

The exercise did what §10 step 3 asked of it: nothing in carrotgame's real
configuration turned out to be *inexpressible* in a YAML shaped like the
paper's sketch, extended along the lines above. That's the answer to "is the
schema sufficient" for one real, small installation. It says nothing yet
about a second, larger, differently-shaped project — that's step 6 in
`Portable-Harness-Design.md` §10, still pending.
