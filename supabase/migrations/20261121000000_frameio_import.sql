-- =====================================================================
-- Noun ART: the one time move of edited videos from Frame.io.
-- Written Nov 16 2026 for the Frame.io move (docs/FRAMEIO-IMPORT.md).
-- Pushed on the owner's yes (Nov 16 2026), in its own push after the code
-- (the code works
-- without it: Frame.io shows "being connected" and an import is refused
-- with Retry until this is live).
-- Behavior tests: supabase/tests/frameio-import.test.mjs.
--
-- What it adds, in plain words:
--   * A version can say it was brought in from another system: intake_via
--     'import'. An import always says where from: source_kind ('frameio'
--     first; later others, so we are never tied to one vendor), the link on
--     the card (source_url), Frame.io's share id and file id, the file's name
--     and size there. Set when the version is made and never changed, for
--     anyone. Only someone who plans the calendar (calendar.plan) brings a
--     video in.
--   * Send to editor on a brought in version goes to the card's editor (the
--     person who pressed the move only moved files; they are not the editor).
--     With no editor on the card it goes to nobody, as before.
--   * frameio_connections: the one Frame.io connection (the owner's Adobe
--     login): Adobe's id for them, their email and name, who connected and
--     when, health. In the audit trail.
--   * frameio_connection_tokens: its access and refresh tokens, sealed by our
--     server (TOKEN_ENCRYPTION_KEY) and bound to the connection's id. Left
--     out of the audit trail on purpose, like google_links: the trail would
--     keep a copy of every sealed token, also after Disconnect.
--   Both tables are server only: RLS on, no policies, no grants to anon or
--   authenticated (like account_tokens). One live connection at a time.
--
-- Why: clean data is the core goal. The future AI editor must tell an
-- editor's upload from a file brought in, and see where it came from.
--
-- Rules followed (supabase/README.md): explicit grants, never DELETE, row
-- level security, no_hard_delete, no_truncate, zz_audit (not on the tokens,
-- see above), updated_at, no demo data, no seed rows, no new permission key
-- (connect: integrations.manage in the app; the move: footage.upload and
-- calendar.plan). The pushed file 20261117000000_edit_intake.sql is not
-- edited: its check and its guard are made again here.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Versions: where a brought in version came from
-- ---------------------------------------------------------------------
alter table public.versions
  add column source_kind text check (source_kind in ('frameio')),
  add column source_url text check (source_url is null or (source_url ~* '^https://' and length(source_url) <= 2000)),
  add column source_share_id text check (source_share_id is null or (btrim(source_share_id) <> '' and length(source_share_id) <= 200)),
  add column source_file_id text check (source_file_id is null or (btrim(source_file_id) <> '' and length(source_file_id) <= 200)),
  add column source_file_name text check (source_file_name is null or length(source_file_name) <= 500),
  add column source_bytes bigint check (source_bytes is null or source_bytes >= 0);
comment on column public.versions.source_kind is 'An import only: the system it was brought in from (frameio). Fixed once saved.';
comment on column public.versions.source_url is 'An import only: the link on the card it was brought in from (the f.io share link). Fixed once saved.';
comment on column public.versions.source_share_id is 'An import only: the share id in the source system. Fixed once saved.';
comment on column public.versions.source_file_id is 'An import only: the file id in the source system. Fixed once saved.';
comment on column public.versions.source_file_name is 'An import only: the file''s name in the source system. Fixed once saved.';
comment on column public.versions.source_bytes is 'An import only: the file''s size in bytes as the source system said. Fixed once saved.';
create index versions_source_file_idx on public.versions (source_kind, source_file_id) where source_kind is not null;

-- intake_via also allows 'import' (its column check from edit_intake, made again).
alter table public.versions drop constraint versions_intake_via_check;
alter table public.versions add constraint versions_intake_via_check check (intake_via in ('row', 'mass', 'import'));

-- The rule that ties how a version came in to its facts, made again with the
-- import branch: an import never has a match or a mass upload, always has
-- its source; nothing else ever has a source.
alter table public.versions drop constraint versions_intake_check;
alter table public.versions add constraint versions_intake_check check (
  (intake_via is null and match_method is null and match_confidence is null and edit_upload_batch_id is null and source_kind is null)
  or (intake_via = 'row' and match_method is null and match_confidence is null and edit_upload_batch_id is null and source_kind is null)
  or (intake_via = 'mass' and match_method is not null and edit_upload_batch_id is not null
      and (match_method = 'ai') = (match_confidence is not null) and source_kind is null)
  or (intake_via = 'import' and match_method is null and match_confidence is null and edit_upload_batch_id is null
      and source_kind is not null and source_url is not null and source_file_id is not null)
);
-- no source facts without a source
alter table public.versions add constraint versions_source_check check (
  source_kind is not null
  or (source_url is null and source_share_id is null and source_file_id is null and source_file_name is null and source_bytes is null)
);
comment on column public.versions.intake_via is 'How the version came in: row (from its row), mass (a mass upload) or import (brought in from another system, see source_kind). Null for older rows. Fixed once saved.';

-- Only someone who plans the calendar brings a video in (our own server may too).
create or replace function private.versions_check_import()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.intake_via = 'import' and auth.uid() is not null and not private.is_planner() then
    raise exception 'Only someone who plans the calendar brings a video in' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function private.versions_check_import() from public, anon, authenticated;
create trigger a_versions_check_import before insert on public.versions
  for each row execute function private.versions_check_import();

-- The guard, made again with the longer fixed list: where a version came
-- from is set when it is made and never changes, for anyone.
drop trigger c_guard_fixed on public.versions;
create trigger c_guard_fixed before update on public.versions
  for each row execute function private.guard_fixed_columns(
    'card_id,number,r2_bucket,r2_key,intake_via,match_method,match_confidence,edit_upload_batch_id,source_kind,source_url,source_share_id,source_file_id,source_file_name,source_bytes',
    'review_state,virality_score,is_reference,final_drive_file_id,size_bytes,duration_ms,width,height,thumbnail_r2_key,uploaded_by');

-- ---------------------------------------------------------------------
-- 2. Send to editor: a brought in version goes to the card's editor
-- ---------------------------------------------------------------------
-- The first migration's function, made again: the same steps, but for an
-- import the uploader is not the editor, so it goes to the card's editor
-- (or nobody when the card has none).
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
      select case when v.intake_via = 'import' then null else v.uploaded_by end into new.sent_to
        from public.versions v where v.id = new.version_id;
    end if;
    if new.sent_to is null then
      select c.assigned_editor_id into new.sent_to from public.cards c where c.id = new.card_id;
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 3. The Frame.io connection (server only)
-- ---------------------------------------------------------------------
create table public.frameio_connections (
  id uuid primary key default gen_random_uuid(),
  -- Adobe's id for the person who signed in (IMS "sub")
  adobe_user_id text not null unique check (btrim(adobe_user_id) <> '' and length(adobe_user_id) <= 200),
  email text check (email is null or length(email) <= 320),
  display_name text check (display_name is null or length(display_name) <= 200),
  health text not null default 'ok' check (health in ('ok', 'warn', 'error', 'off')),
  health_note text check (health_note is null or length(health_note) <= 300),
  connected_by uuid references public.profiles (id),
  connected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- one live connection at a time
create unique index frameio_connections_one_live on public.frameio_connections ((true)) where deleted_at is null;
comment on table public.frameio_connections is 'SERVER ONLY: the one Frame.io connection (the owner''s Adobe login) for the one time move of edited videos. RLS on, no policies, no browser grants.';

create table public.frameio_connection_tokens (
  connection_id uuid primary key references public.frameio_connections (id),
  -- "v1.<iv>.<tag>.<data>", sealed by the server and bound to connection_id; empty after Disconnect
  access_token text,
  refresh_token text,
  token_type text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_refreshed_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.frameio_connection_tokens is 'SERVICE ROLE ONLY: the Frame.io connection''s sealed Adobe tokens. RLS on, no policies, no browser grants, not in the audit trail.';

-- Who signed in is fixed: another Adobe login is another row.
create trigger c_guard_fixed before update on public.frameio_connections
  for each row execute function private.guard_fixed_columns('adobe_user_id', '');

-- The house steps (the first migration's loops ran once).
alter table public.frameio_connections enable row level security;
alter table public.frameio_connection_tokens enable row level security;
do $$
declare
  t text;
begin
  foreach t in array array['frameio_connections', 'frameio_connection_tokens']
  loop
    execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t);
  end loop;
end;
$$;
create trigger zz_audit after insert or update on public.frameio_connections
  for each row execute function private.audit_row();

-- Grants. Nothing for anon or authenticated, ever. Our own server reads and
-- writes, never deletes.
revoke all on public.frameio_connections, public.frameio_connection_tokens from public, anon, authenticated, service_role;
grant select, insert, update on public.frameio_connections, public.frameio_connection_tokens to service_role;
-- RLS is on with NO policies on purpose: only the service role (which skips
-- RLS) reaches these tables.
