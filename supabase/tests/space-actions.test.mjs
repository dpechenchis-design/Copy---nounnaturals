/* Behavior tests for Add a space and Space settings (src/lib/content/space-actions.ts) on the live schema: the exact
   inserts and updates the actions make, run as an owner, an admin, a Strategist/Editor and a viewer on a throwaway
   PGlite database. Who may add a space (spaces_insert asks has_permission('spaces.create') since the migration
   20261119100000_space_create; spaces.manage before it), who may rename, archive and restore one (spaces_update asks
   has_permission('spaces.manage')), who may give a person a space (person_spaces, can_manage_person, the same rows
   Settings' setPersonSpaces writes), and that a person given the space then sees it while another does not.
   Nothing here touches the live Supabase project. Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, signUp, as, rowsAs, oneAs, one, oneSpaceStrategist, SEEDED_SPACES } from "./helpers.mjs";

const RLS = /row-level security/;
const DENIED = /permission denied/;
const UNIQUE = /duplicate key|unique/;

/** `before`: build the world an older migration left (freshDb's own option). */
async function world({ before = null } = {}) {
  const db = await freshDb({ before });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("david@nounnaturals.com", "admin");
  await invite("olena@agency.test", "strategist");
  await invite("vika@nounnaturals.com", "viewer");
  await invite("maker@nounnaturals.com", "viewer");
  await invite("planner@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const admin2 = await signUp(db, "david@nounnaturals.com", "David");
  const strategist = await signUp(db, "olena@agency.test", "Olena");
  const viewer = await signUp(db, "vika@nounnaturals.com", "Vika");
  const maker = await signUp(db, "maker@nounnaturals.com", "Maker"); // a viewer given no space
  /* Strategist/Editor opens every space (spaces.all, owner Nov 16 2026). The planner holds its keys but spaces.all, so
     it opens only the spaces it is given: the person the tile checks below are about. */
  const planner = await signUp(db, "planner@agency.test", "Daryna");
  await oneSpaceStrategist(db, owner, "Planner", [], planner);
  return { db, owner, admin, admin2, strategist, viewer, maker, planner };
}

/* the actions' own statements. createSpace makes the id in code and inserts without reading anything back (an
   insert ... returning needs sight of the new row), then reads the new space by its id in a second request. */
const NEW = `insert into public.spaces (id, slug, name, short_name, sort_order) values ($1, $2, $3, $4, $5)`;
const addSpace = (w, who, slug, name, sort = 3) =>
  as(w.db, who, async (tx) => {
    const id = randomUUID();
    await tx.query(NEW, [id, slug, name, name, sort]);
    return { id, slug };
  });
const readBack = (w, who, id) => rowsAs(w.db, who, `select id, slug from public.spaces where id = $1`, [id]);
const rename = (w, who, id, name) =>
  rowsAs(w.db, who, `update public.spaces set name = $2, short_name = $2 where id = $1 and deleted_at is null returning id`, [id, name]);
const archive = (w, who, id) => rowsAs(w.db, who, `update public.spaces set deleted_at = now() where id = $1 and deleted_at is null returning id`, [id]);
const restore = (w, who, id) => rowsAs(w.db, who, `update public.spaces set deleted_at = null where id = $1 and deleted_at is not null returning id`, [id]);
/* Settings' syncRows: add the missing rows, set deleted_at on the rest */
const give = (w, who, person, space) => rowsAs(w.db, who, `insert into public.person_spaces (profile_id, space_id) values ($1, $2) returning id`, [person, space]);
const take = (w, who, person, space) =>
  rowsAs(w.db, who, `update public.person_spaces set deleted_at = now() where profile_id = $1 and space_id = $2 and deleted_at is null returning id`, [person, space]);
/* readSpaces (the tiles) and readEverySpace (the sheet, archived ones too) */
const tiles = (w, who) => rowsAs(w.db, who, `select id, slug, name from public.spaces where deleted_at is null order by sort_order, name`).then((r) => r.map((s) => s.slug));
const everySpace = (w, who) => rowsAs(w.db, who, `select slug, deleted_at is not null as archived from public.spaces order by sort_order, name`);

test("owners, admins and a Strategist/Editor add a space and read it back; a viewer may not", async () => {
  const w = await world();
  const a = await addSpace(w, w.owner, "product-launches", "Product launches");
  assert.deepEqual(await readBack(w, w.owner, a.id), [{ id: a.id, slug: "product-launches" }]);
  const b = await addSpace(w, w.admin, "gift-sets", "Gift sets", 4);
  assert.deepEqual(await readBack(w, w.admin, b.id), [{ id: b.id, slug: "gift-sets" }]);
  assert.equal(await one(w.db, `select created_by::text from public.spaces where id = $1`, [b.id]), w.admin, "who added it is kept");
  /* Strategist/Editor holds spaces.create and spaces.all (owner, Nov 16 2026) */
  const c = await addSpace(w, w.strategist, "shoot-days", "Shoot days", 5);
  assert.deepEqual(await readBack(w, w.strategist, c.id), [{ id: c.id, slug: "shoot-days" }]);
  await assert.rejects(addSpace(w, w.viewer, "nope", "Nope"), RLS);
  await assert.rejects(addSpace(w, w.maker, "nope", "Nope"), RLS);
  assert.deepEqual(await tiles(w, w.admin2), [...SEEDED_SPACES, "product-launches", "gift-sets", "shoot-days"], "every admin opens every space");
  assert.deepEqual(await tiles(w, w.strategist), [...SEEDED_SPACES, "product-launches", "gift-sets", "shoot-days"], "so does a Strategist/Editor");
  assert.deepEqual(await tiles(w, w.planner), [], "nobody else opens a new space until given it");
  assert.deepEqual(await tiles(w, w.viewer), []);
  assert.ok((await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'spaces'`)) >= 2, "the audit trail keeps each add");
});

test("an address is unique for good, archived spaces too; a space is never deleted", async () => {
  const w = await world();
  const s = await addSpace(w, w.owner, "halloween", "Halloween");
  await archive(w, w.owner, s.id);
  await assert.rejects(addSpace(w, w.owner, "halloween", "Halloween"), UNIQUE, "the action then takes halloween-2");
  assert.equal((await addSpace(w, w.owner, "halloween-2", "Halloween")).slug, "halloween-2", "the name is free again once archived");
  await assert.rejects(rowsAs(w.db, w.owner, `delete from public.spaces where id = $1`, [s.id]), DENIED);
});

test("rename: owners and admins; a Strategist/Editor and a viewer change nothing, even in a space they open", async () => {
  const w = await world();
  const s = await addSpace(w, w.owner, "launches", "Launches");
  await give(w, w.owner, w.strategist, s.id);
  await give(w, w.owner, w.viewer, s.id);
  assert.equal((await rename(w, w.admin, s.id, "Product launches")).length, 1);
  assert.equal((await rename(w, w.strategist, s.id, "Mine")).length, 0);
  assert.equal((await rename(w, w.viewer, s.id, "Mine")).length, 0);
  assert.equal(await one(w.db, `select name from public.spaces where id = $1`, [s.id]), "Product launches");
  assert.equal(await one(w.db, `select slug from public.spaces where id = $1`, [s.id]), "launches", "the address stays");
});

test("archive and restore: owners and admins; it leaves every tile and comes back with who could open it", async () => {
  const w = await world();
  const s = await addSpace(w, w.owner, "launches", "Launches");
  await give(w, w.admin, w.planner, s.id);
  assert.deepEqual(await tiles(w, w.planner), ["launches"]);
  assert.equal((await archive(w, w.strategist, s.id)).length, 0, "a Strategist/Editor may not archive");
  assert.equal((await archive(w, w.planner, s.id)).length, 0);
  assert.equal((await archive(w, w.viewer, s.id)).length, 0);
  assert.equal((await archive(w, w.admin, s.id)).length, 1);
  assert.deepEqual(await tiles(w, w.admin), [...SEEDED_SPACES]);
  assert.deepEqual(await tiles(w, w.strategist), [...SEEDED_SPACES], "it leaves every tile, a Strategist/Editor's too");
  assert.deepEqual(await tiles(w, w.planner), [], "an archived space is closed to people who were given it");
  assert.deepEqual(await rowsAs(w.db, w.planner, `select id from public.spaces where id = $1`, [s.id]), []);
  /* spaces.all reads every space row, archived ones too, as an admin does (private.can_see_space); the tiles leave it out */
  assert.equal((await rowsAs(w.db, w.strategist, `select id from public.spaces where id = $1`, [s.id])).length, 1);
  assert.deepEqual(
    (await everySpace(w, w.admin)).filter((r) => r.archived).map((r) => r.slug),
    ["launches"],
    "the owner and admins still read it, so Restore can find it",
  );
  assert.equal((await restore(w, w.strategist, s.id)).length, 0, "only the owner and admins bring it back");
  assert.equal((await restore(w, w.planner, s.id)).length, 0);
  assert.equal((await restore(w, w.owner, s.id)).length, 1);
  assert.deepEqual(await tiles(w, w.planner), ["launches"], "back with who could open it");
});

test("who can open it: the owner and admins give and take a space for people whose role does less", async () => {
  const w = await world();
  const s = await addSpace(w, w.owner, "launches", "Launches");
  assert.equal((await give(w, w.owner, w.planner, s.id)).length, 1);
  assert.equal((await give(w, w.admin, w.viewer, s.id)).length, 1, "an admin may give a viewer a space");
  await assert.rejects(give(w, w.admin, w.admin2, s.id), RLS, "an admin never changes another admin");
  await assert.rejects(give(w, w.admin, w.owner, s.id), RLS);
  await assert.rejects(give(w, w.admin, w.admin, s.id), RLS, "never your own");
  await assert.rejects(give(w, w.strategist, w.maker, s.id), RLS, "a Strategist/Editor gives nobody a space");
  await assert.rejects(give(w, w.planner, w.maker, s.id), RLS);
  await assert.rejects(give(w, w.viewer, w.maker, s.id), RLS);
  /* a person given the space sees it; another does not */
  assert.deepEqual(await tiles(w, w.planner), ["launches"]);
  assert.deepEqual(await tiles(w, w.viewer), ["launches"]);
  assert.deepEqual(await tiles(w, w.maker), []);
  assert.equal(await oneAs(w.db, w.planner, `select count(*)::int from public.person_spaces where profile_id = $1 and deleted_at is null`, [w.planner]), 1, "a person reads their own rows");
  assert.equal(await oneAs(w.db, w.maker, `select count(*)::int from public.person_spaces where profile_id <> $1`, [w.maker]), 0, "and nobody else's");
  /* taking it away is a change, never a delete */
  assert.equal((await take(w, w.planner, w.planner, s.id)).length, 0, "nobody takes their own");
  assert.equal((await take(w, w.strategist, w.planner, s.id)).length, 0, "a Strategist/Editor takes nobody's");
  assert.equal((await take(w, w.admin, w.planner, s.id)).length, 1);
  assert.deepEqual(await tiles(w, w.planner), []);
  assert.equal((await give(w, w.admin, w.planner, s.id)).length, 1, "and it can be given again");
  await assert.rejects(rowsAs(w.db, w.owner, `delete from public.person_spaces where space_id = $1`, [s.id]), DENIED);
});

test("before the space create migration, a role that adds spaces without opening every space: the space lands, the read back finds nothing", async () => {
  const w = await world({ before: "20261119100000" });
  /* why createSpace reads back in a second request, and says so when it finds nothing: the database shows a space
     only to people who may open it. The migration supabase/migrations/20261119100000_space_create.sql gives the
     creator the space (supabase/tests/spaces-draft.test.mjs); before it, only roles with spaces.manage add spaces. */
  await as(w.db, w.owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name, color) values ('Space keeper', 'st-bank') returning id`)).rows[0].id;
    for (const key of ["spaces.manage", "page.calendar"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, key]);
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, w.maker]);
  });
  await assert.rejects(
    as(w.db, w.maker, (tx) => tx.query(`insert into public.spaces (slug, name, short_name) values ('nope', 'Nope', 'Nope') returning id`)),
    RLS,
    "insert ... returning needs sight of the new row, so the action never asks for it",
  );
  const s = await addSpace(w, w.maker, "keeper", "Keeper");
  assert.deepEqual(await readBack(w, w.maker, s.id), [], "added, and hidden from the person who added it");
  assert.equal(await one(w.db, `select created_by::text from public.spaces where id = $1`, [s.id]), w.maker);
  assert.deepEqual(await tiles(w, w.maker), []);
});
