# The first install into someone else's repository — 2026-09-17

**The harness copied into a live web app it had never seen, then
configured, rehearsed, taken to GitHub and wired to email in one working
session. An AI coding session did the work, following the terminal
walkthrough at the owner's direction, with the owner making every choice
and every GitHub settings change.** Five generations: one rehearsed locally
and merged, then four on GitHub Actions. Two of those crashed and taught the
most. Two went through every gate to a pull request, one for under a dollar of
review. The 2026-09-11 campaigns proved the
loop works on projects prepared for it. This was the first time the install
path itself was the thing under test. Most of what broke was in the steps
around the loop, not in the loop.

NetworkinAI is a private repository, so its source, the diff and the
proposal texts are **not** reproduced here. Only numbers and findings are.

## The project

- **NetworkinAI**, a conference-networking web app: a Three.js venue that
  delegates walk into from a QR code, six AI personas, Socket.io multiplayer
  rooms, Supabase optional. Node 22–23, Express, plain HTML with no bundler,
  Jest (942 tests at install) plus a dependency-free geometry check,
  `qa/check-3d.cjs`.
- **Big editable files.** `venue.html` is 7,144 lines and `server.js` 3,491. The
  2026-09-11 game's editable file was ~120,000 characters. This allowlist
  came to **1,033,980 characters**.
- **A dense `CLAUDE.md`** of invariants a change can break without a test
  noticing: every player in a room must see the same scene, so nothing shared
  may come from `Math.random()`; props register collision footprints before
  personas are placed; a persona's "what to watch for" line lives in three
  files; level ids are pinned by a database CHECK. These went into both briefs
  as explicit reject conditions.
- **Seats:** implement and review `claude-opus-5` (the owner's choice, and
  the run warned that both seats were in one lab's family). Rank defaulted to
  `claude-opus-5`. Budget 2,000,000 tokens. Scope `focused`, earned.
- **Goal** (`project.goal`), in the owner's words: use each new model to make
  gameplay, avatars and levels better, front end and back end, with
  documentation that matches the code.

## The generation

A local campaign rehearsal on six named models:
`node --env-file=.env.harness.local harness/scripts/rehearse.mjs --models gpt-6-astra,gemini-3.8-flash,qwen3.8-max-0902,claude-fable-5-1,muse-spark-1.3,deepseek-flash`.

| Model | What happened | Input tokens | Output tokens |
|---|---|---|---|
| `muse-spark-1.3` | **Dropped at the probe**: `402 billing_not_configured`. The key listed the catalogue fine. | — | — |
| `qwen3.8-max-0902` | Timed out after 600 s with no text. Recorded as a failed request at its estimated input. | 266,845 | 0 |
| `deepseek-flash` | Produced no text at 32,000 output tokens, retried at 64,000, truncated again. Prose kept, edits dropped. Opened an escalation. | 513,808 | 96,000 |
| `gpt-6-astra` | Proposal plus 5 edits and a new test | 247,504 | 2,219 |
| `gemini-3.8-flash` | Proposal plus 4 edits and a new test | 281,251 | 20,606 |
| `claude-fable-5-1` | **Ranked first.** Proposal plus 5 edits and a new test, then **implemented its own change**. Opened an escalation. | 383,225 | 18,071 |
| `claude-opus-5` | Ranked 4 proposals, then approved on the first review | 180,711 | 11,116 |

**Total 2,021,356 tokens against a 2,000,000 cap.** The change: phones could
not turn the camera at all (mouse look needs pointer lock, which touch
browsers refuse, and the joystick only strafes), while the welcome copy told
people to "turn with the touch controls". Fable added drag-to-look on the
canvas, fixed the copy in three places including a server-generated PDF, and
added a source-reading test. 949 tests passed in the loop. The guard passed,
and the owner merged it.

## What it proved

- **The briefs' reject conditions were used.** The winning proposal kept to
  them, and the review's approval cites them one by one. It checked that the
  change reuses the existing overlay gate, allocates nothing per frame and
  changes no shared-room state.
- **A campaign run works on a repo nobody tuned the harness for,** on
  Windows, with a pre-existing CI workflow, `.claude/agents/` and a live
  `.env`.
- **The ranking beat the rest of the field on substance,** not length. Its
  stated reason: another proposal keyed off a dialogue check that is always
  false. That is a correctness judgement.
- **Escalations point at something real.** One named a genuine harness defect
  (below). The other asked for two AI services to become editable so the
  grounded persona's retrieval can be connected. That one is a scope decision
  for the owner, and it is logged.

## What broke — fixed the same day

| Finding | Fix |
|---|---|
| **Every digest email would have gone out as the terse fallback, on every installation.** `send-digest.mjs` and `send-escalation-notice.mjs` call a model but never imported `providers/index.mjs`, so `claude-opus-5` could not resolve. The script exits 0 and the fallback email is sent, which is the fallback's job, so nothing looked wrong. Every unit test injects its own `call`. Found by sending a real test digest. | PR #20 (`1010297`): both scripts import the providers, and `tests/scripts/scripts-register-providers.test.mjs` fails any harness script that calls or resolves a model without that import. It was confirmed to fail on the old code. The resend produced the plain-language email. |
| **The Actions permission was set on the wrong page, then silently didn't save.** The docs named Settings → Actions → General → Workflow permissions, but the owner went to Settings → General → Pull Requests, which looks right. On the right page, *Read and write* saved but *Allow GitHub Actions to create and approve pull requests* did not, with no message. Only `gh api repos/OWNER/REPO/actions/permissions/workflow` showed `can_approve_pull_request_reviews: false`. | PR #19 (`90bad36`): the direct `/settings/actions` URL, the look-alike page named, and the `gh api` check, in the README, the generated `SELF-IMPROVE-README.md`, `console/DEPLOYMENT.md` and `console/how-to-run.html` |
| **A GitHub personal access token was created for nothing.** The docs never said the workflow uses the built-in `github.token`. | PR #19: stated in all four places. The token was removed from the key file. |
| **"Where do the SendGrid details go?"** had no single answer. The secret alone does nothing without a `notify:` block and a regenerated workflow, and SMTP settings the app already had are not read by the harness. | PR #19: README Step 7 says all three |
| **The walkthrough's `cp harness/.env.example .env` would have overwritten the app's live `.env`**, which held OpenAI, Supabase service-role, SMTP, Stripe and Railway secrets. Caught by reading the target before running the command. | PR #19: `how-to-run.html` says to use `.env.harness.local` (covered by a `.env.*.local` ignore rule) and `--env-file=.env.harness.local` |
| **Merge order.** The rehearsal's agent branch is cut from the setup branch, and its record is persisted back onto the setup branch. The owner merged the agent branch into `main` first, so `main` got the harness without the generation record, and the setup PR looked half-merged. An extra empty PR followed. | PR #19: `how-to-run.html` says merge setup first. The records were recovered by merging setup afterwards. |

## Fixed after the write-up, the same day

| Finding | Fix |
|---|---|
| **The suggestion prompt asked for two incompatible structures.** Fable's escalation (target `pipeline`), confirmed in the code. `buildSuggestSystemPrompt()` embedded `buildEditFormatSpec()`, which says "Respond in EXACTLY this format. No other structure is accepted." with SUMMARY/RATIONALE. The user prompt then ended with `SUGGEST_RESPONSE_FORMAT`: "Respond in this structure: PILLAR / PROBLEM / CHANGE / …". Models padded their answers to satisfy both, and generation 001's good commit title existed only because Fable wrote the SUMMARY the conflicting instruction asked for. | `buildEditFormatSpec({ blocksOnly: true })` gives the suggester the edit-block contract without a second structure. SUMMARY moved to the top of `SUGGEST_RESPONSE_FORMAT`, so a suggester whose own edits ship still titles its commit. `proposal.md` fills Pillar and Rationale from the suggestion's own PILLAR and WHY THIS ONE. The implementer's prompt is byte-identical. Three tests fail on the old code. |
| **`init.mjs` offered the current branch as `project.default_branch`.** The walkthrough has you on `self-optimisation-setup` when you run init, so `--yes` wrote that. Every generation would have been cut from, and every pull request opened against, a branch nothing deploys. Railway deploys this project, and the self-optimisation console, from `main`. | `harness/lib/git-default-branch.mjs` offers the remote's default (`origin/HEAD`), then a local or remote `main`/`master`, and never the current branch. `validate.mjs`, init's own check and `rehearse.mjs` now warn when `default_branch` disagrees with the remote. Tested against real clones, including a remote whose default is `trunk`. |

## Found, not fixed

- **The budget cap reserves on an estimate that undercounts code.** *(This
  bullet first said the cap was not enforced inside a fan-out. That was
  wrong, and was corrected after reading `spend.mjs`.)* Every request,
  headroom retries included, is admitted only if its reservation fits:
  estimated input plus its full output allowance. The estimate is characters
  ÷ 4, about 258k tokens for this prompt. The real counts were 247k
  (`gpt-6-astra`), 281k (`gemini-3.8-flash`) and **383k (`claude-fable-5-1`)**.
  Anthropic's tokenizer counts this code-heavy HTML at about 1.5× the
  estimate, and that gap is the 1% overshoot. On a larger fan-out of
  Anthropic models it would be bigger. Every record already carries both the
  estimate's input (the prompt) and the provider's real count, so a
  per-provider ratio learnt from past records would close most of the gap.
- **A truncating model pays twice for nothing.** `deepseek-flash` spent
  610k tokens on two truncated calls. The headroom retry doubles the output
  allowance, but it also resends the whole input, here 257k. On a repository
  this size, one retry costs as much as a whole extra model.
- **A timed-out model costs its full input.** Qwen's 600-second timeout is
  recorded at its estimated input, 267k tokens, with nothing to show. That
  is correct metering, but a timeout that size is a real cost.
- **A key check cannot see billing.** Listing a lab's catalogue is free, so
  Meta's key passed every check and only a real call returned 402. The
  project's own `scripts/verify-harness-keys.mjs` (catalogue per lab, the
  SendGrid key's `mail.send` scope, key-file ignore status, a scrubber so no
  value is printed) says this in its header. The probe step is the first
  place billing shows up, and it drops the lab without failing the run. The
  script, plus a manual workflow that runs it against repository secrets, is
  worth upstreaming into `harness/scripts/`.
- **The copied-in workflow's js-yaml install is also, silently, the project's
  dependency install.** See the next section. It is the only step that puts
  a Node project's own packages (jest, here) on the runner, so it cannot
  simply be isolated the way the local command now is.
- **Display names are not API ids.** The owner named models by their
  marketing names. "DeepSeek-V4.1-Flash" has no versioned id in DeepSeek's
  catalogue. The only match was the `deepseek-flash` alias. The ids were
  found by listing each catalogue through the harness's own provider
  modules.

- **Railway deploys on every push to `main` without waiting for CI.** Both
  this project's service and the self-optimisation console have
  `checkSuites: false`. A merged generation goes live whether or not the
  project's own CI passed. Under `human-approval-required` a person merges
  and can wait for green. Under `autonomous-merge` nothing would. That is a
  host setting, not a harness one, but it belongs on an installer's
  checklist, and now is.

## Installing js-yaml at the project root, tested

The walkthrough's `npm install --no-save js-yaml@5.3.0`, run at a project's
top level, was worried about during the install and then tested in
throwaway projects (npm 10.9, Node 23):

| Project shape | What a root install did |
|---|---|
| Depends on js-yaml `^4` directly | **Silently swapped the project's copy for 5.3.0.** `package.json` and the lock file were unchanged, so nothing showed in git. `yaml.safeLoad`, still used by older code, became `undefined`. A later `npm ci` put 4.3.2 back, so the harness then ran on a version it was not written for, also silently. |
| Gets js-yaml 3 only transitively (jest's coverage loader, as NetworkinAI does) | **Nothing broke.** npm nested 3.15.2 under its dependent. The worry during this install was unfounded for this project. |
| Has a package installed by hand, not in `package.json` | **Deleted it.** |
| Has an install script, installed via the workflow's `--ignore-scripts` | **The script never ran.** Anything it generates is missing when the tests run. |
| Has no `package.json` (a Python project, say) | **npm walked up to the nearest parent folder with a `package.json` and installed there.** On the machine this was tested on, that was the user's home folder. The harness still worked, because Node's resolution walks up too, which is why nothing looked wrong. The experiment's two stray packages were removed afterwards. |
| `--prefix harness --no-save --no-package-lock` instead | **Isolated.** The project's copy was untouched, only `harness/node_modules` appeared, and it survived a later `npm ci`. |

What changed: `console/how-to-run.html` now gives the `--prefix harness`
command, says why in one warning, and has a checklist for a finished
installation. The shared workflow already installs js-yaml in its own
directory.

What did not change, and why: the **copied-in workflow**
(`COPIED_HARNESS_SETUP` in `harness/lib/scaffold.mjs`) still installs at the
root. For a Node project that step is the only thing installing the
project's own dependencies before `npm test`. It does so with
`--ignore-scripts`, and nobody chose that. Isolating it without a project
install step would break every copied install's tests. The fix is to give
copied installs what shared ones have: an explicit
`evaluation.setup_commands` step (for example `npm ci`), run before an
isolated harness install. Existing adapters would need that field added
before they upgrade.

## Then on GitHub Actions

The same afternoon, the loop's first two real runs on GitHub, both campaign
runs on `gpt-6-astra` alone. Both passed every setup step, including the
project's own tests on the runner (which settles that the root js-yaml
install does install jest there). Both produced nothing, and each showed
something the rehearsal could not.

| Generation | What happened | Tokens |
|---|---|---|
| **002** | `gpt-6-astra` proposed. `claude-opus-5`, implementing, spent its 16,000-token output allowance with no text, and its retry was refused: **the Anthropic account had no credit.** The run showed a green tick, and the digest said "❌ review", although nothing had been reviewed. | 909,843 |
| **003**, after a top-up | The same shape. `claude-opus-5` used its whole 16,000 output allowance, then its whole 32,000, and was truncated both times. Opus 5 runs adaptive thinking at effort `high` when a request omits both, as the harness does, and **thinking counts against `max_tokens`**. On a ~380k-token prompt it thought its way through both allowances. Green tick again. | 1,057,031 |

About 2 million tokens, for zero changes. Each finding became a fix in the
same pull request as this section:

| Finding | Fix |
|---|---|
| **A pinned seat's billing was discovered after the suggester had been paid for.** The probe only probed candidates. | `probe-models.mjs` probes the pinned seats too: implement and review, a named ranker, and the digest writer. It does so only when a candidate survived, so a quiet month still costs nothing. An unreachable one skips the cycle before any suggester call, sends its own email ("A fixed model could not be reached — nothing was spent"), and turns the run red. |
| **A crashed loop showed a green tick.** | A final step turns the run red when the loop failed without a verdict. A rejection stays green, because that is the gates working. |
| **The digest's "review" gate was the whole loop step's outcome**, so a crash, an empty fan-out or a budget refusal all read "❌ review". | The gate is `review` only when a review happened, and `improve` otherwise. |
| **A campaign run with no generation was told the release check "did not complete"**, because campaign mode skips that check and `skipped` was read as failed. | `noGenerationReason()` treats `skipped` as not failed. It is now a tested function instead of an inline chain. |
| **The implementer's output allowance was a hard-coded 16,000.** | `roles.implement.max_output_tokens`, default 32,000. |
| **No way to set a seat's thinking effort.** | `roles.implement.effort` and `roles.review.effort`, sent as Anthropic's `output_config.effort` and ignored by every other lab. Opt-in, because a field a future model does not know would 400 every call. `validate` refuses a value no lab accepts. |

Also from these runs: the digest model does not need to be the implementer.
It writes a short email, so `claude-sonnet-5` ($2 / $10 per million tokens
against Opus 5's $5 / $25) is plenty. `claude-fable-5-1` is $10 / $50. It is
only ever called when named for a campaign, or when it is a new release from a
watched lab, but then it is the suggester, and a suggester whose own edits
pass ships them.

## After the fixes: the first generation to ship from GitHub

With #23's harness and the new settings (`roles.implement.effort: medium`,
`notify.digest_model: claude-sonnet-5`), generation **004** ran
`gpt-6-astra` alone and went through every gate on GitHub for the first
time. Its steps:
1. The pinned-seat probe passed: `claude-opus-5` for implement and review,
   `claude-sonnet-5` for the digest.
2. The suggester wrote its own two edits, to `venue.html` and `README.md`.
3. The in-loop tests passed.
4. Opus approved on the first review.
5. The guard and the branch tests passed.
6. The pull request was opened (NetworkinAI #52: "Suspend venue controls for
   the whole persona dialogue").
7. The record was persisted.

It cost 392,919 tokens:

| Seat | Model | Input | Output | At list price |
|---|---|---|---|---|
| suggest (and implement, its own edits) | `gpt-6-astra` | 249,530 | 1,661 | not looked up |
| review | `claude-opus-5` | 137,091 | 4,637 | about $0.80 |

The reviewer's own reasoning caught a real mechanism: the venue's movement
gates test `display !== 'block'` while the dialogue opens with `flex`, so
controls were only suspended by accident. That is the loop working as
designed. It is still unreviewed by a person, and the change is untested on a
phone.

Two things the digest got wrong, not yet fixed:
- **The plain-language email failed once on GitHub** ("No BODY: section
  found in the response") and fell back to the terse one. It did not
  reproduce: the same composition locally with `claude-sonnet-5` ended
  cleanly, using 988 of its 2,000 output tokens (309 thinking), with a BODY.
  So the cause is intermittent or a formatting slip, and unproven. Raising the
  digest's output allowance would make truncation unlikely for a few cents,
  but nothing yet shows truncation was the cause.
- **It reads a pull request waiting for review as a failure.** Under
  `human-approval-required`, "not merged" is the expected end state, yet the
  subject says "⚠️ NOT MERGED", and the plain-language version said "we don't
  know why". It should say a pull request is waiting.

## Generation 005: the pinned implementer, on GitHub

Rotating to `gemini-3.8-flash`, generation **005** is the first run where the
pinned implementer wrote the change on GitHub. Its steps:
1. The pinned-seat probe passed.
2. Gemini ran out of output room at 32,000 tokens, and the headroom retry at
   64,000 resent the whole ~283k-token input.
3. Its proposal came with its own edits: only a new test file and no code
   change. **That test failed in the loop,** before any review was paid for.
4. `claude-opus-5` at `roles.implement.effort: medium` then implemented the
   change: 6 edits to `venue.html`, 7,246 characters, no truncation. That is
   the fix for generations 002 and 003, working.
5. The tests passed, the review approved on attempt 2, and so did the guard
   and the branch tests.
6. The pull request was opened (NetworkinAI #53: every way of dismissing a
   persona dialogue goes through one `closeDialogue()` path, including a tap
   outside it).
7. The plain-language digest, from `claude-sonnet-5`, worked.

| Seat | Model | Calls | Input | Output |
|---|---|---|---|---|
| suggest | `gemini-3.8-flash` | 2 | 566,660 | 60,290 |
| implement + review | `claude-opus-5` | 2 | 512,230 | 15,785 |

1,154,965 tokens in all, about $2.95 of it Opus 5. The wasted Gemini call
led to `roles.suggest.max_output_tokens: 64000` for NetworkinAI.

**Every GitHub run, so far:**

| Gen | Suggester | Outcome | Tokens |
|---|---|---|---|
| 002 | `gpt-6-astra` | crashed: no Anthropic credit | 909,843 |
| 003 | `gpt-6-astra` | crashed: implementer out of output room | 1,057,031 |
| 004 | `gpt-6-astra` | pull request #52, suggester's own edits | 392,919 |
| 005 | `gemini-3.8-flash` | pull request #53, Opus implemented after the suggester's edits failed tests | 1,154,965 |

## The run history page

Reading these records to tell the owner what happened took a script each
time. carrotgame had solved that for itself with a hand-built page whose run
table was the part people read. Every installation now gets
`docs/generations/index.html` (#26):
- one self-contained page, newest run first;
- the change in plain words, and the outcome in plain words;
- failed attempts with their reasons;
- tokens and cache reads, and pull requests waiting for review;
- open escalations.

It is rebuilt with every run's record and at the start of each cycle.
Rendering it from NetworkinAI's five real records found that an opened but
unread pull request counted as merged. That was invisible while the report
was only rebuilt after fates were read back, and it is fixed.

## Checking credit, not just keys

Generation 002 died on an empty balance that every key check had passed. What
each lab lets a key see, from their documentation in September 2026:
- **DeepSeek:** `GET /user/balance` with the ordinary API key. It returns
  `is_available` and total, granted and topped-up balances.
- **Moonshot / Kimi:** `GET /v1/users/me/balance` with the ordinary key. It
  returns available, voucher and cash balances. At zero or below, requests
  fail with a quota error.
- **Anthropic:** no balance endpoint. The Usage & Cost Admin API reports
  spend, and needs an Admin API key (`sk-ant-admin…`) that only an
  organisation admin can create.
- **OpenAI:** the Costs endpoint reports spend with an admin key. Credit
  balance is not reliably available to API keys.
- **Google, Qwen, xAI, Meta, Z.ai:** not checked.

The console holds no keys by design, so any balance check has to run where
the keys are, locally or in the workflow, and report into the records the
console already reads. The probe of pinned seats (#23) is the part that
matters most: it catches an unchargeable account before anything is spent,
on every lab, with no admin key. WORKPLAN I11 carries the rest.

## What it costs, and what that buys

Tokens overstate cost. Almost all of them are input, the models reading the
project, and input is billed at a fraction of output. At September 2026 list
prices for the Anthropic seats (Opus 5 $5 / $25, Sonnet 5 $2 / $10, Fable 5.1
$10 / $50 per million input / output):

| Run | Tokens | Anthropic share |
|---|---|---|
| 004, shipped: suggester self-implemented, one Opus review | 392,919 | ~$0.80 |
| 003, failed: Opus implementer truncated twice | 1,057,031 | ~$5.00 |
| 001 rehearsal, six suggesters, Fable self-implemented | 2,021,356 | ~$5.90 (Fable ~$4.70, Opus ~$1.20) |

The measure that matters is the cost of each change that ships, including
the owner's review of it, against the time a person would have taken to make
it. That is an opportunity cost, not a token count. On those terms a
generation that ships is cheap. What makes the loop expensive is waste:
- runs that spend and ship nothing (002 and 003, ~$9 of Anthropic credit and
  ~500k tokens of OpenAI input between them);
- more suggesters than needed;
- an editable surface wider than the goal;
- a reasoning model thinking through a task that only needs following.

The first is now largely stopped. The rest are configuration.

Two harness changes cut a normal run's cost further. Both were built the same day, after these runs:
1. **Send the implementer only the files the proposal names.** It gets all
   ~380k tokens of editable source today, even when the change touches two
   files.
2. **Use prompt caching on the Anthropic seats.** An implementation retry, a
   refinement or a headroom retry rereads identical source, which caching
   bills at a tenth of the input price.

How each works now:
- **Scoped implementer context.** The implementer is shown the editable files
  the proposal names, plus any the suggester's own edits touched. A
  `NEED FILES:` reply, or an edit that fails against a file it was not shown,
  widens the set for the next attempt. A proposal that names no file falls
  back to every file.
- **Prompt caching.** The implementer's prompt is ordered so that everything
  identical across attempts comes first (proposal, test invariants, source),
  and Anthropic gets a cache breakpoint after it. Checked live: two calls with a
  shared ~30,000-character prefix wrote 10,665 tokens to the cache, and the
  second read all 10,665 back with 12 uncached. `attempts.json` now reports
  `cacheReadTokens` and `cacheWriteTokens`. Neither saving has been
  measured on a real generation yet.

What users are told: `console/how-to-run.html` has a "What it costs, and what
that buys" section with these figures and says the two savings are in. The installer's Seats, Labs and Budget
steps and the About page say the same things where the choices are made.

## What is still not proven

- **The two cost savings on a real run.** Scoped implementer context and
  prompt caching (#25) are tested and checked live against the API, but no
  generation has run with them yet (WORKPLAN I8).
- **A scheduled run.** All four GitHub runs were dispatched by hand.
- **The owner's verdict read back.** Pull requests #52 and #53 are open.
  Nothing has yet merged or closed a workflow-opened pull request for the next
  cycle to record.
- **`context.strategy: scoped`.** At 1.03 million characters of editable
  source, `full-dump` still fit every model's window and cost ~250–510k input
  tokens per model. That makes WORKPLAN 2.1a concrete: it is a cost question
  before it is a window question. At six suggesters, the prompt is most of
  the budget.
- **Whether the change is right on a phone.** It was reviewed from source.
  No visual capture is configured, and nothing in the loop drove a touch
  device.
- **The read-back of a workflow-opened pull request.** The merged change came
  from a rehearsal branch, not from a pull request the workflow opened, so
  `sync-pull-request-outcomes.mjs` has nothing to read yet.
- **n = 1 project.** Five generations on one repository. Nothing here is a
  rate.
