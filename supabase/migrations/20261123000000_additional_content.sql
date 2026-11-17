-- =====================================================================
-- Noun ART: Additional content, a space of folders. A DRAFT, NOT LIVE.
-- Written Nov 16 2026 (owner: "Additional content" is its own space, the
-- third tile in Calendar; inside are folders instead of weeks, and the
-- same folders show in Files). It waits here, in supabase/drafts, for the
-- owner's yes; then it moves, unchanged, to
-- supabase/migrations/20261123000000_additional_content.sql in its own
-- push, after the code is pushed and republished, and AFTER
-- 20261122000000_files_and_reader.sql (it stops with a clear error when
-- that one has not run).
-- Behavior tests: supabase/tests/additional-content.test.mjs.
--
-- The code works on the old database too: with no spaces.kind column and
-- no space_folders table the readers fall back (no tile, no crash).
--
-- What it does, in plain words:
--   * spaces.kind: 'weekly' (weeks inside, as today) or 'folders' (folders
--     inside). Every space of today is weekly. The kind never changes once
--     saved. A folder goes only in a space of folders, a week only in a
--     weekly space.
--   * NEW table space_folders: a folder of one space (Sea salt spray batch,
--     Halloween special): address (slug), name, a code of 2 to 4 capitals
--     (SSB, HAL), a description, its order. One live folder per address,
--     per name and per code in a space.
--   * cards: a row now lives in a week OR in a folder (home_folder_id),
--     never both, never neither. cards.week_id may be empty. A folder row
--     takes its space from its folder; its day is free (no week to fall
--     inside).
--   * NEW table folder_cards: a week's row shown in a folder too. It is a
--     link, never a copy, and it may cross spaces (the Sea salt spray rows
--     stay in Noun Naturals, Week 1). A person sees a link only when they
--     can open the folder's space AND see the row itself.
--   * Removing a folder: only when no row lives in it. Its links are
--     marked removed with it. Nothing is ever deleted.
--   * drive_folders: one more kind, 'folder' (the Drive folder of a
--     space_folders row, folder_id), one live per folder.
--   * The reader's clip_card_candidates also offers rows that live in a
--     folder (it used to drop every row without a week).
--   * Seeds (each only when missing, so running twice changes nothing):
--     the space "Additional content", opened by everyone who opens Noun
--     Naturals content today; its two folders; the 6 Halloween videos as
--     rows of the Halloween folder with both Frame.io links (with music,
--     no music); the fixed label "No music cut"; and a link in the Sea
--     salt folder to every Week 1 row of Noun Naturals named SSB/0NN.
--
-- The functions that assumed a row always has a week, re-read:
--   * private.cards_before_write: replaced below (folder rows).
--   * private.guard_card_week_trash, private.week_trash_cards: unchanged.
--     They look a week up by the row's week_id; an empty one finds no
--     week, so a folder row never goes to the Trash with a week. A linked
--     row does go with its own week and comes back with it; its link row
--     stays as it is.
--   * public.set_card_shot, private.versions_before_insert and the status
--     automation work by card and never read the week: unchanged.
--   * public.clip_card_candidates (Upload/Files): replaced below.
--   * public.decide_clip_suggestion (Upload/Files): unchanged. A matched
--     file still moves only into a week's Raw, so in a space of folders a
--     match is saved without moving the file until that rule is widened.
--
-- No new permission key: calendar.plan adds, renames and removes folders
-- and adds and links rows; spaces.create adds a space of folders;
-- files.manage is the Drive side.
--
-- House rules followed (supabase/README.md): nothing is open by default,
-- every grant is explicit, never DELETE, never TRUNCATE, row level
-- security, the audit trail, updated_at and realtime on both new tables.
-- The rows it adds are the owner's real content, no demo data.
-- It runs with nobody signed in, as Supabase runs a migration.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Upload/Files first: this file re-creates a check that one re-creates.
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.raw_clip_moves') is null then
    raise exception 'Additional content runs after Upload/Files: push 20261122000000_files_and_reader.sql first';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. A space is weekly or a space of folders.
-- ---------------------------------------------------------------------
alter table public.spaces
  add column kind text not null default 'weekly' check (kind in ('weekly', 'folders'));
comment on column public.spaces.kind is 'weekly: weeks inside (the content calendar). folders: folders inside (Additional content). Never changes once saved.';
comment on table public.spaces is 'A space of content: weekly (its own weeks, table and views: Noun Naturals content, Founder content) or a space of folders (Additional content).';

create or replace function private.guard_space_kind()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- A migration (nobody signed in, not our server) may set anything.
  if new.kind is distinct from old.kind and (auth.uid() is not null or private.is_service()) then
    raise exception 'A space stays what it is: weeks or folders';
  end if;
  return new;
end;
$$;
comment on function private.guard_space_kind() is 'Spaces: the kind (weekly or folders) never changes once saved.';
create trigger c_guard_space_kind before update on public.spaces
  for each row execute function private.guard_space_kind();

-- A week goes only in a weekly space.
create or replace function private.weeks_space_kind()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.spaces s where s.id = new.space_id and s.kind = 'folders') then
    raise exception 'That space holds folders, not weeks';
  end if;
  return new;
end;
$$;
comment on function private.weeks_space_kind() is 'Weeks: no week in a space of folders.';
create trigger b_weeks_space_kind before insert on public.weeks
  for each row execute function private.weeks_space_kind();

-- ---------------------------------------------------------------------
-- 2. Folders of a space.
-- ---------------------------------------------------------------------
create table public.space_folders (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  slug text not null check (slug ~ '^[a-z0-9-]+$'),
  name text not null check (btrim(name) <> '' and char_length(name) <= 120),
  -- Row codes read "HAL 03": this code and the row's place in the folder.
  code text not null check (code ~ '^[A-Z]{2,4}$'),
  description text check (description is null or (char_length(description) <= 280 and btrim(description) <> '')),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz
);
create unique index space_folders_slug_key on public.space_folders (space_id, slug) where deleted_at is null;
create unique index space_folders_name_key on public.space_folders (space_id, lower(btrim(name))) where deleted_at is null;
create unique index space_folders_code_key on public.space_folders (space_id, code) where deleted_at is null;
create index space_folders_space_idx on public.space_folders (space_id, sort_order);
comment on table public.space_folders is 'A folder of a space of folders (Sea salt spray batch, Halloween special): address, name, code, order. Removed with deleted_at, and only when no row lives in it.';
comment on column public.space_folders.code is '2 to 4 capitals (SSB, HAL). A row of the folder reads "HAL 03": the code and its place.';

-- ---------------------------------------------------------------------
-- 3. Cards: a row lives in a week or in a folder.
-- ---------------------------------------------------------------------
alter table public.cards alter column week_id drop not null;
alter table public.cards add column home_folder_id uuid references public.space_folders (id);
alter table public.cards add constraint cards_one_home check (num_nonnulls(week_id, home_folder_id) = 1);
create index cards_home_folder_idx on public.cards (home_folder_id, sort_order) where deleted_at is null and home_folder_id is not null;
comment on column public.cards.week_id is 'The week this row lives in. Empty for a row that lives in a folder (home_folder_id).';
comment on column public.cards.home_folder_id is 'The folder this row lives in (a space of folders). Empty for a row of a week. Exactly one of week_id and home_folder_id is set.';
comment on table public.cards is 'One row of a week table or of a folder: space, week or folder, day, type, product, hook, script, links, editor, status, Shot.';

-- Start on "idea" when no status is given. A week row: the space comes from
-- the week and must match it, and the day falls inside the week. A folder
-- row: the space comes from the folder and must match it, the day is free,
-- and no row joins a removed folder. The Shot stamp is always the signed in
-- person and the time now (never typed).
create or replace function private.cards_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_week public.weeks%rowtype;
  v_folder public.space_folders%rowtype;
begin
  if new.status_id is null then
    select s.id into new.status_id from public.card_statuses s where s.key = 'idea';
  end if;
  if new.week_id is null and new.home_folder_id is null then
    raise exception 'A row needs a week or a folder';
  end if;
  if new.week_id is not null and new.home_folder_id is not null then
    raise exception 'A row lives in a week or in a folder, never both';
  end if;
  if new.week_id is not null then
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
  else
    select f.* into v_folder from public.space_folders f where f.id = new.home_folder_id;
    if v_folder.id is not null then
      if new.space_id is null then
        new.space_id := v_folder.space_id;
      elsif new.space_id <> v_folder.space_id then
        raise exception 'That folder belongs to another space';
      end if;
      -- A migration (nobody signed in, not our server) may set anything.
      if v_folder.deleted_at is not null
         and (auth.uid() is not null or private.is_service())
         and (tg_op = 'INSERT' or new.home_folder_id is distinct from old.home_folder_id
              or (old.deleted_at is not null and new.deleted_at is null)) then
        raise exception 'That folder was removed';
      end if;
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

-- ---------------------------------------------------------------------
-- 4. Folder rules: the creator is the signed in person, the space is
--    fixed and must be a space of folders, and a folder is removed only
--    when no row lives in it. Its links go with it.
-- ---------------------------------------------------------------------
create or replace function private.space_folders_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
    if new.deleted_at is not null and (auth.uid() is not null or private.is_service()) then
      raise exception 'A new folder cannot start removed';
    end if;
    if not exists (select 1 from public.spaces s where s.id = new.space_id and s.kind = 'folders') then
      raise exception 'Folders go in a space of folders';
    end if;
    return new;
  end if;
  if new.space_id is distinct from old.space_id then
    raise exception 'A folder stays in its space';
  end if;
  if old.deleted_at is null and new.deleted_at is not null
     and exists (select 1 from public.cards c where c.home_folder_id = new.id and c.deleted_at is null) then
    raise exception 'That folder still holds videos. Move or remove them first.';
  end if;
  return new;
end;
$$;
comment on function private.space_folders_before_write() is 'Folders: made by the signed in person, only in a space of folders, never moved to another space, removed only when no row lives in them.';

create or replace function private.space_folder_removed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.folder_cards l
       set deleted_at = new.deleted_at
     where l.folder_id = new.id and l.deleted_at is null;
  end if;
  return null;
end;
$$;
comment on function private.space_folder_removed() is 'Folders: a removed folder''s links are marked removed with it.';

-- ---------------------------------------------------------------------
-- 5. A week's row shown in a folder too: a link, never a copy.
-- ---------------------------------------------------------------------
create table public.folder_cards (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.space_folders (id),
  card_id uuid not null references public.cards (id),
  sort_order int not null default 0,
  added_by uuid references public.profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index folder_cards_live_key on public.folder_cards (folder_id, card_id) where deleted_at is null;
create index folder_cards_folder_idx on public.folder_cards (folder_id, sort_order) where deleted_at is null;
create index folder_cards_card_idx on public.folder_cards (card_id);
comment on table public.folder_cards is 'A row of a week (or of another folder) shown in a folder too. A link, never a copy; it may cross spaces. Unlinked with deleted_at.';

create or replace function private.folder_cards_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_home uuid;
  v_gone timestamptz;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.added_by := auth.uid();
    end if;
  elsif new.folder_id is distinct from old.folder_id or new.card_id is distinct from old.card_id then
    raise exception 'A link keeps its folder and its row: unlink it and add a new one';
  end if;
  -- A new link, or one brought back: the folder and the row are both live, and the row does not already live there.
  if (tg_op = 'INSERT' and new.deleted_at is null)
     or (tg_op = 'UPDATE' and old.deleted_at is not null and new.deleted_at is null) then
    if exists (select 1 from public.space_folders f where f.id = new.folder_id and f.deleted_at is not null) then
      raise exception 'That folder was removed';
    end if;
    select c.home_folder_id, c.deleted_at into v_home, v_gone from public.cards c where c.id = new.card_id;
    if v_gone is not null then
      raise exception 'That row was removed';
    end if;
    if v_home = new.folder_id then
      raise exception 'That video already lives in this folder';
    end if;
  end if;
  return new;
end;
$$;
comment on function private.folder_cards_before_write() is 'Folder links: added by the signed in person, folder and row fixed, only between a live folder and a live row that does not already live there.';

-- Before triggers fire in name order: a_ (fill), b_ (rules), c_ (guards), z_ (updated_at).
create trigger a_space_folders_before_write before insert or update on public.space_folders
  for each row execute function private.space_folders_before_write();
create trigger d_space_folder_removed after update on public.space_folders
  for each row execute function private.space_folder_removed();
create trigger a_folder_cards_before_write before insert or update on public.folder_cards
  for each row execute function private.folder_cards_before_write();

-- The steps the first migration ran in its loops, for the two new tables.
do $$
declare
  t text;
begin
  foreach t in array array['space_folders', 'folder_cards']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t);
    execute format('create trigger zz_audit after insert or update on public.%I for each row execute function private.audit_row()', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    -- Read, add and change (removing is a change). Never delete.
    execute format('grant select, insert, update on public.%I to authenticated, service_role', t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Who sees and changes folders and links.
--    Folders: by space, like weeks; planners add, rename and remove.
--    Links: only where the person opens the folder's space AND sees the
--    row (so a person without Noun Naturals sees the Sea salt folder but
--    none of its Week 1 rows); planners add and unlink under the same two.
-- ---------------------------------------------------------------------
create or replace function private.can_see_folder(p_folder uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.space_folders f where f.id = p_folder and private.can_see_space(f.space_id));
$$;
comment on function private.can_see_folder(uuid) is 'May the caller open this folder''s space?';

create policy space_folders_select on public.space_folders for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy space_folders_insert on public.space_folders for insert to authenticated
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));
create policy space_folders_update on public.space_folders for update to authenticated
  using ((select private.is_planner()) and (select private.can_see_space(space_id)))
  with check ((select private.is_planner()) and (select private.can_see_space(space_id)));

create policy folder_cards_select on public.folder_cards for select to authenticated
  using ((select private.can_see_folder(folder_id)) and (select private.can_see_card(card_id)));
create policy folder_cards_insert on public.folder_cards for insert to authenticated
  with check ((select private.is_planner()) and (select private.can_see_folder(folder_id)) and (select private.can_see_card(card_id)));
create policy folder_cards_update on public.folder_cards for update to authenticated
  using ((select private.is_planner()) and (select private.can_see_folder(folder_id)) and (select private.can_see_card(card_id)))
  with check ((select private.is_planner()) and (select private.can_see_folder(folder_id)) and (select private.can_see_card(card_id)));

-- ---------------------------------------------------------------------
-- 7. Drive: the folder of a folder.
-- ---------------------------------------------------------------------
alter table public.drive_folders drop constraint drive_folders_purpose_check;
alter table public.drive_folders add constraint drive_folders_purpose_check
  check (purpose in ('root', 'space', 'week', 'day', 'day_raw', 'card', 'card_raw', 'card_edits', 'card_final',
                     'new_uploads', 'week_raw', 'team', 'legacy', 'folder'));
alter table public.drive_folders add column folder_id uuid references public.space_folders (id);
alter table public.drive_folders add constraint drive_folders_folder_folder
  check (purpose <> 'folder' or (folder_id is not null and space_id is not null));
create unique index drive_folders_folder_key on public.drive_folders (folder_id)
  where deleted_at is null and purpose = 'folder';
create index drive_folders_folder_idx on public.drive_folders (folder_id) where folder_id is not null;
comment on column public.drive_folders.folder_id is 'The space_folders row this Drive folder belongs to. Kind "folder" is that folder''s own Drive folder (one live per folder), found by this id, never by name.';
comment on table public.drive_folders is 'Google Drive folders the app knows (space, New uploads, week, Raw, day, card, a folder of a space of folders, a team''s own, and those from before the app), tracked by Drive id.';

-- ---------------------------------------------------------------------
-- 8. The reader: rows that live in a folder are candidates too. The same
--    function as in Upload/Files, with the week now optional: a folder
--    row comes back with no week_id and its folder's name as week_name.
-- ---------------------------------------------------------------------
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
    select c.id, c.title, c.hook, c.script, c.week_id, coalesce(w.name, f.name) as week_name, w.number as week_number, c.planned_on,
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
      left join public.weeks w on w.id = c.week_id and w.deleted_at is null
      left join public.space_folders f on f.id = c.home_folder_id and f.deleted_at is null
     where w.id is not null or f.id is not null
  )
  select s.id, s.title, s.hook, left(s.script, 2000), s.week_id, s.week_name, s.week_number, s.planned_on, s.shot, s.score
    from scored s
   order by s.score desc, s.planned_on desc nulls last, s.id
   limit least(greatest(coalesce(p_limit, 25), 1), 100);
$$;
comment on function public.clip_card_candidates(uuid, int) is 'Server only. The best cards of a file''s space for Gemini to pick from, across all its weeks and folders. A row that lives in a folder has no week_id; week_name is then its folder''s name.';

-- ---------------------------------------------------------------------
-- 9. Function grants. Nothing is open by default.
-- ---------------------------------------------------------------------
revoke all on function
  private.guard_space_kind(), private.weeks_space_kind(), private.space_folders_before_write(),
  private.space_folder_removed(), private.folder_cards_before_write(), private.can_see_folder(uuid)
  from public, anon, authenticated, service_role;
-- The one helper the policies call.
grant execute on function private.can_see_folder(uuid) to authenticated, service_role;
-- clip_card_candidates stays our server's only (create or replace keeps the grants of Upload/Files; said again here).
revoke all on function public.clip_card_candidates(uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.clip_card_candidates(uuid, int) to service_role;

-- ---------------------------------------------------------------------
-- 10. Seeds: the owner's real content. Each step only adds what is
--     missing, so running it twice changes nothing.
-- ---------------------------------------------------------------------
insert into public.variant_kinds (key, label, sort_order)
select 'no_music', 'No music cut', coalesce((select max(k.sort_order) from public.variant_kinds k), 0) + 1
 where not exists (select 1 from public.variant_kinds k where k.key = 'no_music');

do $$
declare
  -- =================================================================
  -- THE ONE PLACE TO CHANGE BEFORE THE PUSH.
  -- The status of the 6 Halloween videos: not decided yet (the owner was
  -- asked, Nov 16 2026). 'review' is In review, which is also what the
  -- import makes of Notion's "Sent for approval to the client".
  c_halloween_status constant text := 'review';
  -- Frame.io share links. Per video links were not collected: every
  -- Halloween row carries the share of the whole Halloween folder, the
  -- same one for the cut with music and the cut without.
  c_halloween_music constant text := 'https://f.io/mNs2JX-8';
  c_halloween_no_music constant text := 'https://f.io/mNs2JX-8';
  c_sea_salt_share constant text := 'https://f.io/RFGP6_D9';
  -- =================================================================
  v_noun uuid;
  v_space uuid;
  v_ssb uuid;
  v_hal uuid;
  v_status uuid;
  v_week_ids uuid[];
  v_ssb_cards int;
begin
  select s.id into v_noun from public.spaces s where s.slug = 'noun' and s.deleted_at is null;

  -- The space. Found by its address, else by its name (someone may have added it by hand in Add a space).
  select s.id into v_space from public.spaces s where s.slug = 'additional';
  if v_space is null then
    select s.id into v_space from public.spaces s
     where s.deleted_at is null and lower(btrim(s.name)) = 'additional content';
    if v_space is not null then
      if exists (select 1 from public.weeks w where w.space_id = v_space and w.deleted_at is null) then
        raise exception 'A space named "Additional content" already has weeks. Rename it, then push this again.';
      end if;
      update public.spaces set kind = 'folders' where id = v_space and kind <> 'folders';
    end if;
  end if;
  if v_space is null then
    insert into public.spaces (slug, name, short_name, kind, sort_order, created_by)
    values ('additional', 'Additional content', 'Additional', 'folders',
            coalesce((select max(s.sort_order) from public.spaces s where s.deleted_at is null), 0) + 1, null)
    returning id into v_space;
    -- Everyone who opens Noun Naturals content today opens it (owners and admins open every space without a row).
    if v_noun is not null then
      insert into public.person_spaces (profile_id, space_id, granted_by)
      select ps.profile_id, v_space, null
        from public.person_spaces ps
       where ps.space_id = v_noun and ps.deleted_at is null
         and not exists (select 1 from public.person_spaces x
                          where x.profile_id = ps.profile_id and x.space_id = v_space and x.deleted_at is null);
    end if;
  end if;
  -- An archived or weekly space under that address is left as it is, with nothing added to it.
  if exists (select 1 from public.spaces s where s.id = v_space and (s.deleted_at is not null or s.kind <> 'folders')) then
    return;
  end if;

  -- The two folders.
  insert into public.space_folders (space_id, slug, name, code, description, sort_order, created_by)
  select v_space, 'sea-salt-spray-batch', 'Sea salt spray batch', 'SSB',
         'The sea salt spray videos, from Week 1 of Noun Naturals content. Frame.io: ' || c_sea_salt_share, 1, null
   where not exists (select 1 from public.space_folders f
                      where f.space_id = v_space and (f.slug = 'sea-salt-spray-batch' or f.code = 'SSB'));
  insert into public.space_folders (space_id, slug, name, code, description, sort_order, created_by)
  select v_space, 'halloween-special', 'Halloween special', 'HAL',
         'Six Halloween videos, each with music and without.', 2, null
   where not exists (select 1 from public.space_folders f
                      where f.space_id = v_space and (f.slug = 'halloween-special' or f.code = 'HAL'));
  select f.id into v_ssb from public.space_folders f
   where f.space_id = v_space and f.slug = 'sea-salt-spray-batch' and f.deleted_at is null;
  select f.id into v_hal from public.space_folders f
   where f.space_id = v_space and f.slug = 'halloween-special' and f.deleted_at is null;

  -- The 6 Halloween videos, V1 to V6, as rows that live in the Halloween folder.
  if v_hal is not null then
    select s.id into v_status from public.card_statuses s where s.key = c_halloween_status;
    if v_status is null then
      raise exception 'No status with the key %', c_halloween_status;
    end if;
    insert into public.cards (space_id, home_folder_id, title, status_id, extra, sort_order, source, created_by)
    select v_space, v_hal, t.title, v_status,
           jsonb_build_object('Edited video', c_halloween_music, 'Edited video (no music)', c_halloween_no_music),
           t.ord, 'notion_import', null
      from (values (1, 'Trick or Shampoo'), (2, 'Candy or Shampoo'), (3, 'Giving Away Shampoo'),
                   (4, 'Halloween Giveaway'), (5, 'Treats and Free Shampoo'), (6, 'Candy AND Shampoo')) as t (ord, title)
     where not exists (select 1 from public.cards c
                        where c.home_folder_id = v_hal and btrim(c.title) = t.title)
     order by t.ord;
  end if;

  -- The Sea salt spray rows stay where they are (Noun Naturals content, Week 1) and show in the folder as links:
  -- every live row named SSB/0NN (SSB/001 to SSB/016; there is no SSB/008, so 15 today) of every live week
  -- numbered 1 (or named "Week 1") in that space: one today, and should there be two, the rows of both.
  -- A row already linked (live or unlinked by hand) stays as it is; new links go after the ones there.
  -- A database without such a week (a fresh one) is left as it is; with one and not one such row, this stops.
  if v_ssb is not null and v_noun is not null then
    select array_agg(w.id) into v_week_ids
      from public.weeks w
     where w.space_id = v_noun and w.deleted_at is null
       and coalesce(w.number, nullif(substring(w.name from '(?i)^\s*week\s*(\d{1,6})'), '')::int) = 1;
    if v_week_ids is not null then
      select count(*) into v_ssb_cards
        from public.cards c
       where c.week_id = any (v_week_ids) and c.deleted_at is null and c.title ~ '^SSB/0\d\d';
      if v_ssb_cards = 0 then
        raise exception 'Week 1 of Noun Naturals content has no row named SSB/0NN: nothing to link into the Sea salt spray folder';
      end if;
      insert into public.folder_cards (folder_id, card_id, sort_order, added_by)
      select v_ssb, c.id,
             coalesce((select max(l.sort_order) from public.folder_cards l where l.folder_id = v_ssb), 0)
               + row_number() over (order by c.title, c.sort_order, c.id),
             null
        from public.cards c
       where c.week_id = any (v_week_ids) and c.deleted_at is null and c.title ~ '^SSB/0\d\d'
         and not exists (select 1 from public.folder_cards l
                          where l.folder_id = v_ssb and l.card_id = c.id);
    end if;
  end if;
end;
$$;
