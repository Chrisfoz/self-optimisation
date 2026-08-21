-- Two corrections, both from checking this schema against reality instead
-- of the other way around.
--
-- 1. run_outcome was invented speculatively (no_release, shipped, no_change,
--    blocked_review, blocked_guard, blocked_tests, failed) before anyone had
--    read what harness/lib/orchestrator.mjs actually writes to
--    attempts.json's top-level `outcome` field. It writes exactly four
--    values — 'no-proposal', 'approved', 'abandoned', 'crashed' — and
--    nothing else, ever; per-attempt detail (rejected-by-review,
--    edits-did-not-apply, ...) is a different, un-enumerated field. Rather
--    than maintain a second vocabulary that can drift from the real one,
--    this enum now mirrors it exactly (hyphens become underscores, since
--    Postgres enum labels don't take hyphens as cleanly). "A quiet month —
--    nothing new released" is deliberately NOT a value here: orchestrator.mjs
--    never runs at all in that case, so there is no attempts.json and
--    correctly no row. A console showing "18 quiet months" it invented
--    itself would be exactly the kind of row this project doesn't write.
--
-- 2. estimated_cost_usd assumed the console could tell a user what a run
--    would cost. It can't, honestly — API pricing per model changes
--    independently of this schema, and a guess presented as a number people
--    stop trusting is worse than no number (this was flagged as a known
--    problem in the design doc that shipped this column). The real, useful
--    signal is narrower and now actually exists: the harness's provider
--    layer (harness/lib/api-errors.mjs) classifies a call failure as
--    missing_key / invalid_key / billing when the API itself says so — a
--    real 401, a real "insufficient credit" 402/403/429 — and
--    writeAttemptRecord() carries that forward as `apiIssues`. api_issues
--    replaces the dollar guess with the thing a user actually needs to
--    know: which key needs attention, not what the run might have cost.

alter table public.runs alter column outcome type text using outcome::text;
drop type public.run_outcome;
create type public.run_outcome as enum ('no_proposal', 'approved', 'abandoned', 'crashed');
alter table public.runs alter column outcome type public.run_outcome using outcome::public.run_outcome;

alter table public.runs drop column estimated_cost_usd;

-- pull_request_url already existed (migration 0001 anticipated it); only
-- api_issues is new here.
alter table public.runs add column api_issues jsonb not null default '[]'::jsonb;

comment on column public.runs.pull_request_url is
  'Set by recordPullRequestUrl() once the workflow step downstream of the run has opened the PR — absent for a run that did not ship.';
comment on column public.runs.api_issues is
  'Mirrors attempts.json''s apiIssues: actionable provider failures only (missing_key / invalid_key / billing), deduplicated by provider+kind. See harness/lib/api-errors.mjs.';
