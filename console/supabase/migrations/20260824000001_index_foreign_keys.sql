-- The performance advisor's unindexed-foreign-key findings, closed: three
-- foreign keys had no covering index. Cheap, standard Postgres hygiene —
-- harmless on today's empty tables, and each becomes load-bearing the
-- moment the console has real rows to join through them (a profile's
-- decision history via escalations.decided_by, an escalation's originating
-- run via escalations.first_seen_run, who wrote a config_writes row via
-- actor_id). Named to match the existing convention
-- (<table>_<purpose>_idx), same as installations_owner_idx,
-- escalations_open_idx, runs_installation_idx.

create index config_writes_actor_idx on public.config_writes (actor_id);
create index escalations_decided_by_idx on public.escalations (decided_by);
create index escalations_first_seen_run_idx on public.escalations (first_seen_run);
