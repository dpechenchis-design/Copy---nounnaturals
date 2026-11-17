-- =====================================================================
-- Noun ART: UGC and mentions saved (approved by the owner, Nov 16 2026).
-- Written Nov 15 2026 for the published UGC screen. Rights workflow removed
-- Nov 16 2026 (owner: creators give their rights when they sign up to
-- Refunnel; the team only downloads, nothing is asked, recorded or rejected). Behavior tests:
-- supabase/tests/ugc.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
--
-- A trimmed, current version of the earlier, never approved draft
-- (docs/drafts/ugc-migration-draft.sql). It keeps only what the screen
-- needs now. No sync timer, no creators or campaigns tables, no daily
-- numbers, no comments (the Comments tab stays as it is).
--
-- What it adds, in plain words:
--   * One permission, "Save UGC" (ugc.manage), ticked for Owner, Admin and
--     Strategist/Editor. Downloading needs no permission, only the page.
--   * ugc_posts: a post from the live feed (Refunnel today) that someone
--     saved, one row per platform post (by the source's id), with the
--     creator's username, the links to its files (never the files), when
--     we saw it, and Refunnel's own rights word as it came
--     (source_usage_rights, read only, never an app workflow). Never hard
--     deleted: "Remove from saved" sets deleted_at.
--   * card_ugc_references: a saved post sent to a card as a reference, who
--     and when, with the note for the editor. Removed with deleted_at.
--
-- Rules followed (supabase/README.md): explicit grants, never DELETE, row
-- level security, no_hard_delete, no_truncate, zz_audit, updated_at,
-- realtime where it helps, no demo data. The new key is seeded here and
-- equals src/lib/access/permissions.ts (tested in
-- src/lib/access/access.test.mjs).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The permission (the team access migration's list, one more key)
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('ugc.manage', 'ugc', 'UGC and mentions', 'Save UGC', 'Save posts from UGC and mentions so they stay in Noun ART. Downloading needs only the page.', 175);

insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, 'ugc.manage', null
from public.roles r
where r.key in ('owner', 'admin', 'strategist')
  and r.deleted_at is null
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = 'ugc.manage' and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------
create table public.ugc_posts (
  id uuid primary key default gen_random_uuid(),
  -- Where the post was read from. Plain text, never one vendor: 'refunnel' today.
  source_key text not null default 'refunnel' check (source_key ~ '^[a-z0-9_]+$'),
  -- The post's id at the source (Refunnel's content id): one row per platform post.
  external_id text not null check (btrim(external_id) <> '' and length(external_id) <= 200),
  -- 'social': found on a platform. 'private': a creator uploaded the file to us.
  origin text not null check (origin in ('social', 'private')),
  -- Null for a private upload, which has no platform.
  platform_key text references public.platforms (key),
  media_type text not null check (media_type in ('video', 'image', 'carousel')),
  post_type text not null check (post_type in ('reel', 'tiktok', 'post', 'story', 'upload')),
  creator_username text not null check (btrim(creator_username) <> '' and length(creator_username) <= 200),
  creator_name text check (length(creator_name) <= 300),
  creator_followers bigint check (creator_followers >= 0),
  caption text check (length(caption) <= 10000),
  hashtags text[] not null default '{}',
  -- The post on the platform. Often missing (no link for TikTok, stories or uploads).
  permalink text check (permalink is null or (permalink ~ '^https://' and length(permalink) <= 2000)),
  -- The links to its files at the source, in order: [{ "type", "url", "thumbnail", "duration" }].
  -- Links only: the browser plays and downloads from them; the bytes never pass through our server.
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  -- The Refunnel campaign (our affiliates); null for anyone who just tagged us.
  campaign_name text check (length(campaign_name) <= 300),
  -- When the creator posted it.
  posted_at timestamptz,
  -- When we first and last saw it in the feed.
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- Refunnel's own rights word when it was saved, as it came. Read only: the app asks for no rights.
  source_usage_rights text check (length(source_usage_rights) <= 40),
  saved_by uuid references public.profiles (id) default auth.uid(),
  saved_at timestamptz not null default now(),
  removed_by uuid references public.profiles (id),
  -- The post as the screen had it, for the future AI agent (no secrets: it came from the feed).
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index ugc_posts_source_key on public.ugc_posts (source_key, external_id);
create index ugc_posts_creator_idx on public.ugc_posts (lower(creator_username));
create index ugc_posts_saved_idx on public.ugc_posts (saved_at desc) where deleted_at is null;
comment on table public.ugc_posts is 'A UGC post or mention someone saved from the live feed (Refunnel): one row per platform post, links to its files. Never hard deleted.';
create table public.card_ugc_references (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  -- The card's space, filled by the database: who opens the space sees it.
  space_id uuid not null references public.spaces (id),
  post_id uuid not null references public.ugc_posts (id),
  -- Posts sent together share one send and one note.
  send_id uuid not null default gen_random_uuid(),
  -- What the editor should do with it ("Use this clip", "Match this style").
  note text check (length(note) <= 2000),
  sent_by uuid references public.profiles (id) default auth.uid(),
  sent_at timestamptz not null default now(),
  removed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index card_ugc_references_live_key on public.card_ugc_references (card_id, post_id) where deleted_at is null;
create index card_ugc_references_card_idx on public.card_ugc_references (card_id, sent_at desc) where deleted_at is null;
create index card_ugc_references_post_idx on public.card_ugc_references (post_id) where deleted_at is null;
create index card_ugc_references_space_idx on public.card_ugc_references (space_id);
comment on table public.card_ugc_references is 'A saved UGC post sent to a card as a reference: who, when, the note for the editor. Removed with deleted_at, never deleted.';

-- ---------------------------------------------------------------------
-- 3. Rules
-- ---------------------------------------------------------------------
-- A person who saves a post is its saver, now.
create or replace function private.ugc_posts_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.saved_by := auth.uid();
    new.saved_at := now();
    new.removed_by := null;
    new.deleted_at := null;
  end if;
  return new;
end;
$$;

-- Who removed it: stamped when deleted_at is set, cleared when it comes back.
create or replace function private.ugc_stamp_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    new.removed_by := auth.uid();
  elsif new.deleted_at is null then
    new.removed_by := null;
  else
    new.removed_by := old.removed_by;
  end if;
  return new;
end;
$$;

-- A reference sits on a live card, in the card's space, points at a saved
-- post, and is sent by the caller, now.
create or replace function private.card_ugc_references_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_card public.cards;
begin
  select * into v_card from public.cards c where c.id = new.card_id;
  if not found then
    raise exception 'That card was not found' using errcode = 'P0001';
  end if;
  if v_card.deleted_at is not null then
    raise exception 'That card was removed. Restore it first.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.ugc_posts p where p.id = new.post_id and p.deleted_at is null) then
    raise exception 'Save the post first' using errcode = 'P0001';
  end if;
  new.space_id := v_card.space_id;
  if auth.uid() is not null then
    new.sent_by := auth.uid();
    new.sent_at := now();
    new.removed_by := null;
    new.deleted_at := null;
  end if;
  return new;
end;
$$;

revoke execute on function private.ugc_posts_before_insert(), private.ugc_stamp_removed(), private.card_ugc_references_before_insert()
  from public, anon, authenticated;

create trigger a_ugc_posts_before_insert before insert on public.ugc_posts
  for each row execute function private.ugc_posts_before_insert();
create trigger b_ugc_stamp_removed before update on public.ugc_posts
  for each row execute function private.ugc_stamp_removed();
-- Fixed once saved: the source and its id, who saved it and when.
create trigger c_guard_fixed before update on public.ugc_posts
  for each row execute function private.guard_fixed_columns(
    'source_key,external_id,saved_by,saved_at', '');

create trigger a_card_ugc_references_before_insert before insert on public.card_ugc_references
  for each row execute function private.card_ugc_references_before_insert();
create trigger b_ugc_stamp_removed before update on public.card_ugc_references
  for each row execute function private.ugc_stamp_removed();
-- Fixed once sent: the card, its space, the post, the send, who and when.
create trigger c_guard_fixed before update on public.card_ugc_references
  for each row execute function private.guard_fixed_columns('card_id,space_id,post_id,send_id,sent_by,sent_at', '');

-- ---------------------------------------------------------------------
-- 4. The house steps for every new table (the first migration's loops ran once)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['ugc_posts', 'card_ugc_references']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t);
    execute format('create trigger zz_audit after insert or update on public.%I for each row execute function private.audit_row()', t);
  end loop;
  foreach t in array array['ugc_posts', 'card_ugc_references']
  loop
    execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Grants. Nothing is open by default. Never DELETE.
-- ---------------------------------------------------------------------
revoke all on public.ugc_posts, public.card_ugc_references from public, anon, authenticated, service_role;
grant select, insert, update on public.ugc_posts, public.card_ugc_references to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------
-- Saved posts: everyone active reads them (they are public posts about us).
-- Saving needs "Save UGC", or "Plan weeks and cards" (sending a post to a
-- card saves it). Removing from saved, or saving again, needs "Save UGC".
create policy ugc_posts_select on public.ugc_posts for select to authenticated
  using ((select private.is_active_user()));
create policy ugc_posts_insert on public.ugc_posts for insert to authenticated
  with check (((select private.has_permission('ugc.manage')) or (select private.is_planner()))
              and saved_by = (select auth.uid()));
create policy ugc_posts_update on public.ugc_posts for update to authenticated
  using ((select private.has_permission('ugc.manage')))
  with check ((select private.has_permission('ugc.manage')));

-- References: seen by whoever sees the card (its space, and the card itself
-- for people who see only their own cards); sent and removed by people who
-- plan that card (calendar.plan).
create policy card_ugc_references_select on public.card_ugc_references for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy card_ugc_references_insert on public.card_ugc_references for insert to authenticated
  with check ((select private.can_plan_card(card_id)) and sent_by = (select auth.uid()));
create policy card_ugc_references_update on public.card_ugc_references for update to authenticated
  using ((select private.can_plan_card(card_id)))
  with check ((select private.can_plan_card(card_id)));

-- ---------------------------------------------------------------------
-- 7. Realtime: a card page shows a new reference while it is open
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.card_ugc_references;
  end if;
end;
$$;
