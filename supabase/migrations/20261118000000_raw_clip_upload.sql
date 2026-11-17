-- =====================================================================
-- Noun ART: raw clip upload (approved by the owner, Nov 16 2026).
-- Written Nov 15 2026 for the Upload build (raw clips from the browser
-- straight into the shared drive "NOUN Content System").
-- Behavior tests: supabase/tests/raw-clip-upload.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
--
-- The upload itself needs NOTHING from this file. upload_batches,
-- raw_clips, card_raw_clips and drive_folders are all live already, with
-- the rules the upload uses (footage.upload to upload, calendar.plan to
-- match a clip to a title). The feature works in full without this draft.
--
-- What it adds, in plain words: one rule on drive_folders. A space has at
-- most one live record of its space folder, of each week folder, of each
-- day folder and of each day's Raw folder. Today two uploads that start in
-- the same second for a day nobody uploaded to before can both record a
-- folder for that day. The app already ends on one folder in Drive (the
-- older one wins, the other goes to Drive's trash) and reads the oldest
-- record, so nothing breaks; this rule only keeps the table itself clean,
-- which is the point of the table (clean data for the future AI).
--
-- A folder that was put in Drive's trash is marked removed (deleted_at),
-- never deleted, and then a new one may be recorded for the same day.
-- Card folders (card, card_raw, card_edits, card_final) are not touched:
-- they come with a later build.
--
-- No new table, no new column, no new permission key. The only data it
-- touches: if the table already holds two live records for one place (two
-- uploads that started in the same second), the first statement below marks
-- every one but the oldest as removed (deleted_at, never deleted), so the
-- two indexes can be built. On a table with no such duplicates it changes
-- nothing. It runs as the migration owner with nobody signed in; the audit
-- trigger and the never delete guards accept that.
-- =====================================================================

-- Step 1: tidy any live duplicates first. The oldest record of a place stays
-- (the app already reads the oldest); the others are marked removed.
update public.drive_folders f
   set deleted_at = now()
  from (
    select id,
           row_number() over (partition by space_id, purpose, day order by created_at, id) as n
      from public.drive_folders
     where deleted_at is null
       and card_id is null
       and space_id is not null
       and ((purpose = 'space' and day is null) or (purpose in ('week', 'day', 'day_raw') and day is not null))
  ) d
 where f.id = d.id
   and d.n > 1;

-- Step 2: the space folder: one live record per space (it has no day).
create unique index drive_folders_space_place_key
  on public.drive_folders (space_id, purpose)
  where deleted_at is null and card_id is null and day is null and purpose = 'space';

-- The week folder (day is the week's Monday), the day folder and the day's Raw folder: one live record each per
-- space and day.
create unique index drive_folders_day_place_key
  on public.drive_folders (space_id, purpose, day)
  where deleted_at is null and card_id is null and day is not null and purpose in ('week', 'day', 'day_raw');
