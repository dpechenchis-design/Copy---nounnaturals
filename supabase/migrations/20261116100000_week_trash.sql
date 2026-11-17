-- =====================================================================
-- Noun ART: delete a week, and the Trash in Settings.
-- Written Nov 15 2026 after the owner made a test week in the published
-- app that he could not delete. Waits for the owner's approval before it
-- is pushed to main. Behavior tests: supabase/tests/week-trash.test.mjs.
--
-- What it does, in plain words:
--   * A new permission, "Delete weeks" (calendar.delete_weeks, Calendar
--     group), ticked for Owner and Admin only. Any custom role can be given
--     it like every other permission.
--   * Deleting a week sets weeks.deleted_at (with who did it). The week's
--     live titles (cards) go with it: they get the same deleted_at and
--     cards.deleted_with_week_id, so Restore brings back exactly those,
--     never rows removed one by one before. Nothing is ever deleted.
--   * Restore clears deleted_at on the week and on the cards that went with
--     it, within 30 days. If a new week took its address (slug) meanwhile,
--     the restored week gets a free one (week-3-2).
--   * "Delete forever" sets weeks.purged_at (with who did it). The week and
--     its titles leave the Trash and the app for good, but every row stays
--     in the database, marked, as the project never hard deletes. A purged
--     week cannot come back from the app or change any more.
--   * The database is the lock: only someone with calendar.delete_weeks can
--     set or clear deleted_at or purged_at on a week (before this, any
--     planner could). Someone with the permission but without "Plan weeks
--     and cards" may move a week to the Trash and back, and change nothing
--     else on it. The stamps (deleted_by, purged_by) are the database's,
--     so they cannot be forged.
--   * A titled row goes to the Trash and comes back only with its week:
--     nobody sets or clears cards.deleted_with_week_id by hand, nobody
--     restores one such row on its own, and no row is added to a week in
--     the Trash.
--
-- No new table and no new public function, so no new grants. The two new
-- functions are triggers in private, closed to everyone like the others.
-- cards.deleted_with_week_id has no foreign key on purpose: a second link
-- from cards to weeks would make the app's `weeks(...)` reads from cards
-- ambiguous. The trigger is what fills it, always with the card's own week.
-- It runs with nobody signed in, so the guards step aside for the seed.
-- Never DELETE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The permission, after "Set up statuses and undo imports" (30) and
--    before the Footage group (40). Owner and Admin get it.
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('calendar.delete_weeks', 'calendar', 'Calendar', 'Delete weeks', 'Move a week and its titles to the Trash in Settings, restore it within 30 days, or delete it from the Trash for good.', 35);

insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, 'calendar.delete_weeks', null
from public.roles r
where r.key in ('owner', 'admin')
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = 'calendar.delete_weeks' and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 2. The columns.
-- ---------------------------------------------------------------------
alter table public.weeks
  add column deleted_by uuid references public.profiles (id),
  add column purged_at timestamptz,
  add column purged_by uuid references public.profiles (id);
comment on column public.weeks.deleted_at is 'Set when the week went to the Trash (with its titles). The Trash shows it for 30 days.';
comment on column public.weeks.deleted_by is 'Who moved the week to the Trash. Filled by the database.';
comment on column public.weeks.purged_at is 'Set by "Delete forever" in the Trash: the week has left the app for good. The row stays, as nothing is ever deleted.';
comment on column public.weeks.purged_by is 'Who deleted the week forever. Filled by the database.';
create index weeks_trash_idx on public.weeks (deleted_at) where deleted_at is not null and purged_at is null;

alter table public.cards
  add column deleted_with_week_id uuid;
comment on column public.cards.deleted_with_week_id is 'The week this row went to the Trash with (always its own week). Restoring the week brings back exactly these rows. Filled and cleared by the database only; no foreign key on purpose (see the week trash migration).';
create index cards_deleted_with_week_idx on public.cards (deleted_with_week_id) where deleted_with_week_id is not null;

-- ---------------------------------------------------------------------
-- 3. Who may move a week to the Trash, bring it back or delete it forever.
--    Before update and insert on weeks.
-- ---------------------------------------------------------------------
create or replace function private.guard_week_trash()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_person boolean := auth.uid() is not null;
  v_base text;
  v_k int := 2;
  v_trash text[] := array['deleted_at', 'deleted_by', 'purged_at', 'purged_by', 'updated_at'];
begin
  if tg_op = 'INSERT' then
    if (v_person or private.is_service())
       and (new.deleted_at is not null or new.deleted_by is not null or new.purged_at is not null or new.purged_by is not null) then
      raise exception 'A new week cannot start in the Trash';
    end if;
    return new;
  end if;

  -- A migration (nobody signed in, not our server) may set anything.
  if not v_person and not private.is_service() then
    return new;
  end if;

  if old.purged_at is not null then
    raise exception 'That week was deleted from the Trash for good. It cannot come back or change.';
  end if;

  if new.deleted_at is not distinct from old.deleted_at
     and new.purged_at is not distinct from old.purged_at
     and new.deleted_by is not distinct from old.deleted_by
     and new.purged_by is not distinct from old.purged_by then
    -- Not a Trash change: the planner's rules (row level security) apply as before.
    if v_person and not private.is_planner() then
      raise exception 'Your role may only move weeks to the Trash and back' using errcode = '42501';
    end if;
    return new;
  end if;

  if v_person and not private.has_permission('calendar.delete_weeks') then
    raise exception 'Only people who may delete weeks can move a week to the Trash, bring it back or delete it forever'
      using errcode = '42501';
  end if;
  -- Without "Plan weeks and cards", only the Trash columns may change.
  if v_person and not private.is_planner()
     and (to_jsonb(new) - v_trash) is distinct from (to_jsonb(old) - v_trash) then
    raise exception 'Your role may only move weeks to the Trash and back' using errcode = '42501';
  end if;

  if old.deleted_at is null and new.deleted_at is not null then
    -- To the Trash: the database's own time and person.
    if new.purged_at is not null then
      raise exception 'A week goes to the Trash before it can be deleted for good';
    end if;
    new.deleted_at := now();
    new.deleted_by := auth.uid();
    new.purged_by := null;
    return new;
  end if;

  if old.deleted_at is not null and new.deleted_at is null then
    -- Back from the Trash, within 30 days.
    if new.purged_at is not null then
      raise exception 'That week was deleted from the Trash for good. It cannot come back or change.';
    end if;
    if old.deleted_at < now() - interval '30 days' then
      raise exception 'That week was in the Trash for more than 30 days, so it has left the app.';
    end if;
    new.deleted_by := null;
    new.purged_by := null;
    -- A new week may have taken its address meanwhile: give it a free one.
    v_base := new.slug;
    while exists (select 1 from public.weeks w
                  where w.space_id = new.space_id and w.slug = new.slug and w.id <> new.id and w.deleted_at is null) loop
      new.slug := v_base || '-' || v_k;
      v_k := v_k + 1;
    end loop;
    return new;
  end if;

  -- Still in the Trash (or never in it): only "Delete forever" may happen.
  if new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by then
    raise exception 'Who deleted a week and when are kept by the database';
  end if;
  if old.purged_at is null and new.purged_at is not null then
    if old.deleted_at is null then
      raise exception 'Only a week in the Trash can be deleted for good';
    end if;
    new.purged_at := now();
    new.purged_by := auth.uid();
    return new;
  end if;
  raise exception 'Who deleted a week forever and when are kept by the database';
end;
$$;
comment on function private.guard_week_trash() is 'Weeks: only calendar.delete_weeks moves a week to the Trash, back, or out for good; the stamps are the database''s; a purged week never changes.';

-- ---------------------------------------------------------------------
-- 4. The titles go with their week, and come back with it.
--    After update on weeks. Runs as the database, so it works for someone
--    with the permission even without "Plan weeks and cards".
-- ---------------------------------------------------------------------
create or replace function private.week_trash_cards()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    update public.cards c
       set deleted_at = new.deleted_at, deleted_with_week_id = new.id
     where c.week_id = new.id and c.deleted_at is null;
  elsif old.deleted_at is not null and new.deleted_at is null then
    update public.cards c
       set deleted_at = null, deleted_with_week_id = null
     where c.week_id = new.id and c.deleted_with_week_id = new.id;
  end if;
  return null;
end;
$$;
comment on function private.week_trash_cards() is 'Weeks: a week''s live cards go to the Trash with it (deleted_with_week_id) and only those come back with it.';

-- ---------------------------------------------------------------------
-- 5. A row in the Trash with its week: set and cleared only by step 4.
--    Before insert and update on cards.
-- ---------------------------------------------------------------------
create or replace function private.guard_card_week_trash()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Step 4 (a trigger inside a trigger) and migrations step aside.
  if pg_trigger_depth() > 1 or (auth.uid() is null and not private.is_service()) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.deleted_with_week_id is not null then
      raise exception 'A row goes to the Trash and comes back only with its week';
    end if;
    if exists (select 1 from public.weeks w where w.id = new.week_id and w.deleted_at is not null) then
      raise exception 'That week is in the Trash. Restore it first.';
    end if;
    return new;
  end if;
  if new.deleted_with_week_id is distinct from old.deleted_with_week_id then
    raise exception 'A row goes to the Trash and comes back only with its week';
  end if;
  if old.deleted_with_week_id is not null and new.deleted_at is null then
    raise exception 'That row is in the Trash with its week. Restore the week in Settings, Trash.';
  end if;
  if new.week_id is distinct from old.week_id
     and exists (select 1 from public.weeks w where w.id = new.week_id and w.deleted_at is not null) then
    raise exception 'That week is in the Trash. Restore it first.';
  end if;
  return new;
end;
$$;
comment on function private.guard_card_week_trash() is 'Cards: a row in the Trash with its week comes back only with the week; no row joins a week in the Trash.';

-- Trigger functions nobody calls directly.
revoke all on function private.guard_week_trash() from public, anon, authenticated, service_role;
revoke all on function private.week_trash_cards() from public, anon, authenticated, service_role;
revoke all on function private.guard_card_week_trash() from public, anon, authenticated, service_role;

-- Before triggers fire in name order: a_ (fill), b_ (rules), c_ (guards), z_ (updated_at).
create trigger c_guard_week_trash before insert or update on public.weeks
  for each row execute function private.guard_week_trash();
create trigger d_week_trash_cards after update on public.weeks
  for each row execute function private.week_trash_cards();
create trigger c_guard_card_week_trash before insert or update on public.cards
  for each row execute function private.guard_card_week_trash();

-- ---------------------------------------------------------------------
-- 6. Who may update a week: planners as before, and now also someone with
--    "Delete weeks" (the guard above lets them change only the Trash
--    columns). Always only in a space they may open.
-- ---------------------------------------------------------------------
drop policy weeks_update on public.weeks;
create policy weeks_update on public.weeks for update to authenticated
  using (((select private.is_planner()) or (select private.has_permission('calendar.delete_weeks')))
         and (select private.can_see_space(space_id)))
  with check (((select private.is_planner()) or (select private.has_permission('calendar.delete_weeks')))
              and (select private.can_see_space(space_id)));

comment on table public.weeks is 'A week of one space (Week 3, starting on a Monday), draft or not. Deleting it moves it and its titles to the Trash (deleted_at) for 30 days; Delete forever marks it purged_at. Never deleted.';
