# Diagrams

Eight diagrams, in [Mermaid](https://mermaid.js.org) source form so you can paste
them straight into your own documents. **Five describe the harness. Three
describe a proposal** — they are prefixed `proposed-` and are indexed
separately below, because a drawing of something that does not exist is the
easiest way to mislead someone about a system.

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

### Three more, for a design that is **not built**

These belong to [`../../docs/Curiosity-Engine-Design.md`](../../docs/Curiosity-Engine-Design.md)
and describe a proposal, not the system. Everything above describes what
exists; everything in these three that is **dashed and warm-toned is
proposed**, and everything solid is what runs today. Do not read them as
documentation of the harness.

| # | File | What it shows |
|---|---|---|
| **D1** | `proposed-curiosity-run.mmd` | **One lap, end to end, with curiosity woven in** — the three run modes, where questions are harvested, and the spike that produces a document instead of a diff. |
| **D2** | `proposed-curiosity-memory.mmd` | **What happens between laps** — the three memory tiers, promotion by independent re-derivation, and the forgetting rule. |
| **D3** | `proposed-curiosity-authorisation.mmd` | **What authorises what** — why looking is cheap and committing is expensive, and how silence stops being scored as rejection. |

Nodes in these three carry a **`C n`** prefix. That is the component's
implementation spec in [`../../docs/curiosity/`](../../docs/curiosity/) — a
node in a picture and a document on that page are the same thing, so an
engineer can point at a box and open the build instructions for it. The index
is [`docs/curiosity/README.md`](../../docs/curiosity/README.md).

They render with the same "whiteprint" theme block as the worked examples,
for the same reason: they are detailed enough to want a fixed plate rather
than the reader's theme.

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

In the meantime, `@mermaid-js/mermaid-cli` renders every `.mmd` here
directly, and is worth running before committing a change to one — a
diagram that fails to parse looks identical to one nobody has looked at:

```
npx -y @mermaid-js/mermaid-cli -i learning/diagrams/<file>.mmd -o /tmp/out.svg
```

All eight files in this folder render clean as of the last change to them.

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
