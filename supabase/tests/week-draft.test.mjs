// Behavior tests for Draft on an existing week (src/lib/content/calendar-actions.ts setWeekDraft), on the live
// migrations: no new rule, only proof that the weeks update rule lets "Plan weeks and cards" (calendar.plan) turn
// is_draft off and on, in a space the person opens, and nobody else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one } from "./helpers.mjs";

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("strat@nounnaturals.com", "strategist");
  await inv("cleaner@agency.test", "strategist");
  await inv("viewer@nounnaturals.com", "viewer");
  await inv("local@agency.test", "strategist");
  const planner = await signUp(db, "strat@nounnaturals.com", "Daryna");
  const cleaner = await signUp(db, "cleaner@agency.test", "Olena");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const local = await signUp(db, "local@agency.test", "Iryna");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, owner, async (tx) => {
    const role = async (name, keys, who) => {
      const id = (await tx.query(`insert into public.roles (name) values ($1) returning id`, [name])).rows[0].id;
      for (const k of keys) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, k]);
      await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, who]);
    };
    /* a custom role with Delete weeks but no planning: it may not take a week off draft */
    await role("Cleaner", ["calendar.delete_weeks", "calendar.all_cards", "page.calendar"], cleaner);
    /* a custom planner without "every space": Noun Naturals only */
    await role("Noun planner", ["calendar.plan", "calendar.all_cards", "page.calendar"], local);
    for (const p of [planner, cleaner, local]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  return { db, owner, planner, cleaner, viewer, local, noun, founder };
}

const addWeek = (db, who, space, start, n, draft = true) =>
  oneAs(db, who, `insert into public.weeks (space_id, slug, name, number, starts_on, sort_order, is_draft) values ($1, $2, $3, $4, $5, $4, $6) returning id`, [space, `week-${n}`, `Week ${n}`, n, start, draft]);
/* what setWeekDraft sends: one column, live weeks only */
const setDraft = (db, who, week, draft) => rowsAs(db, who, `update public.weeks set is_draft = $2 where id = $1 and deleted_at is null returning id, is_draft`, [week, draft]);
const isDraft = (db, week) => one(db, `select is_draft from public.weeks where id = $1`, [week]);

test("a planner takes a week off draft and puts it back, and nothing else on the week changes", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  const before = (await w.db.query(`select slug, name, number, starts_on, deleted_at from public.weeks where id = $1`, [week])).rows[0];
  assert.deepEqual(await setDraft(w.db, w.planner, week, false), [{ id: week, is_draft: false }]);
  assert.equal(await isDraft(w.db, week), false);
  assert.deepEqual(await setDraft(w.db, w.planner, week, true), [{ id: week, is_draft: true }]);
  assert.equal(await isDraft(w.db, week), true);
  assert.deepEqual((await w.db.query(`select slug, name, number, starts_on, deleted_at from public.weeks where id = $1`, [week])).rows[0], before);
  /* the owner may too */
  assert.equal((await setDraft(w.db, w.owner, week, false)).length, 1);
  assert.equal(await isDraft(w.db, week), false);
});

test("nobody else changes Draft: a viewer, a space the planner does not open, a role that only deletes weeks", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  const founderWeek = await addWeek(w.db, w.owner, w.founder, "2026-11-16", 1);
  /* a viewer may not update weeks at all: no row changes */
  assert.deepEqual(await setDraft(w.db, w.viewer, week, false), []);
  assert.equal(await isDraft(w.db, week), true);
  /* a planner who does not open the founder space: no row is touched there, their own space works */
  assert.deepEqual(await setDraft(w.db, w.local, founderWeek, false), []);
  assert.equal(await isDraft(w.db, founderWeek), true);
  assert.equal((await setDraft(w.db, w.local, week, false)).length, 1);
  assert.equal((await setDraft(w.db, w.local, week, true)).length, 1);
  /* Delete weeks without planning: refused by the database's rule */
  await assert.rejects(setDraft(w.db, w.cleaner, week, false), /only move weeks to the Trash/);
  assert.equal(await isDraft(w.db, week), true);
});

test("a week in the Trash is not changed by the action's update (it asks for live weeks only)", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  await as(w.db, w.owner, (tx) => tx.query(`update public.weeks set deleted_at = now() where id = $1`, [week]));
  assert.deepEqual(await setDraft(w.db, w.planner, week, false), []);
  assert.equal(await isDraft(w.db, week), true);
});
