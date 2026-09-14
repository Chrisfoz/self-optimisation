# End-to-end test plan and results — 2026-09-14

**Purpose.** Make the harness operational end to end and prove it: project
selection, every provider and model, a generation run on many models at
once, and the curiosity element. This document is the plan, what was done
against it, what it found, and what remains for the owner because it needs
something only the owner has (lab keys, a GitHub App, a real repository).

**Where it started.** The suite (758 tests) was green, and the real
campaigns of 2026-09-11 had run seven generations with real keys. But every
automated check faked the model calls one function above the transport,
and this environment holds no lab key at all — so nothing here could drive
the real scripts across the real HTTP boundary, on demand, without paying
a lab. That gap is the one the first real campaigns found seven defects in.

**What changed.** One small, loopback-only override lets the whole chain
run against a local stand-in for all nine labs. That turned the plan below
from "what the owner should do with keys" into "what runs on every
`npm test`", plus a shorter list of what still needs keys.

---

## 1. The plan

| # | Area | What "operational" means | How it is proved |
|---|---|---|---|
| 1 | **Project selection** | A person can point the harness at a project: scaffold the adapter, briefs and workflow; validate them; regenerate after editing | `init.mjs --yes`, `validate.mjs`, `init.mjs --from-adapter --force` on a fresh repository; the console's `/api/preview` and `/api/bundle` with a repository named |
| 2 | **All providers, all models** | Every one of the nine labs can be watched, listed, detected, probed, and called through its own dialect and auth; the console lists them all | Detector baseline → quiet run → one release at each lab → `max_fanout`; probe on each; console `/api/catalog` and `/api/models` |
| 3 | **A generation on many models** | One generation fans out to all nine labs, ranks across families, implements, tests in the loop, reviews on a different lab, guards, persists, measures | `rehearse.mjs --models <nine ids>` on a scratch project, real git, real child-process tests |
| 4 | **Repair and refine** | A winner's broken edits are caught by the project's tests and repaired; a review rejection is refined | Scripted: the ranked proposal removes the marker; the reviewer rejects once |
| 5 | **Curiosity** | Escalation consensus flags across labs; a lone one is resurfaced and retired; an accepted one becomes a work order and is carried; runtime evidence, the themes review (with UNKNOWN) and open questions reach the next prompt | Three generations on the scratch project with cadence 2 and resurface 1; assertions on the exact prompts the labs received |
| 6 | **Report** | The operational report renders from the records | `report.mjs` |
| 7 | **The parts that need the owner** | Real keys, the console's GitHub App, a run on GitHub Actions, the pull-request read-back, the digest | Listed in §5 with the exact commands |

---

## 2. What was built to run it

- **`harness/lib/lab-endpoint.mjs`** and one line each in
  `llm-provider.mjs` and `model-release-detector.mjs`: `HARNESS_LAB_ENDPOINT`
  sends every lab request (model calls and catalogue listings) to a
  loopback origin, keeping the provider's own path, headers and body and
  adding `x-harness-upstream-host` so the stand-in knows which lab it is.
  Honoured only for `localhost`, `127.0.0.1` or `::1`; anything else is
  refused before a byte is sent, because the request carries the key.
  Unit-tested in `tests/lib/lab-endpoint.test.mjs`.
- **`tests/helpers/mock-labs.mjs`**: one HTTP server answering in all nine
  dialects — Anthropic messages, OpenAI chat completions, Google
  `generateContent`, and the six OpenAI-compatible labs at their own paths —
  with each lab's catalogue listing, a 401 when the dialect's key is absent,
  a 404 for a model the catalogue does not list, and usage in each lab's
  own shape. It classifies each request by stage (probe, suggest, rank,
  implement, review, themes) from the prompt the harness actually built,
  answers from a default script, and records every request so a test can
  assert on what the harness sent.
- **`tests/helpers/scratch-project.mjs`**: a real project for the harness to
  improve — a git repository, one editable page with a marker line, a
  `node --test` suite, two filled-in briefs, and an adapter watching all
  nine labs with the implement seat on Anthropic, the review seat on
  OpenAI, the shipped evaluator plugin, a committed goal, and a short
  themes cadence.
- **`tests/e2e/mock-labs.test.mjs`**: the plan above, automated. Runs as
  part of `npm test` in about six seconds.
- One fix in **`harness/scripts/rehearse.mjs`**: git's stderr is piped, not
  inherited, so the first-run probes for paths that do not exist yet stop
  printing `fatal:` and `error: pathspec` lines that were handled outcomes.

---

## 3. Results

Every step was run by hand first (drivers in the session's scratchpad,
logs read in full), then encoded as the test. All of the following pass.

### 3.1 Project selection

| Step | Result |
|---|---|
| `node harness/cli/init.mjs --yes` on an empty repository | Writes `project-adapter.yml`, `.github/workflows/self-improve.yml`, both briefs, `SELF-IMPROVE-README.md`. Its own post-check reports the one error (`allowed_paths` empty) and warns about 30 + 11 unfilled placeholders and the two missing keys. |
| `node harness/scripts/validate.mjs` | Same findings, exit 1 — correct, the defaults are not a runnable project. |
| `node harness/cli/init.mjs --from-adapter --force` | Regenerates the workflow and README from the adapter; briefs and adapter untouched. |
| Console `GET /api/catalog` | Nine labs with their env-var names; the protected-path list. |
| Console `GET /api/models` | The bundled catalogue: eight labs with model ids. **Qwen has no bundled model** (see §4). |
| Console `POST /api/preview`, nine labs, three seats on three labs | Five generated files; `requiredSecrets` names all nine keys; the adapter watches all nine; the workflow references all nine secrets. |
| Console `POST /api/bundle` | 86 files: the five generated plus 81 harness files. |
| Cross-origin POST; private route without sign-in | Refused (403, 401), as designed. |
| Console GitHub connection (sign in, pick a repository, open the setup pull request, dispatch a rehearsal, activate the schedule) | **Not run here** — needs the owner's GitHub App (`console/DEPLOYMENT.md`). The flow is covered by `tests/console/github.test.mjs` and `api.test.mjs` against a faked GitHub. |

### 3.2 All providers, all models

| Step | Result |
|---|---|
| Detector, first run, nine labs | Baseline recorded for all nine; each lab's listing was fetched with that lab's own key in that lab's own header/query; `.agent/model-snapshot.json` has nine entries. |
| Detector, second run | `no new models` for all nine. |
| One new model at each lab | Nine detected; `max_fanout: 8` held one back and marked it seen; eight candidates from eight different labs. |
| Probe on the eight | All reachable; each probe called the new id on its own lab. |
| Probe on a model the lab does not serve | Dropped with the lab's 404, before any budget is spent. |

### 3.3 A generation on all nine models

`rehearse.mjs --models claude-opus-5,gpt-6-astra,gemini-3.8-flash,kimi-k3,deepseek-v4-pro,qwen3.5-max,grok-4.6,muse-spark-1.3,glm-5.3`

| Stage | Result |
|---|---|
| Validate, preflight | Adapter OK; the project's suite green. |
| Campaign, probe | Nine resolved to their labs, nine reachable. |
| Claim | Generation 001 on `agent/gen-001`. |
| Baseline measurement | `source-weight`: 3 metrics on the untouched tree. |
| Seats | implement `claude-opus-5` (anthropic), review `gpt-5.5` (openai), rank **auto-picked from a different family** than the implementer, from the snapshot. |
| Suggest | Nine proposals, one per lab; the committed goal in every system prompt; the frozen-test index in every user prompt. |
| Rank | On the cross-family ranker; picked proposal 2 (gpt-6-astra). |
| Implement, attempt 1 | gpt-6-astra's own edits applied; **the in-loop tests failed** (marker removed); recorded `tests-failed`. |
| Implement, attempt 2 | claude-opus-5 repaired from the failing lines; tests green; **review rejected**; recorded `rejected-by-review`. |
| Implement, attempt 3 | Refined; tests green; approved. |
| Persist | Record, proposals from all nine labs, baseline/after metrics and comparison committed to `main`; the branch's copies cleared. |
| Guard, tests | PASS, PASS. Verdict: "would open a pull request". |
| Spend | Provider-reported usage, every call, both retries included. |

### 3.4 Curiosity

| Mechanism | Result |
|---|---|
| Escalation consensus (C8) | Two labs opened the same case and a third backed it: flagged at 3 models across 3 labs in one round; `escalations-flagged=1` in the outputs; the notification text rendered. |
| A lone escalation | Opened by a fourth lab; stays `open`. |
| Owner acceptance → work order | Setting `status: accepted` in the ledger queued a work order at the start of the next run. |
| Runtime evidence (C10) | `record-runtime-evidence.mjs --tap …` wrote `docs/runtime/gen-001.json`; generation 002's prompt carried "What the last runs actually observed at runtime". |
| Resurfacing and retirement | With `resurface_after: 1`, generation 002 asked about the lone entry by name (`ESCALATION REVIEW` in the prompt); three models answered IRRELEVANT; it was retired with the resolution text naming them. |
| Work order carried | A **focused** run does not take one — by design (C4 ordering). Generation 003, run `--scope ambitious`, carried it, and completed it as `approved`; `work-order-completed=esc-001:approved`. |
| Themes review (C2) | Due at generation 002 (cadence 2); written by the review seat; two themes, one with an `UNKNOWN`; a second run says "already covers generation 002" and writes nothing. |
| Open questions in the next prompt | Generation 003's prompt carries "Recurring themes from the last review" and "Open questions this project has not answered", with the UNKNOWN verbatim. |
| Ambitious rubric | The ranker's system prompt for 003 used the AMBITIOUS rubric. |
| Report | Three generations, all campaign; "3 approved only in a local rehearsal and never put to a person"; per-lab asked/chosen/approved/self-implemented; measured effect per generation. |

---

## 4. What it found

- **The default `node --test <dir>` form does not work on Node 22.** A
  scratch adapter with `test_commands: [node --test tests/]` fails
  preflight with `Cannot find module …/tests`. Not a harness defect — the
  README already explains why `npm test` passes a glob — but worth knowing
  when writing an adapter: name the files, or a glob.
- **The rehearsal printed handled git errors as `fatal:`.** On a first run
  the numbering step asks git for `main:docs/generations` and the cleanup
  step checks out four paths that may not be tracked yet; all were caught
  and handled, but their stderr was inherited and looked like failures.
  Fixed in `rehearse.mjs`.
- **The bundled model catalogue has no Qwen entry**, so the console's
  pick-list shows Qwen with nothing to pick. The catalogue is seeded from
  models that have actually answered a real run, and Qwen has not yet; the
  console lets a person type any id, so it is not blocking. Refreshing the
  catalogue with a Qwen key (`refresh-model-catalogue.mjs`) fills it.
- **The cross-family ranker needs a snapshot.** On a campaign run with no
  `.agent/model-snapshot.json` the rank seat falls back to the implementer's
  family and warns; with one, it picks another family automatically. Known
  from 2026-09-11; now visible in the test as the difference between the
  first manual drive (no snapshot: rank on anthropic) and the test (snapshot
  first: rank on deepseek). Run the detector once before a first campaign.
- **A nested `node --test` refuses to run** when `NODE_TEST_CONTEXT` is in
  its environment, so a harness test that spawns the project's own
  `node --test` suite must strip it or every in-loop test passes
  vacuously. Only affects test-suite authors; a real install never has it.

No defect was found in the loop itself, the provider request shapes, the
listing parsers, the records, the ledger, the themes review, or the report.

---

## 5. What still needs the owner

Nothing below can be done from a session with no keys and no GitHub App.
Each is one command or one setting.

1. **Real keys, real labs, the same scratch project.** Copy
   `harness/.env.example` to `.env`, add the keys you hold, then from any
   project with an adapter:
   ```bash
   node --env-file=.env harness/scripts/check-model-releases.mjs     # baseline every lab you hold a key for
   node --env-file=.env harness/scripts/refresh-model-catalogue.mjs  # fills the console pick-list, incl. Qwen
   node --env-file=.env harness/scripts/rehearse.mjs --models <one id per lab>
   ```
   Expect the same stages as §3.3, with real proposals. Discard the branch
   afterwards as the script says, or keep it.
2. **The console's GitHub connection.** Create the GitHub App per
   `console/DEPLOYMENT.md`, set the four variables in `console/.env.example`,
   run `npm start`, sign in, pick a repository, and open the setup pull
   request. That exercises `github.mjs` against the real API.
3. **A run on GitHub Actions**, from the generated workflow, with the nine
   secrets. Then merge or close the pull request and dispatch once more:
   that is the **read-back of a merged or closed pull request**, the one
   step the 2026-09-11 write-up lists as still unproven.
4. **The digest.** Set `notify:` in the adapter and `SENDGRID_API_KEY`; the
   generated workflow sends it after each run.

---

## 6. How to re-run what was done here

```bash
npm test                                            # includes tests/e2e/mock-labs.test.mjs
node --test tests/e2e/mock-labs.test.mjs            # just the chain, ~6 s
```

To drive the scripts by hand against the stand-in, start it in a script
(`startMockLabs()` from `tests/helpers/mock-labs.mjs`), spread
`labs.env()` over the child environment, and run any harness script in a
project directory — see the test for the exact sequence. Spawn children
asynchronously: the stand-in lives in the parent's event loop, and a
`spawnSync` blocks the server the child is calling.
