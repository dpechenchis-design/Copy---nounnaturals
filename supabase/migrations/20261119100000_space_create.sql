-- =====================================================================
-- Noun ART: who may add a space, and the person who adds it opens it
-- (approved by the owner, Nov 16 2026).
-- Written Nov 16 2026 from the owner's decision of that day: "99% of spaces
-- created are going to be by strategists and editors."
-- Behavior tests: supabase/tests/spaces-draft.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
-- It comes after the draft 20261118300000_spaces.sql; move them together,
-- that one first.
--
-- What it does, in plain words:
--   * A new permission, "Add spaces" (spaces.create): add a space. Renaming
--     and archiving stay with "Rename and archive spaces" (spaces.manage,
--     the old "Add and rename spaces", renamed to say what it now does).
--   * Nobody loses anything: the Owner and Admin roles, and every live role
--     that holds spaces.manage today, get spaces.create ticked.
--   * Adding a space asks spaces.create, and the space's created_by must be
--     the person adding it (it already defaults to them).
--   * The person who adds a space can open it. A role that opens every space
--     (spaces.all) already does; for any other role the database gives the
--     creator the space by itself (one person_spaces row, granted by
--     themself). Nobody else is given it here: that stays with the owner and
--     admins, in the sheet or in Settings.
--
-- Why the last part is in the database: a space is shown only to people who
-- may open it (spaces_select, private.can_see_space), and a person cannot give
-- themself a space (person_spaces_insert, private.can_manage_person: never
-- your own). Without it a Strategist/Editor in a role without spaces.all
-- would add a space and never see it.
--
-- The trigger function is security definer (it writes the one row the
-- creator may not write), fixed search_path, private schema, and nobody may
-- call it directly. It writes only for a signed in person whose role lacks
-- spaces.all, only for the space just added, only for that person. With
-- nobody signed in (our own server, a migration) it does nothing.
-- person_spaces has no guard trigger of its own (only no_hard_delete,
-- no_truncate, zz_audit and updated_at), so the row passes as written and the
-- audit trail records it.
--
-- It runs with nobody signed in, so the permission guards (they only judge a
-- signed in person) step aside for the ticks below, as in the earlier
-- migrations.
--
-- Rules followed (supabase/README.md): no new table, explicit execute rights
-- (taken from everyone), never DELETE, no demo data, the new key is seeded
-- here and must equal src/lib/access/permissions.ts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The permission, and the new words for spaces.manage.
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('spaces.create', 'team', 'Team', 'Add spaces', 'Add a space. The person who adds it can open it.', 205);

update public.permissions set label = 'Rename and archive spaces' where key = 'spaces.manage';

-- ---------------------------------------------------------------------
-- 2. Nobody loses anything: Owner, Admin and every live role that holds
--    spaces.manage today get spaces.create.
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, 'spaces.create', null
from public.roles r
where r.deleted_at is null
  and (r.key in ('owner', 'admin')
       or exists (select 1 from public.role_permissions rp
                  where rp.role_id = r.id and rp.permission_key = 'spaces.manage' and rp.deleted_at is null))
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = 'spaces.create' and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 3. Adding a space asks spaces.create, as the person themself.
-- ---------------------------------------------------------------------
drop policy spaces_insert on public.spaces;
create policy spaces_insert on public.spaces for insert to authenticated
  with check ((select private.has_permission('spaces.create')) and created_by = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 4. The person who adds a space opens it.
-- ---------------------------------------------------------------------
create or replace function private.spaces_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or private.current_role_id() is null or private.has_permission('spaces.all') then
    return new;
  end if;
  insert into public.person_spaces (profile_id, space_id, granted_by)
  values (auth.uid(), new.id, auth.uid());
  return new;
end;
$$;
comment on function private.spaces_after_insert() is 'The person who adds a space opens it: one person_spaces row for them when their role does not open every space.';

revoke all on function private.spaces_after_insert() from public, anon, authenticated;

create trigger b_creator_opens after insert on public.spaces
  for each row execute function private.spaces_after_insert();
