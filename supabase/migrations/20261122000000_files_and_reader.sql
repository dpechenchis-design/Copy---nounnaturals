-- =====================================================================
-- Noun ART: Upload/Files and the Gemini reader. A DRAFT, NOT LIVE.
-- Written Nov 16 2026 for the Upload/Files build. It waits here, in
-- docs/drafts, for the owner's yes; then it moves, unchanged, to
-- supabase/migrations/20261122000000_files_and_reader.sql in its own push
-- (after the code is pushed and republished). The timestamp is later than
-- the two Frame.io drafts (20261120100000 and 20261121000000), so the
-- three never share a version.
-- Behavior tests: supabase/tests/files-reader.test.mjs (they load this
-- file from here, and from supabase/migrations once it is live).
--
-- The code works on the old database too: the new flows switch on only
-- when the server sees the table raw_clip_moves; until then today's
-- Upload keeps working as it is.
--
-- What it does, in plain words:
--   * Folders (drive_folders): four more kinds of folder: a space's "New
--     uploads", a week's "Raw", a folder a person made ("team") and a
--     folder that was in the drive before the app ("legacy"). Each folder
--     remembers the folder it sits in, Gemini's two lines about what is
--     inside, when Gemini read it, and whether Drive still has to catch
--     up (needs_sync). One live New uploads per space, one live Raw per
--     week, one live folder per card. The new tree (Week N > day > card)
--     carries its week (week_id), so it lives next to the folders of the
--     first upload flow ("Week of ... > day > Raw") without clashing.
--   * Drops (upload_batches): no day is asked any more. A drop remembers
--     the folder it went into, how it came in (the mass upload, a drop on
--     a folder in Files, or "Read this folder with Gemini") and Gemini's
--     two lines about the whole drop.
--   * Files (raw_clips): no day is asked. A file is a video or a photo.
--     New: whether it has speech, Gemini's title and summary, the folder
--     it was dropped into, and the reader's own bookkeeping (tries, the
--     daily limit hold, the next try, the lease, the last error). Photos
--     are never read: they cost nothing and wait in the inbox.
--   * Matches (clip_match_suggestions): auto_applied marks a match Gemini
--     was sure of and filed without asking.
--   * NEW table raw_clip_moves: the undo ledger. One row per match that
--     was filed: where the file was, where it went, the shortcut, the
--     link to the card, who or what did it, and when it was undone.
--     People read it; nobody writes it by hand.
--   * The reader's own functions (our server only): claim_clip_jobs,
--     reserve_ai_spend, finish_clip_index, save_reader_summary,
--     clip_card_candidates and reader_heartbeat.
--   * People's actions, each its own narrow function: decide_clip_suggestion
--     and undo_clip_move (calendar.plan), request_folder_read and
--     requeue_folder_clips (files.manage), retry_clip, and ai_spend_today
--     (the daily limit and what was spent, for the meter).
--   * A new permission, "Manage folders and read them with Gemini"
--     (files.manage), for Owner, Admin and Strategist/Editor. The page
--     key page.upload stays and is now labelled "Upload/Files"; uploading
--     stays footage.upload.
--   * The daily AI limit: app_settings ai.daily_cap_usd = 5. Only the
--     owner changes it (the rule app_settings already has).
--   * Today's prices for the two models the reader pays for.
--
-- House rules followed: nothing is open by default, every grant is
-- explicit, never DELETE, never TRUNCATE, the audit trail on the new
-- table, updated_at, realtime, no demo data.
--
-- Data it touches when it goes live: every raw clip gets its home folder
-- (the folder it is in today); a raw clip that is a photo is marked a
-- photo and is not queued for Gemini; a raw clip the team already
-- matched to a card by hand is marked read (done), so Gemini does not
-- read or link it again; two live records of one card's folder (if any)
-- keep the oldest. Nothing is removed.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The permission, in "Footage and edits" after "Reply to directions
--    and notes" (60). Owner, Admin and Strategist/Editor get it.
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('files.manage', 'footage', 'Footage and edits', 'Manage folders and read them with Gemini', 'Make, rename, move and remove your team''s folders in Files, see the folders that were in the drive before, and have Gemini read a folder.', 65);

insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, 'files.manage', null
from public.roles r
where r.key in ('owner', 'admin', 'strategist')
  and r.deleted_at is null
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = 'files.manage' and x.deleted_at is null);

-- The page is "Upload/Files" now (the same key, page.upload; a page key is labelled as its screen).
update public.permissions set label = 'Upload/Files' where key = 'page.upload';

-- ---------------------------------------------------------------------
-- 2. Folders
-- ---------------------------------------------------------------------
alter table public.drive_folders drop constraint drive_folders_purpose_check;
alter table public.drive_folders add constraint drive_folders_purpose_check
  check (purpose in ('root', 'space', 'week', 'day', 'day_raw', 'card', 'card_raw', 'card_edits', 'card_final',
                     'new_uploads', 'week_raw', 'team', 'legacy'));

alter table public.drive_folders
  add column parent_drive_folder_id text,
  add column ai_summary text check (length(ai_summary) <= 4000),
  add column ai_summary_run_id uuid references public.agent_runs (id),
  add column ai_read_at timestamptz,
  add column needs_sync boolean not null default false;
comment on column public.drive_folders.parent_drive_folder_id is 'The Drive id of the folder this one sits in. Null for the shared drive itself.';
comment on column public.drive_folders.ai_summary is 'Gemini''s two lines about what is inside. Our server writes it.';
comment on column public.drive_folders.ai_read_at is 'When Gemini last wrote the summary of this folder.';
comment on column public.drive_folders.needs_sync is 'True when Google Drive was down during a rename or a move: the sweeper redoes it.';
comment on table public.drive_folders is 'Google Drive folders the app knows (space, New uploads, week, Raw, day, card, a team''s own, and those from before the app), tracked by Drive id.';

-- A new kind always says what it belongs to (not valid: only rows from now on are checked).
alter table public.drive_folders add constraint drive_folders_new_uploads_space check (purpose <> 'new_uploads' or space_id is not null) not valid;
alter table public.drive_folders add constraint drive_folders_week_raw_week check (purpose <> 'week_raw' or week_id is not null) not valid;
alter table public.drive_folders add constraint drive_folders_card_card check (purpose <> 'card' or card_id is not null) not valid;

-- Two live records of one card's folder (none are expected): the oldest stays, the others are marked removed.
update public.drive_folders f
   set deleted_at = now()
  from (select id, row_number() over (partition by card_id order by created_at, id) as n
          from public.drive_folders
         where deleted_at is null and purpose = 'card' and card_id is not null) d
 where f.id = d.id and d.n > 1;

create unique index drive_folders_new_uploads_key on public.drive_folders (space_id)
  where deleted_at is null and purpose = 'new_uploads';
create unique index drive_folders_week_raw_key on public.drive_folders (week_id)
  where deleted_at is null and purpose = 'week_raw';
create unique index drive_folders_card_key on public.drive_folders (card_id)
  where deleted_at is null and purpose = 'card';

-- The first upload flow's folders ("Week of ... > day > Raw") carry no week_id: one per space and day, as before.
-- The new tree's week and day folders carry their week: one week folder per week, one day folder per week and day.
-- So both trees can hold a folder for the same day.
drop index public.drive_folders_day_place_key;
create unique index drive_folders_day_place_key
  on public.drive_folders (space_id, purpose, day)
  where deleted_at is null and card_id is null and week_id is null and day is not null and purpose in ('week', 'day', 'day_raw');
create unique index drive_folders_week_key on public.drive_folders (week_id)
  where deleted_at is null and week_id is not null and purpose = 'week';
create unique index drive_folders_week_day_key on public.drive_folders (week_id, day)
  where deleted_at is null and week_id is not null and card_id is null and day is not null and purpose = 'day';
create index drive_folders_parent_idx on public.drive_folders (parent_drive_folder_id) where deleted_at is null;

-- Gemini's lines are our server's to write, never a person's.
create or replace function private.drive_folders_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.ai_summary := null;
    new.ai_summary_run_id := null;
    new.ai_read_at := null;
  end if;
  return new;
end;
$$;
create trigger a_drive_folders_before_insert before insert on public.drive_folders
  for each row execute function private.drive_folders_before_insert();
create trigger c_guard_fixed before update on public.drive_folders
  for each row execute function private.guard_fixed_columns('', 'ai_summary,ai_summary_run_id,ai_read_at');

-- Who sees and writes folder records. As before: a card's folder follows the card, a space's folder the space,
-- and planners write them. New: a team folder (and a folder from before the app) is also written by people who
-- manage folders, and the folders from before the app are seen only by them.
drop policy drive_folders_select on public.drive_folders;
create policy drive_folders_select on public.drive_folders for select to authenticated
  using (case
           when purpose = 'legacy' then (select private.has_permission('files.manage'))
                                        and (space_id is null or (select private.can_see_space(space_id)))
           when card_id is not null then (select private.can_see_card(card_id))
           when space_id is not null then (select private.can_see_space(space_id))
           else (select private.is_active_user())
         end);
drop policy drive_folders_insert on public.drive_folders;
create policy drive_folders_insert on public.drive_folders for insert to authenticated
  with check (((select private.can_plan_card(card_id))
               or (purpose in ('team', 'legacy') and card_id is null and (select private.has_permission('files.manage'))))
              and (space_id is null or (select private.can_see_space(space_id))));
drop policy drive_folders_update on public.drive_folders;
create policy drive_folders_update on public.drive_folders for update to authenticated
  using (((select private.can_plan_card(card_id))
          or (purpose in ('team', 'legacy') and card_id is null and (select private.has_permission('files.manage'))))
         and (space_id is null or (select private.can_see_space(space_id))))
  with check (((select private.can_plan_card(card_id))
               or (purpose in ('team', 'legacy') and card_id is null and (select private.has_permission('files.manage'))))
              and (space_id is null or (select private.can_see_space(space_id))));

-- ---------------------------------------------------------------------
-- 3. Drops
-- ---------------------------------------------------------------------
alter table public.upload_batches alter column day drop not null;
alter table public.upload_batches
  add column drive_folder_id text,
  add column origin text not null default 'upload' check (origin in ('upload', 'files', 'folder_read')),
  add column ai_summary text check (length(ai_summary) <= 4000),
  add column summary_run_id uuid references public.agent_runs (id);
comment on column public.upload_batches.day is 'The day of the old day inbox. Null for a drop of the Upload/Files flow, which asks no day.';
comment on column public.upload_batches.drive_folder_id is 'The Drive id of the folder the files were dropped into.';
comment on column public.upload_batches.origin is 'How the files came in: upload (the mass upload into New uploads), files (a drop on a folder in Files), folder_read (Read this folder with Gemini).';
comment on column public.upload_batches.ai_summary is 'Gemini''s two lines about the whole drop, written by our server once every file is read.';
comment on table public.upload_batches is 'One drop of files into a folder of a space: who, from which device, when, how it came in, and Gemini''s lines about it.';
create index upload_batches_recent_idx on public.upload_batches (space_id, uploaded_at desc) where deleted_at is null;

create or replace function private.upload_batches_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.ai_summary := null;
    new.summary_run_id := null;
    if new.origin = 'folder_read' and not private.has_permission('files.manage') then
      raise exception 'Only people who manage folders have Gemini read a folder' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger a_upload_batches_before_insert before insert on public.upload_batches
  for each row execute function private.upload_batches_before_insert();
-- How it came in never changes; Gemini's lines are our server's; the folder is saved once.
create trigger c_guard_fixed before update on public.upload_batches
  for each row execute function private.guard_fixed_columns('origin', 'ai_summary,summary_run_id', 'drive_folder_id');

-- ---------------------------------------------------------------------
-- 4. Files
-- ---------------------------------------------------------------------
alter table public.raw_clips alter column shot_on drop not null;
alter table public.raw_clips
  add column kind text not null default 'video' check (kind in ('video', 'photo')),
  add column has_speech boolean,
  add column ai_title text check (length(ai_title) <= 300),
  add column ai_summary text check (length(ai_summary) <= 4000),
  add column home_drive_folder_id text,
  add column index_attempts int not null default 0 check (index_attempts >= 0),
  add column index_hold text check (index_hold in ('cap')),
  add column next_try_at timestamptz,
  add column claimed_at timestamptz,
  add column index_error text check (length(index_error) <= 1000),
  add column storage_provider text not null default 'gdrive' check (storage_provider in ('gdrive', 'r2'));
comment on column public.raw_clips.kind is 'video: a file with sound to read (a video or a sound file). photo: never read by Gemini, costs nothing.';
comment on column public.raw_clips.has_speech is 'False: a "No sound video" (no audio, or silence). Null: not known yet.';
comment on column public.raw_clips.ai_title is 'A short title Gemini wrote from the transcript. Null without speech.';
comment on column public.raw_clips.ai_summary is 'One or two lines Gemini wrote from the transcript.';
comment on column public.raw_clips.home_drive_folder_id is 'The Drive id of the folder the file was dropped into. Saved once. It decides what a match does: dropped into New uploads or a week, the file moves to the matched week''s Raw; anywhere else it stays.';
comment on column public.raw_clips.drive_folder_id is 'The Drive id of the folder the file is in now.';
comment on column public.raw_clips.index_attempts is 'How many times the reader started on this file. After six it is failed and Retry is offered.';
comment on column public.raw_clips.index_hold is 'cap: today''s AI limit is reached, the file waits ("Waiting: daily limit reached").';
comment on column public.raw_clips.next_try_at is 'Not before this time: the wait after a failed try.';
comment on column public.raw_clips.claimed_at is 'When a reader took this file. A reader that stops answering loses it after the lease.';
comment on column public.raw_clips.index_error is 'Why the last try failed, in plain words.';
comment on column public.raw_clips.storage_provider is 'Where the file lives: gdrive today.';
comment on table public.raw_clips is 'Each raw file in Google Drive (by Drive file id), the folder it was dropped into and where it is now, and what Gemini found in its sound.';

-- What is there today: a photo is a photo and is not read; every file's home is the folder it is in.
update public.raw_clips set kind = 'photo' where mime_type ilike 'image/%' and kind <> 'photo';
update public.raw_clips set index_status = 'done' where kind = 'photo' and index_status = 'queued';
update public.raw_clips set home_drive_folder_id = drive_folder_id where home_drive_folder_id is null and drive_folder_id is not null;
-- Nothing uploaded before this migration is read (owner, Nov 16 2026): those files are already tied to their rows,
-- and reading them would cost money and could link them to a card a second time. Every file that is here today is
-- marked done as it is; it can still be matched by hand. Only files uploaded after this migration go to the reader.
update public.raw_clips r set index_status = 'done', index_error = null
 where r.deleted_at is null and r.index_status in ('queued', 'running', 'failed');

create index raw_clips_queue_idx on public.raw_clips (created_at)
  where deleted_at is null and kind = 'video' and index_status in ('queued', 'running');
create index raw_clips_folder_idx on public.raw_clips (drive_folder_id) where deleted_at is null;
create index raw_clips_home_idx on public.raw_clips (home_drive_folder_id) where deleted_at is null;

-- A raw file takes its space from its drop (and its day, in the old day inbox). What Gemini finds, and the
-- reader's bookkeeping, are our own server's to write, never the uploader's. A photo is never queued.
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
  if tg_op = 'INSERT' then
    if new.mime_type ilike 'image/%' then
      new.kind := 'photo';
    end if;
    if new.home_drive_folder_id is null then
      new.home_drive_folder_id := new.drive_folder_id;
    end if;
    if auth.uid() is not null then
      new.uploaded_by := auth.uid();
      new.index_status := 'queued';
      new.index_run_id := null;
      new.transcript := null;
      new.transcript_language := null;
      new.transcript_words := null;
      new.ai_index := '{}'::jsonb;
      new.thumbnail_r2_key := null;
      new.has_speech := null;
      new.ai_title := null;
      new.ai_summary := null;
      new.index_attempts := 0;
      new.index_hold := null;
      new.next_try_at := null;
      new.claimed_at := null;
      new.index_error := null;
      new.storage_provider := 'gdrive';
    end if;
    if new.kind = 'photo' and new.index_status = 'queued' then
      new.index_status := 'done';
    end if;
  end if;
  return new;
end;
$$;

-- The guard of a raw file, in place of the shared one, with the same rules and the same words:
--   * the file itself (drive_file_id) is fixed for everyone;
--   * the checksum and the home folder are saved once;
--   * what Gemini found and the reader's bookkeeping change only by our server, the database's own triggers,
--     and the one person action on them, public.retry_clip (which says so with a mark that lives only inside
--     its own transaction; the browser cannot set it).
create or replace function private.guard_raw_clip()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_col text;
begin
  if new.drive_file_id is distinct from old.drive_file_id then
    raise exception '% on % is fixed once saved: a new file is a new row', 'drive_file_id', tg_table_name;
  end if;
  foreach v_col in array array['md5_checksum', 'home_drive_folder_id'] loop
    if jsonb_typeof(v_old -> v_col) is distinct from 'null' and (v_old -> v_col) is distinct from (v_new -> v_col) then
      raise exception '% on % is fixed once saved', v_col, tg_table_name;
    end if;
  end loop;
  if auth.uid() is not null and pg_trigger_depth() = 1
     and coalesce(current_setting('noun_art.reader_call', true), '') <> 'on' then
    foreach v_col in array array[
      'index_status', 'index_run_id', 'transcript', 'transcript_language', 'transcript_words', 'ai_index',
      'thumbnail_r2_key', 'uploaded_by', 'kind', 'has_speech', 'ai_title', 'ai_summary', 'index_attempts',
      'index_hold', 'next_try_at', 'claimed_at', 'index_error', 'storage_provider'] loop
      if (v_old -> v_col) is distinct from (v_new -> v_col) then
        raise exception 'Only the system sets % on %', v_col, tg_table_name;
      end if;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger c_guard_fixed on public.raw_clips;
create trigger c_guard_fixed before update on public.raw_clips
  for each row execute function private.guard_raw_clip();

-- ---------------------------------------------------------------------
-- 5. Matches: auto_applied, written by our server only
-- ---------------------------------------------------------------------
alter table public.clip_match_suggestions add column auto_applied boolean not null default false;
comment on column public.clip_match_suggestions.auto_applied is 'True: Gemini was sure and the file was filed under this card without asking. It can be undone.';
drop trigger c_guard_fixed on public.clip_match_suggestions;
create trigger c_guard_fixed before update on public.clip_match_suggestions
  for each row execute function private.guard_fixed_columns(
    'raw_clip_id,card_id,run_id', 'confidence,rank,reason,provider_key,model_key,auto_applied');

-- ---------------------------------------------------------------------
-- 6. The undo ledger
-- ---------------------------------------------------------------------
create table public.raw_clip_moves (
  id uuid primary key default gen_random_uuid(),
  raw_clip_id uuid not null references public.raw_clips (id),
  -- The file's space, so who opens the space sees the row.
  space_id uuid not null references public.spaces (id),
  card_id uuid not null references public.cards (id),
  suggestion_id uuid references public.clip_match_suggestions (id),
  -- The card_raw_clips row this match made (or found).
  link_id uuid references public.card_raw_clips (id),
  -- True: the original moved (same Drive id) from from_drive_folder_id to to_drive_folder_id.
  -- False: it stayed where it was and the card only got a shortcut.
  moved boolean not null default false,
  from_drive_folder_id text,
  to_drive_folder_id text,
  -- The shortcut in the card's folder.
  drive_shortcut_id text,
  -- True: Gemini filed it without asking. False: a person confirmed or picked the card.
  auto_applied boolean not null default false,
  confidence numeric(5, 2) check (confidence between 0 and 100),
  -- The person who matched it. Null: Gemini.
  made_by uuid references public.profiles (id),
  run_id uuid references public.agent_runs (id),
  undone_at timestamptz,
  undone_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check ((undone_at is null) or (undone_at >= created_at))
);
create unique index raw_clip_moves_live_key on public.raw_clip_moves (raw_clip_id, card_id)
  where undone_at is null and deleted_at is null;
create index raw_clip_moves_clip_idx on public.raw_clip_moves (raw_clip_id, created_at desc);
create index raw_clip_moves_card_idx on public.raw_clip_moves (card_id);
create index raw_clip_moves_space_idx on public.raw_clip_moves (space_id, created_at desc);
comment on table public.raw_clip_moves is 'The undo ledger of matches: for each file filed under a card, where it was, where it went, its shortcut and link, who or what did it, and when it was undone. Written only by the database''s own functions.';

do $$
begin
  execute 'alter table public.raw_clip_moves enable row level security';
  execute 'create trigger z_set_updated_at before update on public.raw_clip_moves for each row execute function private.set_updated_at()';
  execute 'create trigger no_hard_delete before delete on public.raw_clip_moves for each row execute function private.block_delete()';
  execute 'create trigger no_truncate before truncate on public.raw_clip_moves for each statement execute function private.block_delete()';
  execute 'create trigger zz_audit after insert or update on public.raw_clip_moves for each row execute function private.audit_row()';
end;
$$;
-- What a move was never changes: only the Drive details still missing are filled in, and the undo.
create trigger c_guard_fixed before update on public.raw_clip_moves
  for each row execute function private.guard_fixed_columns(
    'raw_clip_id,space_id,card_id,auto_applied,made_by,run_id', '',
    'suggestion_id,link_id,from_drive_folder_id,to_drive_folder_id,drive_shortcut_id,undone_at,undone_by');

revoke all on public.raw_clip_moves from public, anon, authenticated, service_role;
-- People read it. Nobody adds or changes a row by hand: the functions below do.
grant select on public.raw_clip_moves to authenticated;
grant select, insert, update on public.raw_clip_moves to service_role;

create policy raw_clip_moves_select on public.raw_clip_moves for select to authenticated
  using ((select private.can_see_space(space_id)));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.raw_clip_moves;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. What reading files cost is visible to the team (owner: every AI cost
--    shows under what it made). The runs of the two reader agents, their
--    calls and what they were about open to every active person; every
--    other agent's runs stay as they were (your own, or team.activity).
-- ---------------------------------------------------------------------
create policy agent_runs_reader_select on public.agent_runs for select to authenticated
  using (agent_key in ('clip_indexer', 'clip_matcher') and (select private.is_active_user()));
create policy agent_tool_calls_reader_select on public.agent_tool_calls for select to authenticated
  using ((select private.is_active_user())
         and exists (select 1 from public.agent_runs r where r.id = run_id and r.agent_key in ('clip_indexer', 'clip_matcher')));
create policy agent_run_outputs_reader_select on public.agent_run_outputs for select to authenticated
  using ((select private.is_active_user())
         and exists (select 1 from public.agent_runs r where r.id = run_id and r.agent_key in ('clip_indexer', 'clip_matcher')));

-- ---------------------------------------------------------------------
-- 8. The daily limit: helpers
-- ---------------------------------------------------------------------
-- Midnight in New York, the start of the day the limit counts.
create or replace function private.ai_day_start()
returns timestamptz language sql stable set search_path = '' as $$
  select date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York';
$$;

-- The limit in dollars (app_settings ai.daily_cap_usd). Missing or unreadable: 5. Never below zero.
create or replace function private.ai_daily_cap()
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare
  v numeric;
begin
  begin
    select (s.value #>> '{}')::numeric into v
      from public.app_settings s where s.key = 'ai.daily_cap_usd' and s.deleted_at is null;
  exception when others then
    v := null;
  end;
  return greatest(coalesce(v, 5), 0);
end;
$$;

-- What every agent run of today cost. A run still going counts as its estimate (the money held for it) until
-- its real cost is saved.
create or replace function private.ai_spent_today()
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(case
           when r.status in ('queued', 'running', 'waiting_approval')
             then greatest(r.total_cost_usd, coalesce(r.plan_cost_est_usd, 0))
           else r.total_cost_usd end), 0)
    from public.agent_runs r
   where r.created_at >= private.ai_day_start() and r.deleted_at is null;
$$;

-- Save what was paid: each call closes its run (once), adds its line (tool, model, tokens, cost) and says what it
-- was about. A run that is already closed is left alone, so the same answer sent twice is never counted twice.
-- p_calls: [{ "run_id", "tool_name", "provider_key", "model_key", "cost_usd", "tokens_in", "tokens_out",
--             "input_summary", "output_summary", "error" }]
create or replace function private.reader_record_calls(p_calls jsonb, p_table text, p_id uuid)
returns numeric language plpgsql security definer set search_path = '' as $$
declare
  v_call jsonb;
  v_run uuid;
  v_cost numeric;
  v_total numeric := 0;
  v_failed boolean;
begin
  if p_calls is null or jsonb_typeof(p_calls) <> 'array' then
    return 0;
  end if;
  for v_call in select e from jsonb_array_elements(p_calls) e loop
    v_run := nullif(v_call ->> 'run_id', '')::uuid;
    if v_run is null then
      continue;
    end if;
    v_cost := greatest(coalesce((v_call ->> 'cost_usd')::numeric, 0), 0);
    v_failed := nullif(v_call ->> 'error', '') is not null;
    update public.agent_runs r
       set status = case when v_failed then 'failed'::public.job_status else 'done'::public.job_status end,
           total_cost_usd = v_cost,
           error = left(nullif(v_call ->> 'error', ''), 1000),
           result_summary = left(v_call ->> 'output_summary', 1000),
           finished_at = now()
     where r.id = v_run and r.status in ('queued', 'running');
    if not found then
      continue;
    end if;
    insert into public.agent_tool_calls (run_id, seq, tool_name, provider_key, model_key, status, input_summary,
                                         output_summary, cost_usd, tokens_in, tokens_out, error, finished_at)
    values (v_run,
            coalesce((select max(t.seq) from public.agent_tool_calls t where t.run_id = v_run), 0) + 1,
            coalesce(nullif(v_call ->> 'tool_name', ''), 'gemini'),
            v_call ->> 'provider_key', v_call ->> 'model_key',
            case when v_failed then 'failed'::public.job_status else 'done'::public.job_status end,
            left(v_call ->> 'input_summary', 1000), left(v_call ->> 'output_summary', 1000),
            v_cost, (v_call ->> 'tokens_in')::int, (v_call ->> 'tokens_out')::int,
            left(nullif(v_call ->> 'error', ''), 1000), now());
    if p_table is not null and p_id is not null
       and not exists (select 1 from public.agent_run_outputs o
                        where o.run_id = v_run and o.entity_table = p_table and o.entity_id = p_id) then
      insert into public.agent_run_outputs (run_id, entity_table, entity_id) values (v_run, p_table, p_id);
    end if;
    v_total := v_total + v_cost;
  end loop;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------
-- 9. The reader's functions. Our server only (the service key).
-- ---------------------------------------------------------------------

-- Hold money for one paid call, against today's limit. One caller at a time (a lock for the length of the
-- transaction), so two readers can never both take the last dollar. When there is room it opens the agent run
-- that carries the estimate and answers its id; the real cost is saved later with the run's call
-- (finish_clip_index, save_reader_summary). Over the limit: ok is false and nothing is opened.
create or replace function public.reserve_ai_spend(p_agent text, p_est_usd numeric, p_inputs jsonb default '{}'::jsonb)
returns table (ok boolean, run_id uuid, cap_usd numeric, spent_usd numeric)
language plpgsql security definer set search_path = '' as $$
declare
  v_cap numeric;
  v_spent numeric;
  v_est numeric := coalesce(p_est_usd, 0);
  v_run uuid;
begin
  if v_est < 0 then
    raise exception 'An estimate cannot be below zero' using errcode = '22023';
  end if;
  if not exists (select 1 from public.agents a where a.key = p_agent and a.deleted_at is null) then
    raise exception 'No such agent: %', p_agent using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('noun_art.ai_spend'));
  v_cap := private.ai_daily_cap();
  v_spent := private.ai_spent_today();
  if v_spent >= v_cap or v_spent + v_est > v_cap then
    return query select false, null::uuid, v_cap, v_spent;
    return;
  end if;
  insert into public.agent_runs (agent_key, trigger, status, inputs, plan_cost_est_usd, started_at)
  values (p_agent, 'event', 'running', coalesce(p_inputs, '{}'::jsonb), v_est, now())
  returning id into v_run;
  return query select true, v_run, v_cap, v_spent + v_est;
end;
$$;
comment on function public.reserve_ai_spend(text, numeric, jsonb) is 'Server only. Holds an estimate against today''s AI limit (New York day) and opens the agent run for it; ok false when the limit is reached.';

-- Take the next files to read. A file is taken by one reader only (skip locked), for a lease: a reader that
-- stops answering loses the file after the lease and another takes it. Files that wait for the daily limit are
-- taken only when there is real room again: about what reading that one file costs (its length at Transcribe's
-- price, plus one Hydrogen call), so a held file is not taken and put back on every sweep near the limit. A file
-- the reader stopped on six times is marked failed.
-- It also closes the reader's own runs that a reader left open (it stopped between holding the money and saving
-- the call): after an hour such a run is closed as failed, counted at its estimate, so it no longer holds money
-- against the limit for the rest of the day.
create or replace function public.claim_clip_jobs(p_limit int default 4, p_lease_minutes int default 15)
returns table (id uuid, space_id uuid, upload_batch_id uuid, drive_file_id text, drive_folder_id text,
               home_drive_folder_id text, file_name text, mime_type text, size_bytes bigint, duration_ms int,
               index_attempts int, has_speech boolean, transcript text, transcript_language text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_limit int := least(greatest(coalesce(p_limit, 4), 1), 20);
  v_lease interval := make_interval(mins => least(greatest(coalesce(p_lease_minutes, 15), 1), 120));
  v_room numeric;
begin
  update public.agent_runs r
     set status = 'failed',
         total_cost_usd = greatest(r.total_cost_usd, coalesce(r.plan_cost_est_usd, 0)),
         error = 'The reader stopped before it saved this call. It is counted at its estimate.',
         finished_at = now()
   where r.agent_key in ('clip_indexer', 'clip_matcher') and r.status = 'running' and r.deleted_at is null
     and coalesce(r.started_at, r.created_at) < now() - interval '1 hour';

  update public.raw_clips r
     set index_status = 'failed', claimed_at = null,
         index_error = coalesce(r.index_error, 'The reader stopped on this file six times.')
   where r.deleted_at is null and r.kind = 'video' and r.index_status = 'running'
     and r.claimed_at < now() - v_lease and r.index_attempts >= 6;

  v_room := private.ai_daily_cap() - private.ai_spent_today();

  return query
  with picked as (
    select c.id
      from public.raw_clips c
     where c.deleted_at is null and c.kind = 'video'
       and ((c.index_status = 'queued'
             and (c.next_try_at is null or c.next_try_at <= now())
             -- about $0.006 a minute of sound (Transcribe, with a margin) and $0.01 for the match
             and (c.index_hold is null
                  or v_room >= 0.01 + coalesce(c.duration_ms, 60000) / 60000.0 * 0.006))
            or (c.index_status = 'running' and (c.claimed_at is null or c.claimed_at < now() - v_lease)))
     order by c.created_at, c.id
     limit v_limit
       for update skip locked)
  update public.raw_clips r
     set index_status = 'running', claimed_at = now(), index_attempts = r.index_attempts + 1,
         index_hold = null, next_try_at = null
    from picked
   where r.id = picked.id
  returning r.id, r.space_id, r.upload_batch_id, r.drive_file_id, r.drive_folder_id, r.home_drive_folder_id,
            r.file_name, r.mime_type, r.size_bytes, r.duration_ms, r.index_attempts, r.has_speech, r.transcript,
            r.transcript_language;
end;
$$;
comment on function public.claim_clip_jobs(int, int) is 'Server only. Takes up to p_limit queued files for the reader (skip locked, a lease of p_lease_minutes); a transcript already saved comes back with the file, so a retry never pays for it twice.';

-- The cards a file could belong to: the best p_limit cards of the file's space, across all its weeks, by how
-- much of each card's title, hook and script is in the transcript (and in the file's name). A card whose Shot
-- box is ticked gets a small lift. The reader hands these to Gemini, which picks.
create or replace function public.clip_card_candidates(p_clip uuid, p_limit int default 25)
returns table (card_id uuid, title text, hook text, script text, week_id uuid, week_name text, week_number int,
               planned_on date, shot boolean, score real)
language sql stable security definer set search_path = '' as $$
  with clip as (
    select r.space_id,
           lower(left(coalesce(r.transcript, ''), 6000)) as said,
           r.transcript_tsv as tsv,
           lower(regexp_replace(regexp_replace(r.file_name, '\.[A-Za-z0-9]+$', ''), '[_\-.]+', ' ', 'g')) as named
      from public.raw_clips r where r.id = p_clip
  ), scored as (
    select c.id, c.title, c.hook, c.script, c.week_id, w.name as week_name, w.number as week_number, c.planned_on,
           c.shot_at is not null as shot,
           (  extensions.word_similarity(lower(c.title), clip.said)
            + case when coalesce(c.hook, '') <> '' then extensions.word_similarity(lower(left(c.hook, 300)), clip.said) else 0 end
            + 0.5 * extensions.similarity(lower(c.title), clip.named)
            + 4 * ts_rank(clip.tsv,
                          replace(plainto_tsquery('simple'::regconfig,
                                                  left(c.title || ' ' || coalesce(c.hook, '') || ' ' || coalesce(c.script, ''), 3000))::text,
                                  '&', '|')::tsquery)
            + case when c.shot_at is not null then 0.15 else 0 end
           )::real as score
      from clip
      join public.cards c on c.space_id = clip.space_id and c.deleted_at is null
      join public.weeks w on w.id = c.week_id and w.deleted_at is null
  )
  select s.id, s.title, s.hook, left(s.script, 2000), s.week_id, s.week_name, s.week_number, s.planned_on, s.shot, s.score
    from scored s
   order by s.score desc, s.planned_on desc nulls last, s.id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;
comment on function public.clip_card_candidates(uuid, int) is 'Server only. The best cards a raw file could belong to, across every week of its space, for Gemini to pick from.';

-- Save what the reader found on one file. p_result ->> 'outcome' says what happened:
--   'transcribed'  the transcript is in: { transcript, language, words, duration_ms }. Saved at once, the file
--                  stays with the reader (its lease starts again). A later retry finds it and never pays twice.
--   'no_speech'    no audio, or silence: a "No sound video". Done, nothing to match.
--   'done'         { title, summary, index, suggestions: [{ card_id, confidence, reason }] (best first, up to 3),
--                    model: { provider_key, model_key },
--                    applied: { card_id, moved, from_drive_folder_id, to_drive_folder_id, drive_shortcut_id } }
--                  "applied" is set when Gemini was sure and the reader already filed the file in Drive: the
--                  suggestion is saved as accepted (auto_applied), the file is linked to the card and the move
--                  goes in the undo ledger. A card the reader filed under that is not among the guesses gets its
--                  own accepted row, so the move is never without its ledger. Without "applied" the suggestions
--                  wait for a person. The answer says "applied": "saved" (in the ledger), "refused" (the card is
--                  no longer a live card of this space: nothing is linked, and the reader takes its Drive work
--                  back) or null.
--   'held'         today's AI limit is reached: the file waits (index_hold = 'cap'), the try is not counted.
--   'retry'        { error }: it failed. Tried again later (2, 4, 8, 16, 32 minutes); after six tries: failed.
--   'gone'         the file is no longer in Drive (or its folder went to the trash): the clip is marked failed
--                  with that reason and Retry (never removed), so a folder brought back from the trash, or a
--                  file put back, is read again.
-- Every outcome may carry "calls" (see private.reader_record_calls): what was paid is saved whatever happened.
-- The same answer sent twice changes nothing the second time.
create or replace function public.finish_clip_index(p_clip uuid, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_clip public.raw_clips;
  v_outcome text := p_result ->> 'outcome';
  v_calls jsonb := coalesce(p_result -> 'calls', '[]'::jsonb);
  v_run uuid;
  v_s record;
  v_card uuid;
  v_conf numeric;
  v_sug uuid;
  v_ids uuid[] := '{}';
  v_applied jsonb := p_result -> 'applied';
  v_applied_card uuid;
  v_applied_sug uuid;
  v_moved boolean;
  v_link uuid;
  v_move uuid;
  v_open int := 0;
  v_failed boolean;
  v_applied_state text;
begin
  if v_outcome is null or v_outcome not in ('transcribed', 'no_speech', 'done', 'held', 'retry', 'gone') then
    raise exception 'Unknown outcome: %', coalesce(v_outcome, 'none') using errcode = '22023';
  end if;
  select * into v_clip from public.raw_clips r where r.id = p_clip for update;
  if not found then
    raise exception 'No such clip' using errcode = 'P0002';
  end if;

  perform private.reader_record_calls(v_calls, 'raw_clips', p_clip);
  v_run := coalesce(nullif(p_result ->> 'run_id', '')::uuid, nullif(v_calls -> 0 ->> 'run_id', '')::uuid);

  if v_clip.index_status = 'done' and v_outcome in ('done', 'no_speech') then
    return jsonb_build_object('ok', true, 'already', true, 'status', 'done');
  end if;
  if v_clip.index_status <> 'running' then
    -- another reader, or a person, already moved this file on
    return jsonb_build_object('ok', false, 'reason', 'not_running', 'status', v_clip.index_status);
  end if;

  if v_outcome = 'transcribed' then
    update public.raw_clips r
       set transcript = p_result ->> 'transcript',
           transcript_language = p_result ->> 'language',
           transcript_words = p_result -> 'words',
           duration_ms = coalesce((p_result ->> 'duration_ms')::int, r.duration_ms),
           has_speech = true,
           index_run_id = coalesce(v_run, r.index_run_id),
           claimed_at = now(),
           index_error = null
     where r.id = p_clip;
    return jsonb_build_object('ok', true, 'status', 'running');

  elsif v_outcome = 'no_speech' then
    update public.raw_clips r
       set has_speech = false, index_status = 'done', claimed_at = null, index_error = null, index_hold = null,
           next_try_at = null, duration_ms = coalesce((p_result ->> 'duration_ms')::int, r.duration_ms)
     where r.id = p_clip;

  elsif v_outcome = 'held' then
    update public.raw_clips r
       set index_status = 'queued', index_hold = 'cap', claimed_at = null,
           index_attempts = greatest(r.index_attempts - 1, 0)
     where r.id = p_clip;
    return jsonb_build_object('ok', true, 'status', 'queued', 'hold', 'cap');

  elsif v_outcome = 'retry' then
    v_failed := v_clip.index_attempts >= 6;
    update public.raw_clips r
       set index_status = case when v_failed then 'failed'::public.job_status else 'queued'::public.job_status end,
           index_error = left(coalesce(nullif(p_result ->> 'error', ''), 'Gemini could not read this file.'), 1000),
           next_try_at = case when v_failed then null
                              else now() + make_interval(mins => least(60, (2 ^ greatest(r.index_attempts, 1))::int)) end,
           claimed_at = null
     where r.id = p_clip;
    return jsonb_build_object('ok', true, 'status', case when v_failed then 'failed' else 'queued' end);

  elsif v_outcome = 'gone' then
    update public.raw_clips r
       set index_status = 'failed', claimed_at = null, next_try_at = null, index_hold = null,
           index_error = 'The file is no longer in Google Drive, or its folder is in the trash. Put it back, then press Retry.'
     where r.id = p_clip;
    return jsonb_build_object('ok', true, 'status', 'failed');

  else -- done
    -- guesses of an earlier read step aside
    update public.clip_match_suggestions s
       set outcome = 'replaced'
     where s.raw_clip_id = p_clip and s.outcome = 'pending' and s.deleted_at is null;

    v_applied_card := nullif(v_applied ->> 'card_id', '')::uuid;
    for v_s in
      select e.value as j, e.ordinality as n
        from jsonb_array_elements(coalesce(p_result -> 'suggestions', '[]'::jsonb)) with ordinality e
       order by e.ordinality
       limit 3
    loop
      v_card := nullif(v_s.j ->> 'card_id', '')::uuid;
      continue when v_card is null;
      continue when not exists (select 1 from public.cards c
                                 where c.id = v_card and c.space_id = v_clip.space_id and c.deleted_at is null);
      v_conf := least(greatest(coalesce((v_s.j ->> 'confidence')::numeric, 0), 0), 100);
      insert into public.clip_match_suggestions (raw_clip_id, card_id, confidence, rank, reason, run_id,
                                                 provider_key, model_key)
      values (p_clip, v_card, v_conf, v_s.n::smallint, left(v_s.j ->> 'reason', 1000), v_run,
              p_result -> 'model' ->> 'provider_key', p_result -> 'model' ->> 'model_key')
      returning id into v_sug;
      v_ids := v_ids || v_sug;
      if v_card = v_applied_card and v_applied_sug is null then
        v_applied_sug := v_sug;
      end if;
    end loop;

    -- the card it was filed under is not among the guesses (or Gemini named it a fourth time): its own row, so
    -- what was done in Drive always has its ledger and its Undo
    if v_applied_card is not null and v_applied_sug is null then
      if exists (select 1 from public.cards c
                  where c.id = v_applied_card and c.space_id = v_clip.space_id and c.deleted_at is null) then
        insert into public.clip_match_suggestions (raw_clip_id, card_id, confidence, rank, reason, run_id,
                                                   provider_key, model_key)
        values (p_clip, v_applied_card, null, (coalesce(array_length(v_ids, 1), 0) + 1)::smallint,
                'Filed by the reader', v_run,
                p_result -> 'model' ->> 'provider_key', p_result -> 'model' ->> 'model_key')
        returning id into v_applied_sug;
        v_ids := v_ids || v_applied_sug;
      else
        v_applied_state := 'refused';
      end if;
    end if;

    v_moved := coalesce((v_applied ->> 'moved')::boolean, false);
    if v_applied_sug is not null
       and not exists (select 1 from public.raw_clip_moves m
                        where m.raw_clip_id = p_clip and m.card_id = v_applied_card
                          and m.undone_at is null and m.deleted_at is null) then
      update public.clip_match_suggestions s
         set outcome = 'accepted', auto_applied = true, chosen_card_id = v_applied_card, decided_at = now()
       where s.id = v_applied_sug
      returning s.confidence into v_conf;
      select l.id into v_link from public.card_raw_clips l
       where l.card_id = v_applied_card and l.raw_clip_id = p_clip and l.deleted_at is null;
      if v_link is null then
        insert into public.card_raw_clips (card_id, raw_clip_id, suggestion_id, drive_shortcut_id, linked_by)
        values (v_applied_card, p_clip, v_applied_sug, nullif(v_applied ->> 'drive_shortcut_id', ''), null)
        returning id into v_link;
      end if;
      insert into public.raw_clip_moves (raw_clip_id, space_id, card_id, suggestion_id, link_id, moved,
                                         from_drive_folder_id, to_drive_folder_id, drive_shortcut_id,
                                         auto_applied, confidence, made_by, run_id)
      values (p_clip, v_clip.space_id, v_applied_card, v_applied_sug, v_link, v_moved,
              nullif(v_applied ->> 'from_drive_folder_id', ''), nullif(v_applied ->> 'to_drive_folder_id', ''),
              nullif(v_applied ->> 'drive_shortcut_id', ''), true, v_conf, null, v_run)
      returning id into v_move;
    end if;
    if v_applied_card is not null and v_applied_state is null then
      v_applied_state := 'saved';
    end if;

    update public.raw_clips r
       set ai_title = left(nullif(p_result ->> 'title', ''), 300),
           ai_summary = left(nullif(p_result ->> 'summary', ''), 4000),
           ai_index = coalesce(p_result -> 'index', r.ai_index),
           has_speech = coalesce(r.has_speech, true),
           index_status = 'done', claimed_at = null, index_error = null, index_hold = null, next_try_at = null,
           drive_folder_id = case when v_move is not null and v_moved
                                  then coalesce(nullif(v_applied ->> 'to_drive_folder_id', ''), r.drive_folder_id)
                                  else r.drive_folder_id end
     where r.id = p_clip;
  end if;

  -- how many files of the same drop the reader still has to read (0: the drop is ready for its summary)
  if v_clip.upload_batch_id is not null then
    select count(*)::int into v_open from public.raw_clips r
     where r.upload_batch_id = v_clip.upload_batch_id and r.deleted_at is null and r.kind = 'video'
       and r.index_status in ('queued', 'running');
  end if;
  return jsonb_build_object('ok', true, 'status', 'done', 'suggestion_ids', to_jsonb(v_ids), 'move_id', v_move,
                            'link_id', v_link, 'batch_id', v_clip.upload_batch_id, 'batch_open', v_open,
                            'applied', v_applied_state);
end;
$$;
comment on function public.finish_clip_index(uuid, jsonb) is 'Server only. Saves what the reader found on one raw file: the transcript, no speech, the title, summary and card suggestions (and an auto applied match, always with its ledger), a hold for the daily limit, a retry, or a file gone from Drive (failed, with Retry). Also saves what was paid.';

-- Gemini's two lines about a whole drop ('drop', an upload_batches id) or a folder ('folder', a drive_folders
-- id), with what the call cost.
create or replace function public.save_reader_summary(p_kind text, p_id uuid, p_summary text, p_calls jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_run uuid := nullif(p_calls -> 0 ->> 'run_id', '')::uuid;
begin
  if p_kind = 'drop' then
    perform private.reader_record_calls(p_calls, 'upload_batches', p_id);
    update public.upload_batches b
       set ai_summary = left(nullif(btrim(p_summary), ''), 4000), summary_run_id = coalesce(v_run, b.summary_run_id)
     where b.id = p_id;
  elsif p_kind = 'folder' then
    perform private.reader_record_calls(p_calls, 'drive_folders', p_id);
    update public.drive_folders f
       set ai_summary = left(nullif(btrim(p_summary), ''), 4000), ai_summary_run_id = coalesce(v_run, f.ai_summary_run_id),
           ai_read_at = now()
     where f.id = p_id;
  else
    raise exception 'Unknown kind: %', coalesce(p_kind, 'none') using errcode = '22023';
  end if;
  if not found then
    raise exception 'Nothing to summarize with that id' using errcode = 'P0002';
  end if;
end;
$$;
comment on function public.save_reader_summary(text, uuid, text, jsonb) is 'Server only. Saves Gemini''s lines about a drop or a folder, and what the call cost.';

-- The reader says it is alive: app_settings ai.reader_heartbeat = { "at": now, "running": true or false }.
-- Settings shows it on the Gemini reader card, and the app skips starting a second run while one is running.
-- No row is seeded: no row means the reader was never set up.
create or replace function public.reader_heartbeat(p_running boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v jsonb := jsonb_build_object('at', now(), 'running', coalesce(p_running, false));
begin
  insert into public.app_settings (key, value, description, updated_by)
  values ('ai.reader_heartbeat', v, 'When the Gemini reader last said it is alive, and whether a run is going. Written by the reader.', null)
  on conflict (key) do update set value = excluded.value, deleted_at = null;
end;
$$;
comment on function public.reader_heartbeat(boolean) is 'Server only. The reader writes when it was last alive and whether a run is going (app_settings ai.reader_heartbeat).';

-- ---------------------------------------------------------------------
-- 10. People's actions, each its own narrow function
-- ---------------------------------------------------------------------

-- One tap on a file: this file belongs to this card (confirm Gemini's guess, or pick another card). Needs
-- "Plan weeks and cards" on a card the person can plan, in the file's own space. It accepts the suggestion (when
-- there is one for that card), sets the file's other open guesses aside, links the file to the card and writes
-- the undo ledger. p_filing holds what was done in Drive, when the app already did it:
--   { "moved", "from_drive_folder_id", "to_drive_folder_id", "drive_shortcut_id" }
-- Calling it again for the same file and card changes nothing and answers the same move (already: true); Drive
-- details that were still missing are filled in then. The folders are checked, never taken on trust: a move starts
-- from the folder the file was dropped into (or is in now) and ends in a week's Raw of the file's own space that
-- the app keeps a live record of. Without a move, where it went is not saved.
create or replace function public.decide_clip_suggestion(p_clip uuid, p_card uuid, p_suggestion uuid default null,
                                                         p_filing jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_clip public.raw_clips;
  v_card public.cards;
  v_sug public.clip_match_suggestions;
  v_move public.raw_clip_moves;
  v_link uuid;
  v_filing jsonb := coalesce(p_filing, '{}'::jsonb);
  v_moved boolean := coalesce((v_filing ->> 'moved')::boolean, false);
  v_from text := nullif(v_filing ->> 'from_drive_folder_id', '');
  v_to text := nullif(v_filing ->> 'to_drive_folder_id', '');
  v_shortcut text := nullif(v_filing ->> 'drive_shortcut_id', '');
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in to match a file' using errcode = '42501';
  end if;
  if not private.has_permission('calendar.plan') then
    raise exception 'Only people who plan the calendar match files to cards' using errcode = '42501';
  end if;
  select * into v_clip from public.raw_clips r where r.id = p_clip and r.deleted_at is null for update;
  if not found or not private.can_see_space(v_clip.space_id) then
    raise exception 'No such file' using errcode = 'P0002';
  end if;
  select * into v_card from public.cards c where c.id = p_card and c.deleted_at is null;
  if not found or not private.can_plan_card(p_card) then
    raise exception 'No such card' using errcode = 'P0002';
  end if;
  if v_card.space_id <> v_clip.space_id then
    raise exception 'A raw clip can only feed cards of its own space' using errcode = '22023';
  end if;
  if not v_moved then
    v_from := null;
    v_to := null;
  elsif v_from is distinct from v_clip.home_drive_folder_id and v_from is distinct from v_clip.drive_folder_id then
    raise exception 'The file did not start in that folder' using errcode = '22023';
  elsif v_to is null or not exists (
      select 1 from public.drive_folders f
        join public.weeks w on w.id = f.week_id and w.space_id = v_clip.space_id
       where f.drive_folder_id = v_to and f.purpose = 'week_raw' and f.deleted_at is null) then
    raise exception 'A matched file moves only into a Raw folder of its own space' using errcode = '22023';
  end if;
  if p_suggestion is not null then
    select * into v_sug from public.clip_match_suggestions s
     where s.id = p_suggestion and s.raw_clip_id = p_clip and s.deleted_at is null;
    if not found or v_sug.card_id is distinct from p_card then
      raise exception 'That suggestion is not for this file and card' using errcode = '22023';
    end if;
  else
    select * into v_sug from public.clip_match_suggestions s
     where s.raw_clip_id = p_clip and s.card_id = p_card and s.deleted_at is null and s.outcome = 'pending'
     order by s.created_at desc limit 1;
  end if;

  -- already matched to this card: the same answer, nothing changes
  select * into v_move from public.raw_clip_moves m
   where m.raw_clip_id = p_clip and m.card_id = p_card and m.undone_at is null and m.deleted_at is null;
  if found then
    if (v_move.from_drive_folder_id is null and v_from is not null)
       or (v_move.to_drive_folder_id is null and v_to is not null)
       or (v_move.drive_shortcut_id is null and v_shortcut is not null) then
      update public.raw_clip_moves m
         set from_drive_folder_id = coalesce(m.from_drive_folder_id, v_from),
             to_drive_folder_id = coalesce(m.to_drive_folder_id, v_to),
             drive_shortcut_id = coalesce(m.drive_shortcut_id, v_shortcut),
             -- whether the original moved is known with where it went
             moved = case when m.to_drive_folder_id is null and v_to is not null then v_moved else m.moved end
       where m.id = v_move.id;
      update public.card_raw_clips l
         set drive_shortcut_id = coalesce(l.drive_shortcut_id, v_shortcut)
       where l.id = v_move.link_id and l.drive_shortcut_id is null and v_shortcut is not null;
      if v_move.to_drive_folder_id is null and v_to is not null and v_moved then
        update public.raw_clips r set drive_folder_id = v_to where r.id = p_clip;
      end if;
    end if;
    return jsonb_build_object('move_id', v_move.id, 'link_id', v_move.link_id, 'suggestion_id', v_move.suggestion_id,
                              'already', true);
  end if;

  if v_sug.id is not null then
    update public.clip_match_suggestions s
       set outcome = 'accepted', chosen_card_id = p_card
     where s.id = v_sug.id and s.outcome is distinct from 'accepted';
  end if;
  update public.clip_match_suggestions s
     set outcome = 'replaced', chosen_card_id = p_card
   where s.raw_clip_id = p_clip and s.outcome = 'pending' and s.deleted_at is null
     and s.id is distinct from v_sug.id;

  select l.id into v_link from public.card_raw_clips l
   where l.card_id = p_card and l.raw_clip_id = p_clip and l.deleted_at is null;
  if v_link is null then
    insert into public.card_raw_clips (card_id, raw_clip_id, suggestion_id, drive_shortcut_id)
    values (p_card, p_clip, v_sug.id, v_shortcut)
    returning id into v_link;
  elsif v_shortcut is not null then
    update public.card_raw_clips l set drive_shortcut_id = coalesce(l.drive_shortcut_id, v_shortcut) where l.id = v_link;
  end if;

  insert into public.raw_clip_moves (raw_clip_id, space_id, card_id, suggestion_id, link_id, moved,
                                     from_drive_folder_id, to_drive_folder_id, drive_shortcut_id, auto_applied,
                                     confidence, made_by)
  values (p_clip, v_clip.space_id, p_card, v_sug.id, v_link, v_moved, v_from, v_to, v_shortcut, false,
          v_sug.confidence, auth.uid())
  returning * into v_move;

  if v_moved and v_to is not null then
    update public.raw_clips r set drive_folder_id = v_to where r.id = p_clip;
  end if;
  return jsonb_build_object('move_id', v_move.id, 'link_id', v_link, 'suggestion_id', v_sug.id, 'already', false);
end;
$$;
comment on function public.decide_clip_suggestion(uuid, uuid, uuid, jsonb) is 'Match a raw file to a card (confirm a suggestion or pick another card). Needs calendar.plan. Links the file, writes the undo ledger; safe to call twice.';

-- Take a match back (Gemini's or a person's). Needs "Plan weeks and cards" in the file's space. The move is
-- marked undone, the link to the card is closed (never deleted), the suggestion is marked rejected and the file
-- is where it was before. Pressing it twice changes nothing the second time. The answer says what to take back
-- in Drive (move the file back, put the shortcut in the trash).
create or replace function public.undo_clip_move(p_move uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_move public.raw_clip_moves;
  v_already boolean;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in to undo a match' using errcode = '42501';
  end if;
  if not private.has_permission('calendar.plan') then
    raise exception 'Only people who plan the calendar undo a match' using errcode = '42501';
  end if;
  select * into v_move from public.raw_clip_moves m where m.id = p_move and m.deleted_at is null for update;
  if not found or not private.can_see_space(v_move.space_id) then
    raise exception 'No such match' using errcode = 'P0002';
  end if;
  v_already := v_move.undone_at is not null;
  if not v_already then
    update public.raw_clip_moves m set undone_at = now(), undone_by = auth.uid() where m.id = p_move
    returning * into v_move;
    update public.card_raw_clips l
       set deleted_at = now(), unlinked_by = auth.uid()
     where l.id = v_move.link_id and l.deleted_at is null;
    update public.clip_match_suggestions s
       set outcome = 'rejected'
     where s.id = v_move.suggestion_id and s.outcome = 'accepted';
    if v_move.moved and v_move.from_drive_folder_id is not null then
      update public.raw_clips r set drive_folder_id = v_move.from_drive_folder_id where r.id = v_move.raw_clip_id;
    end if;
  end if;
  return jsonb_build_object('move_id', v_move.id, 'raw_clip_id', v_move.raw_clip_id, 'card_id', v_move.card_id,
                            'link_id', v_move.link_id, 'suggestion_id', v_move.suggestion_id, 'moved', v_move.moved,
                            'from_drive_folder_id', v_move.from_drive_folder_id,
                            'to_drive_folder_id', v_move.to_drive_folder_id,
                            'drive_shortcut_id', v_move.drive_shortcut_id, 'already', v_already);
end;
$$;
comment on function public.undo_clip_move(uuid) is 'Take a match back. Needs calendar.plan. Marks the move undone, closes the link, rejects the suggestion; safe to press twice.';

-- "Read this folder with Gemini": the files the app found in a folder of the drive (and below it) become one
-- drop of queued files. Needs "Manage folders and read them with Gemini" in a space the person opens. A file the
-- app already knows is skipped, so pressing it twice queues nothing twice.
-- p_files: [{ "drive_file_id", "file_name", "mime_type", "size_bytes", "duration_ms", "drive_folder_id",
--             "md5_checksum", "recorded_at" }], at most 2000 a call.
create or replace function public.request_folder_read(p_space uuid, p_drive_folder_id text, p_files jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch uuid;
  v_file jsonb;
  v_id text;
  v_queued int := 0;
  v_photos int := 0;
  v_skipped int := 0;
  v_status public.job_status;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in to read a folder' using errcode = '42501';
  end if;
  if not private.has_permission('files.manage') then
    raise exception 'Only people who manage folders have Gemini read a folder' using errcode = '42501';
  end if;
  if p_space is null or not private.can_see_space(p_space)
     or not exists (select 1 from public.spaces s where s.id = p_space and s.deleted_at is null) then
    raise exception 'No such space' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_drive_folder_id), '') = '' then
    raise exception 'Which folder?' using errcode = '22023';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' then
    raise exception 'The files must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_files) > 2000 then
    raise exception 'At most 2000 files at a time' using errcode = '22023';
  end if;

  for v_file in select e from jsonb_array_elements(p_files) e loop
    v_id := nullif(btrim(v_file ->> 'drive_file_id'), '');
    if v_id is null or coalesce(btrim(v_file ->> 'file_name'), '') = ''
       or exists (select 1 from public.raw_clips r where r.drive_file_id = v_id) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_batch is null then
      insert into public.upload_batches (space_id, day, uploaded_by, upload_source, origin, drive_folder_id)
      values (p_space, null, auth.uid(), 'import', 'folder_read', p_drive_folder_id)
      returning id into v_batch;
    end if;
    insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, home_drive_folder_id,
                                  file_name, mime_type, size_bytes, md5_checksum, duration_ms, recorded_at,
                                  upload_source)
    values (p_space, v_batch, v_id,
            coalesce(nullif(v_file ->> 'drive_folder_id', ''), p_drive_folder_id),
            coalesce(nullif(v_file ->> 'drive_folder_id', ''), p_drive_folder_id),
            left(v_file ->> 'file_name', 500), nullif(v_file ->> 'mime_type', ''),
            (v_file ->> 'size_bytes')::bigint, nullif(v_file ->> 'md5_checksum', ''),
            (v_file ->> 'duration_ms')::int, (v_file ->> 'recorded_at')::timestamptz, 'import')
    returning index_status into v_status;
    if v_status = 'queued' then
      v_queued := v_queued + 1;
    else
      v_photos := v_photos + 1;
    end if;
  end loop;
  return jsonb_build_object('batch_id', v_batch, 'queued', v_queued, 'photos', v_photos, 'skipped', v_skipped);
end;
$$;
comment on function public.request_folder_read(uuid, text, jsonb) is 'Read this folder with Gemini: the files found in a Drive folder become one drop of queued raw files. Needs files.manage. Files already known are skipped.';

-- Try a failed file again: back in the queue with its tries at zero. For anyone who uploads or plans, in a space
-- they open. Answers true when the file was put back, false when it was not failed (nothing changes).
create or replace function public.retry_clip(p_clip uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_clip public.raw_clips;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in to try a file again' using errcode = '42501';
  end if;
  select * into v_clip from public.raw_clips r where r.id = p_clip and r.deleted_at is null for update;
  if not found or not private.can_see_space(v_clip.space_id) then
    raise exception 'No such file' using errcode = 'P0002';
  end if;
  if not (private.has_permission('footage.upload') or private.has_permission('calendar.plan')) then
    raise exception 'Only people who upload or plan try a file again' using errcode = '42501';
  end if;
  if v_clip.index_status <> 'failed' then
    return false;
  end if;
  perform set_config('noun_art.reader_call', 'on', true);
  update public.raw_clips r
     set index_status = 'queued', index_attempts = 0, index_error = null, next_try_at = null, index_hold = null,
         claimed_at = null
   where r.id = p_clip;
  perform set_config('noun_art.reader_call', 'off', true);
  return true;
end;
$$;
comment on function public.retry_clip(uuid) is 'Try a failed raw file again: it goes back in the reader''s queue. For people who upload or plan, in a space they open.';

-- A team folder came back out of Google Drive's trash (Undo on Remove): the files in it and in the folders inside
-- it that the reader gave up on meanwhile ("no longer in Google Drive") go back in the queue, as Retry would. For
-- people who manage folders, in the spaces they open. p_drive_folder_ids: the folder and every folder inside it
-- (at most 2000). Answers how many files were put back.
create or replace function public.requeue_folder_clips(p_drive_folder_ids text[])
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if not private.has_permission('files.manage') then
    raise exception 'Only people who manage folders bring a folder back' using errcode = '42501';
  end if;
  if p_drive_folder_ids is null or coalesce(array_length(p_drive_folder_ids, 1), 0) = 0 then
    return 0;
  end if;
  if array_length(p_drive_folder_ids, 1) > 2000 then
    raise exception 'At most 2000 folders at a time' using errcode = '22023';
  end if;
  perform set_config('noun_art.reader_call', 'on', true);
  update public.raw_clips r
     set index_status = 'queued', index_attempts = 0, index_error = null, next_try_at = null, index_hold = null,
         claimed_at = null
   where r.deleted_at is null and r.kind = 'video' and r.index_status = 'failed'
     and r.drive_folder_id = any (p_drive_folder_ids)
     and private.can_see_space(r.space_id);
  get diagnostics v_n = row_count;
  perform set_config('noun_art.reader_call', 'off', true);
  return v_n;
end;
$$;
comment on function public.requeue_folder_clips(text[]) is 'Undo on Remove folder: the failed raw files in the folder and the folders inside it go back in the reader''s queue. Needs files.manage.';

-- The meter: today's AI limit, what was spent today (New York day), and how many files wait for the limit in
-- the spaces the caller opens. For every active person (the limit itself is changed only by the owner).
create or replace function public.ai_spend_today()
returns table (cap_usd numeric, spent_usd numeric, held int)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_service() and (auth.uid() is null or not private.is_active_user()) then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  return query
  select private.ai_daily_cap(), private.ai_spent_today(),
         (select count(*)::int from public.raw_clips r
           where r.deleted_at is null and r.index_status = 'queued' and r.index_hold = 'cap'
             and (private.is_service() or private.can_see_space(r.space_id)));
end;
$$;
comment on function public.ai_spend_today() is 'Today''s AI limit, what was spent today and how many files wait for the limit.';

-- ---------------------------------------------------------------------
-- 11. Function grants. Nothing is open by default.
-- ---------------------------------------------------------------------
revoke all on function
  private.drive_folders_before_insert(), private.upload_batches_before_insert(), private.guard_raw_clip(),
  private.ai_day_start(), private.ai_daily_cap(), private.ai_spent_today(),
  private.reader_record_calls(jsonb, text, uuid)
  from public, anon, authenticated, service_role;

revoke all on function
  public.reserve_ai_spend(text, numeric, jsonb), public.claim_clip_jobs(int, int),
  public.clip_card_candidates(uuid, int), public.finish_clip_index(uuid, jsonb),
  public.save_reader_summary(text, uuid, text, jsonb), public.reader_heartbeat(boolean),
  public.decide_clip_suggestion(uuid, uuid, uuid, jsonb), public.undo_clip_move(uuid),
  public.request_folder_read(uuid, text, jsonb), public.retry_clip(uuid), public.ai_spend_today(),
  public.requeue_folder_clips(text[])
  from public, anon, authenticated, service_role;

-- Our server only (the reader).
grant execute on function
  public.reserve_ai_spend(text, numeric, jsonb), public.claim_clip_jobs(int, int),
  public.clip_card_candidates(uuid, int), public.finish_clip_index(uuid, jsonb),
  public.save_reader_summary(text, uuid, text, jsonb), public.reader_heartbeat(boolean)
  to service_role;

-- Signed in people (each function checks the permission itself).
grant execute on function
  public.decide_clip_suggestion(uuid, uuid, uuid, jsonb), public.undo_clip_move(uuid),
  public.request_folder_read(uuid, text, jsonb), public.retry_clip(uuid), public.requeue_folder_clips(text[])
  to authenticated;
grant execute on function public.ai_spend_today() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 12. Seeds: the daily limit and today's prices (checked Nov 16 2026,
--     aistudio.google.com pricing). No demo data.
-- ---------------------------------------------------------------------
insert into public.app_settings (key, value, description) values
  ('ai.daily_cap_usd', '5', 'The most the AI may spend in one day (New York time), in dollars. Files wait when it is reached. Only the owner changes it.')
on conflict (key) do nothing;

update public.ai_models
   set pricing = '{"usd_per_minute": 0.005, "checked_on": "2026-11-16"}'::jsonb,
       description = 'Turns the sound of a raw file into text. It never sees the picture.'
 where provider_key = 'google' and model_key = 'gemini-3.5-transcribe';
update public.ai_models
   set pricing = '{"usd_per_mtok_in": 1.5, "usd_per_mtok_out": 7.5, "checked_on": "2026-11-16"}'::jsonb
 where provider_key = 'google' and model_key = 'gemini-4-hydrogen';
