# The first install into someone else's repository — 2026-09-17

**The harness copied into a live web app it had never seen, then
configured, rehearsed, taken to GitHub and wired to email in one working
session. An AI coding session did the work, following the terminal
walkthrough at the owner's direction, with the owner making every choice
and every GitHub settings change.** One generation, one
change merged, about 2 million tokens. The 2026-09-11 campaigns proved the
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

## Found, not fixed

- **The suggestion prompt asks for two incompatible structures.** Fable's
  escalation (target `pipeline`), confirmed in the code.
  `buildSuggestSystemPrompt()` embeds `buildEditFormatSpec()`, which says
  "Respond in EXACTLY this format. No other structure is accepted." and
  gives SUMMARY/RATIONALE plus edit blocks. The user prompt then ends with
  `SUGGEST_RESPONSE_FORMAT`: "Respond in this structure: PILLAR / PROBLEM /
  CHANGE / …". Models pad their answer to satisfy both. The parser copes,
  but output tokens pay for it, and a model that picks one format loses
  fields from the other.
- **`init.mjs` records the current branch as `project.default_branch`.**
  `detectGitBranch()` runs `git branch --show-current`, and the walkthrough
  has you on `self-optimisation-setup` when you run init. So the adapter said
  `default_branch: self-optimisation-setup` until it was corrected by hand.
  `validate.mjs` does not flag a default branch that isn't the remote's
  default. `git symbolic-ref refs/remotes/origin/HEAD` would give the real
  one.
- **The budget cap is not a ceiling within one fan-out.** It is checked as a
  projection of input tokens before the fan-out, and against actual spend
  between refine attempts. Output tokens and headroom retries inside the
  fan-out are uncounted until afterwards. Here it went 1% over. With more
  truncating models it could go further.
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
- **Installing js-yaml at the project root** (`npm install --no-save
  js-yaml@5.3.0`, as the walkthrough says) would have replaced the js-yaml
  3.15.0 that jest's coverage loader depends on in this project. It was
  installed with `--prefix harness` instead, and Node resolves it from
  `harness/node_modules` first. This was avoided, not observed. The
  generated workflow still installs at the root in CI, and that has not
  been exercised here yet.
- **Display names are not API ids.** The owner named models by their
  marketing names. "DeepSeek-V4.1-Flash" has no versioned id in DeepSeek's
  catalogue. The only match was the `deepseek-flash` alias. The ids were
  found by listing each catalogue through the harness's own provider
  modules.

## What is still not proven

- **The monthly workflow on this repository.** Everything above ran locally,
  except the manual key-check workflow and ordinary CI. The first scheduled
  or dispatched `self-improve.yml` run, including its root js-yaml install
  and the new digest step, has not happened.
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
- **n = 1.**
