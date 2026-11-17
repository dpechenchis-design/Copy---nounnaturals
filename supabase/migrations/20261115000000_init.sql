-- =====================================================================
-- Noun ART: first database migration (Supabase / Postgres 15+)
-- Written Nov 14 2026. Tested start to finish on PGlite (supabase/tests,
-- npm run test:db). Not yet run on the live Supabase project.
--
-- Shape of the data (the family tree):
--   space > week > card > raw clips > versions > variants > posts > numbers
-- plus assets (carousels, photos), directions on raw clips, review notes,
-- approvals, the content bank, the AI studio, agent runs, notifications
-- and the audit trail.
--
-- House rules baked in here:
--   * Never hard delete. Every table has deleted_at (or is append only),
--     app roles get no DELETE grant, and triggers block DELETE and TRUNCATE.
--   * Fixed label lists are lookup tables the owner can extend. Postgres
--     enums are used only for true state machines (role, access, card
--     stage, review state, post status, job status). Card statuses are a
--     table (custom statuses allowed), each one sitting in a fixed stage.
--   * Spaces (Noun Naturals content, Founder content): every card, week,
--     raw clip, upload batch and to do item belongs to one. Owners and
--     admins see every space; everyone else only the spaces they were given.
--   * Privileges are granted table by table in section 17. Nothing relies
--     on the Supabase setting "Automatically expose new tables".
--   * AI provider and model are plain text plus the ai_providers and
--     ai_models tables. Never an enum, never one vendor.
--   * Raw footage lives in Google Drive (we store the Drive file id).
--     Edits, variants and carousels live in Cloudflare R2 (bucket + key).
--   * OAuth tokens live only in account_tokens: RLS on, no policies, no
--     grants for anon or authenticated. Only the service role can read it.
--   * Row level security on every table. Helper functions live in the
--     private schema, which the API does not expose.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Extensions and schemas
-- ---------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. State machines (the only enums)
-- ---------------------------------------------------------------------
create type public.app_role as enum ('owner', 'admin', 'strategist', 'editor', 'viewer');
create type public.access_status as enum ('pending', 'active', 'removed');
-- The six stages every card status sits in, in order. Statuses themselves are
-- the card_statuses table, so the owner can add his own.
create type public.card_stage as enum ('planning', 'shooting', 'editing', 'review', 'ready', 'posted');
create type public.review_state as enum ('checking', 'in_review', 'needs_edits', 'approved', 'rejected', 'superseded');
create type public.review_decision as enum ('approved', 'rejected');
create type public.post_status as enum ('draft', 'scheduled', 'posting', 'finish_in_tiktok', 'posted', 'failed', 'cancelled');
create type public.job_status as enum ('queued', 'running', 'waiting_approval', 'done', 'failed', 'cancelled');

-- ---------------------------------------------------------------------
-- 2. Generic trigger functions (no table dependencies)
-- ---------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.block_delete()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'Noun ART never hard deletes. Set deleted_at on %.% instead.', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end;
$$;

-- Reads one HTTP request header that PostgREST passes in (for example x-app-page).
create or replace function private.request_header(p_name text)
returns text language plpgsql stable set search_path = '' as $$
begin
  return nullif(current_setting('request.headers', true), '')::jsonb ->> lower(p_name);
exception when others then
  return null;
end;
$$;

-- The agent run id our server sends (x-agent-run-id), trusted only from the service role.
create or replace function private.header_run_id()
returns uuid language plpgsql stable set search_path = '' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> 'service_role' then
    return null;
  end if;
  return nullif(private.request_header('x-agent-run-id'), '')::uuid;
exception when others then
  return null;
end;
$$;

-- The role inside the caller's JWT (anon, authenticated, service_role), or null.
create or replace function private.jwt_role()
returns text language plpgsql stable set search_path = '' as $$
begin
  return nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. People: profiles and invites
-- ---------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id),
  email text not null,
  full_name text,
  avatar_url text,
  role public.app_role not null default 'viewer',
  access_status public.access_status not null default 'pending',
  -- "Needs admin approval before posting" (owner, Nov 14 2026). Ticked for
  -- everyone by default. Only the owner or an admin changes it, never for
  -- themselves. Owners and admins never need it.
  needs_post_approval boolean not null default true,
  invited_by uuid references public.profiles (id),
  language text not null default 'en' check (language in ('en', 'uk')),
  telegram_chat_id bigint,
  telegram_username text,
  google_chat_user_id text,
  notify_prefs jsonb not null default '{}'::jsonb,
  ui_prefs jsonb not null default '{}'::jsonb,
  last_active_at timestamptz,
  last_page text,
  removed_at timestamptz,
  removed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index profiles_email_key on public.profiles (lower(email));
create unique index profiles_telegram_chat_key on public.profiles (telegram_chat_id) where telegram_chat_id is not null;
comment on table public.profiles is 'One row per person who signed in with Google: name, photo, role, access, Telegram chat id.';

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role public.app_role not null,
  note text,
  invited_by uuid references public.profiles (id) default auth.uid(),
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id),
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index invites_open_email_key on public.invites (lower(email))
  where accepted_at is null and revoked_at is null and deleted_at is null;
comment on table public.invites is 'People the owner or an admin invited by email, with the role they get on first sign in.';

-- ---------------------------------------------------------------------
-- 3b. Spaces (the Notion word: Noun Naturals content, Founder content)
--     and who may open each. Owners and admins open every space without a
--     row here; everyone else needs one row per space.
-- ---------------------------------------------------------------------
create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  slug text not null check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  short_name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index spaces_slug_key on public.spaces (slug);
comment on table public.spaces is 'A space of content with its own weeks, table and views (Noun Naturals content, Founder content).';

create table public.person_spaces (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  space_id uuid not null references public.spaces (id),
  granted_by uuid references public.profiles (id) default auth.uid(),
  granted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index person_spaces_key on public.person_spaces (profile_id, space_id) where deleted_at is null;
create index person_spaces_space_idx on public.person_spaces (space_id);
comment on table public.person_spaces is 'Which spaces a person may open (owners and admins open all without a row).';

-- ---------------------------------------------------------------------
-- 4. Role helpers (security definer, fixed search_path)
-- ---------------------------------------------------------------------
-- The caller's role, or null when they are not signed in, not active, or removed.
create or replace function private.current_app_role()
returns public.app_role language sql stable security definer set search_path = '' as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
    and p.access_status = 'active'
    and p.deleted_at is null;
$$;

create or replace function private.has_role(variadic p_roles public.app_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.current_app_role() = any (p_roles), false);
$$;

-- Any active person, whatever the role.
create or replace function private.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_app_role() is not null;
$$;

create or replace function private.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role('owner');
$$;

-- Owner or admin.
create or replace function private.is_manager()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role('owner', 'admin');
$$;

-- Plans and edits cards, matches raw clips: owner, admin, strategist.
create or replace function private.is_planner()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role('owner', 'admin', 'strategist');
$$;

-- Sees every card (read): everyone active except editors.
create or replace function private.sees_all_cards()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role('owner', 'admin', 'strategist', 'viewer');
$$;

-- True when the request comes from our server with the service key.
create or replace function private.is_service()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(private.jwt_role() = 'service_role', false);
$$;

-- May the caller open this space? Owners and admins: every space. Everyone
-- else active: only a live space they were given in person_spaces.
create or replace function private.can_see_space(p_space uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_space is null then false
    when private.is_manager() then true
    when not private.is_active_user() then false
    else exists (
      select 1
      from public.person_spaces ps
      join public.spaces s on s.id = ps.space_id
      where ps.space_id = p_space and ps.profile_id = auth.uid()
        and ps.deleted_at is null and s.deleted_at is null)
  end;
$$;

-- ---------------------------------------------------------------------
-- 5. Fixed label lists (lookup tables the owner can extend)
--    Shape: key (lowercase, no spaces), label (what people see),
--    description, sort_order, created/updated/deleted.
-- ---------------------------------------------------------------------
create table public.platforms (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  is_live boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.platforms is 'Fixed list: social platforms we post to (TikTok, Instagram, Facebook, YouTube).';

create table public.content_types (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.content_types is 'Fixed list: how a card is shot (talking head, TikTok comment, expert video, BTS...).';

create table public.content_formats (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.content_formats is 'Fixed list: what a card is for (education, connection, objection handling, proof). A card can have several.';

create table public.products (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  sku text,
  theme jsonb not null default '{}'::jsonb,
  erp_product_ref text,
  shopify_product_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.products is 'Fixed list: Noun products, each with its own color theme for the brand kit. Not seeded: the owner adds them.';

create table public.series (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.series is 'Fixed list: recurring series. Not seeded: the owner adds them.';

create table public.hook_styles (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.hook_styles is 'Fixed list: hook style. Not seeded: the owner adds them.';

create table public.note_tags (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  for_comments boolean not null default true,
  for_rules boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.note_tags is 'Fixed list: tags on review notes and checker rules (hook, captions, audio, pacing, product, claims...).';

create table public.direction_tags (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.direction_tags is 'Fixed list: tags on directions on raw clips (use this, cut this, hook, b roll, sound, text on screen).';

create table public.variant_kinds (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.variant_kinds is 'Fixed list: what a variant changed (new hook, new person, dub, reframe, music...).';

create table public.asset_kinds (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.asset_kinds is 'Fixed list: kinds of still assets (carousel, photo, slide set).';

create table public.post_kinds (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.post_kinds is 'Fixed list: how a post goes out (video, reel, trial reel, carousel, photo post).';

create table public.sound_sources (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.sound_sources is 'Fixed list: where a sound comes from (TikTok library, Instagram audio, Higgsfield music, licensed upload).';

create table public.template_kinds (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.template_kinds is 'Fixed list: template kinds (carousel layout, caption, hook, Canva template, edit recipe).';

create table public.brand_asset_kinds (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.brand_asset_kinds is 'Fixed list: brand kit file kinds (logo, product photo, label shot, font, layout).';

create table public.metric_checkpoints (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  hours_after_post int not null check (hours_after_post > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.metric_checkpoints is 'Fixed list: when post numbers are pulled (1 hour, 1 day, 3 days, 7 days, 30 days).';

-- ---------------------------------------------------------------------
-- 6. AI vendors, models and agents (vendors are data, never enums)
-- ---------------------------------------------------------------------
create table public.ai_providers (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  logo_key text,
  sort_order int not null default 0,
  is_connected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.ai_providers is 'AI vendors we can call (Higgsfield, Google, Anthropic, OpenAI, ByteDance, ElevenLabs, Canva...).';

create table public.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references public.ai_providers (key),
  model_key text not null,
  label text not null,
  description text,
  best_at text,
  jobs text[] not null default '{}',
  via_provider_key text references public.ai_providers (key),
  pricing jsonb not null default '{}'::jsonb,
  est_cost_usd numeric(12, 4),
  from_live_list boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz,
  unique (provider_key, model_key)
);
comment on table public.ai_models is 'Every AI model we can pick, with what it is good at and its price; filled live from Higgsfield.';

create table public.agents (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  kind text not null check (kind in ('agent', 'workflow', 'single_call')),
  default_provider_key text references public.ai_providers (key),
  default_model_key text,
  is_enabled boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.agents is 'The AI agents and workflows (head of content, carousel agent, first check, clip matcher...).';

create table public.agent_prompt_versions (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null references public.agents (key),
  version int not null,
  system_prompt text not null,
  settings jsonb not null default '{}'::jsonb,
  provider_key text,
  model_key text,
  change_note text,
  eval_result jsonb,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz,
  unique (agent_key, version)
);
create unique index agent_prompt_versions_current_key on public.agent_prompt_versions (agent_key)
  where is_current and deleted_at is null;
comment on table public.agent_prompt_versions is 'Each version of an agent''s prompt and settings, so every run says which one it used.';

create table public.agent_threads (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null references public.agents (key),
  title text,
  owner_id uuid references public.profiles (id) default auth.uid(),
  card_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.agent_threads is 'A chat with an agent (Ask the head of content, a carousel chat).';

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_key text not null references public.agents (key),
  prompt_version_id uuid references public.agent_prompt_versions (id),
  thread_id uuid references public.agent_threads (id),
  parent_run_id uuid references public.agent_runs (id),
  trigger text not null check (trigger in ('person', 'schedule', 'event', 'agent')),
  started_by uuid references public.profiles (id),
  status public.job_status not null default 'queued',
  inputs jsonb not null default '{}'::jsonb,
  plan jsonb,
  plan_cost_est_usd numeric(12, 4),
  decision text check (decision in ('approved', 'changed', 'rejected')),
  decision_note text,
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  total_cost_usd numeric(12, 4) not null default 0,
  result_summary text,
  outcome jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index agent_runs_agent_idx on public.agent_runs (agent_key, created_at desc);
create index agent_runs_status_idx on public.agent_runs (status) where deleted_at is null;
create index agent_runs_started_by_idx on public.agent_runs (started_by);
create index agent_runs_thread_idx on public.agent_runs (thread_id);
comment on table public.agent_runs is 'Every agent run: who or what started it, inputs, plan, cost, the person''s decision and the outcome.';

create table public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs (id),
  seq int not null,
  tool_name text not null,
  provider_key text,
  model_key text,
  status public.job_status not null default 'running',
  input_summary text,
  input jsonb,
  output_summary text,
  output_ref jsonb,
  cost_usd numeric(12, 4) not null default 0,
  tokens_in int,
  tokens_out int,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (run_id, seq)
);
create index agent_tool_calls_tool_idx on public.agent_tool_calls (tool_name, created_at desc);
comment on table public.agent_tool_calls is 'Each tool call inside an agent run: tool, model, input, output, cost, time, error.';

create table public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.agent_threads (id),
  run_id uuid references public.agent_runs (id),
  sender text not null check (sender in ('person', 'agent')),
  author_id uuid references public.profiles (id) default auth.uid(),
  body text not null,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index agent_messages_thread_idx on public.agent_messages (thread_id, created_at);
comment on table public.agent_messages is 'Messages in an agent chat, from a person or the agent.';

create table public.agent_run_outputs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs (id),
  entity_table text not null,
  entity_id uuid not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index agent_run_outputs_run_idx on public.agent_run_outputs (run_id);
create index agent_run_outputs_entity_idx on public.agent_run_outputs (entity_table, entity_id);
comment on table public.agent_run_outputs is 'What an agent run created (cards, variants, carousels, rules...), by table and id.';

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('total', 'agent', 'person', 'studio')),
  agent_key text references public.agents (key),
  profile_id uuid references public.profiles (id),
  month date not null check (extract(day from month) = 1),
  amount_usd numeric(12, 2) not null check (amount_usd >= 0),
  per_run_cap_usd numeric(12, 2),
  note text,
  set_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index budgets_month_idx on public.budgets (month);
comment on table public.budgets is 'Monthly AI money budgets the owner sets (total, per agent, per person, studio).';

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.app_settings is 'App wide settings: which model does which job, the team Telegram group, thresholds. No secrets here.';

-- ---------------------------------------------------------------------
-- 7. Social accounts and their tokens
-- ---------------------------------------------------------------------
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  platform_key text not null references public.platforms (key),
  username text not null,
  display_name text,
  external_id text,
  avatar_url text,
  followers_count int,
  health text not null default 'off' check (health in ('ok', 'warn', 'error', 'off')),
  health_note text,
  daily_cap int not null default 0 check (daily_cap >= 0),
  auto_post boolean not null default false,
  posts_private_until_review boolean not null default false,
  timezone text not null default 'America/New_York',
  connected_by uuid references public.profiles (id),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index social_accounts_platform_user_key on public.social_accounts (platform_key, lower(username)) where deleted_at is null;
comment on table public.social_accounts is 'Each TikTok, Instagram, Facebook or YouTube account we post to, shown by its username. No tokens here.';

-- SERVICE ROLE ONLY. RLS is on and there are deliberately NO policies, and all
-- grants for anon and authenticated are revoked (section 17). The browser can
-- never read this table. Only our server, with the service key, reads it.
create table public.account_tokens (
  account_id uuid primary key references public.social_accounts (id),
  access_token text,
  refresh_token text,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  refresh_expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.account_tokens is 'SERVICE ROLE ONLY: OAuth tokens per social account. RLS on, no policies, no browser grants.';

create table public.posting_slots (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.social_accounts (id),
  weekday smallint not null check (weekday between 0 and 6),
  local_time time not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index posting_slots_key on public.posting_slots (account_id, weekday, local_time) where deleted_at is null;
comment on table public.posting_slots is 'Daily time slots per account that the scheduler fills from the bank (weekday 0 is Sunday).';

-- Posting permissions (owner, Nov 14 2026): one row per person per channel
-- (connected account). No live row means that person may not schedule or post
-- on that account. Owners and admins always have every channel without a row.
-- Only the owner or an admin changes this list, and never their own rows.
create table public.person_posting_accounts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  account_id uuid not null references public.social_accounts (id),
  granted_by uuid references public.profiles (id) default auth.uid(),
  granted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index person_posting_accounts_key on public.person_posting_accounts (profile_id, account_id) where deleted_at is null;
create index person_posting_accounts_account_idx on public.person_posting_accounts (account_id);
comment on table public.person_posting_accounts is 'Posting permissions: which channels (accounts) a person may schedule and post on.';

-- ---------------------------------------------------------------------
-- 8. Brand kit
-- ---------------------------------------------------------------------
create table public.faces (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles (id),
  name text not null,
  consent_signed_at timestamptz,
  consent_drive_file_id text,
  consent_scope text,
  consent_revoked_at timestamptz,
  higgsfield_soul_id text,
  voice_clone_ref text,
  photo_r2_bucket text,
  photo_r2_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.faces is 'People whose likeness the AI may use (avatars, cloned voice), with their written consent.';

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  product_key text references public.products (key),
  claim text not null,
  source text not null,
  source_url text,
  source_drive_file_id text,
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create index claims_product_idx on public.claims (product_key);
comment on table public.claims is 'The approved claims library: what we may say, for which product, and its source.';

create table public.brand_assets (
  id uuid primary key default gen_random_uuid(),
  kind_key text not null references public.brand_asset_kinds (key),
  product_key text references public.products (key),
  name text not null,
  r2_bucket text,
  r2_key text,
  drive_file_id text,
  mime_type text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz,
  check (r2_key is not null or drive_file_id is not null)
);
create index brand_assets_product_idx on public.brand_assets (product_key, kind_key);
comment on table public.brand_assets is 'Brand kit files: logos, product photos, label shots, fonts, layouts.';

create table public.brand_rules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('voice', 'do_not')),
  product_key text references public.products (key),
  rule text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.brand_rules is 'Brand voice rules and the do not list, overall or per product.';

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  kind_key text not null references public.template_kinds (key),
  name text not null,
  body text,
  steps jsonb not null default '[]'::jsonb,
  tag_key text references public.note_tags (key),
  canva_template_id text,
  product_key text references public.products (key),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.templates is 'Carousel layouts, caption and hook templates, Canva brand templates, edit recipes.';

-- ---------------------------------------------------------------------
-- 9. Calendar: statuses, weeks, imports, cards, to do lists
-- ---------------------------------------------------------------------

-- Card statuses. The 13 system statuses are seeded (section 20) and cannot be
-- removed or have their key or stage changed; the owner and admins may add
-- custom ones and relabel or recolor any. Every status sits in a stage, so
-- the automation and the reports work for custom statuses too. Order on the
-- status line: stage first, then sort_order.
create table public.card_statuses (
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  stage public.card_stage not null,
  -- A design token name (for example st-review) or a choice from the pill color picker.
  color text not null,
  -- Solid pill: the statuses that need someone now.
  solid boolean not null default false,
  sort_order int not null default 0,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index card_statuses_key on public.card_statuses (key);
create index card_statuses_order_idx on public.card_statuses (stage, sort_order);
comment on table public.card_statuses is 'Card statuses, each in a stage. 13 system statuses plus any custom ones the owner adds.';

-- Weeks of one space ("Week 3"). The week a card belongs to is chosen, never
-- worked out from its day: a card may have no day yet.
create table public.weeks (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  slug text not null check (slug ~ '^[a-z0-9-]+$'),
  name text not null,
  number int,
  starts_on date not null check (extract(isodow from starts_on) = 1),
  is_draft boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index weeks_space_slug_key on public.weeks (space_id, slug) where deleted_at is null;
create index weeks_space_start_idx on public.weeks (space_id, starts_on);
comment on table public.weeks is 'A week of one space (Week 3, starting on a Monday), draft or not.';

-- One press of Import on a week table (CSV, Excel, a pasted table, or the one
-- time Notion import): how each column and value was matched, what was fixed,
-- and what matched nothing. Shaped after ImportRecord in src/lib/import/pipeline.ts.
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  week_id uuid not null references public.weeks (id),
  imported_by uuid references public.profiles (id) default auth.uid(),
  source_kind text not null check (source_kind in ('csv', 'xlsx', 'paste', 'notion')),
  file_name text,
  header_row int,
  rows_in int check (rows_in >= 0),
  row_count int not null default 0 check (row_count >= 0),
  blank_rows int check (blank_rows >= 0),
  column_matches jsonb not null default '[]'::jsonb check (jsonb_typeof(column_matches) = 'array'),
  value_fixes jsonb not null default '[]'::jsonb check (jsonb_typeof(value_fixes) = 'array'),
  unmatched jsonb not null default '{}'::jsonb,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index import_batches_week_idx on public.import_batches (week_id, imported_at desc);
comment on table public.import_batches is 'Each import into a week table: source, column matches, value fixes, what matched nothing.';

create table public.cards (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  week_id uuid not null references public.weeks (id),
  title text not null,
  -- Filled with the "idea" status when left empty (trigger).
  status_id uuid not null references public.card_statuses (id),
  -- The day, inside the card's week. Null for a row with no day yet.
  planned_on date,
  planned_time time,
  type_key text references public.content_types (key),
  product_key text references public.products (key),
  series_key text references public.series (key),
  hook_style_key text references public.hook_styles (key),
  hook text,
  script text,
  brief text,
  shot_list jsonb not null default '[]'::jsonb,
  reference_url text,
  reference_notes text,
  source_url text,
  instructions_url text,
  -- Founder content columns.
  how_to_film text,
  shoot_batch text,
  what_you_need text,
  -- The row's own page by heading: [{"heading": "...", "text": "..."}].
  script_sections jsonb not null default '[]'::jsonb check (jsonb_typeof(script_sections) = 'array'),
  -- Import columns that matched none of ours, kept by their own name.
  extra jsonb not null default '{}'::jsonb check (jsonb_typeof(extra) = 'object'),
  strategist_id uuid references public.profiles (id),
  assigned_editor_id uuid references public.profiles (id),
  due_at timestamptz,
  -- Manual row order in the week table.
  sort_order int not null default 0,
  -- The Shot checkbox: who ticked it and when. Never changes the status.
  -- Ticked through public.set_card_shot (anyone who can see the card).
  shot_at timestamptz,
  shot_by uuid references public.profiles (id),
  source text not null default 'app'
    check (source in ('app', 'notion_import', 'csv_import', 'xlsx_import', 'paste_import', 'agent')),
  import_batch_id uuid references public.import_batches (id),
  import_row int check (import_row >= 0),
  notion_page_id text,
  drive_folder_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  created_by_run_id uuid references public.agent_runs (id),
  deleted_at timestamptz,
  check ((shot_at is null) = (shot_by is null))
);
create index cards_planned_on_idx on public.cards (planned_on) where deleted_at is null;
create index cards_week_idx on public.cards (week_id, sort_order) where deleted_at is null;
create index cards_space_idx on public.cards (space_id) where deleted_at is null;
create index cards_status_idx on public.cards (status_id) where deleted_at is null;
create index cards_editor_idx on public.cards (assigned_editor_id) where deleted_at is null;
create index cards_product_idx on public.cards (product_key);
create index cards_title_trgm_idx on public.cards using gin (title extensions.gin_trgm_ops);
create unique index cards_notion_key on public.cards (notion_page_id) where notion_page_id is not null;
create index cards_import_idx on public.cards (import_batch_id) where import_batch_id is not null;
comment on table public.cards is 'One row of a week table: space, week, day, type, product, hook, script, links, editor, status, Shot.';

alter table public.agent_threads add constraint agent_threads_card_fk foreign key (card_id) references public.cards (id);

create table public.card_accounts (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  account_id uuid not null references public.social_accounts (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index card_accounts_key on public.card_accounts (card_id, account_id) where deleted_at is null;
create index card_accounts_account_idx on public.card_accounts (account_id);
comment on table public.card_accounts is 'Which accounts a card is planned for.';

-- A card can have several formats; the lowest sort_order is the first one.
-- (This replaces the single format column of the first draft.)
create table public.card_formats (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  format_key text not null references public.content_formats (key),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index card_formats_key on public.card_formats (card_id, format_key) where deleted_at is null;
create index card_formats_format_idx on public.card_formats (format_key);
comment on table public.card_formats is 'Every format of a card (a card can have several; the first is the lowest sort order).';

-- The platforms a card is planned for (the week tables plan by platform;
-- card_accounts says which exact accounts once known).
create table public.card_platforms (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  platform_key text not null references public.platforms (key),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index card_platforms_key on public.card_platforms (card_id, platform_key) where deleted_at is null;
comment on table public.card_platforms is 'Which platforms a card is planned for.';

create table public.card_status_changes (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  from_status_id uuid references public.card_statuses (id),
  to_status_id uuid not null references public.card_statuses (id),
  changed_by uuid references public.profiles (id),
  changed_by_run_id uuid references public.agent_runs (id),
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index card_status_changes_card_idx on public.card_status_changes (card_id, changed_at);
comment on table public.card_status_changes is 'Every status change of every card, with who and when (how fast work moves).';

-- Google Drive folders the app creates, tracked by Drive id (renames never break us).
create table public.drive_folders (
  id uuid primary key default gen_random_uuid(),
  drive_folder_id text not null unique,
  purpose text not null check (purpose in ('root', 'space', 'week', 'day', 'day_raw', 'card', 'card_raw', 'card_edits', 'card_final')),
  space_id uuid references public.spaces (id),
  week_id uuid references public.weeks (id),
  day date,
  card_id uuid references public.cards (id),
  name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create index drive_folders_day_idx on public.drive_folders (day, purpose);
create index drive_folders_card_idx on public.drive_folders (card_id);
create index drive_folders_space_idx on public.drive_folders (space_id, purpose);
comment on table public.drive_folders is 'Google Drive folders the app made (space, week, day, card), tracked by Drive id.';

-- The to do list of each space (the content team's Notion to do lists).
create table public.space_todos (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  task text not null,
  status text,
  due_on date,
  done_at timestamptz,
  done_by uuid references public.profiles (id),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create index space_todos_space_idx on public.space_todos (space_id, sort_order) where deleted_at is null;
comment on table public.space_todos is 'The to do list of a space: task, status, due date, who ticked it done and when.';

-- ---------------------------------------------------------------------
-- 10. Raw clips (Google Drive), upload batches, directions, matching to cards
-- ---------------------------------------------------------------------

-- One upload: the clips that went up together into a day's inbox of one
-- space. A day can hold many batches (phone at once, camera cards later).
create table public.upload_batches (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  day date not null,
  uploaded_by uuid references public.profiles (id) default auth.uid(),
  upload_source text not null default 'desktop' check (upload_source in ('desktop', 'phone', 'import', 'studio')),
  -- What the person picked or the browser said: iPhone, Camera card, Computer...
  device text,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index upload_batches_day_idx on public.upload_batches (space_id, day) where deleted_at is null;
comment on table public.upload_batches is 'One upload of raw clips into a day inbox of a space: who, from which device, when.';

create table public.raw_clips (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  upload_batch_id uuid references public.upload_batches (id),
  drive_file_id text not null unique,
  drive_folder_id text,
  file_name text not null,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  md5_checksum text,
  duration_ms int check (duration_ms >= 0),
  width int,
  height int,
  shot_on date not null,
  recorded_at timestamptz,
  uploaded_by uuid references public.profiles (id) default auth.uid(),
  upload_source text not null default 'desktop' check (upload_source in ('desktop', 'phone', 'import', 'studio')),
  index_status public.job_status not null default 'queued',
  index_run_id uuid references public.agent_runs (id),
  transcript text,
  transcript_language text,
  transcript_words jsonb,
  ai_index jsonb not null default '{}'::jsonb,
  transcript_tsv tsvector generated always as (to_tsvector('simple'::regconfig, coalesce(transcript, ''))) stored,
  thumbnail_r2_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index raw_clips_shot_on_idx on public.raw_clips (space_id, shot_on) where deleted_at is null;
create index raw_clips_batch_idx on public.raw_clips (upload_batch_id);
create index raw_clips_uploaded_by_idx on public.raw_clips (uploaded_by);
create index raw_clips_tsv_idx on public.raw_clips using gin (transcript_tsv);
comment on table public.raw_clips is 'Each raw clip in Google Drive (by Drive file id), its day inbox, and what Gemini found in it.';

create table public.card_raw_clips (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  raw_clip_id uuid not null references public.raw_clips (id),
  suggestion_id uuid,
  drive_shortcut_id text,
  linked_by uuid references public.profiles (id) default auth.uid(),
  linked_at timestamptz not null default now(),
  unlinked_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index card_raw_clips_key on public.card_raw_clips (card_id, raw_clip_id) where deleted_at is null;
create index card_raw_clips_clip_idx on public.card_raw_clips (raw_clip_id);
comment on table public.card_raw_clips is 'Which raw clips feed which card (one clip can feed several cards).';

create table public.clip_match_suggestions (
  id uuid primary key default gen_random_uuid(),
  raw_clip_id uuid not null references public.raw_clips (id),
  card_id uuid references public.cards (id),
  confidence numeric(5, 2) check (confidence between 0 and 100),
  rank smallint not null default 1,
  reason text,
  run_id uuid references public.agent_runs (id),
  provider_key text,
  model_key text,
  outcome text not null default 'pending' check (outcome in ('pending', 'accepted', 'rejected', 'replaced')),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  chosen_card_id uuid references public.cards (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index clip_match_suggestions_clip_idx on public.clip_match_suggestions (raw_clip_id);
create index clip_match_suggestions_card_idx on public.clip_match_suggestions (card_id);
comment on table public.clip_match_suggestions is 'Gemini''s suggested card for each raw clip, its confidence, and what the person chose.';

alter table public.card_raw_clips add constraint card_raw_clips_suggestion_fk
  foreign key (suggestion_id) references public.clip_match_suggestions (id);

-- Directions on raw clips (Frame.io style, the most important workflow): what
-- we want the editor to do. Pinned to a moment of one clip (at_ms, with an
-- optional drawing), about a whole clip (at_ms null), or written for a whole
-- upload batch. Owners, admins and strategists write them; everyone who can
-- see the clip reads them. This is also the only place for plain comments on
-- a raw clip (the first draft's raw_clip_comments is folded in here).
create table public.clip_directions (
  id uuid primary key default gen_random_uuid(),
  -- Filled from the clip or the batch (trigger).
  space_id uuid not null references public.spaces (id),
  raw_clip_id uuid references public.raw_clips (id),
  upload_batch_id uuid references public.upload_batches (id),
  author_id uuid references public.profiles (id) default auth.uid(),
  at_ms int check (at_ms >= 0),
  drawing jsonb not null default '[]'::jsonb check (jsonb_typeof(drawing) = 'array'),
  tag_key text references public.direction_tags (key),
  body text not null,
  body_uk text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(raw_clip_id, upload_batch_id) = 1),
  check (upload_batch_id is null or at_ms is null)
);
create index clip_directions_clip_idx on public.clip_directions (raw_clip_id, at_ms);
create index clip_directions_batch_idx on public.clip_directions (upload_batch_id);
create index clip_directions_space_idx on public.clip_directions (space_id, created_at desc);
comment on table public.clip_directions is 'A direction on a raw clip (at a moment, with a drawing) or on a whole upload batch, with its Ukrainian text.';

-- Replies on a direction: the editor asks a question, we answer back.
create table public.clip_direction_replies (
  id uuid primary key default gen_random_uuid(),
  direction_id uuid not null references public.clip_directions (id),
  author_id uuid references public.profiles (id) default auth.uid(),
  body text not null,
  body_uk text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index clip_direction_replies_direction_idx on public.clip_direction_replies (direction_id, created_at);
comment on table public.clip_direction_replies is 'A reply on a direction (the editor''s question, our answer), with its Ukrainian text.';

-- ---------------------------------------------------------------------
-- 11. Versions (editor edits, in R2), variants (AI or hook maker), assets
-- ---------------------------------------------------------------------
create table public.versions (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  number int not null check (number > 0),
  label text,
  r2_bucket text not null,
  r2_key text not null,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes >= 0),
  duration_ms int check (duration_ms >= 0),
  width int,
  height int,
  thumbnail_r2_key text,
  editor_note text,
  uploaded_by uuid references public.profiles (id) default auth.uid(),
  review_state public.review_state not null default 'checking',
  virality_score numeric(5, 2),
  is_reference boolean not null default false,
  final_drive_file_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (card_id, number),
  unique (r2_bucket, r2_key)
);
create index versions_card_idx on public.versions (card_id);
create index versions_state_idx on public.versions (review_state) where deleted_at is null;
create index versions_uploaded_by_idx on public.versions (uploaded_by);
comment on table public.versions is 'Each edit an editor uploads (v1, v2...), stored in R2, with its review state.';

create table public.version_raw_clips (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.versions (id),
  raw_clip_id uuid not null references public.raw_clips (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index version_raw_clips_key on public.version_raw_clips (version_id, raw_clip_id) where deleted_at is null;
create index version_raw_clips_clip_idx on public.version_raw_clips (raw_clip_id);
comment on table public.version_raw_clips is 'Which raw clips an edited version was cut from (raw beside edit).';

create table public.ai_generations (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('image', 'video', 'edit', 'audio', 'carousel')),
  card_id uuid references public.cards (id),
  requested_by uuid references public.profiles (id) default auth.uid(),
  run_id uuid references public.agent_runs (id),
  provider_key text not null,
  model_key text not null,
  ai_model_id uuid references public.ai_models (id),
  prompt text,
  negative_prompt text,
  settings jsonb not null default '{}'::jsonb,
  inputs jsonb not null default '[]'::jsonb,
  source_version_id uuid references public.versions (id),
  source_raw_clip_id uuid references public.raw_clips (id),
  est_cost_usd numeric(12, 4),
  cost_usd numeric(12, 4),
  status public.job_status not null default 'queued',
  external_job_id text,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (requested_by is not null or run_id is not null)
);
create index ai_generations_card_idx on public.ai_generations (card_id);
create index ai_generations_requested_by_idx on public.ai_generations (requested_by, created_at desc);
create index ai_generations_status_idx on public.ai_generations (status) where deleted_at is null;
create index ai_generations_model_idx on public.ai_generations (provider_key, model_key);
comment on table public.ai_generations is 'Every AI job in the Studio or by an agent: tool, model, prompt, settings, cost, who asked.';

create table public.ai_generation_outputs (
  id uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.ai_generations (id),
  idx int not null default 0,
  r2_bucket text not null,
  r2_key text not null,
  mime_type text,
  width int,
  height int,
  duration_ms int,
  size_bytes bigint,
  virality_score numeric(5, 2),
  saved_to_library boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (generation_id, idx),
  unique (r2_bucket, r2_key)
);
comment on table public.ai_generation_outputs is 'Each file an AI job produced, copied into our R2 right away.';

create table public.variants (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  version_id uuid references public.versions (id),
  parent_variant_id uuid references public.variants (id),
  kind_key text not null references public.variant_kinds (key),
  label text not null,
  what_changed text not null,
  provider_key text,
  model_key text,
  ai_model_id uuid references public.ai_models (id),
  prompt text,
  settings jsonb not null default '{}'::jsonb,
  cost_usd numeric(12, 4) not null default 0,
  generation_id uuid references public.ai_generations (id),
  generation_output_id uuid references public.ai_generation_outputs (id),
  hook_raw_clip_id uuid references public.raw_clips (id),
  is_ai boolean not null default true,
  language text,
  r2_bucket text not null,
  r2_key text not null,
  thumbnail_r2_key text,
  duration_ms int,
  review_state public.review_state not null default 'checking',
  virality_score numeric(5, 2),
  agent_note text,
  made_by uuid references public.profiles (id) default auth.uid(),
  made_by_run_id uuid references public.agent_runs (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (version_id is not null or parent_variant_id is not null),
  unique (r2_bucket, r2_key)
);
create index variants_card_idx on public.variants (card_id);
create index variants_version_idx on public.variants (version_id);
create index variants_parent_idx on public.variants (parent_variant_id);
create index variants_state_idx on public.variants (review_state) where deleted_at is null;
comment on table public.variants is 'A new video made from a version: what changed, which tool and model, the prompt, the cost.';

create table public.variant_faces (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.variants (id),
  face_id uuid not null references public.faces (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index variant_faces_key on public.variant_faces (variant_id, face_id) where deleted_at is null;
comment on table public.variant_faces is 'Whose likeness an AI variant uses (posting it then needs the owner''s approval).';

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  kind_key text not null references public.asset_kinds (key),
  card_id uuid references public.cards (id),
  asset_group_id uuid,
  version_number int not null default 1 check (version_number > 0),
  title text not null,
  product_key text references public.products (key),
  template_id uuid references public.templates (id),
  canva_design_id text,
  is_ai boolean not null default false,
  review_state public.review_state not null default 'checking',
  virality_score numeric(5, 2),
  cost_usd numeric(12, 4) not null default 0,
  agent_note text,
  made_by uuid references public.profiles (id) default auth.uid(),
  made_by_run_id uuid references public.agent_runs (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index assets_card_idx on public.assets (card_id);
create index assets_group_idx on public.assets (asset_group_id, version_number);
comment on table public.assets is 'A carousel, photo or slide set; every edit is a new version in the same group.';

create table public.asset_slides (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets (id),
  position int not null check (position > 0),
  layout text,
  heading text,
  highlight text,
  body text,
  photo_source text check (photo_source in ('brand_kit', 'ai', 'upload')),
  brand_asset_id uuid references public.brand_assets (id),
  generation_id uuid references public.ai_generations (id),
  r2_bucket text,
  r2_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index asset_slides_key on public.asset_slides (asset_id, position) where deleted_at is null;
comment on table public.asset_slides is 'Each slide of a carousel: heading, text, photo source, file in R2.';

create table public.asset_claims (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references public.assets (id),
  claim_id uuid not null references public.claims (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index asset_claims_key on public.asset_claims (asset_id, claim_id) where deleted_at is null;
comment on table public.asset_claims is 'Which approved claims a carousel or photo uses.';

-- ---------------------------------------------------------------------
-- 12. Review: notes, Send to editor, approvals, the AI first check
--     A reviewable item is exactly one of: version, variant, asset.
-- ---------------------------------------------------------------------
create table public.edit_requests (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards (id),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  asset_id uuid references public.assets (id),
  sent_by uuid not null references public.profiles (id) default auth.uid(),
  sent_to uuid references public.profiles (id),
  note_count int not null default 0,
  due_at timestamptz,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id, asset_id) = 1)
);
create index edit_requests_card_idx on public.edit_requests (card_id);
create index edit_requests_sent_to_idx on public.edit_requests (sent_to, sent_at desc);
comment on table public.edit_requests is 'Each Send to editor press: which video, who sent it, to whom, how many notes.';

create table public.review_comments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards (id),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  asset_id uuid references public.assets (id),
  slide_position int,
  parent_comment_id uuid references public.review_comments (id),
  at_ms int check (at_ms >= 0),
  tag_key text references public.note_tags (key),
  body text not null,
  body_uk text,
  voice_r2_key text,
  drawing jsonb not null default '[]'::jsonb,
  author_id uuid references public.profiles (id) default auth.uid(),
  author_run_id uuid references public.agent_runs (id),
  sent_at timestamptz,
  edit_request_id uuid references public.edit_requests (id),
  fixed_at timestamptz,
  fixed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id, asset_id) = 1),
  check (jsonb_typeof(drawing) = 'array')
);
create index review_comments_card_idx on public.review_comments (card_id);
create index review_comments_version_idx on public.review_comments (version_id, at_ms);
create index review_comments_variant_idx on public.review_comments (variant_id, at_ms);
create index review_comments_asset_idx on public.review_comments (asset_id);
create index review_comments_request_idx on public.review_comments (edit_request_id);
comment on table public.review_comments is 'A review note pinned to a moment (ms) with its tag, text, Ukrainian translation and drawing.';

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards (id),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  asset_id uuid references public.assets (id),
  decision public.review_decision not null,
  decided_by uuid not null references public.profiles (id) default auth.uid(),
  decided_by_role public.app_role not null default 'viewer',
  decided_at timestamptz not null default now(),
  note text,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id, asset_id) = 1)
);
create index approvals_card_idx on public.approvals (card_id);
create index approvals_version_idx on public.approvals (version_id);
create index approvals_variant_idx on public.approvals (variant_id);
create index approvals_asset_idx on public.approvals (asset_id);
comment on table public.approvals is 'Every approve or reject: which video, who decided, their role at that moment, and when.';

create table public.checker_rules (
  id uuid primary key default gen_random_uuid(),
  rule text not null,
  tag_key text references public.note_tags (key),
  source text not null default 'owner' check (source in ('owner', 'chat', 'review_notes', 'agent')),
  state text not null default 'proposed' check (state in ('proposed', 'approved', 'rejected')),
  is_on boolean not null default false,
  proposed_by uuid references public.profiles (id) default auth.uid(),
  proposed_by_run_id uuid references public.agent_runs (id),
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  flagged_for_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (not is_on or state = 'approved')
);
comment on table public.checker_rules is 'The AI first check''s house rules; a person approves each rule before it counts.';

create table public.checker_references (
  id uuid primary key default gen_random_uuid(),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  note text,
  marked_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id) = 1)
);
comment on table public.checker_references is 'Approved videos marked as good examples for the checker to compare with.';

create table public.checks (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards (id),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  asset_id uuid references public.assets (id),
  run_id uuid references public.agent_runs (id),
  provider_key text,
  model_key text,
  status public.job_status not null default 'queued',
  virality_score numeric(5, 2),
  passed boolean,
  summary text,
  cost_usd numeric(12, 4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id, asset_id) = 1)
);
create index checks_card_idx on public.checks (card_id);
create index checks_version_idx on public.checks (version_id);
create index checks_variant_idx on public.checks (variant_id);
comment on table public.checks is 'One AI first check of one video: model, virality score, passed or not, cost.';

create table public.check_results (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.checks (id),
  rule_id uuid references public.checker_rules (id),
  outcome text not null check (outcome in ('ok', 'warn', 'fail')),
  message text not null,
  at_ms int check (at_ms >= 0),
  marked_wrong_by uuid references public.profiles (id),
  marked_wrong_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index check_results_check_idx on public.check_results (check_id);
create index check_results_rule_idx on public.check_results (rule_id);
comment on table public.check_results is 'Each line of a check: the rule behind it, ok, warn or fail, and whether a person marked it wrong.';

-- ---------------------------------------------------------------------
-- 13. Bank, sounds, posts, numbers
-- ---------------------------------------------------------------------
create table public.bank_items (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards (id),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  asset_id uuid references public.assets (id),
  approval_id uuid not null references public.approvals (id),
  product_key text references public.products (key),
  is_ai boolean not null default false,
  priority int not null default 0,
  added_by uuid references public.profiles (id) default auth.uid(),
  retired_at timestamptz,
  retired_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id, asset_id) = 1)
);
create index bank_items_card_idx on public.bank_items (card_id);
create index bank_items_live_idx on public.bank_items (created_at) where retired_at is null and deleted_at is null;
comment on table public.bank_items is 'The content bank: approved videos and carousels waiting to be scheduled.';

create table public.sounds (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.sound_sources (key),
  title text not null,
  artist text,
  external_id text,
  duration_ms int,
  r2_bucket text,
  r2_key text,
  generation_id uuid references public.ai_generations (id),
  license_name text,
  license_ends_on date,
  trend_delta_pct numeric(8, 2),
  is_saved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create index sounds_source_idx on public.sounds (source_key);
comment on table public.sounds is 'The sounds library: a track, where it came from, its license and end date.';

create table public.sound_platforms (
  id uuid primary key default gen_random_uuid(),
  sound_id uuid not null references public.sounds (id),
  platform_key text not null references public.platforms (key),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index sound_platforms_key on public.sound_platforms (sound_id, platform_key) where deleted_at is null;
comment on table public.sound_platforms is 'Which platforms a sound may be used on.';

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards (id),
  version_id uuid references public.versions (id),
  variant_id uuid references public.variants (id),
  asset_id uuid references public.assets (id),
  bank_item_id uuid references public.bank_items (id),
  account_id uuid not null references public.social_accounts (id),
  platform_key text references public.platforms (key),
  kind_key text not null default 'video' references public.post_kinds (key),
  status public.post_status not null default 'draft',
  scheduled_for timestamptz,
  scheduled_by uuid references public.profiles (id),
  scheduled_at timestamptz,
  approval_id uuid references public.approvals (id),
  approved_by uuid references public.profiles (id),
  -- True when it was scheduled or posted with no approval (an owner or admin,
  -- or a person whose "needs admin approval" box is unticked). Set by the database.
  posted_without_approval boolean not null default false,
  caption text,
  hashtags text[] not null default '{}',
  sound_id uuid references public.sounds (id),
  sound_volume_pct smallint check (sound_volume_pct between 0 and 100),
  cover_at_ms int,
  cover_r2_key text,
  ai_label boolean not null default false,
  is_private boolean not null default false,
  platform_settings jsonb not null default '{}'::jsonb,
  suggestion_run_id uuid references public.agent_runs (id),
  external_post_id text,
  permalink text,
  posted_at timestamptz,
  finish_reason text,
  finished_by uuid references public.profiles (id),
  finished_at timestamptz,
  failed_reason text,
  attempt_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz,
  check (num_nonnulls(version_id, variant_id, asset_id) = 1),
  check (status <> 'scheduled' or scheduled_for is not null)
);
create index posts_card_idx on public.posts (card_id);
create index posts_account_idx on public.posts (account_id, scheduled_for);
create index posts_status_idx on public.posts (status, scheduled_for) where deleted_at is null;
create unique index posts_external_key on public.posts (platform_key, external_post_id) where external_post_id is not null;
comment on table public.posts is 'One video or carousel on one account: time, caption, sound, AI label, status, who approved it.';

create table public.post_attempts (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id),
  attempt_no int not null,
  ok boolean,
  error_code text,
  error_message text,
  response jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (post_id, attempt_no)
);
comment on table public.post_attempts is 'Each try to publish a post and what the platform answered.';

create table public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id),
  checkpoint_key text not null references public.metric_checkpoints (key),
  due_at timestamptz,
  pulled_at timestamptz,
  views bigint,
  reach bigint,
  plays bigint,
  watch_time_ms bigint,
  avg_watch_ms int,
  completion_rate numeric(6, 4),
  hold_3s_rate numeric(6, 4),
  likes bigint,
  comments bigint,
  saves bigint,
  shares bigint,
  follows bigint,
  profile_visits bigint,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (post_id, checkpoint_key)
);
create index post_metrics_due_idx on public.post_metrics (due_at) where pulled_at is null;
comment on table public.post_metrics is 'A post''s numbers at each fixed checkpoint (1 hour, 1 day, 3 days, 7 days, 30 days).';

-- ---------------------------------------------------------------------
-- 14. Notifications and the audit trail
-- ---------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid references public.profiles (id),
  telegram_chat_id bigint,
  channel text not null check (channel in ('telegram', 'google_chat', 'web_push', 'email')),
  kind text not null,
  title text,
  body text not null,
  link text,
  card_id uuid references public.cards (id),
  edit_request_id uuid references public.edit_requests (id),
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  provider_message_id text,
  error text,
  fallback_of_id uuid references public.notifications (id),
  sent_at timestamptz,
  read_at timestamptz,
  created_by uuid references public.profiles (id) default auth.uid(),
  created_by_run_id uuid references public.agent_runs (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);
create index notifications_status_idx on public.notifications (status) where status = 'queued';
comment on table public.notifications is 'Every notice we sent or tried to send (Telegram, Google Chat, phone), with the result.';

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('person', 'agent', 'connector', 'system')),
  actor_id uuid references public.profiles (id),
  agent_run_id uuid references public.agent_runs (id),
  via text,
  page text,
  action text not null,
  entity_table text not null,
  entity_id text,
  card_id uuid,
  changed_fields text[] not null default '{}',
  before_data jsonb,
  after_data jsonb
);
create index audit_log_at_idx on public.audit_log (occurred_at desc);
create index audit_log_actor_idx on public.audit_log (actor_id, occurred_at desc);
create index audit_log_entity_idx on public.audit_log (entity_table, entity_id);
create index audit_log_card_idx on public.audit_log (card_id, occurred_at desc);
comment on table public.audit_log is 'Every change by a person, an agent or a Claude connector: who, what, where, before and after. Append only.';

-- ---------------------------------------------------------------------
-- 15. Business logic triggers
-- ---------------------------------------------------------------------

-- 15a. First sign in: create the profile, for a Google sign in only (Google
-- has checked the email). Any other new sign in (email and password, magic
-- link, another provider) gets no profile at all: it is not active, sees
-- nothing, is not on the "waiting to be let in" list and uses no invite.
-- Invited email gets the invite's role and is active; any other Google
-- account becomes a pending viewer who sees nothing until the owner or an
-- admin lets them in.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invites%rowtype;
begin
  if coalesce(new.raw_app_meta_data ->> 'provider', '') <> 'google'
     or coalesce(btrim(new.email), '') = '' then
    return new;
  end if;
  select * into v_inv
  from public.invites i
  where lower(btrim(i.email)) = lower(btrim(new.email))
    and i.accepted_at is null and i.revoked_at is null and i.deleted_at is null
  order by i.created_at desc
  limit 1;

  insert into public.profiles (id, email, full_name, avatar_url, role, access_status, invited_by)
  values (
    new.id,
    btrim(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    coalesce(v_inv.role, 'viewer'::public.app_role),
    case when v_inv.id is null then 'pending'::public.access_status else 'active'::public.access_status end,
    v_inv.invited_by
  )
  on conflict (id) do nothing;

  if v_inv.id is not null then
    update public.invites set accepted_at = now(), accepted_by = new.id where id = v_inv.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 15a2. An invite for someone who already signed in with Google and is
-- waiting (pending) lets them in at once: the invited role, active, invite
-- used. The invite itself already passed the owner and admin limits (an
-- admin only invites strategists, editors and viewers).
create or replace function private.invites_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_profile uuid;
begin
  if new.accepted_at is not null or new.revoked_at is not null or new.deleted_at is not null then
    return new;
  end if;
  update public.profiles p
     set role = new.role, access_status = 'active', invited_by = new.invited_by
   where lower(btrim(p.email)) = lower(btrim(new.email)) and p.access_status = 'pending' and p.deleted_at is null
  returning p.id into v_profile;
  if v_profile is not null then
    update public.invites set accepted_at = now(), accepted_by = v_profile where id = new.id;
  end if;
  return new;
end;
$$;

-- 15a3. A new invite: the email is stored trimmed and lower case, and a
-- signed in person is always the one who invited (our own server may name
-- someone else).
create or replace function private.invites_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.email := lower(btrim(new.email));
  if auth.uid() is not null then
    new.invited_by := auth.uid();
  end if;
  return new;
end;
$$;

-- 15b. Profile guard.
--   * Your own profile: you change your personal details (name, photo,
--     language, Telegram, notification settings), never your email, role,
--     access, "needs admin approval before posting" box, or who invited or
--     removed you.
--   * Someone else's profile: only role, access, the removal fields and the
--     approval box, and only the owner or an admin; admins cannot touch owners
--     or admins or make anyone an owner or admin. Personal details belong to
--     the person (or our own server).
--   * The last active owner cannot be removed or demoted.
create or replace function private.guard_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_me public.app_role := private.current_app_role();
  v_admin_fields constant text[] := array['role', 'access_status', 'needs_post_approval', 'removed_at', 'removed_by',
                                          'deleted_at', 'updated_at'];
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if new.id <> old.id then
    raise exception 'A profile id never changes';
  end if;
  if new.id = auth.uid() then
    if new.email is distinct from old.email then
      raise exception 'Your email comes from Google sign in and cannot be changed here';
    end if;
    if new.invited_by is distinct from old.invited_by
       or new.removed_at is distinct from old.removed_at
       or new.removed_by is distinct from old.removed_by then
      raise exception 'You cannot change who invited or removed you';
    end if;
  elsif (to_jsonb(new) - v_admin_fields) is distinct from (to_jsonb(old) - v_admin_fields) then
    raise exception 'Only the person themself can change their own details';
  end if;
  if new.role is distinct from old.role
     or new.access_status is distinct from old.access_status
     or new.needs_post_approval is distinct from old.needs_post_approval
     or new.removed_at is distinct from old.removed_at
     or new.removed_by is distinct from old.removed_by
     or new.deleted_at is distinct from old.deleted_at then
    if new.id = auth.uid() then
      raise exception 'You cannot change your own role, access or posting approval';
    end if;
    if v_me is null or v_me not in ('owner', 'admin') then
      raise exception 'Only the owner or an admin can change roles and access';
    end if;
    if v_me = 'admin' and (old.role in ('owner', 'admin') or new.role in ('owner', 'admin')) then
      raise exception 'Only the owner can change owners and admins';
    end if;
    if old.role = 'owner' and (new.role <> 'owner' or new.access_status <> 'active' or new.deleted_at is not null)
       and (select count(*) from public.profiles p
            where p.role = 'owner' and p.access_status = 'active' and p.deleted_at is null and p.id <> old.id) = 0 then
      raise exception 'There must always be at least one active owner';
    end if;
    if new.access_status = 'removed' and old.access_status <> 'removed' then
      new.removed_at := now();
      new.removed_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

-- 15c. Status follows what happened. Move a card to a system status (by its
-- key) only when that is forward on the status line: stage first, then sort
-- order, so a card on a custom status behaves by where that status sits.
-- The one exception: inside the Review stage a card goes back and forth
-- between In review and Needs edits (also from a custom Review status).
-- People may still set any status by hand.
create or replace function private.advance_card_status(p_card uuid, p_key text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_to public.card_statuses%rowtype;
  v_cur public.card_statuses%rowtype;
begin
  if p_card is null then
    return;
  end if;
  select s.* into v_to from public.card_statuses s
   where s.key = p_key and s.is_system and s.deleted_at is null;
  if v_to.id is null then
    raise exception 'Unknown system status %', p_key;
  end if;
  select s.* into v_cur from public.cards c join public.card_statuses s on s.id = c.status_id
   where c.id = p_card and c.deleted_at is null
   for update of c;
  if v_cur.id is null or v_cur.id = v_to.id then
    return;
  end if;
  if (v_cur.stage, v_cur.sort_order) < (v_to.stage, v_to.sort_order)
     or (v_cur.stage = 'review' and v_to.key in ('review', 'edits')) then
    update public.cards set status_id = v_to.id where id = p_card;
  end if;
end;
$$;

-- 15d. Record every card status change.
create or replace function private.log_card_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status_id is distinct from old.status_id then
    insert into public.card_status_changes (card_id, from_status_id, to_status_id, changed_by, changed_by_run_id)
    values (new.id, case when tg_op = 'UPDATE' then old.status_id end, new.status_id, auth.uid(), private.header_run_id());
  end if;
  return new;
end;
$$;

-- 15d2. Cards: start on "idea" when no status is given; the space comes from
-- the week and must match it; the day must fall inside the week; the Shot
-- stamp is always the signed in person and the time now (never typed).
create or replace function private.cards_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_week public.weeks%rowtype;
begin
  if new.status_id is null then
    select s.id into new.status_id from public.card_statuses s where s.key = 'idea';
  end if;
  select w.* into v_week from public.weeks w where w.id = new.week_id;
  if v_week.id is not null then
    if new.space_id is null then
      new.space_id := v_week.space_id;
    elsif new.space_id <> v_week.space_id then
      raise exception 'That week belongs to another space';
    end if;
    if new.planned_on is not null
       and (new.planned_on < v_week.starts_on or new.planned_on > v_week.starts_on + 6) then
      raise exception 'The day % is not in the week starting %', new.planned_on, v_week.starts_on;
    end if;
  end if;
  if auth.uid() is not null
     and ((tg_op = 'INSERT' and new.shot_at is not null)
          or (tg_op = 'UPDATE' and (new.shot_at is distinct from old.shot_at or new.shot_by is distinct from old.shot_by))) then
    if new.shot_at is null then
      new.shot_by := null;
    else
      new.shot_at := now();
      new.shot_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

-- 15d3. Things that hang off a space must agree with it: a raw clip takes its
-- space and day from its upload batch; an import's week must be in its space;
-- a clip can only feed cards of its own space.
create or replace function private.raw_clips_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.upload_batches%rowtype;
begin
  if new.upload_batch_id is not null then
    select b.* into v_batch from public.upload_batches b where b.id = new.upload_batch_id;
    if new.space_id is null then
      new.space_id := v_batch.space_id;
    elsif new.space_id <> v_batch.space_id then
      raise exception 'That upload batch belongs to another space';
    end if;
    if new.shot_on is null then
      new.shot_on := v_batch.day;
    end if;
  end if;
  -- What Gemini finds is our own server's to write, never the uploader's.
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.uploaded_by := auth.uid();
    new.index_status := 'queued';
    new.index_run_id := null;
    new.transcript := null;
    new.transcript_language := null;
    new.transcript_words := null;
    new.ai_index := '{}'::jsonb;
    new.thumbnail_r2_key := null;
  end if;
  return new;
end;
$$;

create or replace function private.import_batches_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_space uuid;
begin
  select w.space_id into v_space from public.weeks w where w.id = new.week_id;
  if new.space_id is null then
    new.space_id := v_space;
  elsif new.space_id <> v_space then
    raise exception 'That week belongs to another space';
  end if;
  if auth.uid() is not null then
    new.imported_by := auth.uid();
  end if;
  return new;
end;
$$;

-- 15d4. To do items: who ticked it done is the signed in person.
create or replace function private.space_todos_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and (tg_op = 'INSERT' or new.done_at is distinct from old.done_at or new.done_by is distinct from old.done_by) then
    new.done_by := case when new.done_at is null then null else auth.uid() end;
  end if;
  return new;
end;
$$;

-- 15d5. System statuses stay: their key, stage and system mark never change
-- and they cannot be removed. Only our own server seeds system statuses.
create or replace function private.guard_card_status()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.is_system and auth.uid() is not null then
      raise exception 'Only the system adds system statuses';
    end if;
    return new;
  end if;
  if old.is_system and (new.key is distinct from old.key
                        or new.stage is distinct from old.stage
                        or new.is_system is distinct from old.is_system
                        or new.deleted_at is not null) then
    raise exception 'A system status cannot be removed, and its key and stage cannot change';
  end if;
  if not old.is_system and new.is_system then
    raise exception 'A custom status cannot become a system status';
  end if;
  return new;
end;
$$;

-- 15d6. Directions: the space comes from the clip or the batch; the author is
-- the signed in person; what a direction is on never changes afterwards.
create or replace function private.clip_directions_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.raw_clip_id is distinct from old.raw_clip_id
       or new.upload_batch_id is distinct from old.upload_batch_id
       or new.author_id is distinct from old.author_id then
      raise exception 'A direction stays on its clip or batch, with its author';
    end if;
    new.space_id := old.space_id;
    return new;
  end if;
  if new.raw_clip_id is not null then
    select r.space_id into new.space_id from public.raw_clips r where r.id = new.raw_clip_id;
  else
    select b.space_id into new.space_id from public.upload_batches b where b.id = new.upload_batch_id;
  end if;
  if auth.uid() is not null then
    new.author_id := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function private.clip_direction_replies_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.direction_id is distinct from old.direction_id or new.author_id is distinct from old.author_id then
      raise exception 'A reply stays on its direction, with its author';
    end if;
    return new;
  end if;
  if auth.uid() is not null then
    new.author_id := auth.uid();
  end if;
  return new;
end;
$$;

-- 15e. Fill card_id on rows that point at a version, variant or asset, so
-- RLS can check it cheaply and nobody can attach a note to the wrong card.
create or replace function private.fill_target_card()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.version_id is not null then
    select v.card_id into new.card_id from public.versions v where v.id = new.version_id;
  elsif new.variant_id is not null then
    select v.card_id into new.card_id from public.variants v where v.id = new.variant_id;
  elsif new.asset_id is not null then
    select a.card_id into new.card_id from public.assets a where a.id = new.asset_id;
  end if;
  return new;
end;
$$;

-- Variants take their card from their version or parent variant. Made by a
-- signed in person: it starts in Checking with no score and no cost (our own
-- server fills those), and the maker is that person.
create or replace function private.fill_variant_card()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.version_id is not null then
    select v.card_id into new.card_id from public.versions v where v.id = new.version_id;
  elsif new.parent_variant_id is not null then
    select v.card_id into new.card_id from public.variants v where v.id = new.parent_variant_id;
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.made_by := auth.uid();
    new.made_by_run_id := null;
    new.review_state := 'checking';
    new.virality_score := null;
    new.cost_usd := 0;
    new.duration_ms := null;
    new.thumbnail_r2_key := null;
  elsif tg_op = 'INSERT' and new.made_by is null and new.made_by_run_id is null then
    new.made_by := auth.uid();
  end if;
  return new;
end;
$$;

-- Carousels and photos made by a signed in person start the same way.
create or replace function private.assets_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.made_by := auth.uid();
    new.made_by_run_id := null;
    new.review_state := 'checking';
    new.virality_score := null;
    new.cost_usd := 0;
  end if;
  return new;
end;
$$;

-- 15f. Versions: number them (v1, v2...), start in Checking, older versions of
-- the same card become Superseded, and the card moves to In review. Uploaded
-- by a signed in person: no score, not a reference, and the measured facts
-- (size, length, frame size, thumbnail) are left for our own server to fill.
create or replace function private.versions_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.number is null or new.number = 0 then
    select coalesce(max(v.number), 0) + 1 into new.number from public.versions v where v.card_id = new.card_id;
  end if;
  if new.label is null then
    new.label := 'v' || new.number;
  end if;
  if auth.uid() is not null then
    new.review_state := 'checking';
    new.uploaded_by := auth.uid();
    new.virality_score := null;
    new.is_reference := false;
    new.final_drive_file_id := null;
    new.size_bytes := null;
    new.duration_ms := null;
    new.width := null;
    new.height := null;
    new.thumbnail_r2_key := null;
  end if;
  return new;
end;
$$;

-- 15f2. Fixed and server owned columns, one guard for every media table.
-- Trigger arguments, each a comma separated column list:
--   1. fixed: never changes after insert, for anyone, our own server too
--      (the file of a video is fixed: a new file is a new version);
--   2. server owned: only our own server and the database's own triggers
--      change it, never a signed in person directly;
--   3. set once (optional): may go from empty to a value once, then fixed.
create or replace function private.guard_fixed_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_col text;
begin
  foreach v_col in array string_to_array(coalesce(tg_argv[0], ''), ',') loop
    if v_col <> '' and (v_old -> v_col) is distinct from (v_new -> v_col) then
      raise exception '% on % is fixed once saved: a new file is a new row', v_col, tg_table_name;
    end if;
  end loop;
  if tg_nargs > 2 then
    foreach v_col in array string_to_array(coalesce(tg_argv[2], ''), ',') loop
      if v_col <> '' and jsonb_typeof(v_old -> v_col) is distinct from 'null'
         and (v_old -> v_col) is distinct from (v_new -> v_col) then
        raise exception '% on % is fixed once saved', v_col, tg_table_name;
      end if;
    end loop;
  end if;
  if auth.uid() is not null and pg_trigger_depth() = 1 then
    foreach v_col in array string_to_array(coalesce(tg_argv[1], ''), ',') loop
      if v_col <> '' and (v_old -> v_col) is distinct from (v_new -> v_col) then
        raise exception 'Only the system sets % on %', v_col, tg_table_name;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

-- A carousel or photo that is approved is final: its slides and claims stay
-- as approved (a change is a new version of the asset).
create or replace function private.guard_approved_asset_part()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_asset uuid := case when tg_op = 'INSERT' then new.asset_id else old.asset_id end;
begin
  if auth.uid() is not null and pg_trigger_depth() = 1
     and exists (select 1 from public.assets a where a.id = v_asset and a.review_state = 'approved') then
    raise exception 'This carousel is approved: make a new version to change it';
  end if;
  if tg_op = 'UPDATE' and new.asset_id is distinct from old.asset_id then
    raise exception 'A slide or claim stays on its carousel';
  end if;
  return new;
end;
$$;

create or replace function private.versions_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.versions v
     set review_state = 'superseded'
   where v.card_id = new.card_id and v.id <> new.id
     and v.review_state in ('checking', 'in_review', 'needs_edits');
  perform private.advance_card_status(new.card_id, 'review');
  return new;
end;
$$;


-- 15g. A clip only feeds cards of its own space. Linking a raw clip to a card
-- moves the card to Shot.
create or replace function private.card_raw_clips_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select c.space_id from public.cards c where c.id = new.card_id)
     is distinct from (select r.space_id from public.raw_clips r where r.id = new.raw_clip_id) then
    raise exception 'A raw clip can only feed cards of its own space';
  end if;
  if auth.uid() is not null then
    new.linked_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function private.card_raw_clips_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.advance_card_status(new.card_id, 'shot');
  return new;
end;
$$;

-- 15h. Review comments: an editor who did not write the note may only tick it
-- fixed (or untick it). Nobody edits a note after it was sent, except to tick it.
create or replace function private.guard_review_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    -- A note is sent only by Send to editor, never typed as sent.
    new.author_id := auth.uid();
    new.author_run_id := null;
    new.sent_at := null;
    new.edit_request_id := null;
    new.fixed_at := null;
    new.fixed_by := null;
    return new;
  end if;
  if new.sent_at is distinct from old.sent_at or new.edit_request_id is distinct from old.edit_request_id then
    raise exception 'A note is sent only with Send to editor';
  end if;
  if new.fixed_at is distinct from old.fixed_at then
    new.fixed_by := case when new.fixed_at is null then null else auth.uid() end;
  end if;
  if old.author_id is distinct from auth.uid() or old.sent_at is not null then
    if (to_jsonb(new) - array['fixed_at', 'fixed_by', 'body_uk', 'updated_at'])
       is distinct from (to_jsonb(old) - array['fixed_at', 'fixed_by', 'body_uk', 'updated_at']) then
      raise exception 'Only the author can change an unsent note; others may only tick it fixed';
    end if;
  end if;
  return new;
end;
$$;

-- 15i. Send to editor: all unsent notes on that video go out together. It
-- cannot be sent with no notes. The video moves to Needs edits.
create or replace function private.edit_requests_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.sent_by := auth.uid();
  end if;
  select count(*) into new.note_count
  from public.review_comments rc
  where rc.sent_at is null and rc.deleted_at is null and rc.parent_comment_id is null
    and rc.version_id is not distinct from new.version_id
    and rc.variant_id is not distinct from new.variant_id
    and rc.asset_id is not distinct from new.asset_id;
  if new.note_count = 0 then
    raise exception 'Add at least one note before sending to the editor';
  end if;
  if new.sent_to is null then
    if new.version_id is not null then
      select v.uploaded_by into new.sent_to from public.versions v where v.id = new.version_id;
    end if;
    if new.sent_to is null then
      select c.assigned_editor_id into new.sent_to from public.cards c where c.id = new.card_id;
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.edit_requests_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.review_comments rc
     set sent_at = new.sent_at, edit_request_id = new.id
   where rc.sent_at is null and rc.deleted_at is null and rc.parent_comment_id is null
     and rc.version_id is not distinct from new.version_id
     and rc.variant_id is not distinct from new.variant_id
     and rc.asset_id is not distinct from new.asset_id;
  if new.version_id is not null then
    update public.versions set review_state = 'needs_edits' where id = new.version_id;
  elsif new.variant_id is not null then
    update public.variants set review_state = 'needs_edits' where id = new.variant_id;
  else
    update public.assets set review_state = 'needs_edits' where id = new.asset_id;
  end if;
  perform private.advance_card_status(new.card_id, 'edits');
  return new;
end;
$$;

-- 15j. Approvals: the decider is always the signed in person and their role is
-- taken from the database at that moment (it cannot be typed in).
create or replace function private.approvals_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role public.app_role;
begin
  if auth.uid() is not null then
    new.decided_by := auth.uid();
  end if;
  select p.role into v_role from public.profiles p
   where p.id = new.decided_by and p.access_status = 'active' and p.deleted_at is null;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception 'Only the owner or an admin can approve or reject';
  end if;
  new.decided_by_role := v_role;
  new.decided_at := now();
  return new;
end;
$$;

create or replace function private.approvals_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_state public.review_state := case when new.decision = 'approved' then 'approved'::public.review_state
                                      else 'rejected'::public.review_state end;
begin
  if new.version_id is not null then
    update public.versions set review_state = v_state where id = new.version_id;
  elsif new.variant_id is not null then
    update public.variants set review_state = v_state where id = new.variant_id;
  else
    update public.assets set review_state = v_state where id = new.asset_id;
  end if;
  if new.decision = 'approved' then
    perform private.advance_card_status(new.card_id, 'approved');
  end if;
  return new;
end;
$$;

-- Approvals never change, except that the owner may revoke one.
create or replace function private.guard_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (to_jsonb(new) - array['revoked_at', 'revoked_by', 'updated_at'])
     is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'updated_at']) then
    raise exception 'An approval cannot be changed; the owner may only revoke it';
  end if;
  if new.revoked_at is not null and old.revoked_at is null then
    new.revoked_by := coalesce(auth.uid(), new.revoked_by);
  end if;
  return new;
end;
$$;

-- Checks that an approval is a live yes for exactly this video.
create or replace function private.approval_matches(p_approval uuid, p_version uuid, p_variant uuid, p_asset uuid)
returns public.approvals language plpgsql stable security definer set search_path = '' as $$
declare
  v public.approvals%rowtype;
begin
  select * into v from public.approvals a where a.id = p_approval;
  if v.id is null or v.decision <> 'approved' or v.revoked_at is not null or v.deleted_at is not null then
    raise exception 'This needs a live approval (approved, not revoked)';
  end if;
  if v.version_id is distinct from p_version or v.variant_id is distinct from p_variant
     or v.asset_id is distinct from p_asset then
    raise exception 'That approval is for a different video';
  end if;
  return v;
end;
$$;

-- 15k. Content bank: only approved items go in; the card moves to In bank.
create or replace function private.bank_items_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v public.approvals%rowtype;
begin
  v := private.approval_matches(new.approval_id, new.version_id, new.variant_id, new.asset_id);
  if auth.uid() is not null then
    new.added_by := auth.uid();
    new.retired_at := null;
    new.retired_by := null;
  end if;
  if new.product_key is null then
    select c.product_key into new.product_key from public.cards c where c.id = new.card_id;
  end if;
  if new.variant_id is not null then
    select vr.is_ai into new.is_ai from public.variants vr where vr.id = new.variant_id;
  elsif new.asset_id is not null then
    select a.is_ai into new.is_ai from public.assets a where a.id = new.asset_id;
  end if;
  return new;
end;
$$;

create or replace function private.bank_items_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.advance_card_status(new.card_id, 'bank');
  return new;
end;
$$;

-- 15l. Posts: posting permissions and approval before posting (owner, Nov 14
-- 2026; this replaces the first draft's "owner rule"). Checked on EVERY move
-- into scheduled, posting, posted or finish in TikTok (also from one of these
-- to the next, so a revoked approval or a removed channel stops a post that is
-- already scheduled), and again if the account, the video or the approval
-- changes while the post is live.
--   * Who is judged: a signed in person is judged as themself. Our own server
--     (the automatic scheduler) is judged by the person in scheduled_by only
--     when it carries on or retries what that person scheduled: the previous
--     status was scheduled, posting, failed or finish in TikTok, and the video
--     and account did not change in this write. In every other case (a post
--     nobody scheduled, a draft, a swapped video or account) it has no person
--     and needs an approval.
--   * scheduled_by is cleared when a post goes back to draft or cancelled, and
--     when its video or account changes (unless a person schedules it in that
--     same write), so the server never inherits a person for another video.
--   * That person must be an active owner or admin, or still hold that exact
--     account in person_posting_accounts.
--   * A live approval of that exact video by an owner or an admin is needed,
--     unless the person is an owner or admin, or their "needs admin approval
--     before posting" box is unticked. With no person, the approval is always
--     needed.
--   * A variant that uses someone's likeness always needs the owner's approval.
--   * scheduled_by, scheduled_at, approved_by and posted_without_approval are
--     written here only; whatever the app sends is overwritten. scheduled_by is
--     the person who moved the post into scheduled.
--   * A signed in person moves a post only to draft, scheduled or cancelled,
--     or from finish in TikTok to posted; posting, failed and finish in TikTok
--     are our own server's. Attempts and failure reasons are the server's too.
create or replace function private.posts_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v public.approvals%rowtype;
  v_actor uuid := auth.uid();
  v_judge uuid;
  v_role public.app_role;
  v_needs_flag boolean;
  v_needs_approval boolean;
  v_likeness boolean;
  v_changed boolean := false;
  v_live constant text[] := array['scheduled', 'posting', 'posted', 'finish_in_tiktok'];
begin
  select a.platform_key into new.platform_key from public.social_accounts a where a.id = new.account_id;

  -- Fields only this trigger writes.
  if tg_op = 'INSERT' then
    new.scheduled_by := null;
    new.scheduled_at := null;
    new.approved_by := null;
    new.posted_without_approval := false;
  else
    new.scheduled_by := old.scheduled_by;
    new.scheduled_at := old.scheduled_at;
    new.approved_by := old.approved_by;
    new.posted_without_approval := old.posted_without_approval;
    v_changed := new.account_id is distinct from old.account_id
                 or new.version_id is distinct from old.version_id
                 or new.variant_id is distinct from old.variant_id
                 or new.asset_id is distinct from old.asset_id;
    -- Back to draft or cancelled: nobody is scheduling it any more.
    if new.status in ('draft', 'cancelled') then
      new.scheduled_by := null;
      new.scheduled_at := null;
      new.approved_by := null;
      new.posted_without_approval := false;
    end if;
    -- A different video or account is never covered by who scheduled the old
    -- one, unless a signed in person schedules it in this same write (then they
    -- are judged as themself and become scheduled_by below).
    if v_changed and not (v_actor is not null and new.status = 'scheduled') then
      new.scheduled_by := null;
    end if;
  end if;

  -- What a signed in person may do by hand.
  if v_actor is not null then
    if tg_op = 'INSERT' then
      if new.status not in ('draft', 'scheduled') then
        raise exception 'A new post starts as a draft or scheduled';
      end if;
      new.attempt_count := 0;
      new.failed_reason := null;
      new.posted_at := null;
    else
      if new.status is distinct from old.status
         and not (new.status in ('draft', 'scheduled', 'cancelled')
                  or (new.status = 'posted' and old.status = 'finish_in_tiktok')) then
        raise exception 'Only the system moves a post to %', new.status;
      end if;
      new.attempt_count := old.attempt_count;
      new.failed_reason := old.failed_reason;
      new.posted_at := old.posted_at;
    end if;
  end if;

  if new.status::text = any (v_live)
     and (tg_op = 'INSERT'
          or new.status is distinct from old.status
          or new.account_id is distinct from old.account_id
          or new.version_id is distinct from old.version_id
          or new.variant_id is distinct from old.variant_id
          or new.asset_id is distinct from old.asset_id
          or new.approval_id is distinct from old.approval_id) then

    if v_actor is not null and new.status = 'scheduled'
       and (tg_op = 'INSERT' or old.status is distinct from 'scheduled' or v_changed) then
      new.scheduled_by := v_actor;
      new.scheduled_at := now();
    elsif v_actor is null and new.status = 'scheduled'
          and (tg_op = 'INSERT' or old.status is distinct from 'scheduled') then
      new.scheduled_at := now();
    end if;

    -- Who is judged. A signed in person: themself. Our own server: the person
    -- who scheduled it, but only to carry on or retry exactly what that person
    -- scheduled (from scheduled, posting, failed or finish in TikTok, same
    -- video, same account). Anything else the server does needs an approval.
    if v_actor is not null then
      v_judge := v_actor;
    elsif tg_op = 'UPDATE' and not v_changed and new.scheduled_by is not null
          and old.status in ('scheduled', 'posting', 'failed', 'finish_in_tiktok') then
      v_judge := new.scheduled_by;
    else
      v_judge := null;
    end if;
    if v_judge is not null then
      select p.role, p.needs_post_approval into v_role, v_needs_flag from public.profiles p
       where p.id = v_judge and p.access_status = 'active' and p.deleted_at is null;
      if v_role is null then
        raise exception 'Only active people can schedule or post';
      end if;
      if v_role not in ('owner', 'admin')
         and not exists (select 1 from public.person_posting_accounts pa
                         where pa.profile_id = v_judge and pa.account_id = new.account_id and pa.deleted_at is null) then
        raise exception 'You do not have posting permission on this account';
      end if;
      v_needs_approval := v_role not in ('owner', 'admin') and v_needs_flag;
    else
      v_needs_approval := true;
    end if;

    v_likeness := exists (select 1 from public.variant_faces vf
                          where vf.variant_id = new.variant_id and vf.deleted_at is null);
    if new.approval_id is not null then
      v := private.approval_matches(new.approval_id, new.version_id, new.variant_id, new.asset_id);
      if v.decided_by_role not in ('owner', 'admin') then
        raise exception 'Only an owner or admin approval counts';
      end if;
    elsif v_needs_approval or v_likeness then
      raise exception 'This post needs an approval of this video by an owner or admin first';
    end if;
    if v_likeness and v.decided_by_role is distinct from 'owner' then
      raise exception 'This video uses someone''s likeness: only an owner approval lets it post';
    end if;
    new.approved_by := v.decided_by;
    new.posted_without_approval := new.approval_id is null;
  end if;

  if new.status = 'posted' and new.posted_at is null then
    new.posted_at := now();
  end if;
  if new.status = 'posted' and tg_op = 'UPDATE' and old.status = 'finish_in_tiktok' and v_actor is not null then
    new.finished_by := v_actor;
    new.finished_at := now();
  end if;
  return new;
end;
$$;

create or replace function private.posts_after_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    if new.status = 'scheduled' then
      perform private.advance_card_status(new.card_id, 'scheduled');
    elsif new.status = 'finish_in_tiktok' then
      perform private.advance_card_status(new.card_id, 'finish');
    elsif new.status = 'posted' then
      perform private.advance_card_status(new.card_id, 'posted');
    end if;
  end if;
  return new;
end;
$$;

-- 15m. Checker rules: only the owner or an admin approves or switches a rule.
create or replace function private.guard_checker_rule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.proposed_by := auth.uid();
    new.proposed_by_run_id := null;
    if not private.is_manager() then
      new.state := 'proposed';
      new.is_on := false;
    end if;
    if new.state = 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    else
      new.approved_by := null;
      new.approved_at := null;
    end if;
    return new;
  end if;
  if new.proposed_by is distinct from old.proposed_by or new.proposed_by_run_id is distinct from old.proposed_by_run_id
     or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    if not (new.state = 'approved' and old.state is distinct from 'approved') then
      raise exception 'Who proposed or approved a rule is recorded by the system';
    end if;
  end if;
  if (new.state is distinct from old.state or new.is_on is distinct from old.is_on) and not private.is_manager() then
    raise exception 'Only the owner or an admin can approve or switch a checker rule';
  end if;
  if new.state = 'approved' and old.state is distinct from 'approved' then
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end;
$$;

-- 15m2. Rows our own server owns. These features are not built yet, so the
-- app may only read them (no UPDATE grant or policy for signed in people on
-- agent_runs, ai_generations, ai_generation_outputs, check_results and
-- notifications). Each person action on them (decide on an agent's plan, mark
-- a check line wrong, mark a notice read) comes later as its own narrow
-- function, like public.set_card_shot. Where a person truly creates the row
-- (a Studio request, a chat message), the server owned columns start empty.
create or replace function private.ai_generations_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.requested_by := auth.uid();
    new.run_id := null;
    new.status := 'queued';
    new.est_cost_usd := null;
    new.cost_usd := null;
    new.external_job_id := null;
    new.error := null;
    new.started_at := null;
    new.finished_at := null;
  end if;
  return new;
end;
$$;

create or replace function private.agent_messages_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.author_id := auth.uid();
    new.sender := 'person';
    new.run_id := null;
  end if;
  return new;
end;
$$;

-- Gemini's match suggestions: a person records only the choice (outcome and
-- chosen card); who decided and when are the signed in person and now.
create or replace function private.clip_match_suggestions_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and pg_trigger_depth() = 1 then
    if new.outcome is distinct from old.outcome or new.chosen_card_id is distinct from old.chosen_card_id then
      new.decided_by := auth.uid();
      new.decided_at := now();
    else
      new.decided_by := old.decided_by;
      new.decided_at := old.decided_at;
    end if;
  end if;
  return new;
end;
$$;

-- Content bank: who retired an item is the signed in person.
create or replace function private.bank_items_before_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null and pg_trigger_depth() = 1 then
    if new.approval_id is distinct from old.approval_id or new.version_id is distinct from old.version_id
       or new.variant_id is distinct from old.variant_id or new.asset_id is distinct from old.asset_id
       or new.added_by is distinct from old.added_by then
      raise exception 'A bank item keeps its video and approval';
    end if;
    if new.retired_at is distinct from old.retired_at then
      new.retired_by := case when new.retired_at is null then null else auth.uid() end;
    else
      new.retired_by := old.retired_by;
    end if;
  end if;
  return new;
end;
$$;

-- 15n. Audit trail. Writes one row per insert or real change. The app sends
-- the page in the x-app-page header; our server sends x-agent-run-id for agent
-- actions and x-via: claude_connector for Claude connector actions. Agent and
-- via headers are trusted only from the service role.
create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_action text;
  v_before jsonb;
  v_after jsonb;
  v_fields text[];
  v_run uuid;
  v_via text := 'app';
  v_type text;
  v_heavy text[] := array['transcript', 'transcript_tsv', 'transcript_words', 'ai_index', 'raw', 'input', 'response', 'system_prompt'];
begin
  v_new := to_jsonb(new) - v_heavy;
  if tg_op = 'INSERT' then
    v_action := 'insert';
    v_after := v_new;
    select coalesce(array_agg(k order by k), '{}') into v_fields from jsonb_object_keys(v_new) k;
  else
    v_old := to_jsonb(old) - v_heavy;
    select coalesce(array_agg(n.key order by n.key), '{}'),
           jsonb_object_agg(n.key, o.value),
           jsonb_object_agg(n.key, n.value)
      into v_fields, v_before, v_after
      from jsonb_each(v_new) n
      left join jsonb_each(v_old) o on o.key = n.key
     where n.key not in ('updated_at', 'last_active_at', 'last_page') and o.value is distinct from n.value;
    if cardinality(v_fields) = 0 then
      return new;
    end if;
    v_action := case
      when (v_old ->> 'deleted_at') is null and (v_new ->> 'deleted_at') is not null then 'soft_delete'
      when (v_old ->> 'deleted_at') is not null and (v_new ->> 'deleted_at') is null then 'restore'
      when tg_table_name = 'cards' and 'status_id' = any (v_fields) then 'status_change'
      when tg_table_name = 'cards' and v_fields <@ array['shot_at', 'shot_by'] then
        case when (v_new ->> 'shot_at') is null then 'unshot' else 'shot' end
      else 'update' end;
  end if;

  if private.is_service() then
    v_run := private.header_run_id();
    v_via := coalesce(nullif(private.request_header('x-via'), ''), 'server');
  end if;

  v_type := case
    when v_run is not null then 'agent'
    when v_via = 'claude_connector' then 'connector'
    when auth.uid() is not null then 'person'
    else 'system' end;

  insert into public.audit_log (actor_type, actor_id, agent_run_id, via, page, action, entity_table, entity_id, card_id,
                                changed_fields, before_data, after_data)
  values (
    v_type,
    auth.uid(),
    v_run,
    v_via,
    left(private.request_header('x-app-page'), 200),
    v_action,
    tg_table_name,
    coalesce(v_new ->> 'id', v_new ->> 'key'),
    case when tg_table_name = 'cards' then (v_new ->> 'id')::uuid else (v_new ->> 'card_id')::uuid end,
    v_fields,
    v_before,
    v_after
  );
  return new;
end;
$$;

-- 15o. The Shot checkbox, ticked on a phone in the field. Anyone active who
-- can see the card may tick or untick it, also an editor (who otherwise
-- cannot change cards); this narrow function is the only way they can. It
-- saves who and when, never changes the status, and the audit trail records
-- it as "shot" or "unshot".
create or replace function public.set_card_shot(p_card uuid, p_shot boolean)
returns public.cards language plpgsql security definer set search_path = '' as $$
declare
  v_card public.cards%rowtype;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_card is null or p_shot is null or not private.can_see_card(p_card) then
    raise exception 'You cannot see that card' using errcode = '42501';
  end if;
  update public.cards c
     set shot_at = case when p_shot then now() end,
         shot_by = case when p_shot then auth.uid() end
   where c.id = p_card and c.deleted_at is null
     and (c.shot_at is null) = p_shot
  returning c.* into v_card;
  if v_card.id is null then
    select c.* into v_card from public.cards c where c.id = p_card;
  end if;
  return v_card;
end;
$$;
comment on function public.set_card_shot(uuid, boolean) is 'Tick (true) or untick (false) the Shot box of a card you can see. Saves who and when; the status never changes.';

-- ---------------------------------------------------------------------
-- 16. Attach triggers
-- ---------------------------------------------------------------------
-- Before triggers fire in name order: a_ (fill), b_ (rules), c_ (guards), z_ (updated_at).

create trigger c_guard_profile before update on public.profiles
  for each row execute function private.guard_profile();

create trigger a_cards_before_write before insert or update on public.cards
  for each row execute function private.cards_before_write();
create trigger d_log_card_status after insert or update of status_id on public.cards
  for each row execute function private.log_card_status();

create trigger c_guard_card_status before insert or update on public.card_statuses
  for each row execute function private.guard_card_status();

create trigger a_raw_clips_before_write before insert or update of upload_batch_id, space_id, shot_on on public.raw_clips
  for each row execute function private.raw_clips_before_write();

create trigger a_import_batches_before_insert before insert on public.import_batches
  for each row execute function private.import_batches_before_insert();

create trigger a_space_todos_before_write before insert or update on public.space_todos
  for each row execute function private.space_todos_before_write();

create trigger a_clip_directions_before_write before insert or update on public.clip_directions
  for each row execute function private.clip_directions_before_write();
create trigger a_clip_direction_replies_before_write before insert or update on public.clip_direction_replies
  for each row execute function private.clip_direction_replies_before_write();

create trigger a_fill_card before insert or update of version_id, parent_variant_id on public.variants
  for each row execute function private.fill_variant_card();

create trigger b_versions_before_insert before insert on public.versions
  for each row execute function private.versions_before_insert();
create trigger d_versions_after_insert after insert on public.versions
  for each row execute function private.versions_after_insert();
-- The file of a video is fixed at insert; review state, score, reference mark
-- and measured facts are set by the database's triggers and our own server.
create trigger c_guard_fixed before update on public.versions
  for each row execute function private.guard_fixed_columns(
    'card_id,number,r2_bucket,r2_key',
    'review_state,virality_score,is_reference,final_drive_file_id,size_bytes,duration_ms,width,height,thumbnail_r2_key,uploaded_by');
create trigger c_guard_fixed before update on public.variants
  for each row execute function private.guard_fixed_columns(
    'card_id,version_id,parent_variant_id,r2_bucket,r2_key,generation_id,generation_output_id,hook_raw_clip_id',
    'review_state,virality_score,cost_usd,duration_ms,thumbnail_r2_key,made_by,made_by_run_id,provider_key,model_key,ai_model_id');
create trigger a_assets_before_insert before insert on public.assets
  for each row execute function private.assets_before_insert();
create trigger c_guard_fixed before update on public.assets
  for each row execute function private.guard_fixed_columns(
    'version_number',
    'review_state,virality_score,cost_usd,made_by,made_by_run_id',
    'asset_group_id');
create trigger c_guard_fixed before update on public.asset_slides
  for each row execute function private.guard_fixed_columns('', '', 'r2_bucket,r2_key');
create trigger b_guard_approved_asset before insert or update on public.asset_slides
  for each row execute function private.guard_approved_asset_part();
create trigger b_guard_approved_asset before insert or update on public.asset_claims
  for each row execute function private.guard_approved_asset_part();
create trigger c_guard_fixed before update on public.ai_generation_outputs
  for each row execute function private.guard_fixed_columns('generation_id,idx,r2_bucket,r2_key', '');
create trigger c_guard_fixed before update on public.raw_clips
  for each row execute function private.guard_fixed_columns(
    'drive_file_id',
    'index_status,index_run_id,transcript,transcript_language,transcript_words,ai_index,thumbnail_r2_key,uploaded_by',
    'md5_checksum');
create trigger a_ai_generations_before_insert before insert on public.ai_generations
  for each row execute function private.ai_generations_before_insert();
create trigger a_agent_messages_before_insert before insert on public.agent_messages
  for each row execute function private.agent_messages_before_insert();
create trigger b_clip_match_suggestions_before_update before update on public.clip_match_suggestions
  for each row execute function private.clip_match_suggestions_before_update();
create trigger c_guard_fixed before update on public.clip_match_suggestions
  for each row execute function private.guard_fixed_columns(
    'raw_clip_id,card_id,run_id', 'confidence,rank,reason,provider_key,model_key');
create trigger b_bank_items_before_update before update on public.bank_items
  for each row execute function private.bank_items_before_update();
create trigger a_invites_before_insert before insert on public.invites
  for each row execute function private.invites_before_insert();
create trigger d_invites_after_insert after insert on public.invites
  for each row execute function private.invites_after_insert();

create trigger b_card_raw_clips_before_insert before insert on public.card_raw_clips
  for each row execute function private.card_raw_clips_before_insert();
create trigger d_card_raw_clips_after_insert after insert on public.card_raw_clips
  for each row execute function private.card_raw_clips_after_insert();

create trigger a_fill_card before insert or update of version_id, variant_id, asset_id on public.review_comments
  for each row execute function private.fill_target_card();
create trigger c_guard_review_comment before insert or update on public.review_comments
  for each row execute function private.guard_review_comment();

create trigger a_fill_card before insert on public.edit_requests
  for each row execute function private.fill_target_card();
create trigger b_edit_requests_before_insert before insert on public.edit_requests
  for each row execute function private.edit_requests_before_insert();
create trigger d_edit_requests_after_insert after insert on public.edit_requests
  for each row execute function private.edit_requests_after_insert();

create trigger a_fill_card before insert on public.approvals
  for each row execute function private.fill_target_card();
create trigger b_approvals_before_insert before insert on public.approvals
  for each row execute function private.approvals_before_insert();
create trigger d_approvals_after_insert after insert on public.approvals
  for each row execute function private.approvals_after_insert();
create trigger c_guard_approval before update on public.approvals
  for each row execute function private.guard_approval();

create trigger a_fill_card before insert or update of version_id, variant_id, asset_id on public.checks
  for each row execute function private.fill_target_card();

create trigger a_fill_card before insert on public.bank_items
  for each row execute function private.fill_target_card();
create trigger b_bank_items_before_insert before insert on public.bank_items
  for each row execute function private.bank_items_before_insert();
create trigger d_bank_items_after_insert after insert on public.bank_items
  for each row execute function private.bank_items_after_insert();

create trigger a_fill_card before insert or update of version_id, variant_id, asset_id on public.posts
  for each row execute function private.fill_target_card();
create trigger b_posts_before_write before insert or update on public.posts
  for each row execute function private.posts_before_write();
create trigger d_posts_after_write after insert or update of status on public.posts
  for each row execute function private.posts_after_write();

create trigger c_guard_checker_rule before insert or update on public.checker_rules
  for each row execute function private.guard_checker_rule();

-- The audit trail is never edited, not even by our own server.
create or replace function private.block_audit_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'The audit trail is append only' using errcode = 'P0001';
end;
$$;
create trigger no_edit before update on public.audit_log
  for each row execute function private.block_audit_edit();

-- updated_at on every public table that has the column; block DELETE and
-- TRUNCATE on every public table (TRUNCATE skips row triggers, so it gets its own).
do $$
declare
  t record;
begin
  for t in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t.relname and column_name = 'updated_at') then
      execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t.relname);
    end if;
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t.relname);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t.relname);
  end loop;
end;
$$;

-- Audit trail on the tables where people and agents act.
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'invites', 'spaces', 'person_spaces', 'person_posting_accounts',
    'social_accounts', 'posting_slots', 'faces', 'claims', 'brand_assets', 'brand_rules',
    'templates', 'card_statuses', 'weeks', 'import_batches', 'cards', 'card_accounts', 'card_formats',
    'card_platforms', 'drive_folders', 'space_todos', 'upload_batches', 'raw_clips', 'card_raw_clips',
    'clip_match_suggestions', 'clip_directions', 'clip_direction_replies', 'versions',
    'variants', 'variant_faces', 'assets', 'edit_requests', 'review_comments', 'approvals', 'checker_rules',
    'checker_references', 'bank_items', 'sounds', 'posts', 'budgets', 'app_settings', 'ai_generations',
    'agents', 'agent_prompt_versions',
    'platforms', 'content_types', 'content_formats', 'products', 'series', 'hook_styles', 'note_tags',
    'direction_tags', 'variant_kinds', 'asset_kinds', 'post_kinds', 'sound_sources', 'template_kinds',
    'brand_asset_kinds', 'metric_checkpoints', 'ai_providers', 'ai_models'
  ]
  loop
    execute format('create trigger zz_audit after insert or update on public.%I for each row execute function private.audit_row()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 17. Grants, table by table. Nothing here relies on the Supabase setting
--     "Automatically expose new tables": first everything is taken away,
--     then each table gets exactly what its policies allow (section 18).
--     anon (not signed in) gets nothing. Nobody gets DELETE or TRUNCATE.
--     account_tokens: nothing for anon or authenticated, ever.
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
-- Anything this role creates later (a table, sequence or function in a later
-- migration) gives nothing to anon, authenticated or public until that
-- migration grants it explicitly. Functions lose Postgres' own "everyone may
-- run it" default too.
-- This one is global on purpose: Postgres gives every new function to PUBLIC
-- by a built in default, and only the global form (no "in schema") can take
-- that away; a per schema form cannot. What it means for later: after any
-- later `create extension` run by this role, the migration that adds it must
-- grant execute on that extension's functions explicitly.
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema private revoke all on tables from public, anon, authenticated;
alter default privileges in schema private revoke all on sequences from public, anon, authenticated;
alter default privileges in schema private revoke all on functions from public, anon, authenticated;

do $$
declare
  t text;
begin
  -- Read only for the app: written only by triggers or our own server. The
  -- server owned AI and notice rows are here too until each person action on
  -- them gets its own narrow function (see 15m2).
  foreach t in array array[
    'card_status_changes', 'agent_tool_calls', 'agent_run_outputs', 'checks', 'post_attempts', 'post_metrics',
    'audit_log', 'agent_runs', 'ai_generation_outputs', 'check_results', 'notifications'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;

  -- Read and add, never change (a send is final; a Studio request and a chat
  -- message are then the server's).
  foreach t in array array['edit_requests', 'agent_messages', 'ai_generations']
  loop
    execute format('grant select, insert on public.%I to authenticated', t);
  end loop;

  -- Read and change, never add (our own server adds them).
  foreach t in array array['profiles', 'clip_match_suggestions']
  loop
    execute format('grant select, update on public.%I to authenticated', t);
  end loop;

  -- Read, add and change (soft delete is a change).
  foreach t in array array[
    'invites', 'spaces', 'person_spaces', 'person_posting_accounts',
    'platforms', 'content_types', 'content_formats', 'products', 'series', 'hook_styles', 'note_tags',
    'direction_tags', 'variant_kinds', 'asset_kinds', 'post_kinds', 'sound_sources', 'template_kinds',
    'brand_asset_kinds', 'metric_checkpoints', 'ai_providers', 'ai_models', 'agents', 'agent_prompt_versions',
    'agent_threads', 'budgets', 'app_settings', 'social_accounts', 'posting_slots',
    'faces', 'claims', 'brand_assets', 'brand_rules', 'templates',
    'card_statuses', 'weeks', 'import_batches', 'cards', 'card_accounts', 'card_formats', 'card_platforms',
    'drive_folders', 'space_todos', 'upload_batches', 'raw_clips', 'card_raw_clips', 'clip_directions',
    'clip_direction_replies', 'versions', 'version_raw_clips', 'variants', 'variant_faces',
    'assets', 'asset_slides', 'asset_claims', 'review_comments', 'approvals', 'checker_rules', 'checker_references',
    'bank_items', 'sounds', 'sound_platforms', 'posts'
  ]
  loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end;
$$;

-- Our own server (service key): reads and writes every table, never deletes.
-- It bypasses row level security, so the triggers are its only guard.
grant select, insert, update on all tables in schema public to service_role;
revoke insert, update on public.audit_log from service_role;
grant usage, select on all sequences in schema public to service_role;

-- account_tokens: locked for the browser, whatever happened above.
revoke all on public.account_tokens from public, anon, authenticated;

-- The one function the browser calls directly: the Shot checkbox.
revoke all on function public.set_card_shot(uuid, boolean) from public, anon;
grant execute on function public.set_card_shot(uuid, boolean) to authenticated, service_role;

revoke all on all functions in schema private from public;
grant execute on function
  private.current_app_role(), private.has_role(public.app_role[]), private.is_active_user(), private.is_owner(),
  private.is_manager(), private.is_planner(), private.sees_all_cards(), private.is_service(),
  private.jwt_role(), private.request_header(text), private.header_run_id()
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 18. Row level security
-- ---------------------------------------------------------------------
-- Turn RLS on for every public table.
do $$
declare
  t record;
begin
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end;
$$;

-- Card visibility, inside the spaces the caller may open: everyone except
-- editors sees every card of those spaces; an editor sees only cards assigned
-- to them. A row with no card (library items) is for the team, not editors.
create or replace function private.card_visible(p_space uuid, p_editor uuid, p_deleted timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_see_space(p_space)
    and (private.sees_all_cards()
         or (private.has_role('editor') and p_editor = auth.uid() and p_deleted is null));
$$;

create or replace function private.can_see_card(p_card uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_card is null then private.sees_all_cards()
    else exists (
      select 1 from public.cards c
      where c.id = p_card and private.card_visible(c.space_id, c.assigned_editor_id, c.deleted_at))
  end;
$$;

-- Plans and edits things on a card: owner, admin or strategist who can see
-- the card's space. With no card: any of them.
create or replace function private.can_plan_card(p_card uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_planner() and (p_card is null or private.can_see_card(p_card));
$$;

-- Raw clip visibility (owner, Nov 14 2026): everyone active, editors too,
-- sees every day's raw clips in the spaces they may open.
create or replace function private.can_see_raw_clip(p_clip uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.raw_clips r where r.id = p_clip and private.can_see_space(r.space_id));
$$;

create or replace function private.can_see_direction(p_direction uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.clip_directions d where d.id = p_direction and private.can_see_space(d.space_id));
$$;

-- May the caller schedule or post on this account? Owners and admins: every
-- account. Anyone else active: only accounts ticked for them.
create or replace function private.can_post_to(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_manager()
    or (private.is_active_user() and exists (
      select 1 from public.person_posting_accounts pa
      where pa.profile_id = auth.uid() and pa.account_id = p_account and pa.deleted_at is null));
$$;

create or replace function private.can_see_run(p_run uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_manager()
    or exists (select 1 from public.agent_runs r where r.id = p_run and r.started_by = auth.uid());
$$;

-- The auth service fires the sign in trigger. Which functions signed in people
-- may run is set once, at the end of section 18.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema private to supabase_auth_admin;
    grant execute on function private.handle_new_user() to supabase_auth_admin;
  end if;
end;
$$;

-- Profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select private.is_active_user()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid()) or (select private.is_manager()))
  with check (id = (select auth.uid()) or (select private.is_manager()));

-- Invites (owner and admins; admins may only invite strategists, editors, viewers)
create policy invites_select on public.invites for select to authenticated
  using ((select private.is_manager()));
create policy invites_insert on public.invites for insert to authenticated
  with check ((select private.is_owner())
              or ((select private.is_manager()) and role in ('strategist', 'editor', 'viewer')));
create policy invites_update on public.invites for update to authenticated
  using ((select private.is_owner()) or ((select private.is_manager()) and role in ('strategist', 'editor', 'viewer')))
  with check ((select private.is_owner()) or ((select private.is_manager()) and role in ('strategist', 'editor', 'viewer')));

-- Spaces: you see the spaces you may open; owner and admins add and rename.
create policy spaces_select on public.spaces for select to authenticated
  using ((select private.can_see_space(id)));
create policy spaces_insert on public.spaces for insert to authenticated
  with check ((select private.is_manager()));
create policy spaces_update on public.spaces for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));

-- Who may open which space, and posting permissions per channel: you see your
-- own rows; owner and admins see all and change them, never their own.
create policy person_spaces_select on public.person_spaces for select to authenticated
  using ((select private.is_manager()) or (profile_id = (select auth.uid()) and (select private.is_active_user())));
create policy person_spaces_insert on public.person_spaces for insert to authenticated
  with check ((select private.is_manager()) and profile_id <> (select auth.uid()));
create policy person_spaces_update on public.person_spaces for update to authenticated
  using ((select private.is_manager()) and profile_id <> (select auth.uid()))
  with check ((select private.is_manager()) and profile_id <> (select auth.uid()));

create policy person_posting_accounts_select on public.person_posting_accounts for select to authenticated
  using ((select private.is_manager()) or (profile_id = (select auth.uid()) and (select private.is_active_user())));
create policy person_posting_accounts_insert on public.person_posting_accounts for insert to authenticated
  with check ((select private.is_manager()) and profile_id <> (select auth.uid()));
create policy person_posting_accounts_update on public.person_posting_accounts for update to authenticated
  using ((select private.is_manager()) and profile_id <> (select auth.uid()))
  with check ((select private.is_manager()) and profile_id <> (select auth.uid()));

-- Fixed label lists, card statuses, vendors, models, agents: every active person reads; owner and admins extend.
do $$
declare
  t text;
begin
  foreach t in array array[
    'platforms', 'content_types', 'content_formats', 'products', 'series', 'hook_styles', 'note_tags',
    'direction_tags', 'card_statuses', 'variant_kinds', 'asset_kinds', 'post_kinds', 'sound_sources', 'template_kinds', 'brand_asset_kinds',
    'metric_checkpoints', 'ai_providers', 'ai_models', 'agents',
    'faces', 'claims', 'brand_assets', 'brand_rules', 'templates', 'sounds', 'sound_platforms',
    'social_accounts', 'posting_slots'
  ]
  loop
    execute format('create policy %I on public.%I for select to authenticated using ((select private.is_active_user()))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.is_manager()))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select private.is_manager())) with check ((select private.is_manager()))', t || '_update', t);
  end loop;
end;
$$;

-- Agents' prompts: owner and admins only.
create policy agent_prompt_versions_select on public.agent_prompt_versions for select to authenticated
  using ((select private.is_manager()));
create policy agent_prompt_versions_insert on public.agent_prompt_versions for insert to authenticated
  with check ((select private.is_owner()));
create policy agent_prompt_versions_update on public.agent_prompt_versions for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));

-- Agent threads and messages: your own chats; owner and admins see all.
create policy agent_threads_select on public.agent_threads for select to authenticated
  using ((select private.is_manager()) or (owner_id = (select auth.uid()) and (select private.is_active_user())));
create policy agent_threads_insert on public.agent_threads for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.has_role('owner', 'admin', 'strategist')));
create policy agent_threads_update on public.agent_threads for update to authenticated
  using (owner_id = (select auth.uid()) or (select private.is_manager()))
  with check (owner_id = (select auth.uid()) or (select private.is_manager()));

create policy agent_messages_select on public.agent_messages for select to authenticated
  using (exists (select 1 from public.agent_threads t where t.id = thread_id
                 and ((select private.is_manager()) or t.owner_id = (select auth.uid()))));
create policy agent_messages_insert on public.agent_messages for insert to authenticated
  with check (sender = 'person' and author_id = (select auth.uid())
              and exists (select 1 from public.agent_threads t where t.id = thread_id and t.owner_id = (select auth.uid())));

-- Agent runs: owner and admins see all; others see runs they started. Only the
-- server creates and changes runs and tool calls (a decision on a plan comes later as its own function).
create policy agent_runs_select on public.agent_runs for select to authenticated
  using ((select private.is_manager()) or (started_by = (select auth.uid()) and (select private.is_active_user())));
create policy agent_tool_calls_select on public.agent_tool_calls for select to authenticated
  using ((select private.can_see_run(run_id)));
create policy agent_run_outputs_select on public.agent_run_outputs for select to authenticated
  using ((select private.can_see_run(run_id)));

-- Budgets and settings
create policy budgets_select on public.budgets for select to authenticated using ((select private.is_manager()));
create policy budgets_insert on public.budgets for insert to authenticated with check ((select private.is_owner()));
create policy budgets_update on public.budgets for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));
create policy app_settings_select on public.app_settings for select to authenticated using ((select private.is_manager()));
create policy app_settings_insert on public.app_settings for insert to authenticated with check ((select private.is_owner()));
create policy app_settings_update on public.app_settings for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));

-- account_tokens: RLS on, NO policies on purpose. Service role only.

-- Weeks, imports, to do lists: by space.
create policy weeks_select on public.weeks for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy weeks_insert on public.weeks for insert to authenticated
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));
create policy weeks_update on public.weeks for update to authenticated
  using ((select private.is_planner()) and (select private.can_see_space(space_id)))
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));

create policy import_batches_select on public.import_batches for select to authenticated
  using ((select private.is_planner()) and (select private.can_see_space(space_id)));
create policy import_batches_insert on public.import_batches for insert to authenticated
  with check ((select private.is_planner()) and (select private.can_see_space(space_id))
              and imported_by = (select auth.uid()));
create policy import_batches_update on public.import_batches for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));

create policy space_todos_select on public.space_todos for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy space_todos_insert on public.space_todos for insert to authenticated
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));
create policy space_todos_update on public.space_todos for update to authenticated
  using ((select private.is_planner()) and (select private.can_see_space(space_id)))
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));

-- Cards: by space; editors only their own cards, read only (the Shot box goes
-- through public.set_card_shot). Planners change cards of spaces they may open.
create policy cards_select on public.cards for select to authenticated
  using ((select private.card_visible(space_id, assigned_editor_id, deleted_at)));
create policy cards_insert on public.cards for insert to authenticated
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));
create policy cards_update on public.cards for update to authenticated
  using ((select private.is_planner()) and (select private.can_see_space(space_id)))
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));

do $$
declare
  t text;
begin
  foreach t in array array['card_accounts', 'card_formats', 'card_platforms']
  loop
    execute format('create policy %I on public.%I for select to authenticated using ((select private.can_see_card(card_id)))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.can_plan_card(card_id)))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select private.can_plan_card(card_id))) with check ((select private.can_plan_card(card_id)))', t || '_update', t);
  end loop;
end;
$$;

create policy card_status_changes_select on public.card_status_changes for select to authenticated
  using ((select private.can_see_card(card_id)));

-- Drive folders: a card's folders with the card; day and week folders with
-- the space (editors need the day inbox folder to upload); the root folder
-- for every active person.
create policy drive_folders_select on public.drive_folders for select to authenticated
  using (case
           when card_id is not null then (select private.can_see_card(card_id))
           when space_id is not null then (select private.can_see_space(space_id))
           else (select private.is_active_user())
         end);
create policy drive_folders_insert on public.drive_folders for insert to authenticated
  with check ((select private.can_plan_card(card_id))
              and (space_id is null or (select private.can_see_space(space_id))));
create policy drive_folders_update on public.drive_folders for update to authenticated
  using ((select private.can_plan_card(card_id)) and (space_id is null or (select private.can_see_space(space_id))))
  with check ((select private.can_plan_card(card_id)) and (space_id is null or (select private.can_see_space(space_id))));

-- Upload batches and raw clips: everyone active who may open the space sees
-- every day's clips, editors too. Everyone but viewers uploads.
create policy upload_batches_select on public.upload_batches for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy upload_batches_insert on public.upload_batches for insert to authenticated
  with check ((select private.has_role('owner', 'admin', 'strategist', 'editor'))
              and uploaded_by = (select auth.uid()) and (select private.can_see_space(space_id)));
create policy upload_batches_update on public.upload_batches for update to authenticated
  using ((select private.can_see_space(space_id))
         and ((select private.is_planner()) or uploaded_by = (select auth.uid())))
  with check ((select private.can_see_space(space_id))
              and ((select private.is_planner()) or uploaded_by = (select auth.uid())));

create policy raw_clips_select on public.raw_clips for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy raw_clips_insert on public.raw_clips for insert to authenticated
  with check ((select private.has_role('owner', 'admin', 'strategist', 'editor'))
              and uploaded_by = (select auth.uid()) and (select private.can_see_space(space_id)));
create policy raw_clips_update on public.raw_clips for update to authenticated
  using ((select private.can_see_space(space_id))
         and ((select private.is_planner()) or (uploaded_by = (select auth.uid()) and (select private.is_active_user()))))
  with check ((select private.can_see_space(space_id))
              and ((select private.is_planner()) or uploaded_by = (select auth.uid())));

create policy card_raw_clips_select on public.card_raw_clips for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy card_raw_clips_insert on public.card_raw_clips for insert to authenticated
  with check ((select private.can_plan_card(card_id)) and (select private.can_see_raw_clip(raw_clip_id)));
create policy card_raw_clips_update on public.card_raw_clips for update to authenticated
  using ((select private.can_plan_card(card_id))) with check ((select private.can_plan_card(card_id)));

-- Gemini's match suggestions: the team matching clips (not editors).
create policy clip_match_suggestions_select on public.clip_match_suggestions for select to authenticated
  using ((select private.sees_all_cards()) and (select private.can_see_raw_clip(raw_clip_id)));
create policy clip_match_suggestions_update on public.clip_match_suggestions for update to authenticated
  using ((select private.is_planner()) and (select private.can_see_raw_clip(raw_clip_id)))
  with check ((select private.is_planner()) and (select private.can_see_raw_clip(raw_clip_id)));

-- Directions on raw clips: owner, admins and strategists write; everyone who
-- can see the clip reads. Replies: everyone who can see it except viewers
-- (the editor answers with a question). The author edits or removes their
-- own; owner and admins may remove any.
create policy clip_directions_select on public.clip_directions for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy clip_directions_insert on public.clip_directions for insert to authenticated
  with check ((select private.is_planner()) and author_id = (select auth.uid())
              and (select private.can_see_space(space_id)));
create policy clip_directions_update on public.clip_directions for update to authenticated
  using ((select private.can_see_space(space_id))
         and ((author_id = (select auth.uid()) and (select private.is_planner())) or (select private.is_manager())))
  with check ((select private.can_see_space(space_id)));

create policy clip_direction_replies_select on public.clip_direction_replies for select to authenticated
  using ((select private.can_see_direction(direction_id)));
create policy clip_direction_replies_insert on public.clip_direction_replies for insert to authenticated
  with check (author_id = (select auth.uid())
              and (select private.has_role('owner', 'admin', 'strategist', 'editor'))
              and (select private.can_see_direction(direction_id)));
create policy clip_direction_replies_update on public.clip_direction_replies for update to authenticated
  using ((select private.can_see_direction(direction_id))
         and ((author_id = (select auth.uid()) and (select private.is_active_user())) or (select private.is_manager())))
  with check ((select private.can_see_direction(direction_id)));

-- Versions: editors upload onto their own cards
create policy versions_select on public.versions for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy versions_insert on public.versions for insert to authenticated
  with check ((select private.can_plan_card(card_id))
              or ((select private.has_role('editor')) and (select private.can_see_card(card_id))));
create policy versions_update on public.versions for update to authenticated
  using ((select private.can_plan_card(card_id)) or (uploaded_by = (select auth.uid()) and (select private.can_see_card(card_id))))
  with check ((select private.can_plan_card(card_id)) or (uploaded_by = (select auth.uid()) and (select private.can_see_card(card_id))));

create policy version_raw_clips_select on public.version_raw_clips for select to authenticated
  using (exists (select 1 from public.versions v where v.id = version_id and (select private.can_see_card(v.card_id))));
create policy version_raw_clips_insert on public.version_raw_clips for insert to authenticated
  with check (exists (select 1 from public.versions v where v.id = version_id
                      and ((select private.can_plan_card(v.card_id)) or v.uploaded_by = (select auth.uid())))
              and (select private.can_see_raw_clip(raw_clip_id)));
create policy version_raw_clips_update on public.version_raw_clips for update to authenticated
  using (exists (select 1 from public.versions v where v.id = version_id and (select private.can_plan_card(v.card_id))))
  with check (exists (select 1 from public.versions v where v.id = version_id and (select private.can_plan_card(v.card_id))));

-- Variants, assets (made in the Studio or by agents)
create policy variants_select on public.variants for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy variants_insert on public.variants for insert to authenticated
  with check ((select private.can_plan_card(card_id)));
create policy variants_update on public.variants for update to authenticated
  using ((select private.can_plan_card(card_id))) with check ((select private.can_plan_card(card_id)));

create policy variant_faces_select on public.variant_faces for select to authenticated
  using (exists (select 1 from public.variants v where v.id = variant_id and (select private.can_see_card(v.card_id))));
create policy variant_faces_insert on public.variant_faces for insert to authenticated
  with check (exists (select 1 from public.variants v where v.id = variant_id and (select private.can_plan_card(v.card_id))));
create policy variant_faces_update on public.variant_faces for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));

create policy assets_select on public.assets for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy assets_insert on public.assets for insert to authenticated
  with check ((select private.can_plan_card(card_id)));
create policy assets_update on public.assets for update to authenticated
  using ((select private.can_plan_card(card_id))) with check ((select private.can_plan_card(card_id)));

create policy asset_slides_select on public.asset_slides for select to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_see_card(a.card_id))));
create policy asset_slides_insert on public.asset_slides for insert to authenticated
  with check (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_plan_card(a.card_id))));
create policy asset_slides_update on public.asset_slides for update to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_plan_card(a.card_id))))
  with check (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_plan_card(a.card_id))));

create policy asset_claims_select on public.asset_claims for select to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_see_card(a.card_id))));
create policy asset_claims_insert on public.asset_claims for insert to authenticated
  with check (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_plan_card(a.card_id))));
create policy asset_claims_update on public.asset_claims for update to authenticated
  using (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_plan_card(a.card_id))))
  with check (exists (select 1 from public.assets a where a.id = asset_id and (select private.can_plan_card(a.card_id))));

-- AI generations: owner and admins see all; others see their own
create policy ai_generations_select on public.ai_generations for select to authenticated
  using ((select private.is_manager()) or (requested_by = (select auth.uid()) and (select private.is_active_user())));
create policy ai_generations_insert on public.ai_generations for insert to authenticated
  with check (requested_by = (select auth.uid()) and (select private.is_planner()));

create policy ai_generation_outputs_select on public.ai_generation_outputs for select to authenticated
  using (exists (select 1 from public.ai_generations g where g.id = generation_id
                 and ((select private.is_manager()) or g.requested_by = (select auth.uid()))));

-- Review notes: editors see sent notes on their own cards; unsent drafts are
-- seen by their author and the owner, admins and strategists.
create policy review_comments_select on public.review_comments for select to authenticated
  using ((select private.can_see_card(card_id))
         and (sent_at is not null or author_id = (select auth.uid()) or (select private.is_planner())));
create policy review_comments_insert on public.review_comments for insert to authenticated
  with check (author_id = (select auth.uid())
              and (select private.has_role('owner', 'admin', 'strategist', 'editor'))
              and (select private.can_see_card(card_id))
              and ((select private.is_planner()) or parent_comment_id is not null));
create policy review_comments_update on public.review_comments for update to authenticated
  using ((select private.can_see_card(card_id))
         and (author_id = (select auth.uid()) or (select private.is_planner())
              or ((select private.has_role('editor')) and sent_at is not null)))
  with check ((select private.can_see_card(card_id)));

create policy edit_requests_select on public.edit_requests for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy edit_requests_insert on public.edit_requests for insert to authenticated
  with check ((select private.can_plan_card(card_id)) and sent_by = (select auth.uid()));

create policy approvals_select on public.approvals for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy approvals_insert on public.approvals for insert to authenticated
  with check ((select private.is_manager()) and decided_by = (select auth.uid()));
create policy approvals_update on public.approvals for update to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));

-- Checker: rules readable by all active people; planners propose; managers approve (trigger).
create policy checker_rules_select on public.checker_rules for select to authenticated
  using ((select private.is_active_user()));
create policy checker_rules_insert on public.checker_rules for insert to authenticated
  with check ((select private.is_planner()));
create policy checker_rules_update on public.checker_rules for update to authenticated
  using ((select private.is_planner())) with check ((select private.is_planner()));

create policy checker_references_select on public.checker_references for select to authenticated
  using ((select private.is_active_user()));
create policy checker_references_insert on public.checker_references for insert to authenticated
  with check ((select private.is_manager()));
create policy checker_references_update on public.checker_references for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));

create policy checks_select on public.checks for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy check_results_select on public.check_results for select to authenticated
  using (exists (select 1 from public.checks c where c.id = check_id and (select private.can_see_card(c.card_id))));

-- Bank: the team (not editors), by space; owner and admins write
create policy bank_items_select on public.bank_items for select to authenticated
  using ((select private.sees_all_cards()) and (select private.can_see_card(card_id)));
create policy bank_items_insert on public.bank_items for insert to authenticated
  with check ((select private.is_manager()));
create policy bank_items_update on public.bank_items for update to authenticated
  using ((select private.is_manager())) with check ((select private.is_manager()));

-- Posts: the team sees all (by space); editors see posts of their own cards
-- Writing a post needs posting permission on its account (owner
-- and admins: every account); the approval rules are in posts_before_write.
create policy posts_select on public.posts for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy posts_insert on public.posts for insert to authenticated
  with check ((select private.can_post_to(account_id)) and (select private.can_see_card(card_id)));
create policy posts_update on public.posts for update to authenticated
  using ((select private.can_post_to(account_id)) and (select private.can_see_card(card_id)))
  with check ((select private.can_post_to(account_id)) and (select private.can_see_card(card_id)));

create policy post_attempts_select on public.post_attempts for select to authenticated
  using ((select private.sees_all_cards())
         and exists (select 1 from public.posts p where p.id = post_id and (select private.can_see_card(p.card_id))));

-- Numbers: the team only, never editors (their Home has no numbers)
create policy post_metrics_select on public.post_metrics for select to authenticated
  using ((select private.sees_all_cards())
         and exists (select 1 from public.posts p where p.id = post_id and (select private.can_see_card(p.card_id))));

-- Notifications: your own; owner and admins see the whole log
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()) or (select private.is_manager()));

-- Audit trail: owner and admins read. Only the audit trigger writes.
create policy audit_log_select on public.audit_log for select to authenticated
  using ((select private.is_manager()));

-- Function privileges, last of all, so no function created above keeps
-- Postgres' default "everyone may run it". Signed in people may run only the
-- helpers the policies call and the Shot checkbox. Trigger functions need no
-- grant: a trigger runs whoever writes the row.
revoke all on all functions in schema private from public, anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;
grant execute on function
  private.current_app_role(), private.has_role(public.app_role[]), private.is_active_user(), private.is_owner(),
  private.is_manager(), private.is_planner(), private.sees_all_cards(), private.is_service(), private.jwt_role(),
  private.request_header(text), private.header_run_id(), private.can_see_space(uuid),
  private.card_visible(uuid, uuid, timestamptz), private.can_see_card(uuid), private.can_plan_card(uuid),
  private.can_see_raw_clip(uuid), private.can_see_direction(uuid), private.can_post_to(uuid), private.can_see_run(uuid)
  to authenticated, service_role;
grant execute on function public.set_card_shot(uuid, boolean) to authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function private.handle_new_user() to supabase_auth_admin;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 19. Realtime: live updates for the screens that change while you watch
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array[
      'cards', 'card_statuses', 'card_formats', 'card_platforms', 'weeks', 'space_todos',
      'upload_batches', 'raw_clips', 'clip_directions', 'clip_direction_replies',
      'card_raw_clips', 'clip_match_suggestions', 'versions', 'variants', 'assets',
      'review_comments', 'edit_requests', 'approvals', 'checks', 'check_results', 'bank_items', 'posts',
      'ai_generations', 'agent_runs', 'agent_tool_calls', 'agent_messages', 'notifications', 'profiles'
    ]
    loop
      execute format('alter publication supabase_realtime add table public.%I', t);
    end loop;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 20. Seed production reference data only: spaces, card statuses,
--     direction tags, platforms, content types and formats (the real lists
--     in src/lib/import), and the system lists below. No demo cards, no demo
--     people. Products, series and hook styles are not seeded: the owner adds
--     the real ones in the app.
-- ---------------------------------------------------------------------
insert into public.spaces (slug, name, short_name, sort_order) values
  ('noun', 'Noun Naturals content', 'Noun Naturals', 1),
  ('founder', 'Founder content', 'Founder', 2);

-- The 13 system statuses: keys and labels from src/design/ui.tsx (the content
-- team's own words), stage from STAGE_OF, color as the app's design token.
insert into public.card_statuses (key, label, stage, color, solid, sort_order, is_system) values
  ('idea', 'Not started', 'planning', 'st-idea', false, 10, true),
  ('scripting', 'Script in progress', 'planning', 'st-scripting', false, 20, true),
  ('planned', 'Script ready', 'planning', 'st-planned', false, 30, true),
  ('qa', 'Script in QA', 'planning', 'st-qa', false, 40, true),
  ('shot', 'Shot', 'shooting', 'st-shot', false, 50, true),
  ('editing', 'Editing', 'editing', 'st-editing', false, 60, true),
  ('review', 'In review', 'review', 'st-review', true, 70, true),
  ('edits', 'Needs edits', 'review', 'st-edits', true, 80, true),
  ('approved', 'Approved', 'ready', 'st-approved', false, 90, true),
  ('bank', 'In bank', 'ready', 'st-bank', false, 100, true),
  ('scheduled', 'Scheduled', 'ready', 'st-scheduled', false, 110, true),
  ('finish', 'Finish in TikTok', 'ready', 'st-finish', true, 120, true),
  ('posted', 'Posted', 'posted', 'st-posted', false, 130, true);

insert into public.direction_tags (key, label, sort_order) values
  ('use_this', 'Use this', 1),
  ('cut_this', 'Cut this', 2),
  ('hook', 'Hook', 3),
  ('b_roll', 'B roll', 4),
  ('sound', 'Sound', 5),
  ('text_on_screen', 'Text on screen', 6);

insert into public.platforms (key, label, sort_order, is_live) values
  ('tiktok', 'TikTok', 1, true),
  ('instagram', 'Instagram', 2, true),
  ('facebook', 'Facebook', 3, true),
  ('youtube', 'YouTube', 4, false);

insert into public.content_types (key, label, sort_order) values
  ('talking_head', 'Talking head', 1),
  ('tiktok_comment', 'TikTok comment', 2),
  ('expert_video', 'Expert video', 3),
  ('bts', 'BTS', 4),
  ('drop', 'Drop', 5),
  ('founder_story', 'Founder story', 6),
  ('industry_callout', 'Industry callout', 7),
  ('product_breakdown', 'Product breakdown', 8);

insert into public.content_formats (key, label, sort_order) values
  ('education', 'Education', 1),
  ('connection', 'Connection', 2),
  ('objection_handling', 'Objection handling', 3),
  ('proof', 'Proof', 4);

insert into public.note_tags (key, label, sort_order, for_comments, for_rules) values
  ('hook', 'Hook', 1, true, true),
  ('captions', 'Captions', 2, true, true),
  ('audio', 'Audio', 3, true, true),
  ('pacing', 'Pacing', 4, true, true),
  ('product', 'Product', 5, true, true),
  ('claims', 'Claims', 6, false, true),
  ('platform_rules', 'Platform rules', 7, false, true),
  ('other', 'Other', 8, true, false);

insert into public.variant_kinds (key, label, sort_order) values
  ('new_hook', 'New hook', 1),
  ('hook_maker', 'Hook maker (recorded hook on the body)', 2),
  ('new_cta', 'New call to action', 3),
  ('swap_person', 'New person', 4),
  ('swap_product', 'New product', 5),
  ('swap_background', 'New background', 6),
  ('swap_outfit', 'New outfit', 7),
  ('new_market', 'Another market or language', 8),
  ('avatar', 'Avatar (cloned voice)', 9),
  ('dub', 'Dubbing', 10),
  ('reframe', 'Reframe to vertical', 11),
  ('upscale', 'Upscale', 12),
  ('music', 'Original music', 13),
  ('captions', 'Captions in Noun style', 14),
  ('extend', 'Extend', 15),
  ('prompt_edit', 'Edit by prompt', 16),
  ('other', 'Other', 99);

insert into public.asset_kinds (key, label, sort_order) values
  ('carousel', 'Carousel', 1),
  ('photo', 'Photo', 2),
  ('slide_set', 'Slide set', 3);

insert into public.post_kinds (key, label, sort_order) values
  ('video', 'Video', 1),
  ('reel', 'Reel', 2),
  ('trial_reel', 'Trial reel', 3),
  ('carousel', 'Carousel', 4),
  ('photo_post', 'Photo post', 5);

insert into public.sound_sources (key, label, sort_order, description) values
  ('tiktok_cml', 'TikTok Commercial Music Library', 1, 'Safe for a business account. TikTok only.'),
  ('instagram_audio', 'Instagram audio', 2, 'Meta''s library for business accounts. Instagram and Facebook.'),
  ('higgsfield_music', 'Higgsfield music', 3, 'Made by AI for us (ElevenLabs Music). Ours, works everywhere.'),
  ('licensed_upload', 'Our licensed tracks', 4, 'Tracks we licensed and uploaded. Watch the end date.');

insert into public.template_kinds (key, label, sort_order) values
  ('carousel_layout', 'Carousel layout', 1),
  ('caption', 'Caption template', 2),
  ('hook', 'Hook template', 3),
  ('canva_brand_template', 'Canva brand template', 4),
  ('edit_recipe', 'Edit recipe', 5);

insert into public.brand_asset_kinds (key, label, sort_order) values
  ('logo', 'Logo', 1),
  ('product_photo', 'Product photo', 2),
  ('label_shot', 'Label shot', 3),
  ('font', 'Font', 4),
  ('layout', 'Layout', 5);

insert into public.metric_checkpoints (key, label, sort_order, hours_after_post) values
  ('h1', '1 hour', 1, 1),
  ('d1', '1 day', 2, 24),
  ('d3', '3 days', 3, 72),
  ('d7', '7 days', 4, 168),
  ('d30', '30 days', 5, 720);

insert into public.ai_providers (key, label, sort_order, logo_key) values
  ('higgsfield', 'Higgsfield', 1, 'higgsfield'),
  ('google', 'Google', 2, 'googlegemini'),
  ('anthropic', 'Anthropic', 3, 'claude'),
  ('openai', 'OpenAI', 4, 'openai'),
  ('bytedance', 'ByteDance', 5, 'bytedance'),
  ('elevenlabs', 'ElevenLabs', 6, 'elevenlabs'),
  ('canva', 'Canva', 7, 'canva'),
  ('kling', 'Kling', 8, null),
  ('recraft', 'Recraft', 9, null);

-- Models named in docs/AGENTS.md and CONCEPT.md. Higgsfield's full list is
-- filled live from its API later (from_live_list = true); keys here are our
-- best names and must be checked against each vendor's real model ids.
insert into public.ai_models (provider_key, model_key, label, jobs, pricing, description) values
  ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', '{planning,writing,agents}', '{"usd_per_mtok_in": 4, "usd_per_mtok_out": 20}', 'Default for planning, writing and tool use.'),
  ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', '{writing,tagging}', '{"usd_per_mtok_in": 2, "usd_per_mtok_out": 10}', 'Bulk captions and tagging where quality holds.'),
  ('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', '{tagging,classification}', '{"usd_per_mtok_in": 0.10, "usd_per_mtok_out": 0.50}', 'Cheap classification.'),
  ('anthropic', 'claude-fable-5-2', 'Claude Fable 5.2', '{strategy}', '{"usd_per_mtok_in": 8, "usd_per_mtok_out": 40}', 'Hardest creative reasoning only.'),
  ('google', 'gemini-3.5-transcribe', 'Gemini 3.5 Transcribe', '{transcribe}', '{"usd_per_minute": 0.005}', 'Transcripts of raw clips with word timestamps.'),
  ('google', 'gemini-4-hydrogen', 'Gemini 4 Hydrogen', '{watch_video,clip_matching,first_check,translate}', '{}', 'Everyday video watching and matching.'),
  ('google', 'gemini-4-argon', 'Gemini 4 Argon', '{watch_video}', '{}', 'Hard cases only.'),
  ('higgsfield', 'soul', 'Higgsfield Soul', '{image,realistic_people}', '{}', 'Realistic people and Soul ID faces.'),
  ('higgsfield', 'ad-multiplier', 'Higgsfield Ad Multiplier', '{video_edit,new_hook}', '{}', 'New hook or call to action, swaps, recreate for a market.'),
  ('higgsfield', 'virality-predictor', 'Higgsfield virality predictor', '{virality_score}', '{}', 'Virality score before review.'),
  ('google', 'nano-banana-pro', 'Nano Banana Pro', '{image,product_shots}', '{}', 'Product photos from real shots.'),
  ('openai', 'gpt-image', 'GPT Image', '{image,text_on_image}', '{}', 'Images with text.'),
  ('bytedance', 'seedance', 'Seedance', '{video_from_image}', '{}', 'Video from image.'),
  ('elevenlabs', 'eleven-music', 'ElevenLabs Music', '{music}', '{}', 'Original music, through Higgsfield.');

update public.ai_models set via_provider_key = 'higgsfield'
 where model_key in ('nano-banana-pro', 'gpt-image', 'seedance', 'eleven-music');

insert into public.agents (key, label, kind, default_provider_key, default_model_key, sort_order, description) values
  ('head_of_content', 'Head of content', 'agent', 'anthropic', 'claude-opus-5-5', 1, 'Keeps the bank full within budget; weekly brief. Name later.'),
  ('carousel_agent', 'Carousel agent', 'agent', 'anthropic', 'claude-opus-5-5', 2, 'Makes carousels and photo posts by chat.'),
  ('first_check', 'AI first check', 'workflow', 'google', 'gemini-4-hydrogen', 3, 'Checks every edit against the house rules before a person sees it.'),
  ('clip_matcher', 'Clip matcher', 'workflow', 'google', 'gemini-4-hydrogen', 4, 'Suggests which card each raw clip belongs to.'),
  ('clip_indexer', 'Clip indexer', 'workflow', 'google', 'gemini-3.5-transcribe', 5, 'Transcribes and indexes each raw clip.'),
  ('scheduling_helper', 'Scheduling helper', 'single_call', 'anthropic', 'claude-sonnet-5-5', 6, 'Suggests accounts, times, captions, cover and sound.'),
  ('studio_auto', 'Studio Auto', 'single_call', 'anthropic', 'claude-haiku-5-5', 7, 'Picks the model for a Studio request.');

insert into public.checker_rules (rule, tag_key, source, state, is_on, approved_at) values
  ('No QR codes, links or discount cards on TikTok (use TikTok coupons)', 'platform_rules', 'owner', 'approved', true, now()),
  ('No text under the platform buttons', 'captions', 'owner', 'approved', true, now()),
  ('Every caption is spell checked', 'captions', 'owner', 'approved', true, now()),
  ('Product names and claims match the brand kit and the claims library', 'claims', 'owner', 'approved', true, now());

insert into public.app_settings (key, value, description) values
  ('models.transcribe', '{"provider": "google", "model": "gemini-3.5-transcribe"}', 'Transcripts of raw clips.'),
  ('models.watch_video', '{"provider": "google", "model": "gemini-4-hydrogen"}', 'Clip matching and the AI first check.'),
  ('models.watch_video_hard', '{"provider": "google", "model": "gemini-4-argon"}', 'Hard cases only.'),
  ('models.agents', '{"provider": "anthropic", "model": "claude-opus-5-5"}', 'Default model for agents.'),
  ('review.virality_min_score', 'null', 'AI videos below this score do not reach review. Owner to set.'),
  ('review.checker_enabled', 'true', 'When false, new versions go straight to In review.'),
  ('matching.confidence_floor', '70', 'Below this confidence the matcher says not sure.'),
  ('notify.team_telegram_chat_id', 'null', 'The team group the bot posts to.'),
  ('drive.root_folder_id', 'null', 'Drive id of the NOUN Content System Shared Drive folder.'),
  ('posting.ai_posts_per_day_cap', 'null', 'Cap on AI posts per day; rises only if AI performs.');

-- The owner's own invite, so the first sign in becomes the owner.
-- This is the owner's Google account at nounnaturals.com (sign in is Google only).
insert into public.invites (email, role, note, invited_by) values
  ('khaled@nounnaturals.com', 'owner', 'Bootstrap: the owner.', null);
