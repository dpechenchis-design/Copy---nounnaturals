-- =====================================================================
-- Noun ART: how an edited video came in (approved by the owner, Nov 16 2026).
-- Written Nov 15 2026 for the edited video flow (owner approved the flow
-- on Nov 15 2026). Behavior tests: supabase/tests/edit-intake.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
--
-- What it adds, in plain words:
--   * Every new version saves how it came in: uploaded from its row in the
--     week table, or in a mass upload. For a mass upload it also saves how
--     its title was found (the code in the file name, the AI, or picked by
--     hand), how sure the AI was (only for an AI match) and which mass
--     upload it was part of. These are set when the version is made and
--     never change. Older versions simply have them empty.
--   * edit_upload_batches: one mass upload of edited videos. Who, which
--     space, how many files, how many were matched by code, by the AI, by
--     hand, and how many were left unmatched.
--   * edit_match_suggestions: the AI's answer for one file of a mass
--     upload: the title it suggested, how sure, why in words, the model,
--     what watching the file cost in dollars (the cost under every Gemini
--     match), the other titles it weighed, what the person chose and when,
--     and the version the file became. Only our own server writes the AI's
--     part; a person records their choice through one narrow function,
--     public.decide_edit_match.
--
-- Why: clean data is the core goal. The future AI editor and AI agent
-- learn from how every version came in and how good the matching was.
--
-- Rules followed (supabase/README.md): explicit grants, never DELETE, row
-- level security, no_hard_delete, no_truncate, zz_audit, updated_at,
-- realtime, a narrow function for the person's action on a server owned
-- row, no demo data, no seed rows, no new permission key (footage.upload).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table public.edit_upload_batches (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id),
  uploaded_by uuid references public.profiles (id) default auth.uid(),
  file_count int not null default 0 check (file_count >= 0),
  matched_by_code int not null default 0 check (matched_by_code >= 0),
  matched_by_ai int not null default 0 check (matched_by_ai >= 0),
  matched_by_hand int not null default 0 check (matched_by_hand >= 0),
  unmatched int not null default 0 check (unmatched >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- a file left out (one of two files for one title) is in no count
  check (matched_by_code + matched_by_ai + matched_by_hand + unmatched <= file_count)
);
create index edit_upload_batches_space_idx on public.edit_upload_batches (space_id, created_at desc) where deleted_at is null;
create index edit_upload_batches_uploaded_by_idx on public.edit_upload_batches (uploaded_by);
comment on table public.edit_upload_batches is 'One mass upload of edited videos: who, which space, how many files, and how each was matched (code, AI, by hand, not matched).';

create table public.edit_match_suggestions (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.edit_upload_batches (id),
  file_name text not null check (btrim(file_name) <> ''),
  -- The AI's best title for the file; null when no title fit.
  card_id uuid references public.cards (id),
  confidence numeric(5, 2) check (confidence between 0 and 100),
  reason text,
  -- The other titles it weighed, best first: [{ "card_id": ..., "confidence": ..., "reason": ... }].
  alternatives jsonb not null default '[]'::jsonb check (jsonb_typeof(alternatives) = 'array'),
  run_id uuid references public.agent_runs (id),
  provider_key text not null,
  model_key text not null,
  ai_model_id uuid references public.ai_models (id),
  cost_usd numeric(12, 4) not null default 0 check (cost_usd >= 0),
  -- What the person chose (null with decided_at set: no title), who and when.
  chosen_card_id uuid references public.cards (id),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  -- The version the file became, once saved.
  version_id uuid references public.versions (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (card_id is null or confidence is not null)
);
create index edit_match_suggestions_batch_idx on public.edit_match_suggestions (batch_id);
create index edit_match_suggestions_card_idx on public.edit_match_suggestions (card_id);
create index edit_match_suggestions_model_idx on public.edit_match_suggestions (provider_key, model_key);
create unique index edit_match_suggestions_version_key on public.edit_match_suggestions (version_id) where version_id is not null;
comment on table public.edit_match_suggestions is 'The AI''s suggested title for one file of a mass upload: confidence, why, model, cost, what the person chose, and the version it became.';

-- ---------------------------------------------------------------------
-- 2. Versions: how each one came in
-- ---------------------------------------------------------------------
alter table public.versions
  add column intake_via text check (intake_via in ('row', 'mass')),
  add column match_method text check (match_method in ('code', 'ai', 'picked')),
  add column match_confidence numeric(5, 2) check (match_confidence between 0 and 100),
  add column edit_upload_batch_id uuid references public.edit_upload_batches (id);
alter table public.versions add constraint versions_intake_check check (
  -- not known (an older row, or code that does not say yet)
  (intake_via is null and match_method is null and match_confidence is null and edit_upload_batch_id is null)
  -- uploaded from its row: no match, no batch
  or (intake_via = 'row' and match_method is null and match_confidence is null and edit_upload_batch_id is null)
  -- a mass upload: always its batch and how the title was found; a percent only for an AI match, and always then
  or (intake_via = 'mass' and match_method is not null and edit_upload_batch_id is not null
      and (match_method = 'ai') = (match_confidence is not null))
);
create index versions_edit_batch_idx on public.versions (edit_upload_batch_id) where edit_upload_batch_id is not null;
comment on column public.versions.intake_via is 'How the version was uploaded: row (from its row) or mass (a mass upload). Null for older rows. Fixed once saved.';
comment on column public.versions.match_method is 'A mass upload only: how its title was found: code (in the file name), ai, or picked by hand. Fixed once saved.';
comment on column public.versions.match_confidence is 'An AI match only: how sure the AI was, 0 to 100. Fixed once saved.';
comment on column public.versions.edit_upload_batch_id is 'A mass upload only: the mass upload it was part of. Fixed once saved.';

-- A version of a mass upload belongs to that upload: same space, and a
-- signed in person files a version only into their own mass upload.
create or replace function private.versions_check_edit_batch()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.edit_upload_batches;
begin
  if new.edit_upload_batch_id is null then
    return new;
  end if;
  select * into v_batch from public.edit_upload_batches b where b.id = new.edit_upload_batch_id;
  if v_batch.deleted_at is not null then
    raise exception 'That mass upload was removed';
  end if;
  if v_batch.space_id is distinct from (select c.space_id from public.cards c where c.id = new.card_id) then
    raise exception 'A version of a mass upload goes on a card of the same space';
  end if;
  if auth.uid() is not null and v_batch.uploaded_by is distinct from auth.uid() then
    raise exception 'A version goes only into your own mass upload' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.versions_check_edit_batch() from public, anon, authenticated;
create trigger a_versions_check_edit_batch before insert on public.versions
  for each row execute function private.versions_check_edit_batch();

-- The guard of the first migration, re-made with the longer fixed list: how
-- a version came in is set when it is made and never changes, for anyone.
drop trigger c_guard_fixed on public.versions;
create trigger c_guard_fixed before update on public.versions
  for each row execute function private.guard_fixed_columns(
    'card_id,number,r2_bucket,r2_key,intake_via,match_method,match_confidence,edit_upload_batch_id',
    'review_state,virality_score,is_reference,final_drive_file_id,size_bytes,duration_ms,width,height,thumbnail_r2_key,uploaded_by');

-- ---------------------------------------------------------------------
-- 3. Mass uploads and the AI's answers: their own rules
-- ---------------------------------------------------------------------
-- The space and who uploaded are fixed. A batch can be removed (deleted_at), never deleted.
create trigger c_guard_fixed before update on public.edit_upload_batches
  for each row execute function private.guard_fixed_columns('space_id,uploaded_by', '');

-- A suggested or chosen title is a card of the batch's space; a saved
-- version is on the chosen title (or the suggested one) and in this batch.
create or replace function private.edit_match_suggestions_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_space uuid := (select b.space_id from public.edit_upload_batches b where b.id = new.batch_id);
begin
  if new.card_id is not null
     and (select c.space_id from public.cards c where c.id = new.card_id) is distinct from v_space then
    raise exception 'The suggested title is not in this mass upload''s space';
  end if;
  if new.chosen_card_id is not null
     and (select c.space_id from public.cards c where c.id = new.chosen_card_id) is distinct from v_space then
    raise exception 'The chosen title is not in this mass upload''s space';
  end if;
  if new.version_id is not null and not exists (
       select 1 from public.versions v
        where v.id = new.version_id and v.edit_upload_batch_id = new.batch_id
          and v.card_id = coalesce(new.chosen_card_id, new.card_id)) then
    raise exception 'The version must be on the chosen title and part of this mass upload';
  end if;
  return new;
end;
$$;
revoke execute on function private.edit_match_suggestions_check() from public, anon, authenticated;
create trigger b_edit_match_suggestions_check before insert or update on public.edit_match_suggestions
  for each row execute function private.edit_match_suggestions_check();

-- The file and the AI's answer are fixed; the AI's part is our own server's
-- (as on clip_match_suggestions); the version it became is set once.
create trigger c_guard_fixed before update on public.edit_match_suggestions
  for each row execute function private.guard_fixed_columns(
    'batch_id,file_name,card_id',
    'confidence,reason,alternatives,run_id,provider_key,model_key,ai_model_id,cost_usd',
    'version_id');

-- The one way a person acts on a suggestion (README: a narrow function, never
-- a wide update permission): choose a title for the file (p_card null: no
-- title), and once the file is saved, the version it became. Who decided and
-- when are the caller and now. Allowed for the person who made the mass upload
-- or anyone who plans cards (calendar.plan), inside a space they open.
create or replace function public.decide_edit_match(p_suggestion uuid, p_card uuid, p_version uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_sug public.edit_match_suggestions;
  v_batch public.edit_upload_batches;
begin
  if auth.uid() is null or not private.is_active_user() then
    raise exception 'Sign in to choose a title' using errcode = '42501';
  end if;
  select * into v_sug from public.edit_match_suggestions s where s.id = p_suggestion and s.deleted_at is null;
  if not found then
    raise exception 'No such match' using errcode = 'P0002';
  end if;
  select * into v_batch from public.edit_upload_batches b where b.id = v_sug.batch_id;
  if v_batch.deleted_at is not null or not private.can_see_space(v_batch.space_id)
     or not (v_batch.uploaded_by = auth.uid() or private.is_planner()) then
    raise exception 'Only the person who made this mass upload, or a planner, chooses its titles' using errcode = '42501';
  end if;
  if v_sug.version_id is not null then
    raise exception 'This file is already saved as a version';
  end if;
  if p_card is not null and not private.can_see_card(p_card) then
    raise exception 'You cannot see that title' using errcode = '42501';
  end if;
  if p_version is not null and p_card is null then
    raise exception 'A saved version needs its title';
  end if;
  update public.edit_match_suggestions s
     set chosen_card_id = p_card, decided_by = auth.uid(), decided_at = now(), version_id = p_version
   where s.id = p_suggestion;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. The house steps for every new table (the first migration's loops ran once)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['edit_upload_batches', 'edit_match_suggestions']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t);
    execute format('create trigger zz_audit after insert or update on public.%I for each row execute function private.audit_row()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Grants. Nothing is open by default. Never DELETE.
-- ---------------------------------------------------------------------
revoke all on public.edit_upload_batches, public.edit_match_suggestions from public, anon, authenticated, service_role;
-- A person makes and updates their mass upload; reads the AI's answers, never writes them.
grant select, insert, update on public.edit_upload_batches to authenticated;
grant select on public.edit_match_suggestions to authenticated;
-- Our own server: reads and writes both, never deletes.
grant select, insert, update on public.edit_upload_batches, public.edit_match_suggestions to service_role;

revoke all on function public.decide_edit_match(uuid, uuid, uuid) from public, anon, service_role;
grant execute on function public.decide_edit_match(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Row level security
-- ---------------------------------------------------------------------
-- Mass uploads: seen by everyone who opens the space (like raw clip uploads);
-- made by someone who may upload (footage.upload), as themself, in a space
-- they open; changed by the person who made it or a planner.
create policy edit_upload_batches_select on public.edit_upload_batches for select to authenticated
  using ((select private.can_see_space(space_id)));
create policy edit_upload_batches_insert on public.edit_upload_batches for insert to authenticated
  with check ((select private.has_permission('footage.upload'))
              and uploaded_by = (select auth.uid()) and (select private.can_see_space(space_id)));
create policy edit_upload_batches_update on public.edit_upload_batches for update to authenticated
  using ((select private.can_see_space(space_id))
         and ((select private.is_planner()) or uploaded_by = (select auth.uid())))
  with check ((select private.can_see_space(space_id))
              and ((select private.is_planner()) or uploaded_by = (select auth.uid())));

-- The AI's answers: inside a mass upload the person can see, the person who
-- made it sees every answer; anyone else sees an answer when they can see the
-- title it suggests (no title: those who see every card). Written only by our server.
create policy edit_match_suggestions_select on public.edit_match_suggestions for select to authenticated
  using (exists (select 1 from public.edit_upload_batches b
                  where b.id = batch_id
                    and (b.uploaded_by = (select auth.uid()) or (select private.can_see_card(card_id)))));

-- ---------------------------------------------------------------------
-- 7. Realtime, like versions, upload_batches and clip_match_suggestions
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.edit_upload_batches;
    alter publication supabase_realtime add table public.edit_match_suggestions;
  end if;
end;
$$;
