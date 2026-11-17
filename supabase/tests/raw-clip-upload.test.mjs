/* Behavior tests for the raw clip upload (the Upload build, Nov 15 2026).

   Part 1 proves that the LIVE tables already carry every rule the upload relies on, exactly as the app writes them
   (src/lib/content/raw-db.ts): upload_batches, raw_clips, card_raw_clips and drive_folders. These run against the
   migrations alone.
   Part 2 proves the migration supabase/migrations/20261118000000_raw_clip_upload.sql (approved Nov 16 2026; one rule on
   drive_folders: one live record per space folder, week folder, day folder and day Raw folder). Its tidy up of records
   already doubled is proven on the world just before it, built with freshDb({ before: RAW_MIGRATION }), then the rest
   run with applyMigrationsFrom as the live project runs them. Nothing here touches the live Supabase project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, applyMigrationsFrom, signUp, as, rowsAs, oneAs, one, narrowEditor, oneSpaceStrategist } from "./helpers.mjs";

const RAW_MIGRATION = "20261118000000";

const RLS = /row-level security/;
const UNIQUE = /duplicate key|unique constraint/;

async function world({ before = null } = {}) {
  const db = await freshDb({ before });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("olena@agency.test", "editor");
  await invite("dmytro@agency.test", "editor");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("outsider@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const editor = await signUp(db, "olena@agency.test", "Olena"); // may upload (footage.upload), may not plan
  const editor2 = await signUp(db, "dmytro@agency.test", "Dmytro");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer"); // opens the space, may not upload
  const stranger = await signUp(db, "outsider@agency.test", "Taras"); // opens no space
  await narrowEditor(db, owner, editor, editor2);
  /* Strategist/Editor opens every space now (spaces.all): the stranger holds its keys but spaces.all, and no space */
  await oneSpaceStrategist(db, owner, "Outsider", [], stranger);

  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, owner, async (tx) => {
    for (const p of [editor, editor2, viewer]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  const ids = await as(db, admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const nounWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const founderWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-16') returning id`, [founder]);
    const cardA = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'That silky feeling might be a coating', '2026-11-17') returning id`, [nounWeek]);
    const cardB = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Patchouli', '2026-11-18') returning id`, [nounWeek]);
    const cardF = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Founder story one', '2026-11-17') returning id`, [founderWeek]);
    return { cardA, cardB, cardF };
  });
  return { db, owner, admin, editor, editor2, viewer, stranger, noun, founder, ...ids };
}

/* exactly what insertBatch and insertClip send (src/lib/content/raw-db.ts). The batch id is made by our server
   first (it goes on the file's labels in Drive), and the row is written last. */
const newBatch = (w, who, space, day = "2026-11-17", id = randomUUID()) =>
  oneAs(w.db, who, `insert into public.upload_batches (id, space_id, day, uploaded_by, upload_source, device) values ($1, $2, $3, $4, 'desktop', 'Mac') returning id`, [id, space, day, who]);
const newClip = (w, who, space, batch, fileId, day = "2026-11-17") =>
  oneAs(
    w.db,
    who,
    `insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, file_name, mime_type, size_bytes, md5_checksum, duration_ms, width, height, shot_on, uploaded_by, upload_source)
     values ($1, $2, $3, 'folder-raw', 'IMG_1.MOV', 'video/quicktime', 4120000000, 'md5', null, null, null, $4, $5, 'desktop') returning id`,
    [space, batch, fileId, day, who],
  );
const folderRow = (w, who, space, purpose, day, driveId) =>
  as(w.db, who, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, day, name) values ($1, $2, $3, $4, 'x')`, [driveId, purpose, space, day]));

/* ---------- Part 1: the live tables ---------- */

test("live: a person with footage.upload saves a batch and its clips in a space they may open; nobody else can", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  const clip = await newClip(w, w.editor, w.noun, batch, "drive-file-1");
  assert.ok(clip);
  assert.equal(await one(w.db, `select uploaded_by from public.raw_clips where id = $1`, [clip]), w.editor);
  assert.equal(await one(w.db, `select size_bytes::text from public.raw_clips where id = $1`, [clip]), "4120000000", "a big camera file's size fits");

  /* a viewer opens the space but has no footage.upload */
  await assert.rejects(newBatch(w, w.viewer, w.noun), RLS);
  await assert.rejects(newClip(w, w.viewer, w.noun, batch, "drive-file-v"), RLS);
  /* someone who opens no space */
  await assert.rejects(newBatch(w, w.stranger, w.noun), RLS);
  await assert.rejects(newClip(w, w.stranger, w.noun, null, "drive-file-s"), RLS);
  /* an editor in a space they may not open */
  await assert.rejects(newBatch(w, w.editor, w.founder), RLS);
  await assert.rejects(newClip(w, w.editor, w.founder, null, "drive-file-f"), RLS);
  /* never in somebody else's name */
  await assert.rejects(
    oneAs(w.db, w.editor, `insert into public.upload_batches (space_id, day, uploaded_by) values ($1, '2026-11-17', $2) returning id`, [w.noun, w.admin]),
    RLS,
  );
  /* not signed in: nothing */
  await assert.rejects(as(w.db, "anon", (tx) => tx.query(`insert into public.upload_batches (space_id, day) values ($1, '2026-11-17')`, [w.noun])), /permission denied|row-level security/);
});

test("live: the batch is written with the id our server made; that id cannot be taken twice or by anyone else", async () => {
  const w = await world();
  const id = randomUUID();
  assert.equal(await newBatch(w, w.editor, w.noun, "2026-11-17", id), id, "the row keeps the id on the file's labels");
  assert.equal(await one(w.db, `select uploaded_by from public.upload_batches where id = $1`, [id]), w.editor);
  /* the same id again (a second tab, a replayed call): refused, the first row stays */
  await assert.rejects(newBatch(w, w.editor, w.noun, "2026-11-17", id), UNIQUE);
  await assert.rejects(newBatch(w, w.editor2, w.noun, "2026-11-17", id), /duplicate key|unique constraint|row-level security/);
  /* a chosen id changes none of the rules: not for a viewer, not in a space they may not open */
  await assert.rejects(newBatch(w, w.viewer, w.noun, "2026-11-17", randomUUID()), RLS);
  await assert.rejects(newBatch(w, w.editor, w.founder, "2026-11-17", randomUUID()), RLS);
  assert.equal(await one(w.db, `select count(*)::int from public.upload_batches`), 1);
  /* a clip joins the batch by that id */
  assert.ok(await newClip(w, w.editor, w.noun, id, "drive-file-9"));
});

test("live: one Drive file is one raw clip, ever; a clip is never hard deleted", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  await newClip(w, w.editor, w.noun, batch, "drive-file-1");
  /* the save step run twice (a retry, a second tab): the second insert is refused, and the app reads the first row */
  await assert.rejects(newClip(w, w.editor2, w.noun, null, "drive-file-1"), UNIQUE);
  assert.equal(await one(w.db, `select count(*)::int from public.raw_clips where drive_file_id = 'drive-file-1'`), 1);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.raw_clips where drive_file_id = 'drive-file-1'`)), /permission denied|never deleted|hard delete/i);
  assert.equal(await one(w.db, `select has_table_privilege('authenticated', 'public.raw_clips', 'delete')`), false);
  assert.equal(await one(w.db, `select has_table_privilege('service_role', 'public.raw_clips', 'delete')`), false);
});

test("live: everyone who may open the space sees every day's raw clips, editors too; nobody else sees any", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  await newClip(w, w.editor, w.noun, batch, "drive-file-1");
  const seenBy = (who) => oneAs(w.db, who, `select count(*)::int from public.raw_clips where space_id = $1 and deleted_at is null`, [w.noun]);
  for (const who of [w.owner, w.admin, w.editor, w.editor2, w.viewer]) assert.equal(await seenBy(who), 1);
  assert.equal(await seenBy(w.stranger), 0);
});

test("live: matching a clip to a title needs calendar.plan, saves who matched it and moves the card to Shot", async () => {
  const w = await world();
  const clip = await newClip(w, w.editor, w.noun, await newBatch(w, w.editor, w.noun), "drive-file-1");
  const link = (who, card) => oneAs(w.db, who, `insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2) returning id`, [card, clip]);

  /* an editor uploads but does not match */
  await assert.rejects(link(w.editor, w.cardA), RLS);
  const before = await one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [w.cardA]);
  const id = await link(w.admin, w.cardA);
  assert.equal(await one(w.db, `select linked_by from public.card_raw_clips where id = $1`, [id]), w.admin);
  const after = await one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [w.cardA]);
  assert.notEqual(before, "shot");
  assert.equal(after, "shot", "the status follows what happened");

  /* one clip can feed several titles; the same title twice is refused (the app treats it as already matched) */
  await link(w.admin, w.cardB);
  await assert.rejects(link(w.admin, w.cardA), UNIQUE);
  /* never a title of another space */
  await assert.rejects(link(w.owner, w.cardF), /its own space/);
});

test("live: taking a match away keeps the row with who removed it, and the clip can be matched again (Undo)", async () => {
  const w = await world();
  const clip = await newClip(w, w.editor, w.noun, await newBatch(w, w.editor, w.noun), "drive-file-1");
  const id = await oneAs(w.db, w.admin, `insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2) returning id`, [w.cardA, clip]);
  /* exactly what removeLink sends */
  const unlink = (who) => rowsAs(w.db, who, `update public.card_raw_clips set deleted_at = now(), unlinked_by = $2 where id = $1 and deleted_at is null returning id`, [id, who]);
  assert.equal((await unlink(w.editor)).length, 0, "an editor changes nothing");
  assert.equal((await unlink(w.admin)).length, 1);
  assert.equal(await one(w.db, `select unlinked_by from public.card_raw_clips where id = $1`, [id]), w.admin);
  assert.equal(await one(w.db, `select count(*)::int from public.card_raw_clips where raw_clip_id = $1`, [clip]), 1, "the row stays");
  assert.equal(await oneAs(w.db, w.admin, `select count(*)::int from public.card_raw_clips where raw_clip_id = $1 and deleted_at is null`, [clip]), 0);
  /* Undo: matched again, as a new row */
  await oneAs(w.db, w.admin, `insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2) returning id`, [w.cardA, clip]);
  assert.equal(await one(w.db, `select count(*)::int from public.card_raw_clips where raw_clip_id = $1`, [clip]), 2);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.card_raw_clips where id = $1`, [id])), /permission denied|never deleted|hard delete/i);
});

test("live: the Drive folder records. Our server and planners write them, an uploader only reads them", async () => {
  const w = await world();
  /* our own server (the service role), which is what the upload uses when its key is entered */
  await folderRow(w, "service", w.noun, "space", null, "drive-space");
  await folderRow(w, "service", w.noun, "day_raw", "2026-11-17", "drive-raw-17");
  /* a planner's own session may write them too */
  await folderRow(w, w.admin, w.noun, "day", "2026-11-17", "drive-day-17");
  /* an editor's session may not (so without the server's key their upload finds the folder by its label in Drive) */
  await assert.rejects(folderRow(w, w.editor, w.noun, "week", "2026-11-16", "drive-week"), RLS);
  /* exactly what folderStore.saved reads, as the editor */
  const saved = (who, purpose, day) =>
    oneAs(
      w.db,
      who,
      `select drive_folder_id from public.drive_folders where purpose = $1 and space_id = $2 and card_id is null and deleted_at is null
         and ${day ? "day = $3" : "day is null and $3::date is null"} order by created_at limit 1`,
      [purpose, w.noun, day],
    );
  assert.equal(await saved(w.editor, "day_raw", "2026-11-17"), "drive-raw-17");
  assert.equal(await saved(w.editor, "space", null), "drive-space");
  assert.equal(await saved(w.stranger, "day_raw", "2026-11-17"), undefined, "someone who may not open the space sees no folder");
  /* one Drive folder is one record */
  await assert.rejects(folderRow(w, "service", w.noun, "day_raw", "2026-11-18", "drive-raw-17"), UNIQUE);
  /* a folder put in Drive's trash is marked removed by our server, never deleted */
  await as(w.db, "service", (tx) => tx.query(`update public.drive_folders set deleted_at = now() where drive_folder_id = 'drive-raw-17' and deleted_at is null`));
  assert.equal(await saved(w.editor, "day_raw", "2026-11-17"), undefined);
  assert.equal(await one(w.db, `select count(*)::int from public.drive_folders where drive_folder_id = 'drive-raw-17'`), 1);
  assert.equal(await one(w.db, `select has_table_privilege('service_role', 'public.drive_folders', 'delete')`), false);
});

/* ---------- Part 2: the drive folder rule (20261118000000_raw_clip_upload) ---------- */

test("rule: a space has one live record per space folder, week folder, day folder and day Raw folder", async () => {
  const w = await world();
  await folderRow(w, "service", w.noun, "space", null, "s1");
  await folderRow(w, "service", w.noun, "week", "2026-11-16", "w1");
  await folderRow(w, "service", w.noun, "day", "2026-11-17", "d1");
  await folderRow(w, "service", w.noun, "day_raw", "2026-11-17", "r1");
  /* the same place a second time: refused (two uploads that started in the same second) */
  await assert.rejects(folderRow(w, "service", w.noun, "space", null, "s2"), UNIQUE);
  await assert.rejects(folderRow(w, "service", w.noun, "week", "2026-11-16", "w2"), UNIQUE);
  await assert.rejects(folderRow(w, "service", w.noun, "day", "2026-11-17", "d2"), UNIQUE);
  await assert.rejects(folderRow(w, w.admin, w.noun, "day_raw", "2026-11-17", "r2"), UNIQUE);
  /* another day, another week and another space are their own places */
  await folderRow(w, "service", w.noun, "day_raw", "2026-11-18", "r3");
  await folderRow(w, "service", w.noun, "week", "2026-11-23", "w3");
  await folderRow(w, "service", w.founder, "space", null, "s3");
  await folderRow(w, "service", w.founder, "day_raw", "2026-11-17", "r4");
  assert.equal(await one(w.db, `select count(*)::int from public.drive_folders where deleted_at is null`), 8);
});

test("rule: a folder marked removed frees its place; card folders are not touched by the rule", async () => {
  const w = await world();
  await folderRow(w, "service", w.noun, "day_raw", "2026-11-17", "r1");
  await as(w.db, "service", (tx) => tx.query(`update public.drive_folders set deleted_at = now() where drive_folder_id = 'r1'`));
  await folderRow(w, "service", w.noun, "day_raw", "2026-11-17", "r2");
  assert.equal(await one(w.db, `select count(*)::int from public.drive_folders where purpose = 'day_raw'`), 2, "the old record stays, marked removed");
  /* a card's folders (a later build) may be as many as it needs */
  const card = (id) => as(w.db, w.admin, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, card_id) values ($1, 'card_raw', $2, $3)`, [id, w.noun, w.cardA]));
  await card("c1");
  await card("c2");
  assert.equal(await one(w.db, `select count(*)::int from public.drive_folders where card_id = $1`, [w.cardA]), 2);
});

test("rule: records that are already doubled are tidied first: the oldest stays live, the others are marked removed, none is deleted", async () => {
  const w = await world({ before: RAW_MIGRATION }); /* before the migration: no index yet, so the same place can be recorded twice */
  const rec = (id, purpose, space, day, at) =>
    as(w.db, "service", (tx) =>
      tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, day, name, created_at) values ($1, $2, $3, $4, 'x', $5)`, [id, purpose, space, day, at]));
  /* one day Raw folder recorded three times, one space folder twice, a day folder twice, a week folder once */
  await rec("raw-old", "day_raw", w.noun, "2026-11-17", "2026-11-17T08:00:00Z");
  await rec("raw-mid", "day_raw", w.noun, "2026-11-17", "2026-11-17T08:00:01Z");
  await rec("raw-new", "day_raw", w.noun, "2026-11-17", "2026-11-17T08:00:02Z");
  await rec("space-old", "space", w.noun, null, "2026-11-16T08:00:00Z");
  await rec("space-new", "space", w.noun, null, "2026-11-16T08:00:01Z");
  await rec("day-old", "day", w.noun, "2026-11-17", "2026-11-17T08:00:00Z");
  await rec("day-new", "day", w.noun, "2026-11-17", "2026-11-17T08:00:00Z");
  await rec("week-1", "week", w.noun, "2026-11-16", "2026-11-16T08:00:00Z");
  /* the same place in another space is its own place; a record already removed is left alone */
  await rec("founder-raw", "day_raw", w.founder, "2026-11-17", "2026-11-17T09:00:00Z");
  await rec("raw-gone", "day_raw", w.noun, "2026-11-17", "2026-11-17T07:00:00Z");
  await as(w.db, "service", (tx) => tx.query(`update public.drive_folders set deleted_at = '2026-11-17T07:30:00Z' where drive_folder_id = 'raw-gone'`));
  /* the card's own folders may be many; they are not touched */
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, card_id) values ('c1', 'card_raw', $1, $2), ('c2', 'card_raw', $1, $2)`, [w.noun, w.cardA]));

  /* the file, run the way Supabase runs a migration: as the database owner, nobody signed in */
  const ran = await applyMigrationsFrom(w.db, RAW_MIGRATION);
  assert.equal(ran[0], "20261118000000_raw_clip_upload.sql");

  const live = async (id) => (await one(w.db, `select deleted_at is null from public.drive_folders where drive_folder_id = $1`, [id]));
  for (const id of ["raw-old", "space-old", "week-1", "founder-raw", "c1", "c2"]) assert.equal(await live(id), true, `${id} stays live`);
  for (const id of ["raw-mid", "raw-new", "space-new"]) assert.equal(await live(id), false, `${id} is marked removed`);
  /* two rows made in the same second: exactly one stays */
  assert.equal(await one(w.db, `select count(*)::int from public.drive_folders where purpose = 'day' and deleted_at is null`), 1);
  /* nothing was deleted, and the one removed earlier kept its own removal time */
  assert.equal(await one(w.db, `select count(*)::int from public.drive_folders`), 12);
  assert.equal(await one(w.db, `select deleted_at = '2026-11-17T07:30:00Z' from public.drive_folders where drive_folder_id = 'raw-gone'`), true);
  /* the removals are in the audit trail, with nobody signed in */
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'drive_folders' and action = 'soft_delete' and actor_type = 'system'`), 5, "four tidied by the file, one set up by the test");
  /* and the rule now holds */
  await assert.rejects(folderRow(w, "service", w.noun, "day_raw", "2026-11-17", "raw-again"), UNIQUE);
  await folderRow(w, "service", w.noun, "day_raw", "2026-11-18", "raw-next");
});
