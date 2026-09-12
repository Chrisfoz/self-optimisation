# Console implementation review — 11 September 2026

Reviewed baseline: `be27d6ecb00152485eecfcf95736d198b004365a` and the live
[Railway console](https://console-production-763f.up.railway.app/).
The deployed baseline was a static wireframe: placeholder repository and runs,
no working GitHub actions, and hand-built YAML that diverged from the harness.

This change implements the browser installer and its GitHub boundary. It is not
a claim that GitHub App configuration or live acceptance has already happened.
See [DEPLOYMENT.md](DEPLOYMENT.md) before enabling sign-in.

## The ten-step audit

| Step | Baseline finding | Implemented behaviour | Automated evidence |
|---|---|---|---|
| 1. Connect | Fixed example repository and inactive manage button | App sign-in, browser-bound state/PKCE, current installation membership, repository picker and real default branch/tree | HTTP OAuth tests; revoked grants, branch metadata and truncated-tree tests |
| 2. Labs and API keys | Google, Qwen and Meta key names disagreed with the registry; custody claims had no implementation | Provider names come from the harness registry; keys entered on GitHub; required repository secret names verified without reading values | Watched plus unwatched-seat key union; missing secrets prevent writes |
| 3. Seats | Hard-coded model menu and key mapping | Implement/review/rank model IDs picked from a live catalogue or typed freely, with an optional explicit lab per seat so a model no provider pattern matches is still usable; registry resolution; optional cross-family ranker | Model validation; catalogue merge and `/api/models`; explicit lab reaches `roles.<seat>.provider`; separate seat values appear in generated adapter and workflow |
| 4. Stages and tests | Toggles suggested unsupported omissions; no real project test inputs | Core stages remain fixed; dependency setup, test commands and attempt limit are real inputs | Workflow parsing; setup precedes harness install; unsafe expression/multiline inputs rejected |
| 5. Boundaries | Example file tree | Actual connected tree plus editable/create-only/frozen patterns, permanent installer protections | Real file matching, path conflicts, traversal and protected edits rejected |
| 6. Meta-goal | Example game text; not connected to actual brief generation | Project goal, constraints and hints generate committed goal and real model briefs | Generated bundle passes the harness structural validator in a temporary project |
| 7. Cadence | Saved example with misleading not-wired labels | Monthly/weekly/manual selection; initial workflow has no schedule; activation is a separate PR | Both initial and activated YAML parsed and checked |
| 8. Approval | A commented-out value despite real kernel support | Initial rehearsal is always PR-only; eventual auto-merge requires an HTTPS verification URL and activation PR | Auto-merge absent during rehearsal; emitted only on activation |
| 9. Budget | Fan-out illustrated a cost estimate | Enforced fan-out, token cap and attempt bounds; no dollar estimate | Invalid ranges/fractions rejected; real adapter values verified |
| 10. Review/rehearse | Inactive PR button, made-up file counts, fake run history | Exact generated files, complete tar download, atomic setup branch/PR, explicit campaign dispatch, actual run/gate state, activation PR | No default-branch write; collision checks; unchanged/merged setup required; unrelated, skipped and failed gates cannot unlock activation |

## Frontend changes

The What it does page now has a clear opening proposition, an explicitly labelled
illustrative run, four sections explaining the loop, distinct roles, all ten setup
decisions and implementation limits. The existing long article and oversized flow
figure are replaced with a responsive composition, navy/blue/lime palette and
shared typography across the console and privacy page. Third-party fonts and the
embedded release tracker are removed; the README retains the independent source.

### The model list on step 3

Seats are pinned to model IDs, and a harness whose purpose is running models
released after it was written cannot ask people to remember those IDs — or
restrict them to the ones a pattern in this repository happens to match.
Step 3 therefore offers a list and a **Refresh model list** button, from two
sources kept distinguishable because they are not equally true:

- `harness/data/model-catalogue.json`, shipped with the deploy and refreshed
  by `harness/scripts/refresh-model-catalogue.mjs` (which needs lab keys, so
  it runs on a maintainer's machine, never here).
- The connected repository's own `.agent/model-snapshot.json` — every model
  each watched lab listed on that project's last run, written with that
  project's keys. The console holds no lab key and never will, so this is the
  only route by which a live, account-accurate list can reach the screen. A
  model in it that the bundled list has never seen is marked as newer than
  what this console shipped with; nothing claims a release date the data does
  not carry.

Beside each seat is an optional lab. An ID whose own name routes it needs
none and is given none, so the generated adapter stays quiet; an ID that
resolves nowhere — the whole point of pinning a model that shipped this
morning — carries `roles.<seat>.provider`, which the run pins at startup
(`pinModelProvider()`), and its lab's key joins the required secrets.

The installer has a ten-step navigation rail, step-level required-field checks,
a configuration summary, explicit connection/empty/error states, inspectable file
previews, tab-local drafts and real GitHub workflow status. Dynamic values use
text nodes, not HTML interpolation. API keys are never requested by the UI.

## Verification and limits

- `npm test`: the complete harness and console regression suite runs locally on
  Node 24. The existing CI also runs Node 22.11.0 and Node 24.
- The new tests live in `tests/console/`: configuration generation and validation,
  GitHub integration contracts, and real HTTP/authentication requests.
- External GitHub responses are injected in these tests. They prove request
  construction, authorisation checks, state transitions and failure handling;
  they do not prove a real App has been registered with the required permissions.
- The live Railway baseline was inspected in the browser. The browser security
  policy blocked both the local server preview and a standalone HTML preview.
  No bypass was attempted after the explicit policy rejection. Desktop/mobile
  rendering, keyboard interaction and the full authenticated live browser journey
  remain acceptance checks after deployment.
- No model calls, paid rehearsals, automatic merges or Railway production changes
  were performed during this implementation.

## Deliberate scope limits

- No GitHub App manifest registration, Supabase integration, token refresh,
  database cache or reusable remote workflow. One server replica is required;
  session restart/expiry falls back to GitHub's own PR and Actions pages.
- First-time installs only. Existing harness/config files are never overwritten.
- Repository secrets are checked, not organisation/environment inheritance.
  Secret presence does not establish provider validity or funding.
- Core stages are not independently switchable. Email notification is not
  configured by this installer. Reports and logs remain available on GitHub.
- A tar export cannot inspect an offline target or protect existing files from
  the person extracting it. Extract in a clean branch and review the diff.
- Rehearsal must create an improvement PR and pass every required gate to unlock
  activation. A no-proposal or rejected attempt does not qualify simply because
  GitHub marks the containing workflow successful.


## GitHub connection follow-through

The Connect screen now includes repository search (name and description), account
filtering, public/private labels and actionable empty states. App installation
returns through `/auth/installed`; that route ignores installation IDs as authority
and returns through sign-in when needed. Returning to the originating console tab
after managing access refreshes discovery. Cancelled authorisation returns to the
console, and revoked user tokens clear the local session.

Switching or refreshing repositories immediately clears previous verified state,
file trees, secret checks and setup controls. Late repository/setup responses are
discarded. Tokens remain server-only and every operation rechecks installation
grants. No new permissions, token storage or dependencies were introduced.

Deployment still needs an operator-owned GitHub App and the variables in
DEPLOYMENT.md. Automated tests use simulated GitHub responses; a live customer
authorisation and organisation-installation acceptance check remains necessary.

Verification commands:

- `node --test 'tests/console/*.test.mjs'` exercises the API and GitHub boundary.
- `node tests/console/github-browser.mjs` is an optional Playwright browser check;
  install Playwright and Chromium in your test environment first, or set
  `PLAYWRIGHT_MODULE` to an existing installation's `index.mjs`. It covers search,
  accounts, delayed responses, access removal, expired sessions and mobile width.
  This browser check was added but could not run in the implementation environment
  because Chromium was unavailable.
