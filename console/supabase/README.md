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

## Still to do by hand

Enabling GitHub sign-in needs credentials only the project owner can create,
so it isn't in a migration:

1. Create a GitHub OAuth app (**Settings → Developer settings → OAuth Apps**)
   with the callback URL
   `https://cegmdqtllgorsniyclas.supabase.co/auth/v1/callback`.
2. In the Supabase dashboard, **Authentication → Providers → GitHub**, paste
   the client ID and client secret and enable it.
3. Set the site URL and redirect allow-list to wherever the console is served
   from.

Until step 2, `auth.users` stays empty and the `handle_new_user` trigger never
fires — the schema is ready, sign-in is not.

## Applying migrations

Migrations here are the source of truth for the schema and are already applied
to the project above. To apply them elsewhere:

```bash
cd console
supabase link --project-ref <ref>
supabase db push
```
