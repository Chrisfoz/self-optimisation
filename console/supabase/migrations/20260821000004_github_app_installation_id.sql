-- Schema support for §8.5's GitHub App: two stable identifiers this design
-- didn't need until the connection model moved from plain OAuth to an App
-- installation.
--
-- profiles.github_id — GitHub's own numeric user/org id, not the login
-- string already stored in github_login. A username can be renamed; this
-- can't. It's the join key a webhook payload's `installation.account.id`
-- needs to find the right `profiles` row — matching on github_login would
-- silently break the day a user renamed their GitHub account.
--
-- installations.gh_installation_id — the GitHub App installation this repo
-- was granted under. Required to mint a scoped installation token (§8.5),
-- and it's how an `installation_repositories` webhook event (add/remove a
-- repo from an existing installation) finds the row to update. Indexed,
-- not unique: several repos can share one installation id when a user
-- grants "all repositories" or selects more than one at install time.
--
-- What this migration deliberately does NOT add: a way for the webhook
-- receiver to CREATE an installations row for a user it doesn't recognise.
-- The row is created by the console itself, right after the signed-in user
-- returns from GitHub's install flow (we already know who they are; we call
-- GitHub's own "get installation" API to learn the id and initial repos).
-- The webhook's job is narrower and still real: keep an already-owned row's
-- repo list correct after that, without requiring the user to reopen the
-- console. See console/DESIGN.md §8.5.

alter table public.profiles add column github_id bigint unique;
comment on column public.profiles.github_id is
  'GitHub''s numeric user id (Supabase''s raw_user_meta_data ->> ''provider_id''), stable across username renames. The join key for reconciling GitHub App webhook events to a profiles row.';

alter table public.installations add column gh_installation_id bigint;
create index installations_gh_installation_idx on public.installations (gh_installation_id);
comment on column public.installations.gh_installation_id is
  'The GitHub App installation this repo was granted under. Needed to mint a short-lived installation access token (§8.5) and to resolve installation_repositories webhook events. Not unique: one installation can cover several repos.';

-- handle_new_user() (private schema, see migration 0002) now also captures
-- the stable id at signup time, the same way it already captures the login.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, github_id, github_login, display_name, avatar_url)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'provider_id', '')::bigint,
    new.raw_user_meta_data ->> 'user_name',
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
