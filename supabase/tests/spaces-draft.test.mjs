/* Behavior tests for two migrations about spaces (drafts approved by the owner Nov 16 2026):
   - supabase/migrations/20261118300000_spaces.sql: live twins get a number first, then a space's description and one
     live space per name;
   - supabase/migrations/20261119100000_space_create.sql: who may add a space (spaces.create), and the person who adds
     it opens it (the creator's person_spaces row, written by the database).
   Every migration is loaded exactly as helpers.mjs does. A world from before one of them is built with
   freshDb({ before }), and the rest then run with applyMigrationsFrom, as the live project runs them. Nothing here
   touches the live Supabase project. Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, applyMigrationsFrom, signUp, as, rowsAs, oneAs, one, oneSpaceStrategist, SEEDED_SPACES } from "./helpers.mjs";

/* The two migrations, by their timestamps. */
const SPACES = "20261118300000";
/* The migration after them that gives Strategist/Editor its wider list (spaces.create and spaces.all among it). */
const STRATEGIST_ACCESS = "20261119200000";

const CHECK = /check constraint|spaces_description_check/;
const UNIQUE = /duplicate key|spaces_live_name_key/;
const RLS = /row-level security/;

/** `before`: build the world an older migration left (freshDb's own option). */
async function world({ before = null } = {}) {
  const db = await freshDb({ before });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  await as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ('steven@nounnaturals.com', 'admin'), ('olena@agency.test', 'strategist'), ('vika@nounnaturals.com', 'viewer'), ('maker@nounnaturals.com', 'strategist')`));
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strategist = await signUp(db, "olena@agency.test", "Olena");
  const viewer = await signUp(db, "vika@nounnaturals.com", "Vika");
  const maker = await signUp(db, "maker@nounnaturals.com", "Maker");
  return { db, owner, admin, strategist, viewer, maker };
}

/* the owner builds a custom role with these keys and gives it to these people */
const customRole = (db, owner, name, keys, ...people) =>
  as(db, owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name, color) values ($1, 'st-bank') returning id`, [name])).rows[0].id;
    for (const key of keys) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, key]);
    for (const p of people) await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, p]);
    return id;
  });

/* the actions' own statements, with the description */
const add = (w, who, slug, name, description = null) =>
  as(w.db, who, async (tx) => (await tx.query(`insert into public.spaces (slug, name, short_name, sort_order, description) values ($1, $2, $2, 9, $3) returning id`, [slug, name, description])).rows[0].id);

/* createSpace (src/lib/content/space-actions.ts): the id is made in code, the insert reads nothing back, then a
   second request reads the new space by its id */
const create = (db, who, slug, name, extra = {}) =>
  as(db, who, async (tx) => {
    const id = randomUUID();
    const cols = { id, slug, name, short_name: name, sort_order: 9, ...extra };
    const keys = Object.keys(cols);
    await tx.query(`insert into public.spaces (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(cols));
    return id;
  });
const readBack = (db, who, id) => rowsAs(db, who, `select id, slug from public.spaces where id = $1`, [id]);
const tiles = (db, who) => rowsAs(db, who, `select slug from public.spaces where deleted_at is null order by sort_order, name`).then((r) => r.map((s) => s.slug));
const rowsOf = (db, space) => db.query(`select profile_id::text, granted_by::text from public.person_spaces where space_id = $1 and deleted_at is null`, [space]).then((r) => r.rows);
const addWeek = (db, who, space) =>
  oneAs(db, who, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-16') returning id`, [space]);

/* ---------- 20261118300000_spaces.sql ---------- */

test("twins made before the migration both survive: the oldest keeps the name, newer ones get the next free number", async () => {
  const w = await world({ before: SPACES });
  /* the live schema checks names only in the app, so twins can exist */
  const live = (slug, name) => as(w.db, w.owner, async (tx) => (await tx.query(`insert into public.spaces (slug, name, short_name, sort_order) values ($1, $2, $2, 9) returning id`, [slug, name])).rows[0].id);
  const a = await live("halloween", "Halloween");
  const b = await live("halloween-2", " halloween ");
  const taken = await live("halloween-3", "Halloween (2)");
  const c = await live("halloween-4", "HALLOWEEN");
  const old = await live("halloween-5", "Halloween");
  await rowsAs(w.db, w.owner, `update public.spaces set deleted_at = now() where id = $1`, [old]);

  const ran = await applyMigrationsFrom(w.db, SPACES);
  assert.equal(ran[0], "20261118300000_spaces.sql");

  const named = async (id) => (await w.db.query(`select name, short_name, slug from public.spaces where id = $1`, [id])).rows[0];
  assert.deepEqual(await named(a), { name: "Halloween", short_name: "Halloween", slug: "halloween" }, "the oldest keeps its name");
  assert.deepEqual(await named(b), { name: "halloween (3)", short_name: "halloween (3)", slug: "halloween-2" }, "(2) is taken, so (3); the address stays");
  assert.equal((await named(taken)).name, "Halloween (2)", "a space that only looks like a twin keeps its name");
  assert.equal((await named(c)).name, "HALLOWEEN (4)");
  assert.equal((await named(old)).name, "Halloween", "an archived space keeps its name");
  const liveNames = (await w.db.query(`select lower(btrim(name)) as n from public.spaces where deleted_at is null`)).rows.map((r) => r.n);
  assert.equal(new Set(liveNames).size, liveNames.length, "no live twins are left, so the lock went on");
  assert.equal(await one(w.db, `select count(*)::int from public.spaces where deleted_at is null`), 4 + SEEDED_SPACES.length, "nothing was archived or lost");
  await assert.rejects(add(w, w.owner, "halloween-6", "halloween"), UNIQUE);
});

test("on today's data the migration renames nothing", async () => {
  const w = await world();
  assert.deepEqual(await tiles(w.db, w.owner), [...SEEDED_SPACES]);
  assert.equal(await one(w.db, `select count(*)::int from public.spaces where name like '%(%'`), 0);
});

test("the first two spaces start without a description", async () => {
  const w = await world();
  assert.equal(await one(w.db, `select count(*)::int from public.spaces where description is not null`), 0);
});

test("a description is saved, changed and cleared by the owner and admins; at most 280 letters, never blank", async () => {
  const w = await world();
  const id = await add(w, w.admin, "launches", "Launches", "Big drops and gift sets");
  assert.equal(await one(w.db, `select description from public.spaces where id = $1`, [id]), "Big drops and gift sets");
  assert.equal((await rowsAs(w.db, w.owner, `update public.spaces set description = $2 where id = $1 and deleted_at is null returning id`, [id, "x".repeat(280)])).length, 1);
  await assert.rejects(rowsAs(w.db, w.owner, `update public.spaces set description = $2 where id = $1 returning id`, [id, "x".repeat(281)]), CHECK);
  await assert.rejects(rowsAs(w.db, w.owner, `update public.spaces set description = '   ' where id = $1 returning id`, [id]), CHECK, "the app saves an empty description as null");
  assert.equal((await rowsAs(w.db, w.admin, `update public.spaces set description = null where id = $1 returning id`, [id])).length, 1);
  assert.equal((await rowsAs(w.db, w.strategist, `update public.spaces set description = 'mine' where id = $1 returning id`, [id])).length, 0, "a Strategist/Editor changes nothing");
});

test("two live spaces never share a name; an archived one keeps its name and may not come back over a twin", async () => {
  const w = await world();
  await assert.rejects(add(w, w.owner, "founder-2", " FOUNDER content "), UNIQUE);
  const old = await add(w, w.owner, "halloween", "Halloween");
  await rowsAs(w.db, w.owner, `update public.spaces set deleted_at = now() where id = $1`, [old]);
  const fresh = await add(w, w.owner, "halloween-2", "halloween");
  assert.ok(fresh, "an archived space's name is free");
  await assert.rejects(rowsAs(w.db, w.owner, `update public.spaces set deleted_at = null where id = $1 returning id`, [old]), UNIQUE);
  await rowsAs(w.db, w.owner, `update public.spaces set name = 'Halloween 2027', short_name = 'Halloween 2027' where id = $1`, [fresh]);
  assert.equal((await rowsAs(w.db, w.owner, `update public.spaces set deleted_at = null where id = $1 returning id`, [old])).length, 1, "back once the twin is renamed");
});

/* ---------- 20261119100000_space_create.sql ---------- */

test("the new permission Add spaces, its words, and who holds it", async () => {
  const w = await world();
  const row = (await w.db.query(`select group_key, group_label, label, hint, sort_order from public.permissions where key = 'spaces.create'`)).rows[0];
  assert.deepEqual(row, { group_key: "team", group_label: "Team", label: "Add spaces", hint: "Add a space. The person who adds it can open it.", sort_order: 205 });
  assert.equal(await one(w.db, `select label from public.permissions where key = 'spaces.manage'`), "Rename and archive spaces");
  const holders = (await w.db.query(`select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id where rp.permission_key = 'spaces.create' and rp.deleted_at is null order by r.sort_order`)).rows.map((r) => r.key);
  assert.deepEqual(holders, ["owner", "admin", "strategist"], "Owner and Admin from this migration, Strategist/Editor from the access migration after it");
  /* the migration itself gives it only to the roles that held spaces.manage: the Owner and Admin */
  const old = await freshDb({ before: STRATEGIST_ACCESS });
  const first = (await old.query(`select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id where rp.permission_key = 'spaces.create' and rp.deleted_at is null order by r.sort_order`)).rows.map((r) => r.key);
  assert.deepEqual(first, ["owner", "admin"], "before the access migration only the Owner and Admin roles hold it");
});

test("a role that adds spaces without opening every space: it adds, opens it, has one row given by itself, and plans a week", async () => {
  const w = await world();
  await customRole(w.db, w.owner, "Space maker", ["spaces.create", "calendar.plan", "page.calendar"], w.maker);
  const id = await create(w.db, w.maker, "launches", "Launches");
  assert.deepEqual(await readBack(w.db, w.maker, id), [{ id, slug: "launches" }], "the read back finds it");
  assert.deepEqual(await tiles(w.db, w.maker), ["launches"], "only the space they added, not the others");
  assert.deepEqual(await rowsOf(w.db, id), [{ profile_id: w.maker, granted_by: w.maker }]);
  assert.equal(await one(w.db, `select created_by::text from public.spaces where id = $1`, [id]), w.maker);
  assert.ok(await addWeek(w.db, w.maker, id), "a new week in it");
  assert.deepEqual(await tiles(w.db, w.viewer), [], "nobody else was given it");
  /* still never their own access by hand, and never anyone else's */
  await assert.rejects(rowsAs(w.db, w.maker, `insert into public.person_spaces (profile_id, space_id) values ($1, $2) returning id`, [w.strategist, id]), RLS);
  assert.equal((await rowsAs(w.db, w.maker, `update public.spaces set name = 'Mine' where id = $1 returning id`, [id])).length, 0, "adding is not renaming");
  assert.ok((await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'person_spaces'`)) >= 1, "the audit trail keeps the row");
});

test("an owner's or admin's new space adds no row: their role opens every space", async () => {
  const w = await world();
  /* a Strategist/Editor in a role without spaces.all (its keys but that one) */
  await oneSpaceStrategist(w.db, w.owner, "Planner", [], w.maker);
  const a = await create(w.db, w.owner, "launches", "Launches");
  const b = await create(w.db, w.admin, "gift-sets", "Gift sets");
  assert.deepEqual(await rowsOf(w.db, a), []);
  assert.deepEqual(await rowsOf(w.db, b), []);
  assert.equal((await readBack(w.db, w.admin, a)).length, 1);
  assert.deepEqual(await tiles(w.db, w.maker), [], "a Strategist/Editor without spaces.all is not given it");
  /* the prebuilt Strategist/Editor opens every space (spaces.all), so its own new space adds no row either */
  const c = await create(w.db, w.strategist, "shoot-days", "Shoot days");
  assert.deepEqual(await rowsOf(w.db, c), []);
  assert.deepEqual(await tiles(w.db, w.strategist), [...SEEDED_SPACES, "gift-sets", "launches", "shoot-days"]);
});

test("a viewer may not add a space; created_by is always the person adding it", async () => {
  const w = await world();
  await assert.rejects(create(w.db, w.viewer, "nope", "Nope"), RLS);
  await customRole(w.db, w.owner, "Space maker", ["spaces.create", "page.calendar"], w.maker);
  await assert.rejects(create(w.db, w.maker, "nope", "Nope", { created_by: w.owner }), RLS, "never in someone else's name");
  await assert.rejects(create(w.db, w.maker, "nope", "Nope", { created_by: null }), RLS);
  assert.equal(await one(w.db, `select count(*)::int from public.spaces where slug = 'nope'`), 0);
});

test("a custom role that held spaces.manage before the migration keeps adding, and opens what it adds", async () => {
  const db = await freshDb({ before: SPACES });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  await as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ('keeper@nounnaturals.com', 'strategist')`));
  const keeper = await signUp(db, "keeper@nounnaturals.com", "Keeper");
  const role = await customRole(db, owner, "Space keeper", ["spaces.manage", "page.calendar"], keeper);
  await applyMigrationsFrom(db, SPACES);
  assert.equal(await one(db, `select count(*)::int from public.role_permissions where role_id = $1 and permission_key = 'spaces.create' and deleted_at is null`, [role]), 1);
  const id = await create(db, keeper, "keeper", "Keeper");
  assert.deepEqual(await tiles(db, keeper), ["keeper"]);
  assert.equal((await rowsAs(db, keeper, `update public.spaces set name = 'Keeper 2' where id = $1 returning id`, [id])).length, 1, "and still renames");
});

test("nobody calls the trigger function directly; with nobody signed in (a migration, our own server) no row is added", async () => {
  const w = await world();
  await customRole(w.db, w.owner, "Space maker", ["spaces.create"], w.maker);
  await assert.rejects(rowsAs(w.db, w.maker, `select private.spaces_after_insert()`), /permission denied|trigger/);
  const id = randomUUID();
  await w.db.query(`insert into public.spaces (id, slug, name, short_name) values ($1, 'server', 'Server', 'Server')`, [id]);
  assert.deepEqual(await rowsOf(w.db, id), []);
});
