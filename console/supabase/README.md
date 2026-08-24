# Console database

The product half of this repository. The harness is open and runs in your own
CI; the console is a hosted thing that needs to know who is asking, and this
is where that lives.

| | |
|---|---|
| Project | `self-optimisation-console` |
| Ref | `cegmdqtllgorsniyclas` |
| URL | `https://cegmdqtllgorsniyclas.supabase.co` |
| Publishable key | `sb_publishable_MoYDUTu4qKXNI0-PXWE29w_TE_hTS0V` |
| Region | `ap-southeast-2` (Sydney) |
| Postgres | 17 |

The publishable key is designed to ship in client-side code — it grants
nothing on its own, because every table is row-level-secured to the signed-in
user. The service-role key is not recorded here and should not be pasted into
anything; see `../DESIGN.md` §8.4 for why no credential of ours belongs in a
user's repository.

## Schema

`../DESIGN.md` §8 is the reasoning. In short: five tables — `profiles`,
`installations`, `runs`, `escalations`, `config_writes` — all RLS-scoped to
their owner, with no public or shared read path anywhere.

Three properties that are enforced rather than intended:

- **API keys cannot be stored.** `installations.config_cache` carries a CHECK
  calling `looks_like_secret()`, which rejects a write that looks like it
  carries a credential rather than scrubbing it.
- **Audit rows cannot be rewritten.** `config_writes` has select and insert
  policies and deliberately no update or delete policy.
- **Derived config cannot drift.** `cadence_cron` and `approval_class` are
  generated columns computed from `config_cache`, not stored beside it.

Verified against the live database after migrating:

```
secret-check: anthropic key            true    (expect true)
secret-check: github token             true    (expect true)
secret-check: real adapter config      false   (expect false)
rls enabled on all 5 tables            5/5
config_writes update/delete policies   0
generated columns on installations     approval_class, cadence_cron
security definer fns left in public    none
run_outcome labels                     no_proposal, approved, abandoned, crashed
estimated_cost_usd column              gone
api_issues default                     '[]'::jsonb
```

`get_advisors(type: security)` returns no lints.

## Migration 0003 — no dollar guesses, real billing flags

0001's `runs.outcome` enum and `estimated_cost_usd` column were both written
before anyone had checked what `harness/lib/orchestrator.mjs` actually
produces. 0003 corrects both:

- **`run_outcome`** now mirrors the harness's real four values exactly —
  `no_proposal`, `approved`, `abandoned`, `crashed` — not an invented
  taxonomy (`shipped`, `blocked_review`, `no_release`, ...) that could drift
  from what the code writes. "Nothing new released this month" is
  deliberately not a value: `runGeneration()` never runs in that case, so
  there is no `attempts.json` and correctly no row — the console shows a
  quiet month by absence, not by writing a row for something that didn't
  happen.
- **`estimated_cost_usd` is gone, replaced by `api_issues`.** The console
  can't honestly price a run — model pricing moves independently of this
  schema, and an estimate presented as a real number is worse than no
  number. What it *can* do, because the harness now does it too
  (`harness/lib/api-errors.mjs`), is tell a user a call actually failed on
  a bad or unfunded key: a real 401, or a 402/403/429 whose body says
  "insufficient credit." `api_issues` mirrors `attempts.json`'s field of
  the same name — actionable failures only, deduplicated by provider and
  kind.

## Migration 0004 — GitHub App identifiers

`console/DESIGN.md` §8.5 replaces a plain OAuth connection with a GitHub
App install — "which repos may this app touch" becomes a real, GitHub-
enforced grant instead of a broad account-wide token. That needs two stable
identifiers the OAuth-only design never did:

- **`profiles.github_id`** — GitHub's numeric user id
  (`raw_user_meta_data ->> 'provider_id'`), not the `github_login` string
  already stored. A username can be renamed; this can't. It's the join key
  a webhook payload's `installation.account.id` needs to find the right
  `profiles` row.
- **`installations.gh_installation_id`** — which App installation a repo
  was granted under, needed to mint a scoped installation access token and
  to resolve `installation_repositories` webhook events (a repo added to or
  removed from an existing installation). Indexed, not unique — one
  installation can cover several repos.

`handle_new_user()` (in the `private` schema — see migration 0002) now
populates `github_id` at signup, the same way it already populated
`github_login`. Verified live: both columns are `bigint`, the unique
constraint on `github_id` and the index on `gh_installation_id` both exist,
and the function is still where migration 0002 put it (`private`, not
`public` — `create or replace function` preserves an object's schema, it
doesn't move it back).

What this migration deliberately leaves alone: nothing here lets a webhook
*create* an `installations` row for a user it doesn't recognise. That row is
created by the console itself, right after a signed-in user returns from
GitHub's install flow — the webhook's job is narrower, keeping an
already-owned row's repo list current afterward.

## Migration 0005 — index the foreign keys the performance advisor flagged

`get_advisors(type: performance)` named three foreign keys with no covering
index: `config_writes.actor_id`, `escalations.decided_by`,
`escalations.first_seen_run`. All three are real join paths the console
will actually use (whose config write was this, who decided this
escalation, which run first raised it) — indexed now rather than waiting
for a slow query to notice, since adding an index later means a schema
change against live rows instead of an empty table.

Verified live: `get_advisors(type: performance)` no longer lists any of the
three; the three new indexes show up as `unused_index` instead, the same
expected state as every other index on a table with zero rows.

## Still to do by hand

Two separate GitHub connections, per `console/DESIGN.md` §8.1: **sign-in**
(who is this person) and the **GitHub App install** (which repos can the
console touch). Neither is in a migration — both need credentials only the
account owner can create.

**Sign-in:**

1. Create a GitHub OAuth app (**Settings → Developer settings → OAuth Apps**)
   with the callback URL
   `https://cegmdqtllgorsniyclas.supabase.co/auth/v1/callback`.
2. In the Supabase dashboard, **Authentication → Providers → GitHub**, paste
   the client ID and client secret and enable it.
3. Set the site URL and redirect allow-list to wherever the console is served
   from.

Until step 2, `auth.users` stays empty and the `handle_new_user` trigger never
fires — the schema is ready, sign-in is not.

**The GitHub App** (§8.5 — needed before Step 1's install picker or any
repository-scoped write can work):

1. Register a new GitHub App (**Settings → Developer settings → GitHub
   Apps → New GitHub App**) — a name, a homepage URL, and permissions
   `contents:write`, `secrets:write`, `actions:write`, `metadata:read`.
   Decide who it belongs to first (§9, open question 5) — a personal
   account or an organisation — since every install screen shows that owner
   as the App's publisher.
2. Generate a private key and store it only in server-side secret storage
   (a Supabase Edge Function's environment, once §8.5's token-minting
   endpoint exists) — never in this repository, never anywhere the browser
   can reach.
3. Set a webhook URL and secret, pointed at the receiver from §8.5, for the
   `installation` and `installation_repositories` events.
4. Record the App's client ID (and, once minted, its installation-token
   endpoint) wherever the console's server-side code reads its own
   configuration from.

Until this exists, "Connect your repository" in the console has nothing to
install — the schema is ready for it (`installations.gh_installation_id`),
the mechanism is designed (§8.5), but the App itself doesn't exist yet.

## Applying migrations

Migrations here are the source of truth for the schema and are already applied
to the project above. To apply them elsewhere:

```bash
cd console
supabase link --project-ref <ref>
supabase db push
```
