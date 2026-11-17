-- =====================================================================
-- Noun ART: Strategist and Editor become one role, "Strategist/Editor".
-- Written Nov 15 2026 from Fable 5.2's plan (custom roles, section 2).
-- Waits for the owner's approval before it is pushed to main.
-- Behavior tests: supabase/tests/strategist-editor.test.mjs.
--
-- What it does, in plain words:
--   * The prebuilt role Strategist is renamed "Strategist/Editor" (its key
--     stays `strategist`). It keeps every permission it had and gets any
--     Editor permission it lacked, so nobody loses access. Today that adds
--     nothing: Editor's ticks are a subset of Strategist's.
--   * Everyone who held Editor (every status, removed people too, so a
--     removed person can still be let back in) now holds Strategist/Editor.
--     Each move writes a history row in profile_role_changes. Open invites
--     move the same way. Used and cancelled invites keep Editor as history.
--   * The Editor role is retired with deleted_at. It is never deleted: its
--     key, its ticks and every old row that points at it stay.
--   * Old code and old habits keep working: writing the old value `editor`
--     into profiles.role or invites.role now means Strategist/Editor, so the
--     published app keeps working between this push and the owner's Republish.
--   * A fix found by a review of the team access migration: the history
--     trigger on profiles now fires on every update, so a role changed by
--     writing only profiles.role (the app today) is recorded too.
--
-- Legacy columns: profiles.role and invites.role hold `strategist` for the
-- moved people and invites (the database fills them from the role's key).
-- The enum app_role keeps the value `editor` (old approvals.decided_by_role
-- rows still use it; an enum value cannot be dropped safely anyway).
--
-- It runs with nobody signed in, so the role, permission and profile guards
-- step aside (they only judge a signed in person), as in the first migrations.
-- No new table and no new function, so no new grants. Never DELETE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. The history trigger fires on every update of a profile.
--    It was `after insert or update of role_id`, and Postgres decides
--    `update of <column>` from the SET list of the statement, not from what
--    a BEFORE trigger changed. The app writes only profiles.role and
--    a_role_sync fills role_id, so the old trigger never ran for it.
--    private.log_role_change already compares old and new role_id and
--    writes nothing when they are the same, so it stays as it is.
-- ---------------------------------------------------------------------
drop trigger d_log_role_change on public.profiles;
create trigger d_log_role_change after insert or update on public.profiles
  for each row execute function private.log_role_change();

-- ---------------------------------------------------------------------
-- 1. The new name and description (key, color and flags stay).
-- ---------------------------------------------------------------------
update public.roles
   set name = 'Strategist/Editor',
       description = 'Plans the weeks and cards, uploads versions, writes directions and review notes, replies to notes.'
 where key = 'strategist';

-- ---------------------------------------------------------------------
-- 2. The union: every live Editor tick that Strategist/Editor does not
--    have live yet becomes a tick of Strategist/Editor. Zero rows with the
--    seed; written so it stays true if a tick was moved before this ran.
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key, granted_by)
select s.id, rp.permission_key, null
from public.roles s
join public.roles e on e.key = 'editor'
join public.role_permissions rp on rp.role_id = e.id and rp.deleted_at is null
join public.permissions pm on pm.key = rp.permission_key and pm.deleted_at is null
where s.key = 'strategist'
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = s.id and x.permission_key = rp.permission_key and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 3. People: everyone on Editor, whatever their status, moves to
--    Strategist/Editor. a_role_sync fills profiles.role = 'strategist';
--    d_log_role_change writes one history row per person (changed_by is
--    empty: the database did it). Their earlier history rows stay.
-- ---------------------------------------------------------------------
update public.profiles
   set role_id = (select r.id from public.roles r where r.key = 'strategist')
 where role_id = (select r.id from public.roles r where r.key = 'editor');

-- ---------------------------------------------------------------------
-- 4. Open invites only (not accepted, not cancelled, not removed) move the
--    same way. Used and cancelled invites keep Editor as history.
-- ---------------------------------------------------------------------
update public.invites
   set role_id = (select r.id from public.roles r where r.key = 'strategist')
 where role_id = (select r.id from public.roles r where r.key = 'editor')
   and accepted_at is null and revoked_at is null and deleted_at is null;

-- ---------------------------------------------------------------------
-- 5. Retire Editor: deleted_at only. Never deleted; key and is_system stay,
--    so old rows that point at it still read "Editor". Its name is free
--    again for a custom role.
-- ---------------------------------------------------------------------
update public.roles set deleted_at = now() where key = 'editor' and deleted_at is null;

comment on table public.roles is 'Roles: the prebuilt ones (Owner, Admin, Strategist/Editor, Viewer; Editor was retired by the 20261116000000 migration) and any custom role the owner builds. A role is a name plus its ticked permissions.';

-- ---------------------------------------------------------------------
-- 6. role_id is the truth; the old enum column follows it. The same
--    function as the team access migration, with one change: the old enum
--    value `editor` means the role with key `strategist` (Strategist/Editor),
--    in both lookups, so old code that writes role = 'editor' keeps working.
-- ---------------------------------------------------------------------
create or replace function private.sync_role_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_live boolean;
  v_wanted text;
begin
  -- The prebuilt role the enum value names. Editor was merged into Strategist/Editor (migration 20261116000000).
  v_wanted := case when new.role::text = 'editor' then 'strategist' else new.role::text end;
  if tg_op = 'INSERT' then
    if new.role_id is null and new.role is not null then
      select r.id into new.role_id from public.roles r where r.key = v_wanted;
    end if;
  elsif new.role_id is not distinct from old.role_id and new.role is distinct from old.role and new.role is not null then
    select r.id into new.role_id from public.roles r where r.key = v_wanted;
  end if;
  if new.role_id is null then
    raise exception 'Pick a role';
  end if;
  select r.key, r.deleted_at is null into v_key, v_live from public.roles r where r.id = new.role_id;
  if not coalesce(v_live, false) then
    if tg_op = 'INSERT' or new.role_id is distinct from old.role_id then
      raise exception 'That role was removed. Pick another role.';
    end if;
    if tg_table_name = 'profiles' then
      if new.access_status = 'active' and old.access_status is distinct from 'active' then
        raise exception 'Their role was removed. Give them another role first.';
      end if;
    end if;
  end if;
  new.role := case when v_key is null then null else v_key::public.app_role end;
  return new;
end;
$$;

-- Same grants as before: a trigger function nobody calls directly.
revoke all on function private.sync_role_columns() from public, anon, authenticated, service_role;
