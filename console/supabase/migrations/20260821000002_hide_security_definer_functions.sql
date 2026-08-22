-- Both SECURITY DEFINER helpers from 0001 were reachable as PostgREST RPC
-- endpoints (/rest/v1/rpc/...), which Supabase's own security advisor flags.
-- Move them into a schema PostgREST does not expose, and grant EXECUTE only
-- to the role that actually needs to run each one.
--
-- Worth keeping the sequence rather than folding this into 0001: the advisor
-- catching this is the reason the schema is correct, and a migration history
-- that hides the correction hides the check that produced it.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated, service_role, supabase_auth_admin;

-- Triggers and RLS policies bind to the function OID, not its name, so moving
-- the schema leaves both intact.
alter function public.handle_new_user() set schema private;
alter function public.owns_installation(uuid) set schema private;

-- handle_new_user fires from the auth.users insert trigger only. Nobody else
-- should be able to call it.
revoke all on function private.handle_new_user() from public, anon, authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin, postgres;

-- owns_installation is evaluated inside RLS policies as the querying role, so
-- authenticated genuinely needs EXECUTE. anon never does.
revoke all on function private.owns_installation(uuid) from public, anon;
grant execute on function private.owns_installation(uuid) to authenticated;

comment on schema private is
  'Helpers that must not be reachable through the REST API. Nothing here is part of the product surface.';
