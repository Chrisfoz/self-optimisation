# Diagrams

Five diagrams, in [Mermaid](https://mermaid.js.org) source form so you can paste
them straight into your own documents.

| File | What it shows |
|---|---|
| `generic-loop.mmd` | **One lap of the loop**, project-neutral — including every way it can stop. |
| `generic-guardrails.mmd` | **The six layers** a change passes through before anyone sees it. |
| `generic-context.mmd` | **What the model is shown, and what it may write.** Context in on the left, the double-enforced allowlist on the right. |
| `worked-example-run.mmd` | The same loop as actually built in the reference implementation, with real job names and check counts. |
| `worked-example-harness.mmd` | The same harness as actually built in the reference implementation, with token costs and per-provider dispatch. |

Start with the generic three. The worked examples are useful when you want to
see what the abstractions look like once they've hit a real system — the number
of failure exits in `worked-example-run.mmd` is itself the lesson.

---

## Rendering them

**In GitHub, Notion, Obsidian, or most modern markdown tools:** paste the
contents into a fenced block labelled `mermaid` and it renders automatically.
The generic three are already embedded that way in
[`../02-blueprint.md`](../02-blueprint.md) and
[`../05-guardrails-and-trust.md`](../05-guardrails-and-trust.md).

**In a plain HTML page or a slide deck:** render to flat SVG at author time
rather than shipping the Mermaid library — it's ~3 MB, and diagrams that only
appear after JavaScript runs are the part of a page a reader most needs to see.
`scripts/render-diagrams.mjs` in the reference implementation (the project
this framework was extracted from) does exactly that with a headless
browser; it hasn't been ported into this repository yet — see
`Portable-Harness-Design.md` at the repo root for the porting plan.

---

## Three mechanical traps, learned the hard way

Worth knowing before you spend an afternoon on them.

**Don't keep Mermaid source in an HTML comment.** A flowchart is built from
`-->` arrows, and `-->` closes an HTML comment. The first arrow ends the
comment and the rest of the diagram renders into your page as prose. Keep the
source in sidecar `.mmd` files — which also diff enormously better than 190 KB
of generated SVG.

**Turn off HTML labels when pre-rendering** (`htmlLabels: false`). By default
Mermaid puts each label in a `<foreignObject>` holding HTML. The box is measured
in *your* browser at render time, but that HTML reflows in the *reader's*
browser against the reader's fonts — so every label clips. Native SVG text is
measured once and stays where it was put.

**Make the output deterministic** (`deterministicIds: true`, and a fixed
`handDrawnSeed` if you use the hand-drawn look). Otherwise every re-render
rewrites the curve control points and produces a large diff that changes
nothing.

---

## A note on styling

The worked examples carry a theme block on their first line — a "whiteprint"
palette of dark ink on pale blue-grey. Delete it and they'll pick up your own
theme. It's there because Mermaid themes with literal colour values and cannot
follow a page's light/dark switch, so those diagrams sit on a fixed pale plate
in both themes: a drawing pinned to the board.
