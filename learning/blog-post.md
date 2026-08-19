# Let the Model Arms Race Ship Your Roadmap

### The world's best-funded labs release a new frontier model every few weeks. You can wire that directly into your product — and increasingly, you should.

---

Nine labs are in an arms race. Anthropic, OpenAI, Google, Moonshot, DeepSeek,
Alibaba, xAI, Meta, Z.ai — thousands of the best engineers alive, tens of billions of
dollars, and a release cadence measured in weeks. Each new model is better at
reading code, spotting problems and writing changes than the one before it.

Almost everyone consumes that capability the same way: a person opens a chat
window and asks for help.

We wired it into the product instead.

On the first of every month, a small pipeline checks what models exist across
those nine labs. If anything genuinely new has shipped, that model is handed
our codebase and asked one question: **what would you improve?** Its answer is
implemented, reviewed, tested, merged and deployed — automatically, with nobody
watching.

The product improves at the industry's release cadence, not at ours.

---

## The argument

Rich Sutton's *Bitter Lesson* says that general methods which scale with
computation eventually beat methods built on human-encoded domain knowledge, and
that we keep painfully re-learning this. It is usually read as advice about
building AI systems.

Read it as advice about building *products* and it gets uncomfortable.

Your roadmap is hand-encoded domain knowledge. So is your design system, your
taxonomy of good ideas, your team's accumulated sense of what to do next. All of
it is a human's compressed model of what would make the thing better — and all
of it is competing against general-purpose models that get measurably better
every few weeks, funded by people spending more on a single training run than
your company has ever raised.

Frontier models now post serious numbers on real software-engineering
benchmarks: not toy puzzles, but "here is a repository and an issue, produce a
working change." That curve is steep, it is bankrolled by an arms race, and it
does not stop when your quarter ends.

The bet is simple. **On the class of work that is a well-specified, localised
improvement to an existing codebase, the frontier is going to pass most local
teams.** Possibly it already has. If that is true, the highest-leverage thing
you can build is not the improvement itself. It is the socket the improvement
plugs into.

---

## What we actually built

The test case is deliberately small and deliberately real: two browser games,
designed by a four-year-old called Beatrice, played by children in hospital
beds. Two HTML files, no dependencies, no data collection, instant load on bad
ward wifi. Real users, real stakes, tiny surface.

The loop is four stages and one rule about who sits where:

1. **Detect.** Compare the labs' model catalogues against a stored snapshot. If
   nothing is new, the run stops — no suggestion, no commit, no cost. It is a
   release detector, not a cron job.
2. **Suggest.** Every newly released model is asked, in parallel, on its own
   lab's API, for *one* improvement. In prose. It writes no code.
3. **Implement and review.** A pinned model turns the winning proposal into a
   handful of exact find-and-replace edits. Another, with a fresh context and a
   reviewer's brief, approves or rejects with specific required fixes.
4. **Gate.** A guard that stops the agent editing its own rules, 718 automated
   checks, then a final check that the live site actually serves the change.

Only the *suggesting* seat rotates. That seat is the entire point: it is where
the frontier plugs in. Everything else stays on a known model, because those
seats answer to strict output contracts and guard the main branch.

---

## The part that made the argument for us

Our agent's brief contains a tidy checklist: seven game-design pillars, three
tiers of "good ideas." The sort of scaffolding you write when you are nervous
about what an unsupervised model might do — a compressed version of our taste,
handed over as guidance.

Two generations have shipped. **Neither used it.**

Kimi K3, from Moonshot, read both games and came back with this:

> *Germ Fighter has a core defensive mechanic that touch players physically
> cannot use. Dash is triggered only from the keyboard handler.*

Dash was bound to Shift and D with no on-screen control. Every child on a tablet
— almost the entire intended audience — was locked out of a core defensive move.
It had been that way since launch and nobody had noticed.

Grok 4.5, from xAI, found the mirror image in the other game: a live countdown
with no way to pause it, so a nurse arriving mid-level cost the child the level.

Two labs, two months, both ignored our taxonomy, and both found something a
child physically *could not do*. Our checklist was not just unused. It was worse
than what the models produced without it.

That is the Bitter Lesson arriving on schedule, in miniature, on a codebase
small enough to see it happen.

---

## What you owe the model

Which reframes the job. If you are not encoding *how* to improve the product,
what do you write down?

Everything in an agent's brief is one of two things:

| | Specifies | Fate as models improve |
|---|---|---|
| **A constraint** | *What is wanted* | Permanent. "Safe for ages 3–8." "No new dependencies." "Saved progress must survive." "Small edits only." |
| **A hint** | *How to think* | Decays. Design checklists. Tiered idea lists. "Here's how I'd approach this." |

Constraints shape the space of acceptable answers. Hints shape the *search* —
and a stronger model does not need your search hints, it is constrained by them.
Sutton never said don't specify what you want. He said don't encode how to look.

So the brief stays absolutely strict about child safety, dependencies and
backwards compatibility, and gets progressively less opinionated about game
design. The hints now arrive framed as *"a checklist, not a ceiling — if you can
see something better, propose that instead and say why this framework missed
it."* They are written to be deleted.

---

## The price of admission

You cannot accept work from a brilliant stranger at 3am without a few things
being genuinely true. The short version:

- **Small anchored edits, never whole-file rewrites.** Ask for a 30,000-token
  file back and you get truncation or drift, and an unattended job commits a
  broken product. Each edit must match exactly once, and a set applies
  all-or-nothing.
- **The agent cannot edit its own rules.** Tests, guards and its own brief are
  frozen — enforced by a script, not by asking nicely. The cheapest way to make
  a failing build pass is to delete the test.
- **Your gates must actually be able to fail.** Ours could not, for months: two
  CI jobs were checking the wrong branch, passing every time, having never once
  seen an agent's change. A broken check goes *green*, not red. Break something
  deliberately and confirm it catches you.
- **Check the live product, not your pipeline.** Twenty-three of our commits
  passed every gate, merged, emailed "success" and reached no player at all —
  the host had silently stopped deploying.

None of that is exotic. It is a weekend of work, and it is what turns "an AI
touched our repo" into something you can leave running.

---

## What it does not do

One honest limitation, and it is the big one. Every *gate* we have proves the
product is *not broken*. Nothing gates on whether it got *better*. There is now
a readiness scorecard alongside the gates — six measured dimensions, shown to
the next model — but nothing selects on it, and no losing proposal is ever
implemented and compared. A change that passes all 718 checks and quietly makes
the game worse would still ship.

The scorecard itself is a lesson in how easy that is to get wrong even with good
intentions: its weakest dimension used to be a readability score computed over
the page text, which is blind to a canvas — so the cheapest way to raise it was
to simplify a caption and leave a hazard looking friendly. Three different labs'
models noticed the same loophole independently before a person did.

The research systems in this space — the self-improving agents you see on arXiv
— all have a fitness function: a benchmark, a verifier, a score that *selects*.
We have a measurement that nothing selects on. That is the difference between a
search and a loop, and closing it is the most valuable thing left to build here.

---

## The point

The arms race is, from where you are sitting, a subsidy. Thousands of the best
minds in the industry are spending billions to make something that will read
your codebase and tell you what is wrong with it, and it costs you a few dollars
a month on an API.

The models will keep getting better whether or not you do anything. The only
question is whether your product is set up to accept the work — a socket, a few
real constraints, and gates strong enough that you can go to sleep.

Build the socket. The talent shows up monthly.

---

*The full framework — the principles, the blueprint, the failure catalogue and
copy-paste templates for the briefs and guards — is published as a
project-neutral guide in the `learning/` folder of the repository. The games are
still just two HTML files.*
