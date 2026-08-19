# Starter kit — templates and checklists

Copy these, replace the bracketed parts, delete what doesn't apply. They are the
working versions from a loop that has actually run, generalised.

---

## 1. The agent brief

This is the document the agent reads. It is also the document you freeze, so the
agent cannot edit it.

**Structure it in this order**, and keep the two categories visibly separate —
see principle 21.

```markdown
# [Project] Improvement Agent

You are an autonomous improvement agent. You run when [TRIGGER CONDITION].
Your mission: make ONE focused, high-quality improvement to [WHAT].

## When you run
- Trigger: [what makes this run at all — not the schedule, the novelty]
- Cadence: [how often it checks]
- If [trigger condition] is false, the run stops before anything is generated.

## The stages
| Stage | Model | Job |
|---|---|---|
| 1. Suggest | [the rotating seat] | Read [the thing], return prose: what to improve, where, why. Writes no code. |
| 2. Implement | [pinned] | Turn that into targeted search/replace edits and apply them. |
| 3. Review | [pinned], fresh context | Approve, or reject with specific required fixes. |
| 4. Refine | [pinned] | On rejection, loop back to stage 2 with the feedback. Three attempts total. |

The review stage is a genuine gate, not a formality. It is the only thing
between an unattended job and [the live thing], so it fails closed: an absent
or unparseable verdict counts as a rejection.

## CONSTRAINTS — non-negotiable, and they never expire
These specify what is wanted. They apply no matter how capable the model is.
- [Safety / audience constraint]
- [Compatibility constraint — e.g. existing saved data must survive]
- [Performance or dependency constraint]
- [Accessibility or inclusion constraint]
- ONE focused improvement, not a list.
- It must be expressible as a small number of localised edits to existing
  [code/content]. Never a wholesale rewrite.

## SCOPE — earned, not scheduled
Each run is either `focused` (one small localised change, the default) or
`ambitious` (structural work, several files). The mode is granted by the track
record — a run of generations that each merged on the first attempt unlocks one
ambitious generation — and a human can force either. Do NOT write "smaller is
always better" into the brief permanently: that is a hint wearing a
constraint's clothes, and it will outlive its usefulness.

## HINTS — a checklist, not a ceiling
These are here to give a model with no history somewhere to start. They should
carry LESS weight as models get stronger. If you can see a better improvement
than anything below, propose that instead and say why this framework missed it.
- [quality dimension 1]
- [quality dimension 2]
- [...]

## What you may edit
Always allowed:
- [file] — [what part of it]
- [file] — [what part of it]

Create-only:
- [pattern] — you may ADD a new file here; you may not modify an existing one.

Always forbidden:
- [automation definitions]
- [this brief]
- [the guard script]
- [test commands / config]
- [deployment and security config]

This list is enforced twice: as an allowlist before anything is written, and
again by the guard in CI.

## What must still pass
- [suite 1] — [N] checks
- [suite 2] — [N] checks

## Available data
- [prior run records — including the ones that failed]
- [artefacts from previous generations]
```

**Two things to get right:**

- The **constraints/hints split** is the part most worth keeping. Write hints so
  they are easy to delete later.
- "One focused improvement, not a list" does more work than it looks like. A
  list is a way of avoiding the judgement you are paying for.

---

## 2. The suggester's required output

```
PILLAR:        <which quality dimension this strengthens>
PROBLEM:       <what is weak today, citing the specific code or behaviour you saw>
CHANGE:        <precisely what should change — name the functions, constants,
                handlers or markup involved, and describe the new behaviour
                concretely enough that another engineer could implement it
                without guessing>
WHY THIS ONE:  <why this beats the other candidates you considered>
RISK:          <what could break, and how the change stays backwards compatible>
VERIFICATION:  <what a reviewer should check to confirm it works>
BRIEF FEEDBACK:<REQUIRED, and read by a human rather than a machine. Which parts
                of the brief genuinely helped? Which constrained you for no good
                reason, or pushed you toward a worse answer than you would have
                given unprompted? What would you delete? Be direct — you cannot
                edit the brief, so saying it is inconvenient costs you nothing.>
```

Then, optionally, the edit blocks implementing the change — see §3. Make the
implementation optional and the analysis required: a model that cannot hit your
format costs you nothing, and one that can gets to ship its own work.

---

## 3. The edit format

Give this to the implementer verbatim, and parse it with code rather than
trusting it.

```
Respond in EXACTLY this format. No other structure is accepted.

SUMMARY: <one line, imperative, max 80 chars — becomes the commit message>
RATIONALE: <2-4 sentences: why this change, why now, why it is safe>

Then one or more edit blocks:

<<<EDIT>>>
FILE: <path from the editable list>
<<<SEARCH>>>
<exact text copied verbatim from the file, including indentation>
<<<REPLACE>>>
<the replacement text>
<<<END>>>

Rules for edit blocks — these are enforced by a parser, not read by a human:
1. The SEARCH text must appear EXACTLY ONCE in the target file. Copy it
   character for character, including leading whitespace. If a snippet would be
   ambiguous, include more surrounding context until it is unique.
2. Do NOT output the whole file. Do NOT abbreviate with "..." or
   "// rest unchanged". Every SEARCH block must be literal, complete text that
   exists in the file right now.
3. Keep the change focused: one improvement, as few edit blocks as it takes.
4. Do not wrap the edit blocks in markdown code fences.

To add a NEW file (optional, and only for a brand new path):

<<<CREATE>>>
FILE: <path matching the creatable pattern>
<<<CONTENT>>>
<the complete file>
<<<END>>>

5. CREATE may only add [pattern], and only at a path that does not exist yet.
```

**Parser requirements** (these are the load-bearing part):

- Check the path against the allowlist **before** anything else.
- Reject `..` and absolute paths.
- Count occurrences of the SEARCH text — reject 0 and reject 2+.
- Tolerate a line-ending mismatch between the file and what the model emitted.
- Validate **all** edits against in-memory content for **all** affected files
  before writing a single byte.
- Reject an empty SEARCH block.
- Refuse a CREATE at a path that already exists — that's a modification wearing
  a create block's clothes.

---

## 4. The reviewer's brief

```markdown
You are a critical reviewer acting as a safety gate for autonomous changes to
[what], used by [who]. Nobody is watching this run. If you approve a broken
change it reaches [the live thing].

You are reviewing a set of targeted search/replace edits that have already been
applied. You can see the full current content of every file that was touched.

REJECT if any of these are true:
- The result is not syntactically valid
- It breaks [the core mechanism — render loop, request handling, data path]
- It would fail [the named suites]
- It breaks backwards compatibility with [existing user data]
- It breaks [accessibility / a supported input method / a supported platform]
- It adds a runtime dependency or an external network request
- It introduces [the things your product must never do]
- It sprawls well beyond the stated improvement

APPROVE only if all of these hold:
- The change is syntactically correct and integrates cleanly with existing code
- It genuinely strengthens the quality dimension it claims to
- [Safety guarantees] are intact
- [Existing user data] still loads
- It follows the patterns already established in the file
- It is focused and minimal

Be conservative: when genuinely uncertain about correctness, reject and say why.
Do not reject for style preferences, or for not doing more than it set out to do.

Respond in exactly this shape:

VERDICT: APPROVED
or
VERDICT: REJECTED

REASON: <one or two sentences>

DETAILS:
- Correctness: <will it run; any integration risk>
- Tests: <will the named suites still pass, and why>
- Safety: <assessment>
- Compatibility: <existing data, supported platforms>
- Warnings: <anything worth noting even on approval>

If REJECTED, finish with:

REQUIRED FIXES:
- <specific, actionable fix>
- <...>
```

---

## 5. The guard configuration

Three kinds of rule, a churn ceiling, and a diff against the base branch.

```
FROZEN         — may not change at all
  [automation definitions]
  [the agent's brief]
  [this guard script itself]
  [deployment / security config]
  [the file defining your safety posture]

APPEND_ONLY    — new files may be added, existing ones may not be edited or removed
  [tests/]

FROZEN_FIELDS  — named settings inside a config file must be byte-identical
  [package.json] → ["scripts"]

MAX_FILES      — [50]     backstop for sprawl, not a design constraint
MAX_LINES      — [10000]
```

Output should say what it checked, then either PASS or a specific list of
violations — and finish with the sentence that makes the asymmetry explicit:

> *A human can make these changes directly. The agent cannot.*

---

## 6. Launch checklist

Before you let it merge anything on its own:

**The trigger**
- [ ] Does a quiet period genuinely produce no run, no cost and no email?
- [ ] Does the first look at a new source record a baseline and act on nothing?
- [ ] Is "I couldn't check" distinguishable from "there was nothing new"?
- [ ] Is there a manual "run it now with these inputs" override?

**The gates**
- [ ] Does every post-agent job check out the **agent's branch**? Go and look.
- [ ] Break something deliberately: does each gate go red?
- [ ] Make the agent try to edit a frozen file: does the guard catch it?
- [ ] Does the preflight run before the agent starts?
- [ ] Does an unparseable reviewer response count as a rejection?
- [ ] If what you're shipping has an appearance, does the reviewer see a
      **render** of it, not just the diff?

**Adding a provider to the rotating seat**
- [ ] Probed the real call shape live, with a real key, before wiring it in?
- [ ] Any error-recovery logic (image/attachment rejection, rate limits) keyed
      on the *shape* of the failure rather than one vendor's error wording?
- [ ] Any per-provider quirk (can't disable reasoning, needs a special header,
      rejects a shared param) given a named slot on the shared request code,
      rather than a branch in the shared path itself?
- [ ] A hang and a truncated response are different failures — does your retry
      logic actually catch both, or only the one that returns something?

**The prompt**
- [ ] Is every file the agent may modify actually included?
- [ ] Does the prompt claim any data the plumbing could fail to supply?
- [ ] Is untrusted text fenced as data, not instructions?
- [ ] Is anything large in there that doesn't change the decision?

**The edits**
- [ ] Is truncation detected before anything is written?
- [ ] Do the edits apply all-or-nothing?
- [ ] Is the working copy reset to pristine between attempts?
- [ ] Are created files deleted on reset?

**The reporting**
- [ ] Does the digest read the real result of each step, not its own status?
- [ ] Test the failure path of the digest, not just the happy one.
- [ ] Is "unknown" loud rather than buried?

**The fitness function**
- [ ] Is there any number that means *better* rather than *not broken*?
- [ ] Is it measured from what would gate a real deployment in your domain,
      rather than from taste?
- [ ] Is it recorded per run, and shown to the next run?
- [ ] Is it deliberately **not** gating yet, until you trust it?
- [ ] Ask what part of the real artefact the metric is structurally blind to —
      not just whether it currently reads low. That blind spot is exactly
      where a well-behaved optimiser will raise the number without improving
      the thing it's supposed to stand for.
- [ ] When the metric changes (a proxy gets replaced, a dimension gets
      retired), does the stored history reflect that, or will the prompt keep
      reading an old number as if it's still current?

**The escape valve**
- [ ] Can a model that disagrees with a frozen rule say so, in a way a human
      will eventually see — without ever being able to act on it directly?
- [ ] Does the mechanism require *convergent, independent* agreement (several
      models, more than one lab) before anyone is notified, so one opinion
      can't trigger a human every time?
- [ ] Is a settled answer recorded and shown back, so the same question isn't
      re-argued by every subsequent run?

**Afterwards**
- [ ] Does something check the live product actually carries the change?
- [ ] Is every generation tagged and revertible?
- [ ] Is the failure record written on failure, and does it survive the run?
- [ ] Is it *also* written from a process-level crash handler — a stage that
      throws instead of returning cleanly is a third path, not a variant of
      the two you already handled?
- [ ] Does the next run actually read it back?
- [ ] Does anything summarising history use a full index rather than a
      fixed-size recency window that will silently forget older entries?
- [ ] Is "how to stop this" written down in one step, somewhere findable?

**The money**
- [ ] Is there a real spending limit at the provider, not just a constant in a
      config file?
- [ ] Does the cost scale with something you control?

---

## 7. Adapting this to non-code work

Nothing here is specific to software. The same loop works for anything with a
stored artefact and a way to check it:

| Part | Code project | Content / knowledge base | Data pipeline |
|---|---|---|---|
| Trigger | New model release | New model release, or new source material | New data drop |
| Suggest | "What should we improve?" | "Which page is weakest and why?" | "Which check is missing?" |
| Implement | Anchored code edits | Anchored text edits | Anchored config edits |
| Guard | Frozen files, append-only tests | Frozen style guide and templates | Frozen schema and thresholds |
| Test gates | Test suites | Link check, reading level, fact-check pass, style linter | Schema validation, row counts, spot checks |
| Fitness | *(still the hard part)* | Reader signal, search performance | Downstream error rate |
| Final check | Is it live? | Is it published and rendering? | Did the consumer receive it? |

The two parts people leave out, in every domain, are the **failure memory** and
the **live check**. Those are the two that make the difference between a loop
that accumulates and a loop that just runs.
