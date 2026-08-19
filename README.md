# Self-Optimisation

A portable harness for model-release-driven software improvement: point it at
a project, and a governed suggest → implement → review → gate → promote loop
lets each newly released frontier model propose one improvement, gated by
that project's own tests before anything ships.

**Status: design and documentation, nothing runnable yet.** The reference
implementation is a separate, real project (two educational HTML games) that
has run this loop for 18+ real generations, including real incidents. This
repository is the work of extracting that into something project-agnostic.
Nothing here should be read as "already built" unless a file says so
explicitly.

## Where to start

| If you want... | Read |
|---|---|
| The concepts, principles, and incidents this is built from — written to be lifted into any project | [`learning/`](learning/), starting with [`learning/README.md`](learning/README.md) |
| Copy-paste templates (agent brief, reviewer brief, guard config, edit format) | [`learning/06-starter-kit.md`](learning/06-starter-kit.md) |
| What's being ported from the reference implementation, what needs genericising, and the proposed repo/CLI structure | [`Portable-Harness-Design.md`](Portable-Harness-Design.md) |
| The academic framing — the ten-component kernel, research questions, threat model, related work | [`Model-Release-Driven-Software-Improvement-Paper-Outline.md`](Model-Release-Driven-Software-Improvement-Paper-Outline.md) |
| The research corpus this draws on (AlphaEvolve, Darwin Gödel Machine, self-rewarding/self-adapting LMs, harness engineering) | [`docs/`](docs/), indexed in [`docs/SOURCES.md`](docs/SOURCES.md) |

## The shape of it, in one paragraph

A model release is the trigger, not the calendar. One seat rotates — whichever
lab shipped the newest model gets to propose the change, on its own API, with
fresh eyes. Every other seat (implement, review) stays pinned to a model
you already trust. Proposals are targeted, exact edits — never a full-file
rewrite — applied all-or-nothing and checked against a project's own test
suite before anything merges. An agent can argue that a frozen rule is wrong,
but it cannot change the rule itself; only a human can, and only after
independent models converge on the same complaint. Every run — including the
ones that ship nothing — writes down what it tried, and the next run reads
that back. `learning/01-principles.md` has the full list, each one anchored
to a real incident rather than stated as a bare rule.

## Repo layout (current, not final — see `Portable-Harness-Design.md` §4)

```
self_optimisation/
├── README.md                        # this file
├── Portable-Harness-Design.md       # what ports, what's generic, what's next
├── Model-Release-Driven-Software-Improvement-Paper-Outline.md
├── docs/                            # research corpus
└── learning/                        # principles, blueprint, failure modes,
                                      # starter kit, diagrams — ported from the
                                      # reference implementation, written to
                                      # need no project-specific knowledge
```

`harness/`, `templates/`, and `cli/` — the actual generic code and the
`init` scaffolder — don't exist yet. `Portable-Harness-Design.md` §10 has the
build order.
