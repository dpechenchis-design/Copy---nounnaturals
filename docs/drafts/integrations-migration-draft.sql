-- =====================================================================
-- DRAFT. NOT A MIGRATION YET. NOT RUN. Do not move this file into
-- supabase/migrations until the owner approves it (supabase/README.md:
-- that folder is live, every file in it runs on the real project).
-- When approved it becomes supabase/migrations/<YYYYMMDDHHMMSS>_integration_checks.sql,
-- with behavior tests added to supabase/tests in the same commit.
--
-- Noun ART: the history of the Integrations page's health checks, drafted
-- Nov 15 2026. Today the page shows each integration's latest check from
-- Next's cache and saves nothing. The shape of one check is fixed in
-- src/lib/integrations/core.ts (toCheckRecord), so the history starts clean
-- the day this table exists: one row per check, append only, never deleted.
--
-- House rules kept: row level security, explicit grants, no hard delete (the
-- table is append only: no update or delete grant), the status is a fixed
-- list, the key of an integration is plain text (never one vendor), and no
-- secret is ever stored: the message is plain words written by the app and
-- never contains a key, a header, an address or an answer body.
--
-- Who writes: the server (service role) after a Refresh, a Resync, a Check
-- all, or the hourly timer. Who reads: people with settings.view.
-- =====================================================================

create table public.integration_checks (
  id uuid primary key default gen_random_uuid(),
  -- the registry key in src/lib/integrations/registry.ts, for example 'refunnel'
  integration_key text not null check (length(integration_key) between 1 and 60),
  status text not null check (status in ('connected', 'attention', 'key_missing', 'key_set', 'not_set_up', 'coming_later')),
  checked_at timestamptz not null default now(),
  duration_ms integer not null check (duration_ms >= 0),
  -- how many things came in (posts in the feed), when it has a count
  count integer check (count >= 0),
  -- when data was last pulled from the service, when it pulls any
  last_sync_at timestamptz,
  -- plain words: what is wrong or a short note
  message text check (message is null or length(message) <= 500),
  -- who asked: null for the timer
  checked_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index integration_checks_key_time_idx on public.integration_checks (integration_key, checked_at desc);
comment on table public.integration_checks is 'One row per health check of an integration (Settings, Integrations). Append only. No secret is ever stored here.';

alter table public.integration_checks enable row level security;

create policy integration_checks_select on public.integration_checks
  for select to authenticated
  using ((select private.has_permission('settings.view')));

revoke all on public.integration_checks from anon, authenticated;
grant select on public.integration_checks to authenticated;
-- inserts come from the server with the service role, which bypasses row level security
