// Behavior tests for supabase/migrations/20261116100000_week_trash.sql (delete a week, and the Trash in Settings).
// Each test does what src/lib/content/trash-actions.ts does, with the same person's session: delete a week (deleted_at),
// restore it (deleted_at cleared), delete it forever (purged_at).
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one, META_POSTING, FILES_READER } from "./helpers.mjs";

const KEY = "calendar.delete_weeks";
const NOT_ALLOWED = /Only people who may delete weeks/;

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("steven@nounnaturals.com", "admin");
  await inv("strat@nounnaturals.com", "strategist");
  await inv("cleaner@agency.test", "strategist");
  await inv("viewer@nounnaturals.com", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const planner = await signUp(db, "strat@nounnaturals.com", "Daryna");
  const cleaner = await signUp(db, "cleaner@agency.test", "Olena");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  /* a custom role built by an admin: Delete weeks and Calendar, nothing else (no planning), Noun Naturals only */
  const cleanerRole = await as(db, admin, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name) values ('Cleaner') returning id`)).rows[0].id;
    for (const k of [KEY, "calendar.all_cards", "page.calendar"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, k]);
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, cleaner]);
    return id;
  });
  await as(db, owner, async (tx) => {
    for (const p of [planner, cleaner]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  return { db, owner, admin, planner, cleaner, viewer, noun, founder, cleanerRole };
}

const addWeek = (db, who, space, start, n, slug = `week-${n}`) =>
  oneAs(db, who, `insert into public.weeks (space_id, slug, name, number, starts_on, sort_order) values ($1, $2, $3, $4, $5, $4) returning id`, [space, slug, `Week ${n}`, n, start]);
const addCard = (db, who, week, title) =>
  oneAs(db, who, `insert into public.cards (week_id, space_id, title, source) values ($1, (select space_id from public.weeks where id = $1), $2, 'app') returning id`, [week, title]);
const trash = (db, who, week) => rowsAs(db, who, `update public.weeks set deleted_at = now() where id = $1 and deleted_at is null returning id`, [week]);
const restore = (db, who, week) => rowsAs(db, who, `update public.weeks set deleted_at = null where id = $1 and deleted_at is not null and purged_at is null returning id, slug`, [week]);
const purge = (db, who, week) => rowsAs(db, who, `update public.weeks set purged_at = now() where id = $1 and purged_at is null returning id`, [week]);
const weekRow = async (db, week) => (await db.query(`select slug, deleted_at, deleted_by, purged_at, purged_by from public.weeks where id = $1`, [week])).rows[0];
const cardRow = async (db, card) => (await db.query(`select deleted_at, deleted_with_week_id from public.cards where id = $1`, [card])).rows[0];

test("seed: Delete weeks is a Calendar permission after Set up statuses, held by Owner and Admin only", async () => {
  const w = await world();
  const p = (await w.db.query(`select group_key, group_label, label, sort_order from public.permissions where key = $1`, [KEY])).rows[0];
  assert.deepEqual(p, { group_key: "calendar", group_label: "Calendar", label: "Delete weeks", sort_order: 35 });
  /* 47 once this migration ran; the ugc, review undo and space create migrations then add one key each */
  const old = await freshDb({ before: "20261117000000" });
  assert.equal(await one(old, `select count(*)::int from public.permissions`), 47);
  /* and the Meta posting and Upload/Files migrations one more each (posting.resolve, files.manage), from the day each is live */
  assert.equal(await one(w.db, `select count(*)::int from public.permissions`), 50 + (META_POSTING.live ? 1 : 0) + (FILES_READER.live ? 1 : 0));
  const holders = (await w.db.query(
    `select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id
      where rp.permission_key = $1 and rp.deleted_at is null and r.key is not null order by 1`,
    [KEY],
  )).rows.map((r) => r.key);
  assert.deepEqual(holders, ["admin", "owner"]);
  for (const [who, has] of [[w.owner, true], [w.admin, true], [w.planner, false], [w.viewer, false], [w.cleaner, true]]) {
    assert.equal(await oneAs(w.db, who, `select private.has_permission($1)`, [KEY]), has);
  }
});

test("deleting a week takes its live titles with it; a row removed earlier stays apart; who and when are the database's", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  const a = await addCard(w.db, w.planner, week, "Why our shampoo foams");
  const b = await addCard(w.db, w.planner, week, "Hard water test");
  const early = await addCard(w.db, w.planner, week, "Removed before");
  await as(w.db, w.planner, (tx) => tx.query(`update public.cards set deleted_at = now() where id = $1`, [early]));
  const earlyAt = (await cardRow(w.db, early)).deleted_at;

  /* a forged deleted_by is replaced by the person who did it */
  const done = await rowsAs(w.db, w.admin, `update public.weeks set deleted_at = '2020-01-01', deleted_by = $2 where id = $1 returning id`, [week, w.owner]);
  assert.equal(done.length, 1);
  const row = await weekRow(w.db, week);
  assert.equal(row.deleted_by, w.admin);
  assert.ok(Date.now() - new Date(row.deleted_at).getTime() < 60_000, "now, not the date sent");
  for (const c of [a, b]) {
    const r = await cardRow(w.db, c);
    assert.equal(r.deleted_with_week_id, week);
    assert.equal(r.deleted_at.getTime(), row.deleted_at.getTime());
  }
  assert.deepEqual(await cardRow(w.db, early), { deleted_at: earlyAt, deleted_with_week_id: null });
  /* the audit trail has the week and both titles as soft deletes, by the admin */
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where action = 'soft_delete' and actor_id = $1 and entity_table = 'weeks'`, [w.admin]), 1);
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where action = 'soft_delete' and actor_id = $1 and entity_table = 'cards'`, [w.admin]), 2);
  /* still in the database: nothing was deleted */
  assert.equal(await one(w.db, `select count(*)::int from public.cards where week_id = $1`, [week]), 3);
});

test("only Delete weeks moves a week to the Trash or back: a planner is refused, a viewer changes nothing", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  await addCard(w.db, w.planner, week, "A title");
  await assert.rejects(trash(w.db, w.planner, week), NOT_ALLOWED);
  /* a viewer cannot update weeks at all: no row changes */
  assert.deepEqual(await trash(w.db, w.viewer, week), []);
  assert.equal((await weekRow(w.db, week)).deleted_at, null);
  /* the planner still plans: renaming a live week works */
  await as(w.db, w.planner, (tx) => tx.query(`update public.weeks set name = 'Week one' where id = $1`, [week]));
  assert.equal(await one(w.db, `select name from public.weeks where id = $1`, [week]), "Week one");

  await trash(w.db, w.owner, week);
  await assert.rejects(restore(w.db, w.planner, week), NOT_ALLOWED);
  await assert.rejects(purge(w.db, w.planner, week), NOT_ALLOWED);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.weeks set deleted_by = $2 where id = $1`, [week, w.planner])), /kept by the database/);
  /* a new week never starts in the Trash */
  await assert.rejects(
    oneAs(w.db, w.owner, `insert into public.weeks (space_id, slug, name, starts_on, deleted_at) values ($1, 'week-9', 'Week 9', '2026-12-28', now()) returning id`, [w.noun]),
    /cannot start in the Trash/,
  );
});

test("restore brings back exactly the titles that went with the week; a row in the Trash never comes back alone", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  const a = await addCard(w.db, w.planner, week, "Went with the week");
  const early = await addCard(w.db, w.planner, week, "Removed before");
  await as(w.db, w.planner, (tx) => tx.query(`update public.cards set deleted_at = now() where id = $1`, [early]));
  await trash(w.db, w.owner, week);

  /* one row of a week in the Trash: not on its own, not even by the owner; the mark is never set by hand */
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.cards set deleted_at = null where id = $1`, [a])), /Restore the week/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.cards set deleted_with_week_id = null where id = $1`, [a])), /only with its week/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.cards set deleted_with_week_id = $2 where id = $1`, [early, week])), /only with its week/);
  /* no new row joins a week in the Trash */
  await assert.rejects(addCard(w.db, w.owner, week, "Late"), /in the Trash/);

  assert.equal((await restore(w.db, w.admin, week)).length, 1);
  assert.deepEqual(await cardRow(w.db, a), { deleted_at: null, deleted_with_week_id: null });
  assert.notEqual((await cardRow(w.db, early)).deleted_at, null, "the row removed one by one stays removed");
  const row = await weekRow(w.db, week);
  assert.equal(row.deleted_at, null);
  assert.equal(row.deleted_by, null);
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where action = 'restore' and entity_table = 'cards' and actor_id = $1`, [w.admin]), 1);
  /* and it can go to the Trash again */
  await trash(w.db, w.owner, week);
  assert.equal((await cardRow(w.db, a)).deleted_with_week_id, week);
});

test("restoring a week whose address was taken gives it a free one", async () => {
  const w = await world();
  const old = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  await trash(w.db, w.owner, old);
  const fresh = await addWeek(w.db, w.planner, w.noun, "2026-11-23", 1);
  const back = await restore(w.db, w.owner, old);
  assert.deepEqual(back.map((r) => r.slug), ["week-1-2"]);
  assert.equal(await one(w.db, `select slug from public.weeks where id = $1`, [fresh]), "week-1");
});

test("Delete forever: only from the Trash; the row stays, marked, and never comes back or changes", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  const a = await addCard(w.db, w.planner, week, "A title");
  await assert.rejects(purge(w.db, w.owner, week), /Only a week in the Trash/);
  await trash(w.db, w.owner, week);
  /* a forged purged_by is replaced by the person who did it */
  await as(w.db, w.admin, (tx) => tx.query(`update public.weeks set purged_at = '2020-01-01', purged_by = $2 where id = $1`, [week, w.owner]));
  const row = await weekRow(w.db, week);
  assert.equal(row.purged_by, w.admin);
  assert.ok(Date.now() - new Date(row.purged_at).getTime() < 60_000);
  assert.notEqual(row.deleted_at, null);
  assert.deepEqual(await restore(w.db, w.owner, week), [], "the app's restore skips a purged week");
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.weeks set deleted_at = null where id = $1`, [week])), /deleted from the Trash for good/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.weeks set purged_at = null where id = $1`, [week])), /deleted from the Trash for good/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.weeks set name = 'x' where id = $1`, [week])), /for good/);
  /* every row is still in the database, marked */
  assert.equal(await one(w.db, `select count(*)::int from public.weeks where id = $1`, [week]), 1);
  assert.equal((await cardRow(w.db, a)).deleted_with_week_id, week);
});

test("after 30 days in the Trash a week cannot be restored", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  await trash(w.db, w.owner, week);
  /* as the database owner (a migration): set the date 31 days back */
  await w.db.query(`update public.weeks set deleted_at = now() - interval '31 days' where id = $1`, [week]);
  await assert.rejects(restore(w.db, w.owner, week), /more than 30 days/);
  /* 29 days is fine */
  await w.db.query(`update public.weeks set deleted_at = now() - interval '29 days' where id = $1`, [week]);
  assert.equal((await restore(w.db, w.owner, week)).length, 1);
});

test("a custom role with Delete weeks but no planning: Trash and back in its spaces only, and nothing else", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  const card = await addCard(w.db, w.owner, week, "A title");
  const founderWeek = await addWeek(w.db, w.owner, w.founder, "2026-11-16", 1);
  assert.equal((await trash(w.db, w.cleaner, week)).length, 1);
  assert.equal((await cardRow(w.db, card)).deleted_with_week_id, week, "the titles go with it although the role cannot plan");
  assert.equal((await restore(w.db, w.cleaner, week)).length, 1);
  assert.equal((await cardRow(w.db, card)).deleted_at, null);
  /* it changes nothing else on a week */
  await assert.rejects(as(w.db, w.cleaner, (tx) => tx.query(`update public.weeks set name = 'x' where id = $1`, [week])), /only move weeks to the Trash/);
  await assert.rejects(as(w.db, w.cleaner, (tx) => tx.query(`update public.weeks set deleted_at = now(), name = 'x' where id = $1`, [week])), /only move weeks to the Trash/);
  /* a space it does not open: no row is touched */
  assert.deepEqual(await trash(w.db, w.cleaner, founderWeek), []);
  assert.equal((await weekRow(w.db, founderWeek)).deleted_at, null);
  /* without the tick, refused (the admin takes it away) */
  await as(w.db, w.admin, (tx) => tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = $2`, [w.cleanerRole, KEY]));
  assert.deepEqual(await trash(w.db, w.cleaner, week), []);
});
