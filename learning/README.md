# Learning — how to build a self-improving project

This folder is not about Mason the Carrot. It is about the *machine around* Mason
the Carrot: a loop that lets an AI model improve a real, live piece of software
once a month, on its own, without a person watching — and without ever shipping
something broken to the people who use it.

Everything here was learned the hard way on one small project. Two HTML games,
made by a four-year-old, played by children in hospital. The loop has run for
real, shipped real changes, and broken in real ways. What follows is what
survived.

**It is written to be lifted and used somewhere else.** Nothing in these pages
depends on games, on HTML, or on this repository.

---

## Who this is for

You use AI agents. You are comfortable asking one to do work for you. You do not
necessarily write the plumbing yourself — you may be directing an agent to build
it, or deciding whether it is worth building at all.

You do not need to read code to read this. Where something technical matters,
it is explained in plain words first.

---

## The three words that do the work

Before anything else, three terms, because the rest of the folder leans on them.

**A harness.** Think of a wind tunnel. The tunnel does not make the aircraft
better. It holds the aircraft still, blows air over it in a controlled way, and
measures what happens. A harness is the machinery around an AI model: what the
model is shown, what it is allowed to touch, and who checks its work. *The model
is the engine. The harness is everything bolted around it.*

**A loop.** The same sequence runs again, on a schedule, with nobody starting
it: look at the work, suggest a change, make it, check it, then ship it or throw
it away. Each pass is called a **generation**.

**Self-improvement.** This is a careful claim, and it is worth being precise
about. *The software does not improve itself.* A new model, built by a lab
somewhere else, arrives and improves the software. What is automatic is the
**plumbing** — noticing the new model exists, giving it the right context,
applying what it says, and refusing it if the checks go red. The intelligence
arrives from outside. The loop just keeps the door open.

The consequence is the interesting part: because the improving is done by
whichever model shipped most recently, **the project gets better without anyone
editing it.** The code you write is a socket. What plugs into it keeps getting
stronger.

---

## Learning from practical outcomes

The built loop uses external model capabilities and persisted run history.
[Harness KPIs](../docs/harness-kpis/README.md) proposes a further loop that learns
which operating strategies work for which tasks: assess real product outcomes,
compare context, memory or review policies, then adopt supported changes through
the existing review route. This is a design and implementation plan, not a live
scorecard or autonomous policy optimiser.

A merged change and passing tests are process evidence. Verified benefit needs
project acceptance evidence and follow-up. Keep failed attempts, unknown outcomes
and the rationale for decisions so later experiments can distinguish a useful
lesson from an unsupported reflection.

## What's in here

| File | What it gives you |
|---|---|
| [`01-principles.md`](01-principles.md) | The principles, each with the real incident behind it. **Start here.** |
| [`02-blueprint.md`](02-blueprint.md) | How to actually build one, in the order you'd build it. Includes a smallest-useful version. |
| [`03-failure-modes.md`](03-failure-modes.md) | Everything that broke, what it taught, and the defence now in place. Read before you ship. |
| [`04-context-recipe.md`](04-context-recipe.md) | What to put in front of the model — and what to deliberately leave out. |
| [`05-guardrails-and-trust.md`](05-guardrails-and-trust.md) | How to make an unattended agent safe to leave alone, and what you still can't measure. |
| [`06-starter-kit.md`](06-starter-kit.md) | Copy-paste templates: the agent brief, the reviewer's brief, the guard config, the launch checklist. |
| [`07-whats-actually-new.md`](07-whats-actually-new.md) | Where this sits against the 2026 literature on harnesses and self-improving agents — what's mainstream, what's behind the frontier, what's genuinely unusual, and what the research says we got wrong. |
| [`blog-post.md`](blog-post.md) | The story in article form, written for a general audience. |
| [Practical outcome learning](../docs/harness-kpis/README.md) | Proposed KPI definitions, the two-loop diagram, evidence mapping and controlled strategy experiments. |
| [`diagrams/`](diagrams/) | The pictures, in a form you can drop into your own docs. |

---

## The short version

If you read nothing else:

1. **Trigger on real novelty, not the calendar.** The loop wakes up when a new
   frontier model exists. In a quiet month it does nothing at all — no
   suggestion, no commit, no email. That is what makes it a release detector and
   not just a cron job that burns money.
2. **Split the seats.** One seat rotates — the newest model, giving a fresh
   opinion. Every other seat (write the change, review the change) stays on a
   model whose behaviour you already know.
3. **Ideas and edits are different jobs.** The model with the fresh eyes writes
   prose, not code. Something else turns prose into a change.
4. **Small, exact edits. Never "rewrite the file".** Ask for the whole file back
   and you get truncation or drift, and an unattended job commits a broken
   product.
5. **An agent that can edit its own rules has no rules.** The tests, the
   guardrails, and the agent's own brief are off limits — enforced by a machine,
   not by asking nicely.
6. **Prove the baseline first.** Run the checks *before* the agent starts, so a
   failure afterwards is attributable to the agent rather than to something that
   was already broken.
7. **A gate that cannot fail is not a gate.** Both of this project's safety
   checks were silently checking the wrong thing for months. They passed every
   time. They had never once looked at an agent's change.
8. **Failure is data — if you write it down.** A run that ships nothing still
   records what it tried and why it died, and the next run reads that back.
9. **Check the real world, not just your pipeline.** Twenty-three commits here
   passed every gate, merged, and emailed "success" while the host quietly
   published none of them.
10. **Know what you are not measuring.** Every gate here proves the product is
    *not broken*. Nothing proves it got *better*. That gap is real and unsolved,
    and pretending otherwise is the most expensive mistake available. The
    [KPI design](../docs/harness-kpis/README.md) specifies an evidence-based way
    to address it; automated assessment is not implemented.

---

## A note on honesty

The last section of [`01-principles.md`](01-principles.md) and the closing part
of [`05-guardrails-and-trust.md`](05-guardrails-and-trust.md) are about what
this design still does not solve. Keep that section when you copy this
framework. A loop that reports on itself and only ever reports success is worse
than no loop, because you stop looking.
