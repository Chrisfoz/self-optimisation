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

1. Sign in and grant the App access on GitHub; refresh the repository list.
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
   for upgrades. The first install copies `harness/` into the target: the proposed
   reusable remote workflow is not implemented, and this private source repository
   is not assumed to be readable by other repositories' Actions runners.
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

A rehearsal can legitimately fail or produce no proposal. Inspect the Actions
logs and generation record; do not treat that as a passed activation gate. If
setup files/default branch changed, a session expired, or a server restart lost
setup tracking, use GitHub Actions and inspect the files directly. The current
console does not reconstruct its setup session from arbitrary historical PRs.

The public APIs generate files only. They do not run submitted test commands,
call models or access a repository anonymously. GitHub actions require sign-in,
current installation membership and, for writes, an origin and CSRF check.
No generic GitHub proxy or secret-value endpoint is exposed.
