-- =====================================================================
-- Noun ART: a space's description, and one live space per name (approved by the owner, Nov 16 2026).
-- Written Nov 15 2026 for Add a space and Space settings on the Calendar;
-- step 1 (twins renamed first) added Nov 16 2026 after a review.
-- Behavior tests: supabase/tests/spaces-draft.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
-- The draft 20261119100000_space_create.sql (who may add a space) comes
-- after this one; move them together, this one first.
--
-- What it does, in plain words, in this order:
--   1. Twins get a number. If two or more live spaces already share a name
--      (case and outer spaces do not count), the oldest keeps it and each
--      newer one gets " (2)", " (3)" and so on (the next number no live
--      space uses). The live app checks names only in the app, so a twin
--      can exist before this runs; without this step the lock in 3 would
--      fail and stop the whole file. Its pill name (short_name) gets the
--      same number. The address (slug) never changes, so links keep working.
--      On today's data (two spaces with different names) it changes nothing.
--   2. spaces.description: a short line saying what goes in a space (at most
--      280 letters), set in the Add a space sheet and in Space settings.
--      Empty for the two first spaces until someone writes one.
--   3. One live space per name: two live spaces may never have the same
--      name (case and outer spaces do not count). An archived space keeps its
--      name, so a new space may take it; it then has to be renamed before the
--      archived one comes back. The app already checks this with plain words;
--      this is the lock behind it.
--
-- What works without it: adding, renaming, archiving and restoring a space,
-- and who can open it, all on the live schema (src/lib/content/space-actions.ts).
-- Without it the description box is grayed with one line saying why, and the
-- name check is the app's alone.
--
-- It runs with nobody signed in, as Supabase runs a migration. Every write
-- here is an update (never a delete), so updated_at and the audit trail
-- record each renamed twin.
--
-- Rules followed (supabase/README.md): no new table, no new function, no new
-- grant needed (spaces already has select, insert and update for
-- authenticated, and its policies, triggers and audit trail cover the new
-- column), never DELETE, no demo data, no seed rows, no new permission key.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Twins get a number before the lock (3) goes on.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  k int;
  v_name text;
begin
  for r in
    select s.id, btrim(s.name) as base, s.short_name,
           row_number() over (partition by lower(btrim(s.name)) order by s.created_at, s.id) as n
      from public.spaces s
     where s.deleted_at is null
     order by s.created_at, s.id
  loop
    continue when r.n = 1;
    k := r.n;
    loop
      v_name := r.base || ' (' || k || ')';
      exit when not exists (select 1 from public.spaces x
                            where x.deleted_at is null and lower(btrim(x.name)) = lower(v_name));
      k := k + 1;
    end loop;
    update public.spaces
       set name = v_name,
           short_name = btrim(r.short_name) || ' (' || k || ')'
     where id = r.id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. The description.
-- ---------------------------------------------------------------------
alter table public.spaces
  add column description text
  check (description is null or (char_length(description) <= 280 and btrim(description) <> ''));
comment on column public.spaces.description is 'A short line saying what goes in this space (at most 280 letters). Empty when nobody wrote one.';

-- ---------------------------------------------------------------------
-- 3. One live space per name.
-- ---------------------------------------------------------------------
create unique index spaces_live_name_key on public.spaces (lower(btrim(name))) where deleted_at is null;
comment on index public.spaces_live_name_key is 'Two live spaces never share a name (case and outer spaces do not count). Archived spaces keep theirs.';
