/* Behavior tests for Upload/Files and the Gemini reader: supabase/migrations/20261122000000_files_and_reader.sql
   (live since Nov 16 2026, owner approved).
   While it is a draft the suite loads the draft after every live migration; once it is live, the live file (found by
   the end of its name, so nothing here changes on that day).

   What is proven: the new permission and seeds, each role's access to the folders, drops, files and the undo ledger,
   that the reader's functions answer only our own server, the daily limit (also with many callers at once), the
   reader's queue (one reader per file, a lease), what the reader saves, a person's match and its undo (allowed for
   whom, safe to repeat), "Read this folder with Gemini", Retry, and that nothing is ever hard deleted.

   The throwaway database (PGlite) is one connection, so two readers cannot truly run side by side here: the queue and
   the limit are proven by many calls in a row and by the lock and "skip locked" being in the functions.
   Nothing here touches the live Supabase project. Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, applyMigration, signUp, as, rowsAs, oneAs, one, narrowEditor, oneSpaceStrategist, FILES_READER, keysMissingWith } from "./helpers.mjs";
import { PERMISSIONS, PREBUILT } from "../../src/lib/access/permissions.ts";

const LIVE = FILES_READER.live;
const MIG = FILES_READER.file.slice(0, 14);
/** A database with the draft (or the live file) applied. */
const fresh = () => freshDb(LIVE ? {} : { extra: [FILES_READER.path] });
/** The world just before it, and the step that applies it as Supabase runs a migration (nobody signed in). */
const before = () => freshDb(LIVE ? { before: MIG } : {});
const run = (db) => (LIVE ? applyMigration(db, MIG) : db.exec(readFileSync(FILES_READER.path, "utf8")));
/** Keys the code lists that another draft still waiting adds (posting.resolve while the Meta posting draft waits):
    this suite's database has every live migration and this file only. */
const OTHER_DRAFT_KEYS = keysMissingWith([FILES_READER]);

const RLS = /row-level security/;
const UNIQUE = /duplicate key|unique constraint/;
const NO_FUNCTION = /permission denied for function/;
const NO_TABLE = /permission denied for table/;
const SYSTEM_ONLY = /Only the system sets/;

async function people(db) {
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("daryna@agency.test", "strategist");
  await invite("olena@agency.test", "editor");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("outsider@agency.test", "strategist");
  await invite("keeper@agency.test", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "daryna@agency.test", "Daryna"); // Strategist/Editor: plans, uploads, manages folders, opens every space
  const editor = await signUp(db, "olena@agency.test", "Olena"); // uploads and replies only (the old Editor keys)
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer"); // reads
  const outsider = await signUp(db, "outsider@agency.test", "Taras"); // plans and manages folders, but opens no space
  const keeper = await signUp(db, "keeper@agency.test", "Kira"); // a custom role with files.manage only
  const pending = await signUp(db, "nobody@elsewhere.test", "Nobody"); // signed in, never let in
  return { owner, admin, strat, editor, viewer, outsider, keeper, pending };
}

async function world() {
  const db = await fresh();
  const p = await people(db);
  await narrowEditor(db, p.owner, p.editor);
  await oneSpaceStrategist(db, p.owner, "Outsider", [], p.outsider);
  await as(db, p.owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name) values ('Folder keeper') returning id`)).rows[0].id;
    for (const key of ["files.manage", "page.upload"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, key]);
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, p.keeper]);
  });
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, p.owner, async (tx) => {
    for (const who of [p.editor, p.viewer, p.keeper]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [who, noun]);
  });
  const ids = await as(db, p.admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const week = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const founderWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-16') returning id`, [founder]);
    const cardA = await q(`insert into public.cards (week_id, title, hook, planned_on) values ($1, 'That silky feeling might be a coating', 'Your hair is not soft, it is coated', '2026-11-17') returning id`, [week]);
    const cardB = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Patchouli bar restock', '2026-11-18') returning id`, [week]);
    const cardF = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Founder story one', '2026-11-17') returning id`, [founderWeek]);
    return { week, founderWeek, cardA, cardB, cardF };
  });
  return { db, ...p, noun, founder, ...ids };
}

/* ---------- small helpers ---------- */

let n = 0;
/** A raw file as our server saves it (a queued video unless the type says photo). */
const addClip = (w, { file = `file-${++n}`, mime = "video/quicktime", space = w.noun, folder = "folder-new-uploads", batch = null, name = "IMG_1.MOV" } = {}) =>
  oneAs(w.db, "service", `insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, file_name, mime_type) values ($1, $2, $3, $4, $5, $6) returning id`, [space, batch, file, folder, name, mime]);
const clipRow = async (w, id) => (await w.db.query(`select * from public.raw_clips where id = $1`, [id])).rows[0];
const claim = async (w, limit = 4, lease = 15) => rowsAs(w.db, "service", `select * from public.claim_clip_jobs($1, $2)`, [limit, lease]);
const finish = (w, clip, result, who = "service") => oneAs(w.db, who, `select public.finish_clip_index($1, $2::jsonb)`, [clip, JSON.stringify(result)]);
const reserve = async (w, est, agent = "clip_indexer") => {
  const r = (await rowsAs(w.db, "service", `select * from public.reserve_ai_spend($1, $2)`, [agent, est]))[0];
  return { ok: r.ok, run: r.run_id, cap: Number(r.cap_usd), spent: Number(r.spent_usd) };
};
const decide = (w, who, clip, card, suggestion = null, filing = {}) =>
  oneAs(w.db, who, `select public.decide_clip_suggestion($1, $2, $3, $4::jsonb)`, [clip, card, suggestion, JSON.stringify(filing)]);
const undo = (w, who, move) => oneAs(w.db, who, `select public.undo_clip_move($1)`, [move]);
const count = (w, sql, params = []) => one(w.db, `select count(*)::int from ${sql}`, params);
const statusOf = (w, card) => one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [card]);
/** A file the reader read: transcript in, then the answer (suggestions, perhaps an applied match). */
async function read(w, clip, done = {}) {
  await claim(w, 20);
  await finish(w, clip, { outcome: "transcribed", transcript: "that silky feeling might be a coating on your hair", language: "en", duration_ms: 42000 });
  return finish(w, clip, { outcome: "done", title: "Silky is a coating", summary: "She explains why silky hair can be a coating.", model: { provider_key: "google", model_key: "gemini-4-hydrogen" }, ...done });
}

/* ---------- seeds ---------- */

test("seed: Manage folders is a Footage permission after Reply, held by Owner, Admin and Strategist/Editor; the list equals the code's 52, less another draft's keys", async () => {
  const w = await world();
  const p = (await w.db.query(`select group_key, group_label, label, hint, sort_order from public.permissions where key = 'files.manage'`)).rows[0];
  assert.deepEqual(p, {
    group_key: "footage",
    group_label: "Footage and edits",
    label: "Manage folders and read them with Gemini",
    hint: "Make, rename, move and remove your team's folders in Files, see the folders that were in the drive before, and have Gemini read a folder.",
    sort_order: 65,
  });
  const holders = (await w.db.query(
    `select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id
      where rp.permission_key = 'files.manage' and rp.deleted_at is null and r.key is not null order by 1`,
  )).rows.map((r) => r.key);
  assert.deepEqual(holders, ["admin", "owner", "strategist"]);
  const rows = (await w.db.query(`select key, group_key, group_label, label, hint from public.permissions where deleted_at is null order by sort_order`)).rows;
  assert.equal(PERMISSIONS.length, 52);
  assert.equal(rows.length, 52 - OTHER_DRAFT_KEYS.length);
  assert.deepEqual(
    rows.map((r) => ({ key: r.key, group: r.group_key, groupLabel: r.group_label, label: r.label, hint: r.hint })),
    PERMISSIONS.filter((p) => !OTHER_DRAFT_KEYS.includes(p.key)).map(({ key, group, groupLabel, label, hint }) => ({ key, group, groupLabel, label, hint })),
  );
  const live = async (key) => (await w.db.query(`select rp.permission_key from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = $1 and rp.deleted_at is null order by 1`, [key])).rows.map((r) => r.permission_key);
  for (const key of ["owner", "admin", "strategist", "viewer"]) assert.deepEqual(await live(key), PREBUILT[key].keys.filter((k) => !OTHER_DRAFT_KEYS.includes(k)).sort(), key);
  assert.equal((await live("strategist")).length, 31);
  /* who really has it */
  for (const [who, has] of [[w.owner, true], [w.admin, true], [w.strat, true], [w.keeper, true], [w.outsider, true], [w.editor, false], [w.viewer, false], [w.pending, false]]) {
    assert.equal(await oneAs(w.db, who, `select private.has_permission('files.manage')`), has);
  }
});

test("seed: the daily limit is 5 dollars and only the owner changes it; today's prices of the two reader models", async () => {
  const w = await world();
  assert.equal(await one(w.db, `select value from public.app_settings where key = 'ai.daily_cap_usd'`), 5);
  assert.deepEqual(await one(w.db, `select pricing from public.ai_models where model_key = 'gemini-3.5-transcribe'`), { usd_per_minute: 0.005, checked_on: "2026-11-16" });
  assert.deepEqual(await one(w.db, `select pricing from public.ai_models where model_key = 'gemini-4-hydrogen'`), { usd_per_mtok_in: 1.5, usd_per_mtok_out: 7.5, checked_on: "2026-11-16" });
  const set = (who, v) => rowsAs(w.db, who, `update public.app_settings set value = $1::jsonb where key = 'ai.daily_cap_usd' returning key`, [v]);
  for (const who of [w.admin, w.strat, w.editor, w.viewer]) assert.equal((await set(who, "50")).length, 0);
  assert.equal(await one(w.db, `select value from public.app_settings where key = 'ai.daily_cap_usd'`), 5);
  assert.equal((await set(w.owner, "8")).length, 1);
  assert.equal((await reserve(w, 0.1)).cap, 8);
  /* running it again never resets the owner's limit (the seed keeps what is there) */
  await w.db.exec(`insert into public.app_settings (key, value) values ('ai.daily_cap_usd', '5') on conflict (key) do nothing`);
  assert.equal(await one(w.db, `select value from public.app_settings where key = 'ai.daily_cap_usd'`), 8);
});

/* ---------- the migration on rows from before ---------- */

test("on the rows of before: photos are marked and not queued, every file gets its home folder, a doubled card folder keeps the oldest", async () => {
  const db = await before();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const ids = await as(db, owner, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const week = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const card = await q(`insert into public.cards (week_id, title) values ($1, 'A card') returning id`, [week]);
    const batch = await q(`insert into public.upload_batches (space_id, day, uploaded_by) values ($1, '2026-11-17', $2) returning id`, [noun, owner]);
    const clip = (file, mime) => q(`insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, file_name, mime_type, shot_on, uploaded_by) values ($1, $2, $3, 'day-raw-1', $3, $4, '2026-11-17', $5) returning id`, [noun, batch, file, mime, owner]);
    return { week, card, video: await clip("a.mov", "video/quicktime"), photo: await clip("b.jpg", "image/jpeg") };
  });
  /* the first upload flow's day folder, and one card's folder recorded twice */
  await db.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, day, name) values ('old-day', 'day', $1, '2026-11-17', 'Tue Nov 17')`, [noun]);
  await db.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, card_id, name, created_at) values ('card-1', 'card', $1, $2, 'c', now() - interval '1 hour'), ('card-2', 'card', $1, $2, 'c', now())`, [noun, ids.card]);
  const w = { db };
  await run(db);

  const video = await clipRow(w, ids.video);
  const photo = await clipRow(w, ids.photo);
  assert.deepEqual([video.kind, video.index_status, video.home_drive_folder_id, video.storage_provider, video.index_attempts], ["video", "done", "day-raw-1", "gdrive", 0], "a video of before is not read");
  assert.deepEqual([photo.kind, photo.index_status, photo.home_drive_folder_id], ["photo", "done", "day-raw-1"]);
  assert.equal(await one(db, `select origin from public.upload_batches limit 1`), "upload");
  assert.deepEqual((await db.query(`select drive_folder_id from public.drive_folders where purpose = 'card' and deleted_at is null`)).rows, [{ drive_folder_id: "card-1" }]);
  assert.equal(await count(w, `public.drive_folders`), 3, "nothing is deleted");

  /* the new tree's day folder (it carries its week) lives next to the first flow's folder of the same day */
  await db.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, week_id, day, name) values ('new-day', 'day', $1, $2, '2026-11-17', 'Tue Nov 17')`, [noun, ids.week]);
  await assert.rejects(db.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, week_id, day, name) values ('new-day-2', 'day', $1, $2, '2026-11-17', 'x')`, [noun, ids.week]), UNIQUE);
  await assert.rejects(db.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, day, name) values ('old-day-2', 'day', $1, '2026-11-17', 'x')`, [noun]), UNIQUE);
});

/* ---------- folders ---------- */

test("folders: one live New uploads per space, one Raw and one week folder per week, one folder per card; removed ones make room", async () => {
  const w = await world();
  const add = (purpose, driveId, extra = {}) =>
    as(w.db, w.strat, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, week_id, card_id, parent_drive_folder_id, name) values ($1, $2, $3, $4, $5, 'parent', 'x')`, [driveId, purpose, w.noun, extra.week ?? null, extra.card ?? null]));
  await add("new_uploads", "nu-1");
  await assert.rejects(add("new_uploads", "nu-2"), UNIQUE);
  await add("week", "wk-1", { week: w.week });
  await assert.rejects(add("week", "wk-2", { week: w.week }), UNIQUE);
  await add("week_raw", "raw-1", { week: w.week });
  await assert.rejects(add("week_raw", "raw-2", { week: w.week }), UNIQUE);
  await add("card", "card-1", { card: w.cardA });
  await assert.rejects(add("card", "card-2", { card: w.cardA }), UNIQUE);
  await add("card", "card-b", { card: w.cardB });
  /* a new kind says what it belongs to */
  await assert.rejects(add("week_raw", "raw-x"), /drive_folders_week_raw_week/);
  await assert.rejects(add("card", "card-x"), /drive_folders_card_card/);
  await assert.rejects(w.db.query(`insert into public.drive_folders (drive_folder_id, purpose, name) values ('nu-x', 'new_uploads', 'x')`), /drive_folders_new_uploads_space/);
  await assert.rejects(add("nonsense", "zz"), /drive_folders_purpose_check/);
  /* removed (never deleted): a new record may take its place */
  await as(w.db, w.strat, (tx) => tx.query(`update public.drive_folders set deleted_at = now() where drive_folder_id = 'nu-1'`));
  await add("new_uploads", "nu-2");
  assert.equal(await one(w.db, `select parent_drive_folder_id from public.drive_folders where drive_folder_id = 'nu-2'`), "parent");
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.drive_folders where drive_folder_id = 'nu-1'`)), NO_TABLE);
});

test("folders by role: planners write the app's folders; files.manage writes team folders only; legacy folders show only to files.manage; Gemini's lines are the server's", async () => {
  const w = await world();
  const add = (who, purpose, driveId, space = w.noun) =>
    as(w.db, who, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, name, ai_summary, ai_read_at) values ($1, $2, $3, 'B roll', 'made up', now())`, [driveId, purpose, space]));
  for (const who of [w.owner, w.admin, w.strat, w.keeper]) await add(who, "team", `team-${who}`);
  /* the keeper holds files.manage and nothing else: a team folder yes, an app folder no */
  await assert.rejects(add(w.keeper, "week", "week-k"), RLS);
  await assert.rejects(add(w.keeper, "team", "team-founder", w.founder), RLS, "not in a space they do not open");
  await add(w.strat, "week", "week-s");
  for (const who of [w.editor, w.viewer, w.outsider, w.pending]) await assert.rejects(add(who, "team", `team-no-${who}`), RLS);
  await assert.rejects(as(w.db, "anon", (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, name) values ('a', 'team', 'x')`)), /permission denied|row-level security/);
  /* a person never writes Gemini's lines: not when adding, not later */
  assert.deepEqual((await w.db.query(`select ai_summary, ai_read_at from public.drive_folders where drive_folder_id = $1`, [`team-${w.keeper}`])).rows[0], { ai_summary: null, ai_read_at: null });
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.drive_folders set ai_summary = 'mine' where drive_folder_id = $1`, [`team-${w.strat}`])), SYSTEM_ONLY);
  /* rename, mark for the sweeper, remove: the keeper on a team folder, not on the week folder */
  const upd = (who, driveId) => rowsAs(w.db, who, `update public.drive_folders set name = 'B roll 2', needs_sync = true where drive_folder_id = $1 returning id`, [driveId]);
  assert.equal((await upd(w.keeper, `team-${w.strat}`)).length, 1);
  assert.equal((await upd(w.keeper, "week-s")).length, 0);
  assert.equal((await upd(w.editor, `team-${w.strat}`)).length, 0);
  assert.equal((await upd(w.strat, "week-s")).length, 1);

  /* a folder from before the app, at the top of the drive (no space) and one tied to a space */
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, name) values ('legacy-top', 'legacy', 'WEEK 1')`));
  await as(w.db, w.keeper, (tx) => tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, name) values ('legacy-noun', 'legacy', $1, 'WEEK 2')`, [w.noun]));
  const sees = async (who) => (await rowsAs(w.db, who, `select drive_folder_id from public.drive_folders where purpose = 'legacy' order by 1`)).map((r) => r.drive_folder_id);
  for (const who of [w.owner, w.admin, w.strat, w.keeper]) assert.deepEqual(await sees(who), ["legacy-noun", "legacy-top"]);
  assert.deepEqual(await sees(w.outsider), ["legacy-top"], "files.manage, but not that space");
  for (const who of [w.editor, w.viewer, w.pending]) assert.deepEqual(await sees(who), []);
  /* team folders: everyone who opens the space reads them */
  for (const [who, yes] of [[w.editor, true], [w.viewer, true], [w.outsider, false], [w.pending, false]]) {
    assert.equal((await rowsAs(w.db, who, `select 1 from public.drive_folders where purpose = 'team'`)).length > 0, yes);
  }
  /* our server writes the lines through its own function */
  const folder = await one(w.db, `select id from public.drive_folders where drive_folder_id = 'legacy-noun'`);
  await as(w.db, "service", (tx) => tx.query(`select public.save_reader_summary('folder', $1, ' Old shoots from October. ')`, [folder]));
  const f = (await w.db.query(`select ai_summary, ai_read_at from public.drive_folders where id = $1`, [folder])).rows[0];
  assert.equal(f.ai_summary, "Old shoots from October.");
  assert.ok(f.ai_read_at);
});

/* ---------- drops and files, as a person writes them ---------- */

test("a drop needs no day and a file no day: saved by people who upload; a photo is never queued; the reader's columns are never a person's", async () => {
  const w = await world();
  const drop = (who, origin = "upload", space = w.noun) =>
    oneAs(w.db, who, `insert into public.upload_batches (space_id, uploaded_by, upload_source, origin, drive_folder_id, ai_summary) values ($1, $2, 'desktop', $3, 'folder-nu', 'made up') returning id`, [space, who, origin]);
  const file = (who, batch, id, mime) =>
    oneAs(
      w.db,
      who,
      `insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, file_name, mime_type, uploaded_by, kind, has_speech, ai_title, ai_summary, index_attempts, index_hold, index_error, claimed_at, index_status)
       values ($1, $2, $3, 'folder-nu', 'IMG.MOV', $4, $5, 'video', true, 'made up', 'made up', 5, 'cap', 'made up', now(), 'done') returning id`,
      [w.noun, batch, id, mime, who],
    );
  const batch = await drop(w.editor);
  const b = (await w.db.query(`select day, origin, drive_folder_id, ai_summary, uploaded_by from public.upload_batches where id = $1`, [batch])).rows[0];
  assert.deepEqual(b, { day: null, origin: "upload", drive_folder_id: "folder-nu", ai_summary: null, uploaded_by: w.editor });
  const video = await clipRow(w, await file(w.editor, batch, "v-1", "video/mp4"));
  assert.deepEqual(
    [video.shot_on, video.kind, video.index_status, video.has_speech, video.ai_title, video.ai_summary, video.index_attempts, video.index_hold, video.index_error, video.claimed_at, video.home_drive_folder_id, video.storage_provider],
    [null, "video", "queued", null, null, null, 0, null, null, null, "folder-nu", "gdrive"],
  );
  const photo = await clipRow(w, await file(w.editor, batch, "p-1", "image/heic"));
  assert.deepEqual([photo.kind, photo.index_status], ["photo", "done"]);
  await drop(w.strat, "files");
  /* who may: the same people as before this migration */
  for (const who of [w.viewer, w.outsider, w.pending, w.keeper]) await assert.rejects(drop(who), RLS);
  await assert.rejects(drop(w.editor, "upload", w.founder), RLS);
  await assert.rejects(drop(w.editor, "nonsense"), /upload_batches_origin_check/);
  /* "Read this folder" is not a drop a person without files.manage can make by hand */
  await assert.rejects(drop(w.editor, "folder_read"), /manage folders/);

  /* later: a person changes none of what Gemini and the reader write */
  const set = (who, sql) => as(w.db, who, (tx) => tx.query(`update public.raw_clips set ${sql} where id = $1`, [video.id]));
  for (const sql of ["index_status = 'done'", "has_speech = false", "ai_title = 'x'", "ai_summary = 'x'", "index_attempts = 0 + 3", "index_hold = 'cap'", "next_try_at = now()", "claimed_at = now()", "index_error = 'x'", "kind = 'photo'", "storage_provider = 'r2'", "transcript = 'x'"]) {
    await assert.rejects(set(w.strat, sql), SYSTEM_ONLY, sql);
    await assert.rejects(set(w.editor, sql), SYSTEM_ONLY, sql);
  }
  await assert.rejects(set(w.strat, "home_drive_folder_id = 'elsewhere'"), /fixed once saved/);
  await assert.rejects(set(w.strat, "drive_file_id = 'other'"), /fixed once saved/);
  await set(w.strat, "drive_folder_id = 'folder-week-raw'"); // where it is now may change (a move)
  /* the drop: how it came in is fixed, Gemini's lines are the server's, the folder is saved once */
  const setDrop = (sql) => as(w.db, w.strat, (tx) => tx.query(`update public.upload_batches set ${sql} where id = $1`, [batch]));
  await assert.rejects(setDrop("origin = 'files'"), /fixed once saved/);
  await assert.rejects(setDrop("ai_summary = 'x'"), SYSTEM_ONLY);
  await assert.rejects(setDrop("drive_folder_id = 'other'"), /fixed once saved/);
  await as(w.db, "service", (tx) => tx.query(`select public.save_reader_summary('drop', $1, 'Two takes of the silky hook.')`, [batch]));
  assert.equal(await one(w.db, `select ai_summary from public.upload_batches where id = $1`, [batch]), "Two takes of the silky hook.");
});

test("the old day inbox still saves on the new database: a drop with its day, a file that takes the day from it", async () => {
  const w = await world();
  const batch = await oneAs(w.db, w.editor, `insert into public.upload_batches (space_id, day, uploaded_by, upload_source, device) values ($1, '2026-11-17', $2, 'desktop', 'Mac') returning id`, [w.noun, w.editor]);
  const clip = await oneAs(
    w.db,
    w.editor,
    `insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, file_name, mime_type, size_bytes, md5_checksum, uploaded_by, upload_source)
     values ($1, $2, 'old-1', 'day-raw', 'IMG_1.MOV', 'video/quicktime', 4120000000, 'md5', $3, 'desktop') returning id`,
    [w.noun, batch, w.editor],
  );
  const row = await clipRow(w, clip);
  assert.equal(await one(w.db, `select shot_on::text from public.raw_clips where id = $1`, [clip]), "2026-11-17");
  assert.deepEqual([row.index_status, row.kind, row.home_drive_folder_id], ["queued", "video", "day-raw"]);
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2)`, [w.cardA, clip]));
  assert.equal(await statusOf(w, w.cardA), "shot");
});

/* ---------- who may run what ---------- */

test("the reader's functions answer only our own server; people's functions never answer someone not signed in", async () => {
  const w = await world();
  const clip = await addClip(w);
  const serverOnly = [
    [`select * from public.claim_clip_jobs(1, 15)`, []],
    [`select * from public.reserve_ai_spend('clip_indexer', 0.01)`, []],
    [`select public.finish_clip_index($1, '{"outcome":"gone"}'::jsonb)`, [clip]],
    [`select public.save_reader_summary('drop', $1, 'x')`, [clip]],
    [`select * from public.clip_card_candidates($1, 5)`, [clip]],
    [`select public.reader_heartbeat(true)`, []],
  ];
  for (const [sql, params] of serverOnly) {
    for (const who of [w.owner, w.admin, w.strat, w.editor, w.viewer, w.pending, "anon"]) await assert.rejects(rowsAs(w.db, who, sql, params), NO_FUNCTION, `${sql} as ${who}`);
  }
  for (const fn of ["private.ai_spent_today()", "private.ai_daily_cap()", "private.reader_record_calls('[]'::jsonb, null, null)"]) {
    for (const who of [w.owner, "service"]) await assert.rejects(rowsAs(w.db, who, `select ${fn}`), NO_FUNCTION, fn);
  }
  assert.equal((await clipRow(w, clip)).deleted_at, null, "nothing happened");
  /* the heartbeat: no row until the reader first says it is alive, then one row that follows it */
  assert.equal(await count(w, `public.app_settings where key = 'ai.reader_heartbeat'`), 0, "no fake row is seeded");
  await rowsAs(w.db, "service", `select public.reader_heartbeat(true)`);
  const beat = await one(w.db, `select value from public.app_settings where key = 'ai.reader_heartbeat'`);
  assert.equal(beat.running, true);
  assert.ok(Math.abs(Date.parse(beat.at) - Date.now()) < 60_000);
  await rowsAs(w.db, "service", `select public.reader_heartbeat(false)`);
  assert.equal((await one(w.db, `select value from public.app_settings where key = 'ai.reader_heartbeat'`)).running, false);
  assert.equal(await count(w, `public.app_settings where key = 'ai.reader_heartbeat'`), 1);
  assert.equal((await rowsAs(w.db, w.owner, `select 1 from public.app_settings where key = 'ai.reader_heartbeat'`)).length, 1, "Settings reads it");
  assert.equal((await rowsAs(w.db, w.editor, `select 1 from public.app_settings where key = 'ai.reader_heartbeat'`)).length, 0);
  const persons = [
    [`select public.decide_clip_suggestion($1, $2)`, [clip, w.cardA]],
    [`select public.undo_clip_move($1)`, [clip]],
    [`select public.request_folder_read($1, 'f', '[]'::jsonb)`, [w.noun]],
    [`select public.retry_clip($1)`, [clip]],
    [`select public.requeue_folder_clips(array[$1::text])`, ["f"]],
  ];
  for (const [sql, params] of persons) {
    await assert.rejects(rowsAs(w.db, "anon", sql, params), NO_FUNCTION);
    await assert.rejects(rowsAs(w.db, "service", sql, params), NO_FUNCTION, "they act as a person, never as the server");
    await assert.rejects(rowsAs(w.db, w.pending, sql, params), /Sign in/);
  }
  await assert.rejects(rowsAs(w.db, "anon", `select * from public.ai_spend_today()`), NO_FUNCTION);
  /* every one of them runs with a fixed search path, as the database owner */
  const fns = (await w.db.query(
    `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('claim_clip_jobs', 'reserve_ai_spend', 'finish_clip_index', 'save_reader_summary', 'clip_card_candidates', 'reader_heartbeat',
                                                   'decide_clip_suggestion', 'undo_clip_move', 'request_folder_read', 'retry_clip', 'ai_spend_today', 'requeue_folder_clips')`,
  )).rows;
  assert.equal(fns.length, 12);
  for (const f of fns) {
    assert.equal(f.prosecdef, true, f.proname);
    assert.ok((f.proconfig ?? []).some((c) => /^search_path=(""|)$/.test(c)), f.proname);
  }
});

/* ---------- the daily limit ---------- */

test("reserve_ai_spend: holds the estimate, refuses past the limit, also with many callers at once; real costs replace estimates; only today counts", async () => {
  const w = await world();
  const first = await reserve(w, 1.5);
  assert.deepEqual([first.ok, first.cap, first.spent], [true, 5, 1.5]);
  assert.ok(first.run);
  const run = (await w.db.query(`select agent_key, status, trigger, plan_cost_est_usd::float8 as est, total_cost_usd::float8 as cost from public.agent_runs where id = $1`, [first.run])).rows[0];
  assert.deepEqual(run, { agent_key: "clip_indexer", status: "running", trigger: "event", est: 1.5, cost: 0 });

  /* thirty callers at once for 0.5 each: 3.5 is left, so exactly seven get through */
  const many = await Promise.all(Array.from({ length: 30 }, () => reserve(w, 0.5, "clip_matcher")));
  assert.equal(many.filter((r) => r.ok).length, 7);
  assert.ok(many.filter((r) => !r.ok).every((r) => r.run === null && r.spent === 5));
  assert.equal(await count(w, `public.agent_runs`), 8, "a refused call opens no run");
  assert.equal(Number(await one(w.db, `select private.ai_spent_today()`)), 5);
  assert.equal((await reserve(w, 0)).ok, false, "at the limit even a free call waits");
  assert.match(await one(w.db, `select pg_get_functiondef('public.reserve_ai_spend(text, numeric, jsonb)'::regprocedure)`), /pg_advisory_xact_lock/);

  /* the first call cost 0.2, not 1.5: the difference is free again */
  const clip = await addClip(w);
  await claim(w);
  await finish(w, clip, { outcome: "transcribed", transcript: "hello", calls: [{ run_id: first.run, tool_name: "transcribe", provider_key: "google", model_key: "gemini-3.5-transcribe", cost_usd: 0.2 }] });
  assert.equal(Number(await one(w.db, `select private.ai_spent_today()`)), 3.7);
  assert.equal((await reserve(w, 1.3)).ok, true);
  assert.equal((await reserve(w, 0.01)).ok, false);

  /* yesterday's spend does not count today (the day is New York's) */
  await w.db.exec(`update public.agent_runs set created_at = now() - interval '2 days'`);
  assert.equal(Number(await one(w.db, `select private.ai_spent_today()`)), 0);
  assert.equal((await reserve(w, 4.99)).ok, true);
  assert.equal(await one(w.db, `select private.ai_day_start() <= now() and private.ai_day_start() > now() - interval '25 hours'`), true);

  /* odd asks */
  await assert.rejects(reserve(w, -1), /below zero/);
  await assert.rejects(reserve(w, 0.1, "no_such_agent"), /No such agent/);
  /* a limit nobody can read falls back to 5; a limit of zero stops everything */
  await w.db.exec(`update public.app_settings set value = '"lots"' where key = 'ai.daily_cap_usd'`);
  assert.equal(Number(await one(w.db, `select private.ai_daily_cap()`)), 5);
  await w.db.exec(`update public.app_settings set value = '0' where key = 'ai.daily_cap_usd'`);
  assert.equal((await reserve(w, 0)).ok, false);
});

test("ai_spend_today: every active person reads the meter (limit, spent, files that wait in their spaces); nobody else", async () => {
  const w = await world();
  await reserve(w, 1.25);
  const held = await addClip(w);
  const heldFounder = await addClip(w, { space: w.founder });
  await claim(w, 20);
  for (const c of [held, heldFounder]) await finish(w, c, { outcome: "held" });
  const meter = async (who) => {
    const r = (await rowsAs(w.db, who, `select * from public.ai_spend_today()`))[0];
    return [Number(r.cap_usd), Number(r.spent_usd), r.held];
  };
  for (const who of [w.owner, w.admin, w.strat, "service"]) assert.deepEqual(await meter(who), [5, 1.25, 2]);
  for (const who of [w.editor, w.viewer, w.keeper]) assert.deepEqual(await meter(who), [5, 1.25, 1], "only the space they open");
  assert.deepEqual(await meter(w.outsider), [5, 1.25, 0]);
  await assert.rejects(meter(w.pending), /Sign in/);
});

/* ---------- the reader's queue ---------- */

test("claim_clip_jobs: oldest first, one reader per file, photos never, a lease that runs out, six stops and it is failed", async () => {
  const w = await world();
  const a = await addClip(w);
  const b = await addClip(w);
  const c = await addClip(w, { space: w.founder });
  const photo = await addClip(w, { mime: "image/jpeg" });
  await w.db.query(`update public.raw_clips set created_at = now() - (case id when $1 then interval '3 minutes' when $2 then interval '2 minutes' else interval '1 minute' end)`, [a, b]);

  const first = await claim(w, 2);
  assert.deepEqual(first.map((r) => r.id), [a, b]);
  assert.deepEqual(Object.keys(first[0]).sort(), ["drive_file_id", "drive_folder_id", "duration_ms", "file_name", "has_speech", "home_drive_folder_id", "id", "index_attempts", "mime_type", "size_bytes", "space_id", "transcript", "transcript_language", "upload_batch_id"]);
  assert.equal(first[0].index_attempts, 1);
  const rowA = await clipRow(w, a);
  assert.equal(rowA.index_status, "running");
  assert.ok(rowA.claimed_at);
  /* the next reader gets what is left, and then nothing: a claimed file is nobody else's */
  assert.deepEqual((await claim(w, 5)).map((r) => r.id), [c]);
  assert.deepEqual(await claim(w, 5), []);
  assert.equal((await clipRow(w, photo)).index_status, "done", "a photo is never read");
  assert.match(await one(w.db, `select pg_get_functiondef('public.claim_clip_jobs(int, int)'::regprocedure)`), /for update skip locked/i);

  /* the reader of a stopped answering: after the lease another takes the file, and the saved transcript comes with it */
  await finish(w, a, { outcome: "transcribed", transcript: "said once", language: "en" });
  await w.db.query(`update public.raw_clips set claimed_at = now() - interval '16 minutes' where id = $1`, [a]);
  const again = await claim(w, 5);
  assert.deepEqual(again.map((r) => [r.id, r.index_attempts, r.transcript, r.has_speech]), [[a, 2, "said once", true]]);
  assert.deepEqual(await claim(w, 5, 15), [], "b and c are inside their lease");
  /* a shorter lease is the caller's to ask; limits are kept sane */
  await w.db.query(`update public.raw_clips set claimed_at = now() - interval '3 minutes' where id = $1`, [b]);
  assert.deepEqual((await claim(w, -5, 2)).map((r) => r.id), [b]);

  /* six starts that never finished: failed, with its words, and Retry is offered */
  await w.db.query(`update public.raw_clips set index_attempts = 6, claimed_at = now() - interval '1 hour' where id = $1`, [c]);
  assert.deepEqual(await claim(w, 5), []);
  const rowC = await clipRow(w, c);
  assert.deepEqual([rowC.index_status, rowC.claimed_at, rowC.index_error], ["failed", null, "The reader stopped on this file six times."]);
  /* a removed file is never taken */
  const gone = await addClip(w);
  await w.db.query(`update public.raw_clips set deleted_at = now() where id = $1`, [gone]);
  assert.deepEqual(await claim(w, 5), []);
});

test("the daily limit holds files: held is not a try, held files wait until there is room again", async () => {
  const w = await world();
  const a = await addClip(w);
  const b = await addClip(w);
  await claim(w);
  assert.deepEqual(await finish(w, a, { outcome: "held" }), { ok: true, status: "queued", hold: "cap" });
  const row = await clipRow(w, a);
  assert.deepEqual([row.index_status, row.index_hold, row.index_attempts, row.claimed_at], ["queued", "cap", 0, null]);
  /* the limit is reached: the held file stays where it is, a new file is still handed out (it asks for itself) */
  await w.db.exec(`update public.app_settings set value = '0' where key = 'ai.daily_cap_usd'`);
  await finish(w, b, { outcome: "retry", error: "x" });
  await w.db.query(`update public.raw_clips set next_try_at = null where id = $1`, [b]);
  assert.deepEqual((await claim(w)).map((r) => r.id), [b]);
  /* the owner raises it (or the next day starts): the held file is taken again, its hold cleared */
  await w.db.exec(`update public.app_settings set value = '5' where key = 'ai.daily_cap_usd'`);
  assert.deepEqual((await claim(w)).map((r) => [r.id, r.index_attempts]), [[a, 1]]);
  assert.equal((await clipRow(w, a)).index_hold, null);
});

/* ---------- what the reader saves ---------- */

test("finish_clip_index: the transcript is saved at once; then title, summary and up to three guesses that wait for a person; costs are saved once", async () => {
  const w = await world();
  const batch = await oneAs(w.db, w.strat, `insert into public.upload_batches (space_id, uploaded_by, drive_folder_id) values ($1, $2, 'folder-nu') returning id`, [w.noun, w.strat]);
  const clip = await addClip(w, { batch });
  const other = await addClip(w, { batch });
  await claim(w, 1);
  const t = await reserve(w, 0.02);
  const transcribed = { outcome: "transcribed", transcript: "that silky feeling might be a coating", language: "en", words: [{ w: "that", s: 0 }], duration_ms: 42000, calls: [{ run_id: t.run, tool_name: "transcribe", provider_key: "google", model_key: "gemini-3.5-transcribe", cost_usd: 0.0035, input_summary: "42 s of sound" }] };
  assert.deepEqual(await finish(w, clip, transcribed), { ok: true, status: "running" });
  let row = await clipRow(w, clip);
  assert.deepEqual([row.index_status, row.transcript, row.transcript_language, row.has_speech, row.duration_ms, row.index_run_id], ["running", "that silky feeling might be a coating", "en", true, 42000, t.run]);
  /* the same answer again (a lost reply): nothing is counted twice */
  await finish(w, clip, transcribed);
  assert.equal(await count(w, `public.agent_tool_calls where run_id = $1`, [t.run]), 1);
  assert.deepEqual((await w.db.query(`select status, total_cost_usd::float8 as cost from public.agent_runs where id = $1`, [t.run])).rows[0], { status: "done", cost: 0.0035 });
  assert.deepEqual((await w.db.query(`select entity_table, entity_id from public.agent_run_outputs where run_id = $1`, [t.run])).rows, [{ entity_table: "raw_clips", entity_id: clip }]);

  const m = await reserve(w, 0.01, "clip_matcher");
  const done = await finish(w, clip, {
    outcome: "done",
    title: "Silky is a coating",
    summary: "She explains why silky hair can be a coating.",
    index: { topics: ["silicones"] },
    model: { provider_key: "google", model_key: "gemini-4-hydrogen" },
    suggestions: [
      { card_id: w.cardA, confidence: 82.5, reason: "Same hook" },
      { card_id: w.cardF, confidence: 60, reason: "Another space: left out" },
      { card_id: w.cardB, confidence: 140, reason: "Kept inside 0 to 100" },
      { card_id: w.cardB, confidence: 10, reason: "A fourth: left out" },
    ],
    calls: [{ run_id: m.run, tool_name: "match", provider_key: "google", model_key: "gemini-4-hydrogen", cost_usd: 0.005, tokens_in: 2100, tokens_out: 180 }],
  });
  assert.equal(done.ok, true);
  assert.equal(done.suggestion_ids.length, 2);
  assert.deepEqual([done.move_id, done.link_id, done.batch_id, done.batch_open], [null, null, batch, 1], "one more file of the drop is still to read");
  row = await clipRow(w, clip);
  assert.deepEqual([row.index_status, row.ai_title, row.ai_summary, row.ai_index, row.claimed_at, row.drive_folder_id], ["done", "Silky is a coating", "She explains why silky hair can be a coating.", { topics: ["silicones"] }, null, "folder-new-uploads"]);
  const sugs = (await w.db.query(`select card_id, confidence::float8 as confidence, rank, outcome, auto_applied, run_id, model_key, decided_by from public.clip_match_suggestions where raw_clip_id = $1 order by rank`, [clip])).rows;
  assert.deepEqual(sugs, [
    { card_id: w.cardA, confidence: 82.5, rank: 1, outcome: "pending", auto_applied: false, run_id: m.run, model_key: "gemini-4-hydrogen", decided_by: null },
    { card_id: w.cardB, confidence: 100, rank: 3, outcome: "pending", auto_applied: false, run_id: m.run, model_key: "gemini-4-hydrogen", decided_by: null },
  ]);
  assert.equal(await count(w, `public.card_raw_clips`), 0, "nothing is filed without a person below sure");
  assert.equal(await count(w, `public.raw_clip_moves`), 0);
  assert.deepEqual((await w.db.query(`select tokens_in, tokens_out, cost_usd::float8 as cost, model_key, status from public.agent_tool_calls where run_id = $1`, [m.run])).rows, [{ tokens_in: 2100, tokens_out: 180, cost: 0.005, model_key: "gemini-4-hydrogen", status: "done" }]);
  /* done twice: already, and nothing doubles */
  assert.deepEqual(await finish(w, clip, { outcome: "done", suggestions: [{ card_id: w.cardA, confidence: 99 }] }), { ok: true, already: true, status: "done" });
  assert.equal(await count(w, `public.clip_match_suggestions where raw_clip_id = $1`, [clip]), 2);
  /* a file nobody claimed is not the reader's to finish */
  assert.deepEqual(await finish(w, other, { outcome: "no_speech" }), { ok: false, reason: "not_running", status: "queued" });
  await assert.rejects(finish(w, clip, { outcome: "nonsense" }), /Unknown outcome/);
  await assert.rejects(finish(w, "00000000-0000-4000-8000-000000000000", { outcome: "gone" }), /No such clip/);

  /* what reading cost shows to the team: the reader's runs and calls, never another agent's */
  await w.db.exec(`insert into public.agent_runs (agent_key, trigger, status, total_cost_usd) values ('head_of_content', 'schedule', 'done', 3)`);
  for (const who of [w.strat, w.editor, w.viewer, w.keeper]) {
    assert.deepEqual((await rowsAs(w.db, who, `select distinct agent_key from public.agent_runs order by 1`)).map((r) => r.agent_key), ["clip_indexer", "clip_matcher"]);
    assert.equal((await rowsAs(w.db, who, `select 1 from public.agent_tool_calls`)).length, 2);
    assert.equal((await rowsAs(w.db, who, `select 1 from public.agent_run_outputs`)).length, 2);
  }
  assert.equal((await rowsAs(w.db, w.owner, `select 1 from public.agent_runs`)).length, 3);
  assert.equal((await rowsAs(w.db, w.pending, `select 1 from public.agent_runs`)).length, 0);
  assert.equal((await rowsAs(w.db, w.pending, `select 1 from public.agent_tool_calls`)).length, 0);
});

test("finish_clip_index: no speech, a retry with a longer wait each time and failed after six, a file gone from Drive", async () => {
  const w = await world();
  const silent = await addClip(w);
  const flaky = await addClip(w);
  const gone = await addClip(w);
  await claim(w, 20);
  const done = await finish(w, silent, { outcome: "no_speech", duration_ms: 9000 });
  assert.deepEqual([done.ok, done.status, done.suggestion_ids], [true, "done", []]);
  const s = await clipRow(w, silent);
  assert.deepEqual([s.index_status, s.has_speech, s.ai_title, s.duration_ms, s.claimed_at], ["done", false, null, 9000, null]);
  assert.equal(await count(w, `public.clip_match_suggestions`), 0);
  assert.equal(await count(w, `public.agent_runs`), 0, "silence costs nothing");

  /* a failed paid call: its run closes as failed with what it cost, the file waits and is tried again */
  const r = await reserve(w, 0.02);
  assert.deepEqual(await finish(w, flaky, { outcome: "retry", error: "Gemini answered 503", calls: [{ run_id: r.run, tool_name: "transcribe", cost_usd: 0, error: "503" }] }), { ok: true, status: "queued" });
  assert.deepEqual((await w.db.query(`select status, error, total_cost_usd::float8 as cost from public.agent_runs where id = $1`, [r.run])).rows[0], { status: "failed", error: "503", cost: 0 });
  let f = await clipRow(w, flaky);
  assert.deepEqual([f.index_status, f.index_error, f.index_attempts, f.claimed_at], ["queued", "Gemini answered 503", 1, null]);
  const waitMin = async () => Math.round(Number(await one(w.db, `select extract(epoch from (next_try_at - now())) / 60 from public.raw_clips where id = $1`, [flaky])));
  assert.equal(await waitMin(), 2);
  assert.deepEqual(await claim(w, 20), [], "not before its next try");
  const waits = [];
  for (let i = 2; i <= 5; i++) {
    await w.db.query(`update public.raw_clips set next_try_at = now() - interval '1 second' where id = $1`, [flaky]);
    assert.deepEqual((await claim(w, 20)).map((x) => x.index_attempts), [i]);
    await finish(w, flaky, { outcome: "retry", error: "again" });
    waits.push(await waitMin());
  }
  assert.deepEqual(waits, [4, 8, 16, 32]);
  await w.db.query(`update public.raw_clips set next_try_at = now() - interval '1 second' where id = $1`, [flaky]);
  await claim(w, 20);
  assert.deepEqual(await finish(w, flaky, { outcome: "retry" }), { ok: true, status: "failed" });
  f = await clipRow(w, flaky);
  assert.deepEqual([f.index_status, f.index_attempts, f.next_try_at, f.index_error], ["failed", 6, null, "Gemini could not read this file."]);
  assert.deepEqual(await claim(w, 20), [], "a failed file waits for Retry");

  /* the file is no longer in Drive (or its folder is in the trash): failed with its reason and Retry, never removed,
     so a folder brought back is read again */
  assert.deepEqual(await finish(w, gone, { outcome: "gone" }), { ok: true, status: "failed" });
  const g = await clipRow(w, gone);
  assert.equal(g.deleted_at, null);
  assert.deepEqual([g.index_status, g.claimed_at], ["failed", null]);
  assert.match(g.index_error, /no longer in Google Drive/);
  assert.equal(await count(w, `public.raw_clips`), 3);
  assert.equal(await as(w.db, w.strat, (tx) => tx.query(`select public.retry_clip($1) as ok`, [gone]).then((r) => r.rows[0].ok)), true, "Retry puts it back");
  assert.equal((await clipRow(w, gone)).index_status, "queued");
});

test("finish_clip_index, sure: the match is filed without asking: accepted and auto applied, linked, in the undo ledger, the card moves to Shot", async () => {
  const w = await world();
  const clip = await addClip(w);
  const m = await reserve(w, 0.01, "clip_matcher");
  const done = await read(w, clip, {
    suggestions: [{ card_id: w.cardA, confidence: 94, reason: "Same hook, word for word" }, { card_id: w.cardB, confidence: 20 }],
    applied: { card_id: w.cardA, moved: true, from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: "folder-week-raw", drive_shortcut_id: "shortcut-1" },
    calls: [{ run_id: m.run, tool_name: "match", cost_usd: 0.005 }],
  });
  assert.ok(done.move_id && done.link_id);
  const move = (await w.db.query(`select * from public.raw_clip_moves where id = $1`, [done.move_id])).rows[0];
  assert.deepEqual(
    [move.raw_clip_id, move.space_id, move.card_id, move.link_id, move.moved, move.from_drive_folder_id, move.to_drive_folder_id, move.drive_shortcut_id, move.auto_applied, Number(move.confidence), move.made_by, move.run_id, move.undone_at],
    [clip, w.noun, w.cardA, done.link_id, true, "folder-new-uploads", "folder-week-raw", "shortcut-1", true, 94, null, m.run, null],
  );
  assert.equal(move.suggestion_id, done.suggestion_ids[0]);
  const sugs = (await w.db.query(`select outcome, auto_applied, chosen_card_id, decided_by, decided_at is not null as decided from public.clip_match_suggestions where raw_clip_id = $1 order by rank`, [clip])).rows;
  assert.deepEqual(sugs, [
    { outcome: "accepted", auto_applied: true, chosen_card_id: w.cardA, decided_by: null, decided: true },
    { outcome: "pending", auto_applied: false, chosen_card_id: null, decided_by: null, decided: false },
  ]);
  const link = (await w.db.query(`select card_id, raw_clip_id, suggestion_id, drive_shortcut_id, linked_by, deleted_at from public.card_raw_clips where id = $1`, [done.link_id])).rows[0];
  assert.deepEqual(link, { card_id: w.cardA, raw_clip_id: clip, suggestion_id: done.suggestion_ids[0], drive_shortcut_id: "shortcut-1", linked_by: null, deleted_at: null });
  const row = await clipRow(w, clip);
  assert.deepEqual([row.drive_folder_id, row.home_drive_folder_id], ["folder-week-raw", "folder-new-uploads"], "where it is now, and where it was dropped");
  assert.equal(await statusOf(w, w.cardA), "shot");
  assert.equal(done.applied, "saved");
  /* the reader filed it under a card that is not among the guesses: that card gets its own accepted row and the move
     its ledger, so what was done in Drive can always be undone */
  const odd = await addClip(w);
  const res = await read(w, odd, { suggestions: [{ card_id: w.cardB, confidence: 95 }], applied: { card_id: w.cardA, moved: false, drive_shortcut_id: "shortcut-odd" } });
  assert.ok(res.move_id);
  assert.equal(res.applied, "saved");
  assert.equal(res.suggestion_ids.length, 2);
  assert.deepEqual(
    (await w.db.query(`select card_id, outcome, auto_applied, rank, confidence::float8 as confidence from public.clip_match_suggestions where raw_clip_id = $1 order by rank`, [odd])).rows,
    [{ card_id: w.cardB, outcome: "pending", auto_applied: false, rank: 1, confidence: 95 }, { card_id: w.cardA, outcome: "accepted", auto_applied: true, rank: 2, confidence: null }],
  );
  assert.equal(await one(w.db, `select card_id from public.raw_clip_moves where id = $1`, [res.move_id]), w.cardA);
  /* a card that is gone (removed, or of another space): nothing is linked, and the reader is told to take its Drive work back */
  const lost = await addClip(w);
  const refused = await read(w, lost, { suggestions: [], applied: { card_id: w.cardF, moved: true, from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: "x", drive_shortcut_id: "s" } });
  assert.deepEqual([refused.ok, refused.move_id, refused.applied], [true, null, "refused"]);
  assert.equal(await count(w, `public.card_raw_clips where raw_clip_id = $1`, [lost]), 0);
  assert.equal((await clipRow(w, lost)).drive_folder_id, "folder-new-uploads");
  /* a person cannot mark a guess auto applied, or change what Gemini said */
  const set = (sql) => as(w.db, w.strat, (tx) => tx.query(`update public.clip_match_suggestions set ${sql} where raw_clip_id = $1`, [odd]));
  await assert.rejects(set("auto_applied = true"), SYSTEM_ONLY);
  await assert.rejects(set("confidence = 99"), SYSTEM_ONLY);
});

test("clip_card_candidates: the cards of the file's own space that fit what was said, best first; removed cards and other spaces never", async () => {
  const w = await world();
  const clip = await addClip(w, { name: "patchouli_restock_take2.mov" });
  await claim(w);
  const list = async (limit = 25) => rowsAs(w.db, "service", `select * from public.clip_card_candidates($1, $2)`, [clip, limit]);
  /* before the transcript: the file's name already points at a card */
  assert.equal((await list())[0].card_id, w.cardB);
  await finish(w, clip, { outcome: "transcribed", transcript: "So that silky feeling might be a coating. Your hair is not soft, it is coated with silicone." });
  const got = await list();
  assert.deepEqual(got.map((r) => r.card_id), [w.cardA, w.cardB]);
  assert.deepEqual(Object.keys(got[0]).sort(), ["card_id", "hook", "planned_on", "score", "script", "shot", "title", "week_id", "week_name", "week_number"]);
  assert.deepEqual([got[0].title, got[0].week_name, got[0].week_number, got[0].shot], ["That silky feeling might be a coating", "Week 3", 3, false]);
  assert.ok(got[0].score > got[1].score);
  assert.equal((await list(1)).length, 1);
  await w.db.query(`update public.cards set deleted_at = now() where id = $1`, [w.cardA]);
  assert.deepEqual((await list()).map((r) => r.card_id), [w.cardB]);
});

/* ---------- a person's match, and its undo ---------- */

test("decide_clip_suggestion: only people who plan, in the file's space; it accepts the guess, sets the others aside, links, writes the ledger; twice is once", async () => {
  const w = await world();
  /* the week's Raw, as the app records it when it files a match */
  await w.db.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, week_id, name) values ('folder-week-raw', 'week_raw', $1, $2, 'Raw'), ('founder-raw', 'week_raw', $3, $4, 'Raw')`, [w.noun, w.week, w.founder, w.founderWeek]);
  const clip = await addClip(w);
  const done = await read(w, clip, { suggestions: [{ card_id: w.cardA, confidence: 82 }, { card_id: w.cardB, confidence: 40 }] });
  const [sugA, sugB] = done.suggestion_ids;

  /* who may not */
  for (const who of [w.editor, w.viewer, w.keeper]) await assert.rejects(decide(w, who, clip, w.cardA, sugA), /plan the calendar/);
  await assert.rejects(decide(w, w.outsider, clip, w.cardA, sugA), /No such file/, "plans, but does not open the space");
  await assert.rejects(decide(w, w.pending, clip, w.cardA, sugA), /Sign in/);
  await assert.rejects(decide(w, w.strat, clip, w.cardF), /own space/);
  await assert.rejects(decide(w, w.strat, clip, w.cardB, sugA), /not for this file and card/);
  await assert.rejects(decide(w, w.strat, clip, "00000000-0000-4000-8000-000000000000"), /No such card/);
  assert.equal(await count(w, `public.raw_clip_moves`), 0);
  assert.equal(await count(w, `public.card_raw_clips`), 0);

  /* the folders of a move are checked, never taken on trust */
  await assert.rejects(decide(w, w.strat, clip, w.cardA, sugA, { moved: true, from_drive_folder_id: "somewhere-else", to_drive_folder_id: "folder-week-raw" }), /did not start in that folder/);
  for (const to of ["unknown-folder", "founder-raw", null]) {
    await assert.rejects(decide(w, w.strat, clip, w.cardA, sugA, { moved: true, from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: to }), /only into a Raw folder of its own space/);
  }
  assert.equal(await count(w, `public.raw_clip_moves`), 0);

  /* the strategist confirms; the Drive work comes after, so its details are still empty */
  const first = await decide(w, w.strat, clip, w.cardA, sugA);
  assert.equal(first.already, false);
  assert.equal(first.suggestion_id, sugA);
  const sugs = (await w.db.query(`select id, outcome, chosen_card_id, decided_by, auto_applied from public.clip_match_suggestions where raw_clip_id = $1 order by rank`, [clip])).rows;
  assert.deepEqual(sugs, [
    { id: sugA, outcome: "accepted", chosen_card_id: w.cardA, decided_by: w.strat, auto_applied: false },
    { id: sugB, outcome: "replaced", chosen_card_id: w.cardA, decided_by: w.strat, auto_applied: false },
  ]);
  assert.equal(await one(w.db, `select linked_by from public.card_raw_clips where id = $1`, [first.link_id]), w.strat);
  assert.equal(await statusOf(w, w.cardA), "shot");

  /* a second tap, another person's tap, the same call after a lost answer: the same move, nothing doubles */
  const filing = { moved: true, from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: "folder-week-raw", drive_shortcut_id: "shortcut-9" };
  const again = await decide(w, w.admin, clip, w.cardA, null, filing);
  assert.deepEqual(again, { move_id: first.move_id, link_id: first.link_id, suggestion_id: sugA, already: true });
  assert.deepEqual(await decide(w, w.strat, clip, w.cardA, sugA, { drive_shortcut_id: "another" }), again);
  assert.equal(await count(w, `public.raw_clip_moves`), 1);
  assert.equal(await count(w, `public.card_raw_clips`), 1);
  /* the Drive details that were missing were filled in, once */
  const move = (await w.db.query(`select made_by, auto_applied, confidence::float8 as confidence, moved, from_drive_folder_id, to_drive_folder_id, drive_shortcut_id from public.raw_clip_moves where id = $1`, [first.move_id])).rows[0];
  assert.deepEqual(move, { made_by: w.strat, auto_applied: false, confidence: 82, moved: true, from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: "folder-week-raw", drive_shortcut_id: "shortcut-9" });
  assert.equal((await clipRow(w, clip)).drive_folder_id, "folder-week-raw", "the file is where the move put it");
  assert.equal(await one(w.db, `select drive_shortcut_id from public.card_raw_clips where id = $1`, [first.link_id]), "shortcut-9");

  /* a second card for the same file is its own move (a second shortcut); picking by hand needs no guess */
  const second = await decide(w, w.owner, clip, w.cardB, null, { moved: false, drive_shortcut_id: "shortcut-b" });
  assert.equal(second.already, false);
  assert.notEqual(second.move_id, first.move_id);
  assert.equal(second.suggestion_id, null, "that guess was set aside already");
  /* a photo, never read, is matched by hand the same way, with the Drive work done first */
  const photo = await addClip(w, { mime: "image/jpeg" });
  const p = await decide(w, w.strat, photo, w.cardA, null, filing);
  assert.equal(p.already, false);
  assert.equal((await clipRow(w, photo)).drive_folder_id, "folder-week-raw");
  assert.equal(await one(w.db, `select moved from public.raw_clip_moves where id = $1`, [p.move_id]), true);
});

test("undo_clip_move: only people who plan; the move is marked undone, the link closed, the guess rejected, the file back; twice is once; then it can be matched again", async () => {
  const w = await world();
  const clip = await addClip(w);
  const done = await read(w, clip, {
    suggestions: [{ card_id: w.cardA, confidence: 93 }],
    applied: { card_id: w.cardA, moved: true, from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: "folder-week-raw", drive_shortcut_id: "shortcut-1" },
  });
  for (const who of [w.editor, w.viewer, w.keeper]) await assert.rejects(undo(w, who, done.move_id), /plan the calendar/);
  await assert.rejects(undo(w, w.outsider, done.move_id), /No such match/);
  await assert.rejects(undo(w, w.strat, "00000000-0000-4000-8000-000000000000"), /No such match/);

  const first = await undo(w, w.strat, done.move_id);
  assert.deepEqual(first, {
    move_id: done.move_id, raw_clip_id: clip, card_id: w.cardA, link_id: done.link_id, suggestion_id: done.suggestion_ids[0], moved: true,
    from_drive_folder_id: "folder-new-uploads", to_drive_folder_id: "folder-week-raw", drive_shortcut_id: "shortcut-1", already: false,
  });
  const move = (await w.db.query(`select undone_at, undone_by from public.raw_clip_moves where id = $1`, [done.move_id])).rows[0];
  assert.ok(move.undone_at);
  assert.equal(move.undone_by, w.strat);
  assert.deepEqual((await w.db.query(`select deleted_at is not null as closed, unlinked_by from public.card_raw_clips where id = $1`, [done.link_id])).rows[0], { closed: true, unlinked_by: w.strat });
  assert.deepEqual((await w.db.query(`select outcome, decided_by, auto_applied from public.clip_match_suggestions where id = $1`, [done.suggestion_ids[0]])).rows[0], { outcome: "rejected", decided_by: w.strat, auto_applied: true });
  assert.equal((await clipRow(w, clip)).drive_folder_id, "folder-new-uploads");
  /* pressed again, by anyone who plans: the same answer, nothing changes */
  const again = await undo(w, w.admin, done.move_id);
  assert.deepEqual(again, { ...first, already: true });
  assert.equal(await one(w.db, `select undone_by from public.raw_clip_moves where id = $1`, [done.move_id]), w.strat);
  /* undone stays undone: nobody rewrites the ledger, not even our server */
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.raw_clip_moves set undone_at = null where id = $1`, [done.move_id])), /fixed once saved/);
  /* matched again by a person: a new move and a new link; the old rows stay as history */
  const next = await decide(w, w.strat, clip, w.cardA);
  assert.equal(next.already, false);
  assert.notEqual(next.move_id, done.move_id);
  assert.notEqual(next.link_id, done.link_id);
  assert.equal(await count(w, `public.raw_clip_moves`), 2);
  assert.equal(await count(w, `public.card_raw_clips`), 2);
});

test("the undo ledger: read by who opens the space, written by nobody by hand, never deleted, in the audit trail and live", async () => {
  const w = await world();
  const clip = await addClip(w);
  const founderClip = await addClip(w, { space: w.founder });
  const move = (await decide(w, w.strat, clip, w.cardA)).move_id;
  await decide(w, w.strat, founderClip, w.cardF);
  const sees = async (who) => (await rowsAs(w.db, who, `select id from public.raw_clip_moves`)).length;
  for (const who of [w.owner, w.admin, w.strat]) assert.equal(await sees(who), 2);
  for (const who of [w.editor, w.viewer, w.keeper]) assert.equal(await sees(who), 1, "the space they open");
  for (const who of [w.outsider, w.pending]) assert.equal(await sees(who), 0);
  await assert.rejects(sees("anon"), NO_TABLE);

  for (const who of [w.owner, w.admin, w.strat, w.editor, w.viewer, w.keeper, w.pending, "anon"]) {
    await assert.rejects(as(w.db, who, (tx) => tx.query(`insert into public.raw_clip_moves (raw_clip_id, space_id, card_id) values ($1, $2, $3)`, [clip, w.noun, w.cardB])), NO_TABLE, `insert as ${who}`);
    await assert.rejects(as(w.db, who, (tx) => tx.query(`update public.raw_clip_moves set undone_at = now() where id = $1`, [move])), NO_TABLE, `update as ${who}`);
    await assert.rejects(as(w.db, who, (tx) => tx.query(`delete from public.raw_clip_moves where id = $1`, [move])), NO_TABLE, `delete as ${who}`);
  }
  /* never a hard delete, for anyone: our server has no right to, and the database owner is stopped by the table */
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`delete from public.raw_clip_moves where id = $1`, [move])), NO_TABLE);
  await assert.rejects(w.db.query(`delete from public.raw_clip_moves where id = $1`, [move]), /never hard deletes/);
  await assert.rejects(w.db.exec(`truncate public.raw_clip_moves`), /never hard deletes/);
  await assert.rejects(w.db.exec(`truncate public.raw_clip_moves cascade`), /never hard deletes/);
  /* what a move was never changes */
  await assert.rejects(w.db.query(`update public.raw_clip_moves set card_id = $2 where id = $1`, [move, w.cardB]), /fixed once saved/);
  /* row level security on, in the audit trail (who did it), live for open screens, updated_at kept */
  assert.equal(await one(w.db, `select relrowsecurity from pg_class where oid = 'public.raw_clip_moves'::regclass`), true);
  const audit = (await w.db.query(`select action, actor_type, actor_id, card_id from public.audit_log where entity_table = 'raw_clip_moves' and entity_id = $1`, [move])).rows;
  assert.deepEqual(audit, [{ action: "insert", actor_type: "person", actor_id: w.strat, card_id: w.cardA }]);
  assert.equal(await count(w, `pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'raw_clip_moves'`), 1);
  const triggers = (await w.db.query(`select tgname from pg_trigger where tgrelid = 'public.raw_clip_moves'::regclass and not tgisinternal order by 1`)).rows.map((r) => r.tgname);
  assert.deepEqual(triggers, ["c_guard_fixed", "no_hard_delete", "no_truncate", "z_set_updated_at", "zz_audit"]);
  /* and the tables around it still never delete */
  for (const t of ["raw_clips", "upload_batches", "drive_folders", "clip_match_suggestions", "card_raw_clips"]) {
    for (const who of [w.owner, "service"]) await assert.rejects(as(w.db, who, (tx) => tx.query(`delete from public.${t}`)), NO_TABLE, t);
    assert.equal(await count(w, `pg_trigger where tgrelid = 'public.${t}'::regclass and tgname in ('no_hard_delete', 'no_truncate')`), 2, t);
  }
  await assert.rejects(w.db.exec(`delete from public.raw_clips`), /never hard deletes/);
  await assert.rejects(w.db.exec(`delete from public.card_raw_clips`), /never hard deletes/);
});

/* ---------- Read this folder with Gemini, and Retry ---------- */

test("request_folder_read: only people who manage folders, in a space they open; the files become one drop; known files are skipped", async () => {
  const w = await world();
  const known = await addClip(w, { file: "old-2" });
  const files = [
    { drive_file_id: "old-1", file_name: "interview.mov", mime_type: "video/quicktime", size_bytes: 812000000, duration_ms: 95000, drive_folder_id: "legacy-sub", md5_checksum: "abc" },
    { drive_file_id: "old-2", file_name: "already known.mp4", mime_type: "video/mp4" },
    { drive_file_id: "old-3", file_name: "voice memo.m4a", mime_type: "audio/mp4" },
    { drive_file_id: "old-4", file_name: "cover.jpg", mime_type: "image/jpeg" },
    { drive_file_id: " ", file_name: "no id.mov" },
  ];
  const ask = (who, list = files, space = w.noun, folder = "legacy-1") => oneAs(w.db, who, `select public.request_folder_read($1, $2, $3::jsonb)`, [space, folder, JSON.stringify(list)]);
  for (const who of [w.editor, w.viewer]) await assert.rejects(ask(who), /manage folders/);
  await assert.rejects(ask(w.outsider), /No such space/);
  await assert.rejects(ask(w.keeper, files, w.founder), /No such space/);
  await assert.rejects(ask(w.strat, files, w.noun, " "), /Which folder/);
  await assert.rejects(ask(w.strat, { not: "a list" }), /must be a list/);
  await assert.rejects(ask(w.strat, Array.from({ length: 2001 }, (_, i) => ({ drive_file_id: `x${i}`, file_name: "x.mov" }))), /2000/);
  assert.equal(await count(w, `public.upload_batches`), 0);

  const res = await ask(w.keeper);
  assert.deepEqual([res.queued, res.photos, res.skipped], [2, 1, 2]);
  const drop = (await w.db.query(`select space_id, day, origin, drive_folder_id, uploaded_by, upload_source from public.upload_batches where id = $1`, [res.batch_id])).rows[0];
  assert.deepEqual(drop, { space_id: w.noun, day: null, origin: "folder_read", drive_folder_id: "legacy-1", uploaded_by: w.keeper, upload_source: "import" });
  const rows = (await w.db.query(`select drive_file_id, kind, index_status, drive_folder_id, home_drive_folder_id, uploaded_by, shot_on, size_bytes::text as size, duration_ms from public.raw_clips where upload_batch_id = $1 order by drive_file_id`, [res.batch_id])).rows;
  assert.deepEqual(rows, [
    { drive_file_id: "old-1", kind: "video", index_status: "queued", drive_folder_id: "legacy-sub", home_drive_folder_id: "legacy-sub", uploaded_by: w.keeper, shot_on: null, size: "812000000", duration_ms: 95000 },
    { drive_file_id: "old-3", kind: "video", index_status: "queued", drive_folder_id: "legacy-1", home_drive_folder_id: "legacy-1", uploaded_by: w.keeper, shot_on: null, size: null, duration_ms: null },
    { drive_file_id: "old-4", kind: "photo", index_status: "done", drive_folder_id: "legacy-1", home_drive_folder_id: "legacy-1", uploaded_by: w.keeper, shot_on: null, size: null, duration_ms: null },
  ]);
  assert.equal((await clipRow(w, known)).upload_batch_id, null, "the known file is left as it is");
  /* pressed again: nothing is queued twice, and no empty drop is made */
  const again = await ask(w.strat);
  assert.deepEqual(again, { batch_id: null, queued: 0, photos: 0, skipped: 5 });
  assert.equal(await count(w, `public.upload_batches`), 1);
  /* the reader takes them like any other file */
  assert.equal((await claim(w, 20)).length, 3);
});

test("retry_clip: a failed file goes back in the queue with its tries at zero; for people who upload or plan, in their spaces; never another way", async () => {
  const w = await world();
  const clip = await addClip(w);
  const retry = (who, id = clip) => oneAs(w.db, who, `select public.retry_clip($1)`, [id]);
  assert.equal(await retry(w.strat), false, "not failed: nothing to do");
  await w.db.query(`update public.raw_clips set index_status = 'failed', index_attempts = 6, index_error = 'x', index_hold = 'cap' where id = $1`, [clip]);
  for (const who of [w.viewer, w.keeper]) await assert.rejects(retry(who), /upload or plan/);
  await assert.rejects(retry(w.outsider), /No such file/);
  await assert.rejects(retry(w.pending), /Sign in/);
  /* by hand it stays closed, for the same person the function lets through */
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.raw_clips set index_status = 'queued' where id = $1`, [clip])), SYSTEM_ONLY);
  assert.equal(await retry(w.editor), true);
  const row = await clipRow(w, clip);
  assert.deepEqual([row.index_status, row.index_attempts, row.index_error, row.index_hold, row.next_try_at, row.claimed_at], ["queued", 0, null, null, null, null]);
  assert.equal(await retry(w.editor), false);
  /* the mark the function uses does not outlive it: the next change by hand is refused as ever */
  await w.db.query(`update public.raw_clips set index_status = 'failed' where id = $1`, [clip]);
  await assert.rejects(
    as(w.db, w.strat, async (tx) => {
      await tx.query(`select public.retry_clip($1)`, [clip]);
      await tx.query(`update public.raw_clips set index_attempts = 3 where id = $1`, [clip]);
    }),
    SYSTEM_ONLY,
  );
  assert.equal((await clipRow(w, clip)).index_status, "failed", "the whole try was taken back");
  assert.deepEqual((await claim(w)).length, 0);
  assert.equal(await retry(w.admin), true);
  assert.deepEqual((await claim(w)).map((r) => [r.id, r.index_attempts]), [[clip, 1]]);
});

/* ---------- the fixes after the reviews of Nov 16 2026 ---------- */

test("on the rows of before: nothing uploaded before the migration is read (owner, Nov 16 2026), matched or not; only new uploads go to the reader", async () => {
  const db = await before();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const ids = await as(db, owner, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const week = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const card = await q(`insert into public.cards (week_id, title) values ($1, 'A card') returning id`, [week]);
    const batch = await q(`insert into public.upload_batches (space_id, day, uploaded_by) values ($1, '2026-11-17', $2) returning id`, [noun, owner]);
    const clip = (file) => q(`insert into public.raw_clips (space_id, upload_batch_id, drive_file_id, drive_folder_id, file_name, mime_type, shot_on, uploaded_by) values ($1, $2, $3, 'day-raw-1', $3, 'video/quicktime', '2026-11-17', $4) returning id`, [noun, batch, file, owner]);
    const linked = await clip("linked.mov");
    const unlinked = await clip("unlinked.mov");
    const unlinkedLater = await clip("unlinked-later.mov");
    await tx.query(`insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2), ($1, $3)`, [card, linked, unlinkedLater]);
    await tx.query(`update public.card_raw_clips set deleted_at = now() where raw_clip_id = $1`, [unlinkedLater]);
    return { linked, unlinked, unlinkedLater };
  });
  await run(db);
  const w = { db };
  assert.equal((await clipRow(w, ids.linked)).index_status, "done");
  assert.equal((await clipRow(w, ids.unlinked)).index_status, "done", "an unmatched file of before is not read either");
  assert.equal((await clipRow(w, ids.unlinkedLater)).index_status, "done");
  assert.deepEqual(await claim(w, 10), [], "the reader finds nothing of before");
});

test("claim_clip_jobs closes a reader's run left open for over an hour, counted at its estimate; a held file waits for room for itself", async () => {
  const w = await world();
  const old = await reserve(w, 0.5);
  const fresh = await reserve(w, 0.25);
  await w.db.query(`update public.agent_runs set started_at = now() - interval '61 minutes' where id = $1`, [old.run]);
  await claim(w);
  const runOf = async (id) => (await w.db.query(`select status, total_cost_usd::float8 as cost, error, finished_at is not null as closed from public.agent_runs where id = $1`, [id])).rows[0];
  const o = await runOf(old.run);
  assert.deepEqual([o.status, o.cost, o.closed], ["failed", 0.5, true]);
  assert.match(o.error, /stopped before it saved/);
  assert.equal((await runOf(fresh.run)).status, "running", "a run still inside its hour is left alone");
  assert.equal(Number((await rowsAs(w.db, "service", `select spent_usd from public.ai_spend_today()`))[0].spent_usd), 0.75, "the closed run still counts what it held");

  /* a held file of ten minutes needs about 7 cents of room; with 5 cents left it waits, with more it is taken */
  const held = await addClip(w);
  await w.db.query(`update public.raw_clips set duration_ms = 600000 where id = $1`, [held]);
  assert.deepEqual((await claim(w)).map((r) => r.id), [held]);
  await finish(w, held, { outcome: "held" });
  await w.db.exec(`update public.app_settings set value = '0.80' where key = 'ai.daily_cap_usd'`);
  assert.deepEqual(await claim(w), [], "5 cents of room is not enough for it");
  const row = await clipRow(w, held);
  assert.deepEqual([row.index_status, row.index_hold, row.index_attempts], ["queued", "cap", 0], "not taken and put back: untouched");
  await w.db.exec(`update public.app_settings set value = '0.90' where key = 'ai.daily_cap_usd'`);
  assert.deepEqual((await claim(w)).map((r) => r.id), [held]);
});

test("requeue_folder_clips: a folder back from the trash puts its failed files back in the queue; files.manage only, in spaces the person opens", async () => {
  const w = await world();
  const inside = await addClip(w, { folder: "team-folder" });
  const below = await addClip(w, { folder: "team-sub" });
  const elsewhere = await addClip(w, { folder: "other" });
  const founderFile = await addClip(w, { folder: "team-folder", space: w.founder });
  await claim(w, 20);
  for (const c of [inside, below, elsewhere, founderFile]) await finish(w, c, { outcome: "gone" });
  const requeue = (who) => oneAs(w.db, who, `select public.requeue_folder_clips($1::text[])`, [["team-folder", "team-sub"]]);
  for (const who of [w.editor, w.viewer]) await assert.rejects(requeue(who), /manage folders/);
  assert.equal(await requeue(w.keeper), 2, "the keeper opens Noun Naturals only");
  for (const c of [inside, below]) {
    const r = await clipRow(w, c);
    assert.deepEqual([r.index_status, r.index_attempts, r.index_error], ["queued", 0, null]);
  }
  assert.equal((await clipRow(w, elsewhere)).index_status, "failed");
  assert.equal((await clipRow(w, founderFile)).index_status, "failed");
  assert.equal(await requeue(w.strat), 1, "then the founder file, for who opens that space");
  assert.equal(await requeue(w.strat), 0, "twice is once");
});
