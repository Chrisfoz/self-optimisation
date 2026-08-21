-- Console: identity, installations, run history, escalations.
--
-- READ THIS BEFORE ADDING A COLUMN.
--
-- This database holds the minimum needed to show a person their own
-- installations and their history. Three things are deliberately absent, and
-- console/DESIGN.md §2.2 is the reason:
--
--   1. Provider API keys. They are encrypted in the user's browser and sent
--      straight to GitHub Actions Secrets. They must never reach this
--      database, in any column, in any form. The CHECK constraint on
--      installations.config_cache is a backstop for that promise, not a
--      substitute for not sending them.
--   2. Source code, diffs, or prompts. Those live in the user's repository
--      and in their own Actions logs.
--   3. The truth about a project's configuration. project-adapter.yml in the
--      user's repository is the source of truth; config_cache here is a
--      render cache with a blob sha so we can tell when it went stale.
--
-- Everything is row-level-secured to the owning user. There is no shared or
-- public read path anywhere in this schema.

-- ---------------------------------------------------------------- enums ----

create type public.install_status as enum (
  'draft',        -- being configured in the console, nothing written yet
  'pending_pr',   -- config pull request opened, not merged
  'active',       -- merged; the workflow is live in the repo
  'paused',       -- user switched the schedule off
  'removed'       -- user uninstalled; row kept for their own history
);

create type public.run_outcome as enum (
  'no_release',     -- checked, nothing new had shipped; costs nothing
  'shipped',        -- a change passed every gate and reached a pull request
  'no_change',      -- ran, proposed nothing worth doing
  'blocked_review', -- the independent reviewer refused it
  'blocked_guard',  -- the guard caught a diff touching protected paths
  'blocked_tests',  -- the project's own suite failed
  'failed'          -- the run itself broke (API error, timeout, bad config)
);

create type public.escalation_status as enum (
  'open',       -- awaiting a human decision
  'accepted',   -- the human agreed the rule was wrong and changed it
  'declined',   -- the human kept the rule
  'withdrawn'   -- no longer raised by current runs
);

-- ------------------------------------------------------------ functions ----

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Backstop for the promise in the header. Deliberately blunt: it rejects a
-- write rather than quietly scrubbing it, so a console bug that starts
-- sending secrets fails loudly on the first attempt instead of accumulating
-- them silently. A gate that cannot fail is not a gate.
create or replace function public.looks_like_secret(doc jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select doc::text ~* '(sk-[a-za-z0-9_-]{16,}|ghp_[a-za-z0-9]{20,}|"[a-z0-9_]*(api_?key|secret|password|access_?token)"[[:space:]]*:[[:space:]]*"[^"]{8,}")';
$$;

comment on function public.looks_like_secret(jsonb) is
  'True if a JSON document appears to carry a credential. Used as a CHECK backstop; see the migration header.';

-- ------------------------------------------------------------- profiles ----

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  github_login text,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.profiles is
  'One row per signed-in user. Email lives in auth.users and is deliberately not duplicated here.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Populate a profile the moment someone signs in with GitHub.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, github_login, display_name, avatar_url)
  values (
    new.id,
    new.raw_user_meta_data ->> 'user_name',
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -------------------------------------------------------- installations ----

create table public.installations (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references public.profiles(id) on delete cascade,

  github_repo_id   bigint not null unique,
  repo_owner       text   not null,
  repo_name        text   not null,
  default_branch   text   not null default 'main',

  status           public.install_status not null default 'draft',

  -- Render cache for project-adapter.yml. Not the truth — see the header.
  config_cache     jsonb  not null default '{}'::jsonb,
  config_blob_sha  text,
  config_synced_at timestamptz,

  -- Derived from the cache rather than stored alongside it, so the two can
  -- never disagree. Still indexable, still queryable, no drift possible.
  cadence_cron     text generated always as (config_cache -> 'cadence' ->> 'schedule_cron') stored,
  approval_class   text generated always as (config_cache ->> 'approval_class') stored,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint installations_repo_slug_ok
    check (repo_owner <> '' and repo_name <> ''),
  constraint installations_config_carries_no_secrets
    check (not public.looks_like_secret(config_cache))
);

comment on table public.installations is
  'One row per repository a user has configured. config_cache is a cache of the repo''s project-adapter.yml, never the source of truth.';

create index installations_owner_idx on public.installations (owner_id, updated_at desc);
create index installations_slug_idx  on public.installations (repo_owner, repo_name);

create trigger installations_set_updated_at
  before update on public.installations
  for each row execute function public.set_updated_at();

-- Owner check used by every child table's policies. SECURITY DEFINER so the
-- lookup doesn't re-enter installations' own RLS and recurse.
create or replace function public.owns_installation(iid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.installations i
    where i.id = iid and i.owner_id = (select auth.uid())
  );
$$;

-- ----------------------------------------------------------------- runs ----

create table public.runs (
  id                 uuid primary key default gen_random_uuid(),
  installation_id    uuid not null references public.installations(id) on delete cascade,

  generation         integer not null,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  outcome            public.run_outcome,

  trigger_model      text,     -- the newly released model that caused this run
  proposer_model     text,     -- whose proposal won the blind ranking
  proposals_count    integer not null default 0 check (proposals_count >= 0),
  refine_attempts    integer not null default 0 check (refine_attempts >= 0),

  pull_request_url   text,
  workflow_run_url   text,
  estimated_cost_usd numeric(10,4) check (estimated_cost_usd >= 0),

  -- The digest's own plain-language sentence. Prose, not a diff.
  summary            text,

  created_at         timestamptz not null default now(),

  constraint runs_generation_positive check (generation > 0),
  constraint runs_unique_generation unique (installation_id, generation),
  constraint runs_finished_has_outcome
    check (finished_at is null or outcome is not null)
);

comment on table public.runs is
  'One row per generation, including the ones that shipped nothing — a run that proposes nothing is a result, not an absence.';

create index runs_installation_idx on public.runs (installation_id, generation desc);

-- ---------------------------------------------------------- escalations ----

create table public.escalations (
  id              uuid primary key default gen_random_uuid(),
  installation_id uuid not null references public.installations(id) on delete cascade,

  rule_ref        text not null,   -- which constitution rule is disputed
  claim           text not null,   -- what the models say is wrong with it
  models          text[] not null default '{}',
  labs            text[] not null default '{}',
  first_seen_run  uuid references public.runs(id) on delete set null,

  status          public.escalation_status not null default 'open',
  decided_by      uuid references public.profiles(id) on delete set null,
  decided_at      timestamptz,
  decision_note   text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint escalations_decided_when_closed
    check (status = 'open' or decided_at is not null)
);

comment on table public.escalations is
  'The human decision surface. An agent may argue a protected rule is wrong; only a person here can change it.';

create index escalations_open_idx
  on public.escalations (installation_id, created_at desc)
  where status = 'open';

create trigger escalations_set_updated_at
  before update on public.escalations
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------- config writes ----

create table public.config_writes (
  id               uuid primary key default gen_random_uuid(),
  installation_id  uuid not null references public.installations(id) on delete cascade,
  actor_id         uuid references public.profiles(id) on delete set null,
  files            text[] not null default '{}',
  pull_request_url text,
  created_at       timestamptz not null default now()
);

comment on table public.config_writes is
  'Append-only record of what the console wrote to a repository and who asked for it.';

create index config_writes_installation_idx
  on public.config_writes (installation_id, created_at desc);

-- ------------------------------------------------------------------ RLS ----

alter table public.profiles      enable row level security;
alter table public.installations enable row level security;
alter table public.runs          enable row level security;
alter table public.escalations   enable row level security;
alter table public.config_writes enable row level security;

-- profiles: yours only, and you cannot create or delete one by hand — the
-- auth trigger owns creation, and cascade from auth.users owns deletion.
create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- installations
create policy installations_select_own on public.installations
  for select to authenticated using ((select auth.uid()) = owner_id);
create policy installations_insert_own on public.installations
  for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy installations_update_own on public.installations
  for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy installations_delete_own on public.installations
  for delete to authenticated using ((select auth.uid()) = owner_id);

-- runs: readable and writable by the owner of the installation. The real
-- writer is the workflow, via the service role, which bypasses RLS.
create policy runs_select_own on public.runs
  for select to authenticated using (public.owns_installation(installation_id));
create policy runs_insert_own on public.runs
  for insert to authenticated with check (public.owns_installation(installation_id));
create policy runs_update_own on public.runs
  for update to authenticated using (public.owns_installation(installation_id)) with check (public.owns_installation(installation_id));

-- escalations: the owner reads them and decides them.
create policy escalations_select_own on public.escalations
  for select to authenticated using (public.owns_installation(installation_id));
create policy escalations_insert_own on public.escalations
  for insert to authenticated with check (public.owns_installation(installation_id));
create policy escalations_update_own on public.escalations
  for update to authenticated using (public.owns_installation(installation_id)) with check (public.owns_installation(installation_id));

-- config_writes: append-only. No update or delete policy exists, so neither
-- is possible for any authenticated user — that is the point of an audit row.
create policy config_writes_select_own on public.config_writes
  for select to authenticated using (public.owns_installation(installation_id));
create policy config_writes_insert_own on public.config_writes
  for insert to authenticated with check (public.owns_installation(installation_id));
