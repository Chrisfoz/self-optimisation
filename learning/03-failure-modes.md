# Failure modes — everything that was silently broken

Every entry here actually happened on a live pipeline. None of them announced
themselves. Most of them looked like success.

Read this before you launch, not after.

---

## Part 1 — The gates that weren't gates

### Both CI safety checks were no-ops

The guard job and the test job both checked out the **default branch** instead
of the agent's branch. The guard compared the main branch against itself. The
test suite ran against unmodified code.

Both passed, every run, for months. Neither had ever seen an agent change.

> **Defence:** every job after the agent runs must explicitly check out the
> agent's branch, and that requirement is now written into the top of the
> workflow file as a comment so the next person doesn't undo it. Test it by
> making a deliberate violation and confirming the gate goes red.

### The digest could not report a failure

The email step read the job's own status to decide what to say. In GitHub
Actions, a job's status read from inside itself is always `success`. So the
digest said "success" whether the run succeeded or not.

> **Defence:** read the results of the *dependency* jobs, not your own. And test
> the failure path of your reporting, not just the happy one.

### A failure looked identical to "nothing happened"

When a lab's API check failed, the pipeline logged "unknown state". That's the
right design — it isn't "no new releases", and pretending otherwise is a lie.
But nobody reads a log that says "unknown" every month.

Adding the actual reason to the log immediately surfaced a Google
`403 API_KEY_SERVICE_BLOCKED` that had been silently failing for an unknown
period. An OpenAI key had been dead for weeks — that lab simply stopped being
detected, and nothing said so.

> **Defence:** every error carries its HTTP status and message into the log, and
> the digest has to make "unknown" visible rather than burying it.

---

## Part 2 — The prompt that lied

### The source was never actually sent

The pipeline read both game files and used only their **lengths**, while the
prompt asserted "you have the full files above."

### A file the agent could edit was never shown to it

The landing page was on the list of files the agent was allowed to change, but
was never included in the prompt. A proposal could legitimately target a file
that nobody had read — and then the implementation stage would have to invent
anchor text for a file it had never seen, which cannot match. It burns an
attempt and looks like a model error rather than a missing input.

> **Rule:** *a file the agent may edit is a file the agent must have read.*
> Derive the "what to send" list from the "what may be edited" list, in code, so
> they cannot drift apart.

### Data the prompt promised was never fetched

The brief told the model that player ratings and comments existed and to use
them. The pipeline never fetched any. A model told it has data it wasn't given
reasons around the hole rather than flagging it.

> **Defence:** the section is now either populated or **omitted entirely**.
> There is no state where the prompt claims data that isn't present.

### Screenshots were captured every run and shown to nobody

Layout, contrast and touch-target size are judged from a picture. Generation 001
had to *reason* about whether a new button would overlap in landscape, and
explicitly deferred to "the workflow's automatic screenshots" — it was asking
for the picture it was never given.

---

## Part 3 — The output format that couldn't work

### Asking for a full file rewrite, with a 4,096-token limit

The prompt demanded a complete rewritten file — roughly 30,000 tokens — with a
4,096-token output cap. It could not have succeeded. Thinking consumed the
budget before any text was produced at all.

**This was the error in the log.** It was the least interesting thing wrong with
the pipeline.

> **Defence:** anchored search/replace edits, plus explicit truncation
> detection — if the response stopped because it hit the limit, abort before
> writing anything.

### Changing what a stage returns without changing its output budget

A stage that had returned prose for a year was given a second job — attach the
edits implementing your proposal, if you can. Its output cap stayed where it had
been set for prose alone.

Both models asked spent the budget writing edits, hit the cap, and had their
complete analyses discarded along with the half-written edit sets. Two vendors,
zero proposals, run aborted before it reached an implementer. The safety
behaviour was correct — a partial edit set must never be applied — but it was
applied bluntly to a response whose *analysis* was entirely usable.

> **Defence:** raise the budget to cover the new shape, tell the model in the
> prompt what its budget is and to emit the required part first, and make
> truncation salvageable rather than fatal — discard the partial edits, keep the
> analysis when it demonstrably completed. The marker for "completed" is the
> presence of the last required field.

**Portable version:** when you add an output obligation to a prompt, the token
budget is part of the contract you just changed. And ask what your failure
handling throws away: "discard everything on truncation" is right for the
dangerous half and wasteful for the rest.

### The retry wrote against a dirty tree

A refinement attempt writes anchor text derived from the *original* file. If the
previous attempt's edits are still on disk, the anchors don't match and the
retry fails for reasons unrelated to the actual problem.

> **Defence:** reset to a pristine copy before every attempt — including
> deleting any file a failed attempt created, otherwise the retry's "create this
> new file" block is rejected because the path now exists.

### A partial edit set half-applied

Three edits out of five landing leaves a product that looks changed and is
broken.

> **Defence:** validate every edit against in-memory content for every affected
> file *before* writing a single byte. All or nothing.

---

## Part 4 — Configuration that failed silently

### The workflow read the wrong path out of the config

The workflow's parsing looked for a value at one location; the script wrote it
at another. Every branch fell through to a **hardcoded default**. Detection ran
perfectly. Nothing consumed the result.

> **Defence:** the script emits its decision directly and the workflow consumes
> it verbatim, rather than re-deriving it. Anywhere two places compute the same
> thing, one of them is eventually wrong and silent about it.

### "Latest model" meant "last alphabetically"

Model selection sorted an unfiltered list and took the last one. The list
included embedding models, text-to-speech models and image models.

> **Defence:** filter the catalogue to models that can actually do the job, sort
> by real creation date where the provider publishes one, and be explicit about
> the tie-break where they don't. Err towards *letting a model through* — the
> call itself will fail loudly if it turns out to be the wrong kind, whereas
> wrongly rejecting a real frontier model silently skips a whole cycle.

### A step that could never have run

The refinement step sent a parameter the model rejects with a 400, asked for
full files, wrote multi-line values into a mechanism that cannot carry
newlines — and fed no downstream job at all.

> **Defence:** if a step's output isn't consumed by something, delete the step.
> An unconsumed output is a lie about how the system works.

---

## Part 5 — Green all the way to nowhere

### Twenty-three commits that no user ever saw

Every gate passed. Everything merged, tagged, emailed "success". The host had
silently skipped every deploy because of a billing state outside the repository.

Two generations of improvements, plus the fix to the feedback mechanism, sat
unpublished — so feedback collection stayed broken for the entire period it was
believed fixed.

> **Defence:** a final gate that fetches the live product and confirms it
> carries the change. And a warning: a **byte-for-byte** comparison does not
> work if anything post-processes your output — the host rewrote quotes and
> reordered attributes, so a byte check reports "stale" forever. A signal that
> is always red gets muted, and then real staleness goes unnoticed too. Compare
> only what the pipeline provably leaves alone.

### Half the automated deploys published identical output

Each run produces at least two commits and only one touches the product — the
rest are logs, screenshots and records. Every one triggered a metered deploy
republishing byte-identical output.

> **Defence:** skip deploys for commits that cannot change what a user sees.
> Make it an *exclude* list, not an include list: being wrong in that direction
> costs one wasted deploy; being wrong the other way silently fails to publish a
> new page and nobody finds out.

### One failed generation hid the current screenshots

Screenshots were looked for in the newest generation folder only, falling back
to the launch baseline. But a generation that fails still creates its folder (to
store its failure record) and never stores screenshots. So a single failed run
shadowed the last real pictures and dropped the model all the way back to the
launch baseline — *while the prompt told it these were current.*

> **Defence:** search every generation newest-first, and only reach the baseline
> when nothing else has images. And state the provenance in the prompt: which
> generation these came from, and that they show the state the change starts
> from rather than its result.

### The documentation described a system that no longer existed

The write-up described three agents with per-model temperature settings and a
pinned model. None of that had been true since the four-stage loop landed —
temperature isn't even sent, because the model rejects it. Test counts were
wrong in four places. A hand-written table described "the generation" when there
were two.

> **Defence:** generate everything derivable from the records the runs already
> write. Anything a human must remember to update is already wrong.

---

## Part 6 — Lessons from onboarding provider #9

Adding a ninth AI lab to the rotating seat surfaced two things that would each
have failed inside a live run — both caught only because the endpoints were
probed live, with a real key, before anything was wired into the pipeline.

### The documented default path was a bare 404 with nothing in it

The new lab's default REST path returned a plain nginx 404 — no JSON body, no
error field, nothing that reads as "wrong endpoint." A provider entry built
from the shared factory default would have hit this **inside stage 1**, after
preflight had already run the full test suite, exactly the failure an earlier
generation had already paid for once with a different lab's model that turned
out to be served through an entirely different API family than the one this
pipeline speaks.

> **Defence:** every candidate is sent a trivial request through the real call
> shape, right after it's selected and before the expensive stages spend
> anything on it. Unreachable candidates are dropped there. Deliberately not a
> per-model classification table — most labs' catalogue listings don't report
> which API family serves a given id, and a name carries no reliable signal of
> it either.

### The vision-rejection fallback was keyed on wording that only eight labs used

Every stage sends screenshots. A text-only retry exists specifically so a
vision-less model costs only the pictures rather than the whole run — it works
by matching the wording of the rejection. The new lab refused images with
`messages.content.type is invalid, allowed values: ['text']`, a sentence naming
neither "image" nor any field name the other eight labs' rejections used. The
regex never matched. The rescue path was there, tested, and would not have
fired — the run would have died over an attachment it could have simply
dropped, and nobody would have known why until they read the raw log.

> **Defence:** match the *shape* of the failure — a 400 on the call that
> carried an image, from a request that otherwise would have gone through —
> rather than the sentence a particular vendor's error message happens to
> contain. Confirmed live, not just in review: a real screenshot to the new
> model is now dropped and the call rescued rather than fatal.

**The general lesson, stated plainly because it keeps recurring:** a fallback
keyed on how other implementations phrase things is not a fallback. It is a
guess with good manners. Prove the rescue path fires against the real
endpoint, not against the error you imagined it would send.

### A forced maximum reasoning effort turned a timeout into a silent total loss

The same lab's model could not disable its own thinking at all, and defaulted
its reasoning effort to maximum regardless of what was asked. A reachability
probe (a few words, cheap) answered fine — reasoning effort barely matters at
that size. A **real** stage-1 prompt, at the ~107,000 tokens a real generation
actually sends, simply never answered. It reasoned past the pipeline's
ten-minute per-request timeout.

This defeated the existing safety net completely, and it's worth being precise
about why: the retry that doubles a call's token budget only fires when a call
*returns* something truncated. A hang returns nothing to inspect — it is a
different failure shape, not a smaller version of the one already handled. The
run died having spent its entire window on one model, zero proposals produced.
The identical prompt, forced to the model's lowest available effort setting,
answered in eight seconds; a fuller version answered in 32 seconds with a
proposal that correctly named a real bug elsewhere in the product.

> **Defence:** a per-provider options hook on the shared request-building
> factory — an escape hatch that exists for exactly this, so one lab's quirk
> doesn't force special-casing every other entry that doesn't need it. Forcing
> the lowest effort setting isn't asking this model to think less carefully
> about the work; every release from this lab forces thinking on regardless of
> what's asked, and the lowest setting is the only one that returns before the
> infrastructure gives up waiting.

---

## Part 7 — A measure that can't see the whole picture

Two gates, built at different times for different reasons, shared one blind
spot: each judged only the part of the product it happened to be able to see,
and both were fooled by changes that were invisible to the judge and visible to
a child.

### A readability score that cannot see a canvas

A deployment-readiness scorecard's weakest dimension was computed with a
standard readability formula run over `document.body.innerText`. The prompt
told every model that raising the weakest dimension was worth more than
polishing a strong one. But a readability formula reads rendered *text*. It
cannot see a canvas — not the hazards drawn on it, not the score, not a warning
ring, and not an in-game instructions line that the interface hides entirely on
touch devices. Every part of the product the metric *could* see was prose a
caregiver reads. So the cheapest honest way to raise the score was to simplify
an About page and leave a lethal-looking-friendly hazard exactly as it was.
Three different models, from three different labs, independently proposed some
version of that trade — none of them being adversarial, each one correctly
solving the problem as measured.

> **Defence:** replace the proxy with a probe that drives the real play path in
> an actual browser and judges outcomes directly — a maze win reached by walking
> into it, a level completed through the game's own collision and completion
> check — rather than reading rendered text as a stand-in for the experience.
> Closed three specific loopholes the *proposing* model itself named while
> arguing for the fix: nothing counts as a visual cue unless it actually
> renders at real size, canvas states are judged by instrumented draw calls
> rather than guessed from pixels, and a full-screen rectangle is scored as a
> wash rather than a symbol, so a text overlay can't pass by merely dimming the
> screen. An unreachable game state scores nothing — otherwise breaking the
> probe would itself be the cheapest available "improvement."

Two things generalise past the specific fix. First, retiring a metric in code
is not the end of the job: the prompt read the *stored* result of the last
measurement, so the old number kept steering the loop for the entire gap
between the code change and the next real measurement, unless the stored
record itself is marked retired and excluded from "what's weakest" the moment
the code changes. Second, the old (wrong) number was kept as an unscored
diagnostic rather than deleted outright — it is still a true fact about the
copy a caregiver reads, and a deleted series can never be compared against
again.

### A review gate that had never been shown a picture

Screenshots were captured every run from early on. For a long stretch, nobody
downstream ever looked at them — an earlier generation had to *reason* about
whether a new UI element would overlap in landscape orientation, and explicitly
deferred to "the workflow's automatic screenshots" it had never actually been
given. Once screenshots were finally attached to the review call, a second,
subtler version of the same blind spot appeared: a warning ring drawn around an
on-screen hazard was correct code and passed review — and on a small screen the
ring's stroke crossed straight through the character's own face. A diff cannot
show that a circle at 0.82 of a cell's radius overlaps a glyph drawn at 0.8 of
the same cell. Review had approved code that was correct and a render that
made the game harder to read.

> **Defence:** render the working tree after edits are applied — every screen a
> person actually sees, hazards staged into frame — and attach the images to
> the review call itself. Give the reviewing model a worked example (a rejected
> render next to the fixed one) and, on a retry, the render of its *own*
> rejected attempt — the closest a single-shot call gets to looking at what it
> just drew. Deliberately not a pixel-diff against a stored baseline: that
> rejects every *intended* visual change too, and teaches the loop to avoid the
> part of the product a diff can't see.

**The shared lesson:** a gate can only reject what it is shown. If your check
reads a proxy for the real artefact — page text instead of a canvas, a diff
instead of a render — it will pass exactly the changes that exploit the gap
between the two, and it will do so without anyone acting in bad faith.

---

## Part 8 — The record that forgot itself, twice

The same bug shape — a fixed-size window standing in for a growing history,
with no signal when it starts dropping things — was found, fixed, and then
found again in a completely different part of the same pipeline. Recording it
once is not the same as it being gone.

### The architecture notes that fell out of the prompt

A prompt included recent architecture notes with `readFile(...).slice(-4000)`.
An append-only log stored *below* those notes in the same file grew past 4,000
characters, and every note above the cutoff — including a hard-won one about
successfully closing a feedback loop — was silently excluded from what any
model was ever shown again. Nobody deleted the note. The window simply became
smaller than what it needed to hold, on whatever day the log crossed that line
count, and nothing said so.

> **Defence:** send everything above the append-only log in full, since it is
> small and slow-growing by construction; only the log itself needs bounding.

### The five-generation window that aged out the whole early history

Separately, full per-generation detail was capped to the 5 most recent
generations by design — full detail is expensive, and that seemed reasonable.
By the fifteenth generation, generations one through nine had aged completely
out of every model's view, silently, with nothing recording that it had
happened. This was caught only because someone deliberately went looking for
the same bug shape a second time, while auditing an unrelated question.

> **Defence:** two tiers instead of one — a one-line-per-generation index
> covering *every generation there has ever been* (cheap enough to send in
> full, forever), alongside a detailed window narrowed to only the last few.
> The expensive tier no longer has to double as the only record something
> existed.

The same audit reproduced a large-context model failing with a TCP-level reset
twice in a row on a real ~100k-token prompt — not a rejection, the shape a
slow-to-generate response to a large prompt actually produces. The fix makes
context size a visible, recorded number rather than only a console line, and
drops a candidate whose provider-reported context window plainly can't hold
the prompt before spending a real call on it — deliberately not a per-model
lookup table, for the same reason the reachability probe in Part 6 refuses to
be one.

### A crash mid-loop erased the generation it crashed in

A run's own rule was: write down what was tried, on success and on failure.
That covered two paths. A review call that spent its entire output budget on
hidden reasoning and returned no visible text at all arrived as a **throw**,
not a returned truncated result — and the record-writing code ran only on the
two paths built to succeed or fail politely. The generation log jumped straight
from one entry to the next as though nothing had been attempted, despite a
model having been asked, having answered, having implemented a change, and
having been rejected.

> **Defence:** a process-level crash handler that writes the attempt record on
> the way down, not only from the two paths designed to exit normally.

**The general shape, stated once because it explains all three:** a mechanism
meant to carry something forward needs something checking what it actually
carries, not just that it runs without throwing. "Every generation is
recorded" quietly meant "every generation that failed the way we anticipated is
recorded," until each of these proved otherwise.

---

## Part 9 — The risks no test can see

These sit outside the repository, where no check can reach them. Any one of them
stops the loop or quietly runs up a bill.

**Unattended API cost.** The loop asks every newly released model, so cost
scales with how busy the labs are rather than with a number anyone chose. A
month with eight releases is eight large context packs before implementation and
review. Nothing in the pipeline reads a budget. A cap in a config file is not a
spending limit — set one at the provider.

**Keys expire and a source goes dark.** Already happened twice here, silently.

**Every integration is a way to break.** Six of the nine labs speak a common
dialect *by convention, not by contract*. Any of them can rename a model, change
a response shape or move a host without warning. Contained by "settle all
promises, don't fail fast" — one lab returning a 500 costs one proposal, not the
run.

**Supply chain, on the build side.** The product itself ships zero runtime
dependencies, which removes this risk where it matters most. The build side is
different: the test browser, the diagram renderer and the CI runner all execute
holding a token that can push to the main branch. A compromised package there
doesn't have to defeat a single gate — **it is already inside them.**

**Credential blast radius.** Nine API keys plus a token that can write to the
default branch, all reachable from one file. The guard stops the *agent* editing
that file. It does nothing about anyone who obtains the token.

**A model that is confidently wrong.** Every gate checks the product still
*works*. None checks that anyone still likes it. A change that passes all 718
checks — and, now, scores well on a readiness scorecard nothing selects on —
can still quietly make things worse and would keep shipping.

**Silence that looks like health.** The worst outcome is not a loud failure. It
is the loop running every month, emailing success, and doing nothing of value —
a stalled detector, an empty context pack, a reviewer that always says yes. The
pipeline reports what it did. **It cannot report what it should have done.**
