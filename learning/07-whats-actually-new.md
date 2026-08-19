# Is any of this new? — an honest placement in the field

Written August 2026, after checking the current literature rather than relying
on impressions.

**A caveat on method, up front.** The papers below were located and summarised
through search; several sources were unreachable from this environment, so the
characterisations come from abstracts, summaries and secondary coverage rather
than full readings. Treat specific numbers as approximately right and the
framing as directionally right. Anything you plan to act on, read properly
first — links are at the bottom.

---

## 1. Where the field is

2026 has been the year the **harness** stopped being plumbing and became the
object of study. The shorthand across recent work: the model is the engine, the
harness is the scaffolding around it — context assembly, tool interfaces,
validation, memory — and a growing body of results says the harness is often
where the remaining performance is.

The systems worth knowing:

| System | What it does | What grades it |
|---|---|---|
| **Darwin Gödel Machine** (May 2025, ICLR 2026) | Keeps an archive of coding agents that rewrite their own code; samples and mutates them open-endedly | SWE-bench (20.0% → 50.0%), Polyglot (14.2% → 30.7%) |
| **AlphaEvolve** (DeepMind, 2025) | LLM proposes diffs to programs; a population evolves | Automated evaluators producing a score |
| **Self-Harness** (June 2026) | An agent mines its own failed traces, proposes minimal edits **to its own harness**, validates by regression testing — no human, no stronger model | Terminal-Bench 2.0 (+33% to +60%) |
| **DemoEvolve**, **TTHE**, **Red Queen Gödel Machine**, **HyperAgents** (2026) | Variations: sparse-feedback harness evolution, test-time harness evolution, co-evolving agents *and* their evaluators, self-modification beyond code | Benchmarks, or co-evolved evaluators |

The pattern in all of them is the same three beats: **find weakness → propose a
targeted change → validate empirically before keeping it.**

That is, structurally, our loop. Which is the first honest thing to say.

---

## 2. Where we are squarely inside the mainstream

Most of what we built is a competent implementation of known patterns. Being
unoriginal here is *good* — these are the patterns that survived contact with
other people's failures.

| What we do | The lineage it sits in |
|---|---|
| Suggest → implement → review → refine | The evaluator-optimizer / generator-critic workflow. Standard agent-design vocabulary since late 2024. |
| Anchored search/replace edits with a unique-match rule | The coding-agent edit-format lineage (Aider's search/replace blocks, SWE-agent's argument that the agent-computer *interface* is a first-class design surface). |
| Failure memory fed into the next run | The Reflexion lineage — verbal self-critique retained across attempts. Ours is unusual only in its timescale: months, not turns. |
| Guards, allowlists, append-only tests | Standard sandboxing practice for self-modifying systems; DGM's authors flag the same concern about agents editing their own evaluation. |
| Derived context over raw dumps | Mainstream context engineering. "Send what changes the decision" is our phrasing of a widely-held view. |
| Hiding authors from a judge | Standard LLM-as-judge hygiene — though see §5, where the literature says we got the details wrong. |

**Nothing in that table is a contribution.** If someone reads only our framework
docs and thinks otherwise, that is a failure of our writing.

---

## 3. Where we are behind the frontier

This is the important section, and it is short because the gap is concentrated
in one place.

### We had no fitness function; now we have a measurement and no selection

*Updated after this review: a readiness scorecard now exists. The gap narrowed
rather than closed, and the distinction matters.*

Every serious system in §1 grades itself. DGM has SWE-bench. Self-Harness has
verifier-grounded failure signatures derived from real execution traces.
AlphaEvolve has automated evaluators producing a *score*.

Our 718 checks (98 game-logic, 601 pipeline, 19 browser) produce a **boolean**:
not broken. There is now also a scorecard producing a number — six dimensions of
deployment readiness for a hospital setting, measured in headless Chromium,
recorded per generation and shown to the next model. The games currently score
79/100.

*Updated again: one of those six dimensions was itself a case study in the gap
between measuring and gating. `readingLevel` scored a Flesch-Kincaid grade over
`document.body.innerText` — invisible to a canvas, so it rewarded simplifying
the About page over fixing anything a child actually sees. Three models across
three labs found the blind spot independently and escalated it; it was replaced
with a probe that drives real play and judges the canvas by its actual draw
calls. Score went 44 → 79 on the same code, because the metric changed, not the
game. Worth remembering next time a single number is the whole story: ask what
it cannot see before you trust what it can.*

But **nothing selects on it.** It does not gate the merge, no stage optimises
against it, and the losing proposals in a fan-out are still discarded rather
than implemented and compared. A score that nothing chooses by is a dashboard,
not a fitness function. The remaining distance is measurement-to-selection.

One unplanned result worth recording, because it is an argument for building
these early: the scorecard's **first run** found a defect that 239 existing
checks had never noticed — two pages pulling a webfont from a third party over a
render-blocking import, on a project whose brief calls external dependencies
non-negotiable. With that host unreachable, first paint stalls about thirteen
seconds, identically at 1× and 4× CPU. Every gate was green throughout.

That is the difference between **evolution** and **regression testing**, and it
is the reason this project is honestly a *loop* rather than a *search*. It also
explains a cascade of secondary limitations:

- **We generate N candidates and discard N−1.** Several models propose in
  parallel; a ranker picks one; the losers are never implemented or measured.
  Generating and *measuring* N is the trade that actually scales — and it needs
  a fitness function first.
- **We cannot detect slow degradation.** A change that passes everything and
  quietly makes the game worse ships, and would keep shipping.
- **We cannot compare labs on outcome.** We record which model proposed what,
  which is a nice provenance trail and not a result.

The literature's answer is a verifier. Ours would have to be a real player
signal — ratings, completion rates, session length — which we now collect and do
not yet use as a score. That is the single highest-value thing left to build.

### The harness does not evolve; a human edits it

Self-Harness's whole claim is that the *scaffold* is the artifact being
optimised, by the agent, without a stronger model. In our system the harness is
frozen — deliberately, since an agent that can edit its own guard has no guard —
and every improvement to it has come from a human working with an assistant.

Whether that is a limitation or a safety property depends entirely on the stakes.
For a benchmark, it is a limitation. For software played by sick children with
nobody watching at 3am, freezing the guard is the correct call, and we would
make it again.

### The reviewer and the implementer share a mind

Fresh context and a different brief, but the same model family. A shared blind
spot stays blind. Cheap to fix; not yet fixed.

---

## 4. What looks genuinely unusual

Three things, with an honest confidence level on each and a way to check.

### (a) The clock is the industry's release cadence — high confidence this is unusual

Every self-improving system I found iterates as fast as its owner is willing to
pay for. Compute is the clock.

Ours does **nothing at all** until an external lab ships a model. In a quiet
month the pipeline wakes, checks nine catalogues, finds nothing new, and stops
before generating a single token.

The nearest prior art is a standing evaluation pipeline that runs on every
frontier release — a well-established practice by 2026. But those pipelines
score *the model*. Ours asks the model to change *the product*. I could not find
that arrangement described anywhere.

Why it might matter beyond novelty: it makes the loop's improvement rate a
function of the capability curve rather than of a budget line. It is the most
direct expression of the Bitter Lesson available to a small project — you are
not betting on your own cleverness scaling, you are betting on somebody else's
compute scaling, and buying an option on it monthly.

*How to check:* search for release-triggered product improvement rather than
release-triggered evaluation. If someone is doing this, it will be inside a
company and undocumented.

### (b) A longitudinal, cross-lab comparison on a live artifact — medium-high confidence

Nine labs, the same small codebase, month after month, every proposal recorded
verbatim with its author and its outcome, tagged in git and revertible one
generation at a time.

Benchmarks compare models on frozen tasks with known answers. This compares them
on the same *evolving real thing that real people use*, where the interesting
signal is what each model chooses to notice.

And that signal has already been informative. Two generations, two different
labs, and both picked something a child physically *could not do* — a dash bound
only to a keyboard, a countdown with no pause — rather than anything on the
seven-pillar design checklist we supplied. That is a finding about model taste
that no benchmark would surface, and it accumulates for free.

*Caveat:* n=2. This is an anecdote with good record-keeping, not a result. It
becomes a result at n=20, which at monthly cadence is 2028.

### (c) Production truth as a gate — high confidence it is underrated

Benchmark-graded systems never encounter the failure mode where every check
passes and the artifact is not actually served. Every real deployment does.
Ours did, for 23 consecutive commits, while emailing "success" each time.

The final gate fetches the live site and confirms it carries the merged change.
It is the least academic idea in the project and the first one I would port to
anything else. It is also the only gate that tests the thing the project is
*for*, rather than the thing the pipeline produces.

---

## 5. What the literature taught us we got wrong

Our ranking step hides proposal authors from the judge, on the theory that
anonymity stops it favouring its own lab. Work on self-preference bias in
LLM-as-judge suggests that is weaker than we assumed: the effect appears to be
driven substantially by **perplexity** — a judge finds its own family's output
more fluent and rates it higher — rather than by recognising a byline. Reported
effects are large enough to matter (skews of several points on ranking tasks;
markedly higher rates of wrongly marking one's own failed output as passing).

The mitigations that reportedly hold up on real traffic are mechanical: use a
judge from a **different model family**, shuffle order on every pairwise call,
pin the judge's contract, and calibrate against human labels.

**So: blinding the authors blunts our problem without removing it.** The correct
fix is to rank with a model from a different family than the implementer — which
is cheap, and which we have not done. This is the most actionable finding from
the whole review.

---

## 6. The cheapest experiments worth running next

*Three of the five below have since been built. Kept with their status, because
the reasoning is the transferable part.*

1. **Rank with a different model family than the one that implements.** Hours of
   work. Directly addresses a documented bias. **Still not done — the highest
   remaining item.**
2. **A score, even a crude one, so degradation is visible.** ✅ **Done**, though
   not as player ratings: a six-dimension readiness scorecard measuring what
   would gate a hospital deployment. Ratings remain a second, noisier signal
   that is still unused.
3. **Implement two proposals instead of one and keep both in the record.** Half
   a step toward search, one extra implement-and-review cycle rather than N.
   **Not done, and now coherent for the first time** — before the scorecard
   there was nothing to compare them with.
4. **Diff this generation's screenshots against the last and show the reviewer
   both.** **Not done.** We capture the images already and compare nothing.
5. **Start deleting hints from the brief and record what changes.** ✅
   **Instrumented rather than done**: every proposal must now return a
   `BRIEF FEEDBACK` field naming the parts of the brief that constrained it for
   no good reason, from every asking model, recorded whether it won or lost. The
   blanket "smaller beats ambitious" instruction is already retired in favour of
   a per-run scope earned from the track record. The falsifiable claim — that
   deleting the seven-pillar checklist will not degrade proposal quality — is
   now testable with evidence from several labs rather than nerve.

Two further changes came out of this review that were not on the original list:
the suggesting model may now **implement its own proposal** (optional format,
silent fallback), which is what makes the cross-lab comparison in §4(b) a
comparison of engineering rather than only of taste; and the editable surface is
now derived from a single allowlist rather than three parallel literals.

---

## Sources

Located via search in August 2026. Not all were readable from this environment;
see the caveat at the top.

- Darwin Gödel Machine — [arXiv:2505.22954](https://arxiv.org/abs/2505.22954),
  [Sakana AI write-up](https://sakana.ai/dgm/),
  [ICLR 2026 poster](https://iclr.cc/virtual/2026/poster/10007327),
  [code](https://github.com/jennyzzt/dgm)
- Self-Harness: Harnesses That Improve Themselves —
  [arXiv:2606.09498](https://arxiv.org/abs/2606.09498),
  [VentureBeat coverage](https://venturebeat.com/orchestration/researchers-introduce-self-harness-a-framework-that-lets-ai-agents-rewrite-their-own-rules-boosting-performance-up-to-60)
- Harness Engineering for Self-Improvement — [Lil'Log, July 2026](https://lilianweng.github.io/posts/2026-07-04-harness/)
- A primer on self-improving agent harnesses —
  [TechTalks, July 2026](https://bdtechtalks.com/2026/07/13/ai-agents-self-improving-harness/)
- DemoEvolve: Overcoming Sparse Feedback in Agentic Harness Evolution —
  [arXiv:2605.24539](https://arxiv.org/pdf/2605.24539)
- TTHE: Test-Time Harness Evolution — [arXiv:2607.08124](https://arxiv.org/pdf/2607.08124)
- The Red Queen Gödel Machine: Co-Evolving Agents and Their Evaluators —
  [arXiv:2606.26294](https://arxiv.org/pdf/2606.26294)
- Self-Preference Bias in LLM-as-a-Judge —
  [arXiv:2410.21819](https://arxiv.org/pdf/2410.21819);
  rubric-based follow-up [arXiv:2604.06996](https://arxiv.org/abs/2604.06996)
- Frontier Model Release Velocity Index, Q2 2026 —
  [digitalapplied.com](https://www.digitalapplied.com/blog/frontier-model-release-velocity-index-q2-2026)
- Lab: a training platform for self-improving agents —
  [Prime Intellect](https://www.primeintellect.ai/blog/lab-is-open)
- Rich Sutton, *The Bitter Lesson* (2019) —
  [incompleteideas.net](http://www.incompleteideas.net/IncIdeas/BitterLesson.html)
