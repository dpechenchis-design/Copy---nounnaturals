-- =====================================================================
-- DRAFT. NOT A MIGRATION YET. Do not move this file into
-- supabase/migrations until the owner approves it (supabase/README.md:
-- that folder is live, every file in it runs on the real project).
-- When approved it becomes supabase/migrations/<YYYYMMDDHHMMSS>_ugc.sql,
-- with behavior tests added to supabase/tests in the same commit.
--
-- Noun ART: UGC and mentions (Refunnel), drafted Nov 15 2026 by Fable 5.2.
-- Smoke tested on the throwaway database (PGlite) on top of the first
-- migration: it loads, a sync page applies twice without doubles, the
-- person actions work. Not run on the live project.
--
-- What it adds (11 tables):
--   ugc_sources, ugc_rights_statuses      fixed label lists
--   ugc_sync_runs                         the run log of the timer
--   ugc_creators                          who posted (and: is it our own account)
--   ugc_campaigns                         the Refunnel campaign a post belongs to
--   ugc_posts                             one row per post, story or upload
--   ugc_post_files                        its videos and photos (links, never the bytes)
--   ugc_post_metrics_daily                its numbers, one row per day
--   ugc_rights_events                     every rights answer, by whom, when (append only)
--   card_ugc_references                   one "Send to a card": the card, the note, who
--   card_ugc_reference_posts              the posts in that send
--
-- House rules kept: never hard delete, row level security on every table,
-- explicit grants, fixed label lists as tables, the source is plain text
-- plus a list (never one vendor), the source's own row is kept as it came
-- (raw) for the future AI agent. No demo data: only the two label lists
-- are seeded. Comments on our own videos are NOT here (later, when TikTok
-- and Instagram are connected); nothing here blocks that.
--
-- Who writes what:
--   our server (service key), only in the published app: creators,
--     campaigns, posts, files, daily numbers, sync runs, through
--     public.ugc_sync_apply (one call per page, safe to repeat).
--   a signed in person, each through its own narrow function:
--     mark_ugc_rights, set_ugc_post_hidden, send_ugc_to_card,
--     set_ugc_creator_ours (owner and admins only).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Fixed label lists
-- ---------------------------------------------------------------------
create table public.ugc_sources (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.ugc_sources is 'Fixed list: where UGC and mentions are read from (Refunnel first; our own Instagram and TikTok connections later).';

create table public.ugc_rights_statuses (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  label text not null,
  description text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
comment on table public.ugc_rights_statuses is 'Fixed list: the creator''s answer about using a post in Meta ads (not asked, asked, granted, declined). A detail, never a gate: download and Send to a card do not depend on it.';

-- ---------------------------------------------------------------------
-- 2. The run log of the sync (created first: posts point at their last run)
-- ---------------------------------------------------------------------
create table public.ugc_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.ugc_sources (key),
  -- 'timer': the Supabase timer. 'person': someone pressed Sync now.
  started_how text not null default 'timer' check (started_how in ('timer', 'person')),
  requested_by uuid references public.profiles (id),
  -- 'recent' reads the last 30 days (hourly), 'full' reads everything (nightly).
  mode text not null default 'recent' check (mode in ('recent', 'full')),
  window_from date,
  window_to date,
  status public.job_status not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  pages_read int not null default 0,
  posts_seen int not null default 0,
  posts_added int not null default 0,
  own_posts_seen int not null default 0,
  files_seen int not null default 0,
  -- A calm one line reason when it failed. Never a key, never a full response.
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Two runs of one source never overlap. The route marks a run that has been
-- "running" for more than 15 minutes as failed before it starts a new one.
create unique index ugc_sync_runs_one_running on public.ugc_sync_runs (source_key) where status = 'running' and deleted_at is null;
create index ugc_sync_runs_recent_idx on public.ugc_sync_runs (source_key, started_at desc);
comment on table public.ugc_sync_runs is 'Run log of the UGC sync: when, how it started, what it read, how it ended. "Last synced" on the screen is the newest done run.';

-- ---------------------------------------------------------------------
-- 3. Creators, campaigns, posts, files, numbers
-- ---------------------------------------------------------------------
create table public.ugc_creators (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.ugc_sources (key),
  -- The creator's id at the source (Refunnel's creator.id).
  external_id text not null,
  username text not null,
  display_name text,
  followers_count bigint,
  is_verified boolean,
  -- True for our own accounts: their posts never show under UGC and mentions.
  -- The sync ticks it by itself when the username is one of our connected
  -- accounts (social_accounts); an owner or admin can tick or untick it by
  -- hand (set_ugc_creator_ours), and a hand made choice is never overwritten.
  is_own_account boolean not null default false,
  own_marked_by uuid references public.profiles (id),
  own_marked_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (source_key, external_id)
);
create index ugc_creators_username_idx on public.ugc_creators (lower(username));
comment on table public.ugc_creators is 'Who posted a UGC post or mention, as the source knows them. is_own_account marks our own accounts, whose posts are left out of the feed.';

create table public.ugc_campaigns (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.ugc_sources (key),
  external_id text not null,
  name text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (source_key, external_id)
);
comment on table public.ugc_campaigns is 'A campaign at the source (our affiliates in Refunnel). A post with a campaign shows as "Affiliate".';

create table public.ugc_posts (
  id uuid primary key default gen_random_uuid(),
  source_key text not null references public.ugc_sources (key),
  -- The post's id at the source (Refunnel's content id).
  external_id text not null,
  -- 'social': found on a platform. 'private': a creator uploaded the file to us.
  origin text not null check (origin in ('social', 'private')),
  -- Null for a private upload, which has no platform.
  platform_key text references public.platforms (key),
  -- Our own two words for what it is (what the screen filters on) ...
  media_type text not null check (media_type in ('video', 'image', 'carousel')),
  post_type text not null check (post_type in ('reel', 'tiktok', 'post', 'story', 'upload')),
  -- ... and the source's own words, kept as they came.
  source_media_type text,
  source_post_type text,
  caption text,
  hashtags text[] not null default '{}',
  mentions text[] not null default '{}',
  -- The post on the platform. Often missing (Refunnel gives none for TikTok, stories or uploads).
  permalink text,
  -- When the creator posted it.
  posted_at timestamptz not null,
  creator_id uuid not null references public.ugc_creators (id),
  campaign_id uuid references public.ugc_campaigns (id),
  -- The source's own fields, as they came (Refunnel: usage_rights NONE, REQUESTED, GRANTED;
  -- approval_status PENDING, APPROVED, REJECTED or empty; locked true or false).
  source_usage_rights text,
  source_approval_status text,
  source_locked boolean,
  -- The rights answer the screen shows. It follows the source until a person
  -- marks it by hand (rights_marked_by); after that the person's answer stays.
  -- Every change is a row in ugc_rights_events.
  rights_status_key text not null default 'not_asked' references public.ugc_rights_statuses (key),
  rights_marked_by uuid references public.profiles (id),
  rights_marked_at timestamptz,
  -- The newest numbers (the history is ugc_post_metrics_daily). Null: the source has none.
  views bigint,
  plays bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  impressions bigint,
  reach bigint,
  engagement numeric(16, 4),
  emv numeric(14, 2),
  gmv numeric(14, 2),
  stats_updated_at timestamptz,
  -- Hidden from the feed by a person (the "Hidden" chip still shows it).
  hidden_at timestamptz,
  hidden_by uuid references public.profiles (id),
  first_synced_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  last_run_id uuid references public.ugc_sync_runs (id),
  -- The source's row exactly as it came, for the future AI agent.
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (source_key, external_id)
);
create index ugc_posts_feed_idx on public.ugc_posts (posted_at desc) where deleted_at is null;
create index ugc_posts_creator_idx on public.ugc_posts (creator_id, posted_at desc);
create index ugc_posts_campaign_idx on public.ugc_posts (campaign_id) where campaign_id is not null;
comment on table public.ugc_posts is 'One UGC post, mention, story or private upload read from a source (Refunnel). Our own accounts'' posts are saved too and left out of the feed by their creator''s is_own_account.';

create table public.ugc_post_files (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.ugc_posts (id),
  -- Order inside the post, from 1 (a carousel has several).
  position int not null check (position >= 1),
  kind text not null check (kind in ('video', 'image')),
  -- The file at the source (cdn.refunnel.com: a plain link that does not expire).
  -- The browser plays and downloads from it directly; the bytes never pass through our server.
  source_url text not null,
  thumbnail_url text,
  duration_seconds numeric(8, 2),
  -- Our own copy in Cloudflare R2, if we ever keep one (so we do not depend on one vendor). Empty today.
  r2_bucket text,
  r2_key text,
  copied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (post_id, position)
);
comment on table public.ugc_post_files is 'The videos and photos of a UGC post, in order: the link at the source, the poster, the length. Links only.';

create table public.ugc_post_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.ugc_posts (id),
  -- The New York day the numbers were read on (the same days the Noun ERP uses).
  day date not null,
  views bigint,
  plays bigint,
  likes bigint,
  comments bigint,
  shares bigint,
  impressions bigint,
  reach bigint,
  engagement numeric(16, 4),
  emv numeric(14, 2),
  gmv numeric(14, 2),
  source_updated_at timestamptz,
  run_id uuid references public.ugc_sync_runs (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (post_id, day)
);
comment on table public.ugc_post_metrics_daily is 'A UGC post''s numbers, one row per day they were read (the last read of the day wins), so growth over time can be seen.';

-- ---------------------------------------------------------------------
-- 4. Rights history (append only)
-- ---------------------------------------------------------------------
create table public.ugc_rights_events (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.ugc_posts (id),
  status_key text not null references public.ugc_rights_statuses (key),
  -- 'source': the source changed its own field. 'person': someone marked it in the app.
  origin text not null check (origin in ('source', 'person')),
  -- The source's own word, when it came from the source.
  source_value text,
  note text,
  marked_by uuid references public.profiles (id),
  run_id uuid references public.ugc_sync_runs (id),
  created_at timestamptz not null default now()
);
create index ugc_rights_events_post_idx on public.ugc_rights_events (post_id, created_at desc);
comment on table public.ugc_rights_events is 'Every rights answer on a UGC post: what, from the source or from a person, who, when. Append only.';

-- ---------------------------------------------------------------------
-- 5. Send to a card as a reference (many posts per send, with a note)
-- ---------------------------------------------------------------------
create table public.card_ugc_references (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards (id),
  -- What the editor should do with them ("use this", "look through these").
  note text,
  sent_by uuid references public.profiles (id) default auth.uid(),
  sent_at timestamptz not null default now(),
  removed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index card_ugc_references_card_idx on public.card_ugc_references (card_id, sent_at desc);
comment on table public.card_ugc_references is 'One "Send to a card as a reference": the card, the note for the editor, who sent it and when.';

create table public.card_ugc_reference_posts (
  id uuid primary key default gen_random_uuid(),
  reference_id uuid not null references public.card_ugc_references (id),
  -- Repeated from the send, so the audit trail and the card page find it fast.
  card_id uuid not null references public.cards (id),
  post_id uuid not null references public.ugc_posts (id),
  position int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (reference_id, post_id)
);
create index card_ugc_reference_posts_post_idx on public.card_ugc_reference_posts (post_id);
create index card_ugc_reference_posts_card_idx on public.card_ugc_reference_posts (card_id);
comment on table public.card_ugc_reference_posts is 'The UGC posts inside one send to a card. A post can be a reference on many cards.';

-- ---------------------------------------------------------------------
-- 6. Functions
-- ---------------------------------------------------------------------
-- A JSON list of words as a text array (empty for anything else).
create or replace function private.jsonb_text_array(p jsonb)
returns text[] language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'array'
    then coalesce((select array_agg(x) from jsonb_array_elements_text(p) x), '{}'::text[])
    else '{}'::text[] end;
$$;

-- The source's rights word as one of ours.
create or replace function private.ugc_rights_from_source(p text)
returns text language sql immutable set search_path = '' as $$
  select case upper(coalesce(p, ''))
    when 'GRANTED' then 'granted'
    when 'APPROVED' then 'granted'
    when 'REQUESTED' then 'asked'
    when 'PENDING' then 'asked'
    when 'DECLINED' then 'declined'
    when 'REJECTED' then 'declined'
    else 'not_asked' end;
$$;

-- 6a. The sync. Our server calls this once per page it read (up to 100
-- posts), only in the published app. Safe to repeat: a post is found again by
-- (source, external id) and updated, never doubled. It never touches what a
-- person set: hidden, a hand made rights answer, a hand made "our account".
-- p_items is a list of posts in our own neutral shape (written by the mapper
-- in src/lib/refunnel), so a second source later feeds the same function:
--   { external_id, origin, platform_key, media_type, post_type,
--     source_media_type, source_post_type, caption, hashtags[], mentions[],
--     permalink, posted_at,
--     creator { external_id, username, display_name, followers, verified },
--     campaign { external_id, name } or null,
--     source_usage_rights, source_approval_status, source_locked,
--     stats { views, plays, likes, comments, shares, impressions, reach,
--             engagement, emv, gmv, updated_at } or null,
--     files [ { kind, url, thumbnail_url, duration_seconds } ],
--     raw }
create or replace function public.ugc_sync_apply(p_run uuid, p_items jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_source text;
  i jsonb;
  f jsonb;
  v_creator uuid;
  v_own boolean;
  v_campaign uuid;
  v_post uuid;
  v_added boolean;
  v_rights text;
  v_marked uuid;
  v_want text;
  v_has_stats boolean;
  v_files int;
  c_seen int := 0;
  c_added int := 0;
  c_own int := 0;
  c_files int := 0;
begin
  if not private.is_service() then
    raise exception 'Only our own server runs the sync' using errcode = '42501';
  end if;
  select r.source_key into v_source from public.ugc_sync_runs r where r.id = p_run and r.status = 'running';
  if v_source is null then
    raise exception 'No running sync run %', p_run using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'p_items must be a list' using errcode = '22023';
  end if;

  for i in select value from jsonb_array_elements(p_items)
  loop
    -- the creator
    insert into public.ugc_creators as c (source_key, external_id, username, display_name, followers_count, is_verified)
    values (
      v_source,
      i #>> '{creator,external_id}',
      coalesce(nullif(ltrim(i #>> '{creator,username}', '@'), ''), 'unknown'),
      nullif(i #>> '{creator,display_name}', ''),
      (i #>> '{creator,followers}')::numeric::bigint,
      (i #>> '{creator,verified}')::boolean)
    on conflict (source_key, external_id) do update set
      username = excluded.username,
      display_name = coalesce(excluded.display_name, c.display_name),
      followers_count = coalesce(excluded.followers_count, c.followers_count),
      is_verified = coalesce(excluded.is_verified, c.is_verified),
      last_seen_at = now()
    returning c.id into v_creator;

    -- our own account? Ticked by itself from the connected accounts, unless a person decided.
    update public.ugc_creators c set is_own_account = true
     where c.id = v_creator and not c.is_own_account and c.own_marked_by is null
       and exists (select 1 from public.social_accounts a
                   where a.deleted_at is null and lower(ltrim(a.username, '@')) = lower(c.username));
    select c.is_own_account into v_own from public.ugc_creators c where c.id = v_creator;

    -- the campaign
    v_campaign := null;
    if nullif(i #>> '{campaign,external_id}', '') is not null then
      insert into public.ugc_campaigns as g (source_key, external_id, name)
      values (v_source, i #>> '{campaign,external_id}', nullif(i #>> '{campaign,name}', ''))
      on conflict (source_key, external_id) do update set
        name = coalesce(excluded.name, g.name), last_seen_at = now()
      returning g.id into v_campaign;
    end if;

    -- the post (rights and hidden are never in this SET list)
    v_has_stats := coalesce(jsonb_typeof(i -> 'stats') = 'object', false);
    v_want := private.ugc_rights_from_source(i ->> 'source_usage_rights');
    insert into public.ugc_posts as p (
      source_key, external_id, origin, platform_key, media_type, post_type, source_media_type, source_post_type,
      caption, hashtags, mentions, permalink, posted_at, creator_id, campaign_id,
      source_usage_rights, source_approval_status, source_locked, rights_status_key,
      views, plays, likes, comments, shares, impressions, reach, engagement, emv, gmv, stats_updated_at,
      last_run_id, raw)
    values (
      v_source, i ->> 'external_id', i ->> 'origin', nullif(i ->> 'platform_key', ''), i ->> 'media_type', i ->> 'post_type',
      i ->> 'source_media_type', i ->> 'source_post_type',
      nullif(i ->> 'caption', ''), private.jsonb_text_array(i -> 'hashtags'), private.jsonb_text_array(i -> 'mentions'),
      nullif(i ->> 'permalink', ''), (i ->> 'posted_at')::timestamptz, v_creator, v_campaign,
      i ->> 'source_usage_rights', i ->> 'source_approval_status', (i ->> 'source_locked')::boolean, v_want,
      (i #>> '{stats,views}')::numeric::bigint, (i #>> '{stats,plays}')::numeric::bigint,
      (i #>> '{stats,likes}')::numeric::bigint, (i #>> '{stats,comments}')::numeric::bigint,
      (i #>> '{stats,shares}')::numeric::bigint, (i #>> '{stats,impressions}')::numeric::bigint,
      (i #>> '{stats,reach}')::numeric::bigint, (i #>> '{stats,engagement}')::numeric,
      (i #>> '{stats,emv}')::numeric, (i #>> '{stats,gmv}')::numeric,
      (i #>> '{stats,updated_at}')::timestamptz,
      p_run, i -> 'raw')
    on conflict (source_key, external_id) do update set
      origin = excluded.origin,
      platform_key = excluded.platform_key,
      media_type = excluded.media_type,
      post_type = excluded.post_type,
      source_media_type = excluded.source_media_type,
      source_post_type = excluded.source_post_type,
      caption = excluded.caption,
      hashtags = excluded.hashtags,
      mentions = excluded.mentions,
      permalink = coalesce(excluded.permalink, p.permalink),
      posted_at = excluded.posted_at,
      creator_id = excluded.creator_id,
      campaign_id = excluded.campaign_id,
      source_usage_rights = excluded.source_usage_rights,
      source_approval_status = excluded.source_approval_status,
      source_locked = excluded.source_locked,
      views = coalesce(excluded.views, p.views),
      plays = coalesce(excluded.plays, p.plays),
      likes = coalesce(excluded.likes, p.likes),
      comments = coalesce(excluded.comments, p.comments),
      shares = coalesce(excluded.shares, p.shares),
      impressions = coalesce(excluded.impressions, p.impressions),
      reach = coalesce(excluded.reach, p.reach),
      engagement = coalesce(excluded.engagement, p.engagement),
      emv = coalesce(excluded.emv, p.emv),
      gmv = coalesce(excluded.gmv, p.gmv),
      stats_updated_at = coalesce(excluded.stats_updated_at, p.stats_updated_at),
      last_synced_at = now(),
      last_run_id = excluded.last_run_id,
      raw = excluded.raw
    returning p.id, (p.xmax = 0), p.rights_status_key, p.rights_marked_by into v_post, v_added, v_rights, v_marked;

    -- rights: the source's answer is history too. It moves the shown answer only
    -- while no person has marked the post by hand.
    if v_added then
      if v_want <> 'not_asked' then
        insert into public.ugc_rights_events (post_id, status_key, origin, source_value, run_id)
        values (v_post, v_want, 'source', i ->> 'source_usage_rights', p_run);
      end if;
    elsif v_marked is null and v_rights <> v_want then
      update public.ugc_posts p set rights_status_key = v_want where p.id = v_post;
      insert into public.ugc_rights_events (post_id, status_key, origin, source_value, run_id)
      values (v_post, v_want, 'source', i ->> 'source_usage_rights', p_run);
    end if;

    -- the files, in order; one that is gone from the post is soft deleted
    v_files := 0;
    for f in select value from jsonb_array_elements(case when jsonb_typeof(i -> 'files') = 'array' then i -> 'files' else '[]'::jsonb end)
    loop
      continue when nullif(f ->> 'url', '') is null;
      v_files := v_files + 1;
      insert into public.ugc_post_files as x (post_id, position, kind, source_url, thumbnail_url, duration_seconds)
      values (v_post, v_files, f ->> 'kind', f ->> 'url', nullif(f ->> 'thumbnail_url', ''), (f ->> 'duration_seconds')::numeric)
      on conflict (post_id, position) do update set
        kind = excluded.kind,
        source_url = excluded.source_url,
        thumbnail_url = excluded.thumbnail_url,
        duration_seconds = coalesce(excluded.duration_seconds, x.duration_seconds),
        deleted_at = null;
    end loop;
    update public.ugc_post_files x set deleted_at = now()
     where x.post_id = v_post and x.position > v_files and x.deleted_at is null;

    -- today's numbers (the last read of the day wins)
    if v_has_stats then
      insert into public.ugc_post_metrics_daily as m (
        post_id, day, views, plays, likes, comments, shares, impressions, reach, engagement, emv, gmv, source_updated_at, run_id)
      select p.id, (now() at time zone 'America/New_York')::date, p.views, p.plays, p.likes, p.comments, p.shares,
             p.impressions, p.reach, p.engagement, p.emv, p.gmv, p.stats_updated_at, p_run
        from public.ugc_posts p where p.id = v_post
      on conflict (post_id, day) do update set
        views = excluded.views, plays = excluded.plays, likes = excluded.likes, comments = excluded.comments,
        shares = excluded.shares, impressions = excluded.impressions, reach = excluded.reach,
        engagement = excluded.engagement, emv = excluded.emv, gmv = excluded.gmv,
        source_updated_at = excluded.source_updated_at, run_id = excluded.run_id;
    end if;

    c_seen := c_seen + 1;
    c_files := c_files + v_files;
    if v_added then c_added := c_added + 1; end if;
    if v_own then c_own := c_own + 1; end if;
  end loop;

  update public.ugc_sync_runs r
     set pages_read = r.pages_read + 1,
         posts_seen = r.posts_seen + c_seen,
         posts_added = r.posts_added + c_added,
         own_posts_seen = r.own_posts_seen + c_own,
         files_seen = r.files_seen + c_files
   where r.id = p_run;

  return jsonb_build_object('seen', c_seen, 'added', c_added, 'own', c_own, 'files', c_files);
end;
$$;
comment on function public.ugc_sync_apply(uuid, jsonb) is 'Our server only: save one page of posts read from a source. Safe to repeat. Never changes what a person set.';

-- 6b. Anyone active may mark the rights answer of a post (owner, Nov 15 2026).
create or replace function public.mark_ugc_rights(p_post uuid, p_status text, p_note text default null)
returns public.ugc_posts language plpgsql security definer set search_path = '' as $$
declare
  v_post public.ugc_posts%rowtype;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.ugc_rights_statuses s where s.key = p_status and s.deleted_at is null) then
    raise exception 'Unknown rights answer' using errcode = '22023';
  end if;
  update public.ugc_posts p
     set rights_status_key = p_status, rights_marked_by = auth.uid(), rights_marked_at = now()
   where p.id = p_post and p.deleted_at is null
  returning p.* into v_post;
  if v_post.id is null then
    raise exception 'No such post' using errcode = '42501';
  end if;
  insert into public.ugc_rights_events (post_id, status_key, origin, note, marked_by)
  values (p_post, p_status, 'person', nullif(btrim(p_note), ''), auth.uid());
  return v_post;
end;
$$;
comment on function public.mark_ugc_rights(uuid, text, text) is 'Mark the rights answer of a UGC post (not asked, asked, granted, declined). Saves who and when, and a row of history.';

-- 6c. Hide a post from the feed, or bring it back. Anyone active.
create or replace function public.set_ugc_post_hidden(p_post uuid, p_hidden boolean)
returns public.ugc_posts language plpgsql security definer set search_path = '' as $$
declare
  v_post public.ugc_posts%rowtype;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_post is null or p_hidden is null then
    raise exception 'No such post' using errcode = '42501';
  end if;
  update public.ugc_posts p
     set hidden_at = case when p_hidden then now() end,
         hidden_by = case when p_hidden then auth.uid() end
   where p.id = p_post and p.deleted_at is null and (p.hidden_at is null) = p_hidden
  returning p.* into v_post;
  if v_post.id is null then
    select p.* into v_post from public.ugc_posts p where p.id = p_post;
  end if;
  return v_post;
end;
$$;
comment on function public.set_ugc_post_hidden(uuid, boolean) is 'Hide a UGC post from the feed (true) or show it again (false). Saves who and when.';

-- 6d. "This is our own account": owner and admins only.
create or replace function public.set_ugc_creator_ours(p_creator uuid, p_ours boolean)
returns public.ugc_creators language plpgsql security definer set search_path = '' as $$
declare
  v_creator public.ugc_creators%rowtype;
begin
  if auth.uid() is null or not private.is_manager() then
    raise exception 'Only the owner and admins decide which accounts are ours' using errcode = '42501';
  end if;
  update public.ugc_creators c
     set is_own_account = coalesce(p_ours, false), own_marked_by = auth.uid(), own_marked_at = now()
   where c.id = p_creator and c.deleted_at is null
  returning c.* into v_creator;
  if v_creator.id is null then
    raise exception 'No such creator' using errcode = '42501';
  end if;
  return v_creator;
end;
$$;
comment on function public.set_ugc_creator_ours(uuid, boolean) is 'Owner and admins: mark a creator as one of our own accounts (its posts leave the feed) or not.';

-- 6e. Send one or many posts to a card as a reference, with a note. Anyone
-- active who can see the card (an editor: only a card assigned to them).
create or replace function public.send_ugc_to_card(p_card uuid, p_posts uuid[], p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_ref uuid;
  v_count int;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if p_card is null or not private.can_see_card(p_card)
     or not exists (select 1 from public.cards c where c.id = p_card and c.deleted_at is null) then
    raise exception 'You cannot see that card' using errcode = '42501';
  end if;
  v_count := coalesce(cardinality(p_posts), 0);
  if v_count = 0 or v_count > 50 then
    raise exception 'Pick 1 to 50 posts' using errcode = '22023';
  end if;
  if (select count(distinct p.id) from public.ugc_posts p
        join public.ugc_creators c on c.id = p.creator_id
       where p.id = any (p_posts) and p.deleted_at is null and not c.is_own_account)
     <> (select count(distinct x) from unnest(p_posts) x) then
    raise exception 'One of those posts cannot be sent' using errcode = '22023';
  end if;
  insert into public.card_ugc_references (card_id, note, sent_by)
  values (p_card, nullif(btrim(p_note), ''), auth.uid())
  returning id into v_ref;
  insert into public.card_ugc_reference_posts (reference_id, card_id, post_id, position)
  select v_ref, p_card, x.id, min(x.n)::int
    from unnest(p_posts) with ordinality x (id, n)
   group by x.id;
  return v_ref;
end;
$$;
comment on function public.send_ugc_to_card(uuid, uuid[], text) is 'Send 1 to 50 UGC posts to a card you can see, as references, with a note for the editor. Returns the send''s id.';

-- ---------------------------------------------------------------------
-- 7. Triggers: the same steps the first migration ran in its loops
--    (updated_at, never hard delete, never truncate, row level security
--    on), plus the audit trail where people act. The sync's own writes are
--    not audited row by row (thousands an hour): their history is
--    ugc_sync_runs, the daily numbers and the rights events.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'ugc_sources', 'ugc_rights_statuses', 'ugc_sync_runs', 'ugc_creators', 'ugc_campaigns', 'ugc_posts',
    'ugc_post_files', 'ugc_post_metrics_daily', 'ugc_rights_events', 'card_ugc_references', 'card_ugc_reference_posts'
  ]
  loop
    if exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = t and column_name = 'updated_at') then
      execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
    end if;
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t);
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array array['ugc_sources', 'ugc_rights_statuses', 'ugc_rights_events', 'card_ugc_references', 'card_ugc_reference_posts']
  loop
    execute format('create trigger zz_audit after insert or update on public.%I for each row execute function private.audit_row()', t);
  end loop;
end;
$$;

-- On posts and creators only what a person decides is audited (the columns
-- the sync's own upsert never names).
create trigger zz_audit after update of hidden_at, rights_status_key, deleted_at on public.ugc_posts
  for each row execute function private.audit_row();
create trigger zz_audit after update of is_own_account, deleted_at on public.ugc_creators
  for each row execute function private.audit_row();

-- The rights history is never edited.
create trigger no_edit before update on public.ugc_rights_events
  for each row execute function private.block_audit_edit();

-- ---------------------------------------------------------------------
-- 8. Grants, table by table. Nothing is open by default. Nobody gets DELETE.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- Our own server: reads and writes, never deletes. Everyone else starts from nothing.
  foreach t in array array[
    'ugc_sources', 'ugc_rights_statuses', 'ugc_sync_runs', 'ugc_creators', 'ugc_campaigns', 'ugc_posts',
    'ugc_post_files', 'ugc_post_metrics_daily', 'ugc_rights_events', 'card_ugc_references', 'card_ugc_reference_posts'
  ]
  loop
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select, insert, update on public.%I to service_role', t);
  end loop;

  -- Read only for the app: written by our server or by the narrow functions.
  foreach t in array array[
    'ugc_sync_runs', 'ugc_creators', 'ugc_campaigns', 'ugc_posts', 'ugc_post_files', 'ugc_post_metrics_daily',
    'ugc_rights_events', 'card_ugc_reference_posts'
  ]
  loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;

  -- Read and change, never add (send_ugc_to_card adds; taking a send back is a change).
  execute 'grant select, update on public.card_ugc_references to authenticated';

  -- The label lists: read, add and change (owner and admins, by policy).
  foreach t in array array['ugc_sources', 'ugc_rights_statuses']
  loop
    execute format('grant select, insert, update on public.%I to authenticated', t);
  end loop;
end;
$$;
revoke update on public.ugc_rights_events from service_role;

revoke all on function public.ugc_sync_apply(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ugc_sync_apply(uuid, jsonb) to service_role;

revoke all on function public.mark_ugc_rights(uuid, text, text), public.set_ugc_post_hidden(uuid, boolean),
  public.set_ugc_creator_ours(uuid, boolean), public.send_ugc_to_card(uuid, uuid[], text) from public, anon;
grant execute on function public.mark_ugc_rights(uuid, text, text), public.set_ugc_post_hidden(uuid, boolean),
  public.set_ugc_creator_ours(uuid, boolean), public.send_ugc_to_card(uuid, uuid[], text) to authenticated, service_role;

revoke all on function private.jsonb_text_array(jsonb), private.ugc_rights_from_source(text) from public, anon, authenticated;
grant execute on function private.jsonb_text_array(jsonb), private.ugc_rights_from_source(text) to service_role;

-- ---------------------------------------------------------------------
-- 9. Row level security (turned on in section 7)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  -- The label lists: everyone active reads, owner and admins add and change.
  foreach t in array array['ugc_sources', 'ugc_rights_statuses']
  loop
    execute format('create policy %I on public.%I for select to authenticated using ((select private.is_active_user()))', t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.is_manager()))', t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select private.is_manager())) with check ((select private.is_manager()))', t || '_update', t);
  end loop;

  -- The feed: everyone active reads it, editors too (the screen is theirs to
  -- pick footage from). Nobody writes it from the browser.
  foreach t in array array[
    'ugc_sync_runs', 'ugc_creators', 'ugc_campaigns', 'ugc_posts', 'ugc_post_files', 'ugc_post_metrics_daily', 'ugc_rights_events'
  ]
  loop
    execute format('create policy %I on public.%I for select to authenticated using ((select private.is_active_user()))', t || '_select', t);
  end loop;
end;
$$;

-- References on a card: whoever can see the card sees them. Taking a send
-- back (soft delete) or fixing its note: the person who sent it, or a planner.
create policy card_ugc_references_select on public.card_ugc_references for select to authenticated
  using ((select private.can_see_card(card_id)));
create policy card_ugc_references_update on public.card_ugc_references for update to authenticated
  using ((select private.can_see_card(card_id)) and (sent_by = (select auth.uid()) or (select private.is_planner())))
  with check ((select private.can_see_card(card_id)) and (sent_by = (select auth.uid()) or (select private.is_planner())));
create policy card_ugc_reference_posts_select on public.card_ugc_reference_posts for select to authenticated
  using ((select private.can_see_card(card_id)));

-- ---------------------------------------------------------------------
-- 10. Realtime: a card page shows a new reference while it is open
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.card_ugc_references;
    alter publication supabase_realtime add table public.card_ugc_reference_posts;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 11. Seed: the two label lists only. No posts, no creators, no demo data.
-- ---------------------------------------------------------------------
insert into public.ugc_sources (key, label, description, sort_order) values
  ('refunnel', 'Refunnel', 'Refunnel''s read only developer API: Instagram and TikTok posts, stories and private uploads.', 1);

insert into public.ugc_rights_statuses (key, label, sort_order) values
  ('not_asked', 'Not asked', 1),
  ('asked', 'Asked', 2),
  ('granted', 'Granted', 3),
  ('declined', 'Declined', 4);

-- ---------------------------------------------------------------------
-- 12. The timer (pg_cron + pg_net). Every hour Supabase calls the published
--     app, which does the reading and the saving:
--       POST https://art.incivera.ai/api/sync/refunnel   header x-sync-secret
--     The secret is NOT in this file. The owner saves it once in Supabase
--     Vault under the name ugc_sync_secret (and the same value in Replit
--     Secrets as SYNC_SECRET). Until he does, the timer runs and does nothing.
--     Skipped where the two extensions do not exist (the throwaway test
--     database). No app role gets any of the extensions' functions: only the
--     timer itself (the database owner) uses them.
--     First real test: the first run on the live project. If the role that
--     runs migrations may not create these extensions there, the owner turns
--     on "pg_cron" and "pg_net" once under Database, Extensions, before this
--     file is pushed, and this section then finds them.
-- ---------------------------------------------------------------------
create or replace function private.call_ugc_sync(p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_secret text;
begin
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'ugc_sync_secret';
  if v_secret is null or v_secret = '' then
    return;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 120000)'
    using 'https://art.incivera.ai/api/sync/refunnel',
          jsonb_build_object('content-type', 'application/json', 'x-sync-secret', v_secret),
          jsonb_build_object('mode', p_mode);
end;
$$;
revoke all on function private.call_ugc_sync(text) from public, anon, authenticated, service_role;
comment on function private.call_ugc_sync(text) is 'The timer''s one job: ask the published app to run the UGC sync (recent or full). Reads the shared secret from Vault; does nothing without it.';

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_cron';
    execute 'create extension if not exists pg_net';
    -- every hour at minute 7: the last 30 days (about 3 pages)
    execute $cron$select cron.schedule('ugc-sync-recent', '7 * * * *', $job$select private.call_ugc_sync('recent')$job$)$cron$;
    -- every night at 08:37 UTC (3:37 am in New York in winter): everything, so old posts keep fresh numbers
    execute $cron$select cron.schedule('ugc-sync-full', '37 8 * * *', $job$select private.call_ugc_sync('full')$job$)$cron$;
  end if;
end;
$$;
