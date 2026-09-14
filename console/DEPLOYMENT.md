# Deploying the working console

The server still runs with `npm ci --ignore-scripts` and `npm start`. The existing
Railway service and `railway.json` are reused. No Supabase database is required.
The browser uses the existing harness generator through explicit API routes.

## Enable GitHub sign-in

Create or configure a **GitHub App**, rather than an OAuth App, owned by the
account that operates the console. This one-time registration and its credentials
are not created by the source changes.

- Homepage: `https://console-production-763f.up.railway.app/`
- User authorisation callback: `https://console-production-763f.up.railway.app/auth/callback`
- Post-installation Setup URL: `https://console-production-763f.up.railway.app/auth/installed`.
  Enable redirect on update so changing repository grants returns users to the console.
  This is separate from the user authorisation callback above.
- Allow installation on **Any account** if this console is intended for other users
  and organisations; an App limited to its owner cannot connect customer repositories.
- Repository permissions: **Contents: read/write**, **Pull requests: read/write**,
  **Actions: read/write**, **Workflows: read/write**, **Secrets: read-only**,
  **Metadata: read-only**.
- Install on only the repositories the operator wants to configure.
- This implementation uses GitHub App user access tokens. It does not need an
  App private key, installation-token minting, webhook delivery or Supabase.
  Access is checked on each repository operation rather than maintained in a cache.

Set Railway Variables using `console/.env.example`: `CONSOLE_ORIGIN`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_APP_SLUG`.
The client ID is not the numeric App ID. Keep the secret in Railway variables;
never send it in a chat message or commit it. Redeploy after setting the variables.
Use the exact public origin, without a trailing slash or path.

The implementation follows GitHub's [user access token flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
including browser-bound, single-use state and S256 PKCE. The token is held in
server memory, not browser storage. Sessions last at most one hour. No refresh
tokens are retained. Use a **single service replica**; restarting or replacing
it ends sessions. Multiple replicas need a shared session store before use.
Configure hosting logs to redact callback query strings and cookies. Do not put
request bodies, authorisation headers, or credentials into proxy logs.

Without these variables, the frontend explicitly says GitHub is not configured.
All ten configuration screens, validation and the complete download bundle still
work. A download does not claim to verify repository contents or secrets.

## Connect and install

1. Click **Connect GitHub**, then **Manage repository access** to grant the App
   selected repositories. Returning to the console tab refreshes the list; the
   Refresh repositories button is also available. Use search and the account filter
   to find a project. Only writable, unarchived repositories from active installations
   appear. An organisation may require its owner to approve the installation.
2. Select the repository. Its actual default branch and file tree are loaded.
3. Add model keys directly in **GitHub → Settings → Secrets and variables → Actions**.
   The console checks names only. It deliberately does not accept plaintext keys
   or implement the earlier proposed browser sealed-box flow. Watching and pinned
   seats jointly determine required keys. Repository secrets are required; inherited
   organisation/environment secrets are not counted by the current preflight.
4. Put dependency installation (for example `npm ci --ignore-scripts`) in the
   dependency setup field, and test execution in the test commands field. Project
   installation runs before the pinned harness dependency installation, so npm
   cannot silently remove `js-yaml` halfway through the run.
   Configure all ten steps and inspect the generated files. Existing installations
   are refused rather than overwritten; use `harness/cli/init.mjs --from-adapter`
   for upgrades. By default the install copies `harness/` into the target. A
   deployment can install the shared harness instead; see **Shared harness** below.
5. Open and inspect the setup PR. In GitHub's Actions settings enable **Allow
   GitHub Actions to create and approve pull requests**. Merge setup yourself.
6. Refresh setup status and explicitly request the rehearsal. It dispatches a
   real, focused campaign using the configured implementer as the campaign model.
   It may spend tokens and open an improvement PR, but cannot auto-merge it.
7. Refresh status. A green workflow alone is insufficient: validation, probe,
   baseline tests, improvement, guard, final tests and PR creation must each pass.
   Changed setup/configuration, unrelated runs and skipped gates cannot unlock activation.
8. Inspect the improvement PR. Open and review the separate activation PR for the
   chosen cadence and eventual approval mode. Automatic merge requires an HTTPS
   deployment verification URL. Manual/PR mode needs no activation change.

## Shared harness

Instead of copying `harness/` into every repository, a deployment can give each
one a short workflow that calls this repository's shared workflow,
`.github/workflows/self-improve.yml`, at one pinned commit. Upgrading a project
is then a one-line change to that commit, and a fix to the harness reaches a
project the moment it moves its pin.

Set, in Railway Variables:

- `SELF_OPTIMISATION_SHARED_REF` — the full 40-character commit SHA to pin. A
  branch, tag or short SHA stops the service at startup rather than opening pull
  requests that could never run.
- `SELF_OPTIMISATION_SHARED_LABEL` — optional, a version such as `v0.1.0`, shown
  as a comment beside the pin and in the console.
- `SELF_OPTIMISATION_SHARED_REPOSITORY` — optional, `owner/repo` of a fork.
  Defaults to `Chrisfoz/self-optimisation`.

**Leave these unset while the harness repository is private.** GitHub lets a
private repository's reusable workflows be called only from private repositories
owned by the same account, and even then the calling run cannot read the harness
code the shared workflow fetches. Once the repository is public, any project can
call it.

What changes in a shared install: the setup pull request carries no `harness/`
directory; the project's test and dependency setup commands live in
`project-adapter.yml` (`evaluation.test_commands`, `evaluation.setup_commands`)
and are read once per run from the default branch, before any agent change; the
adapter records the pin under `harness.shared`. The same gates run in the same
order. Pinning is by SHA, never a tag, for the reason the workflow pins its actions
by SHA: a movable ref would run whatever it was moved to, in every project at once.
From a terminal, `node harness/cli/init.mjs --shared <sha>` does the same.

## Several projects

The console keeps a **Projects** list: one project per repository, each with its
own draft, step and status, held in the browser tab's session storage. **+ New**
starts another project, blank or copying an existing project's labs, models,
cadence, attempts, fan-out and token budget. The repository, branch, tests,
paths, goal, deployment URL and automatic merge are never copied: each project
opts in to automatic merge on its own. Choosing a repository that already has a
project opens that project instead of a second draft.

One sign-in can open a setup pull request for each repository, and track each
one's rehearsal and activation separately (up to 25 per session). Opening a
second setup for the same repository is still refused. Signing out clears the
tab's projects, as it cleared the single draft before.

A rehearsal can legitimately fail or produce no proposal. Inspect the Actions
logs and generation record; do not treat that as a passed activation gate. If
setup files/default branch changed, a session expired, or a server restart lost
setup tracking, use GitHub Actions and inspect the files directly. The current
console does not reconstruct its setup session from arbitrary historical PRs.

The public APIs generate files only. They do not run submitted test commands,
call models or access a repository anonymously. GitHub actions require sign-in,
current installation membership and, for writes, an origin and CSRF check.
No generic GitHub proxy or secret-value endpoint is exposed.

