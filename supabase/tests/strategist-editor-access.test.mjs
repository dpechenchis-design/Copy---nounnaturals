/* Behavior tests for the migration supabase/migrations/20261119200000_strategist_editor_access.sql (approved by the
   owner Nov 16 2026): Strategist/Editor is "almost admin". The world is built on every migration before it
   (freshDb({ before: ACCESS }), so the UGC, spaces, review undo and space create migrations it needs are there), then
   this one runs as Supabase runs a migration: as the database owner, nobody signed in.
   Nothing here touches the live Supabase project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, applyMigration, signUp, as, rowsAs, oneAs, one } from "./helpers.mjs";

/* The migration under test, by its timestamp. */
const ACCESS = "20261119200000";
const runAccess = (db) => applyMigration(db, ACCESS);

/* The role's 30 keys (src/lib/access/permissions.ts, PREBUILT_ROLES strategist). */
const STRATEGIST = [
  "calendar.plan", "calendar.all_cards", "calendar.setup",
  "footage.upload", "footage.direct", "footage.reply",
  "review.notes",
  "posting.numbers",
  "studio.make", "rules.propose",
  "brand.manage",
  "ugc.manage",
  "spaces.create", "spaces.all",
  "page.analytics", "page.calendar", "page.upload", "page.review", "page.studio", "page.carousels", "page.ugc",
  "page.brand", "page.templates", "page.library", "page.sounds",
  "page.discovery", "page.community", "page.competitors", "page.ads",
  "page.rules",
];
/* Never for Strategist/Editor. */
const NEVER = [
  "calendar.delete_weeks", "review.approve", "review.undo", "posting.all_channels", "posting.bank", "posting.accounts",
  "rules.approve", "ai.setup", "team.manage", "team.roles", "spaces.manage", "team.activity", "settings.view",
  "integrations.manage", "page.bank", "page.posting", "page.accounts", "page.activity", "page.audit", "page.settings",
];
const DESCRIPTION = "Adds spaces, plans the weeks and cards, uploads raw clips and versions, writes directions and review notes, and makes with AI. Approving, posting and the team stay with the owner and admins.";
const VIEWER = ["calendar.all_cards", "page.analytics", "page.calendar", "posting.numbers"];

const sorted = (a) => [...a].sort();
const rid = (db, key) => one(db, `select id from public.roles where key = $1`, [key]);
const liveKeys = async (db, role) =>
  (await db.query(`select permission_key from public.role_permissions where role_id = $1 and deleted_at is null order by 1`, [role])).rows.map((r) => r.permission_key);
const allKeys = async (db) => (await db.query(`select key from public.permissions where deleted_at is null order by 1`)).rows.map((r) => r.key);

/** The world just before this migration: every migration before it. `beforeAccess(w)` runs there. */
async function world({ beforeAccess = null, access = true } = {}) {
  const db = await freshDb({ before: ACCESS });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("steven@nounnaturals.com", "admin");
  await inv("olena@agency.test", "strategist");
  await inv("viewer@nounnaturals.com", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "olena@agency.test", "Olena");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const w = { db, owner, admin, strat, viewer };
  if (beforeAccess) await beforeAccess(w);
  if (access) assert.equal(await runAccess(db), "20261119200000_strategist_editor_access.sql");
  return w;
}

test("the migrations it needs ran before it (the ugc, review undo and space create migrations add the three new keys)", async () => {
  const w = await world({ access: false });
  const keys = await allKeys(w.db);
  for (const k of ["ugc.manage", "review.undo", "spaces.create"]) assert.ok(keys.includes(k), k);
  assert.equal(keys.length, 50, "the 47 keys before them and their three");
  /* before it, Strategist/Editor still has its merged list: no spaces.all, no spaces.create */
  const st = await rid(w.db, "strategist");
  for (const k of ["spaces.all", "spaces.create", "calendar.setup", "brand.manage"]) assert.ok(!(await liveKeys(w.db, st)).includes(k), k);
  await runAccess(w.db);
  assert.equal((await allKeys(w.db)).length, 50, "it adds no key");
});

test("Strategist/Editor holds exactly its 30 keys; its name, key, color and flags stay; the description is new", async () => {
  const w = await world();
  const st = await rid(w.db, "strategist");
  assert.deepEqual(await liveKeys(w.db, st), sorted(STRATEGIST));
  assert.equal(STRATEGIST.length, 30);
  for (const k of NEVER) assert.ok(!STRATEGIST.includes(k), k);
  assert.deepEqual(sorted([...STRATEGIST, ...NEVER]), await allKeys(w.db), "every key is in one list or the other");
  const role = (await w.db.query(`select key, name, description, color, is_system, is_locked, deleted_at from public.roles where key = 'strategist'`)).rows[0];
  assert.deepEqual(role, { key: "strategist", name: "Strategist/Editor", description: DESCRIPTION, color: "st-editing", is_system: true, is_locked: false, deleted_at: null });
  /* the database did it: no person is named on the new ticks */
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1 and deleted_at is null and granted_by is not null`, [st]), 0);
  /* no other role moved: Owner and Admin hold every key, Viewer its four, Editor stays retired with its old ticks */
  const every = await allKeys(w.db);
  assert.deepEqual(await liveKeys(w.db, await rid(w.db, "owner")), every);
  assert.deepEqual(await liveKeys(w.db, await rid(w.db, "admin")), every);
  assert.deepEqual(await liveKeys(w.db, await rid(w.db, "viewer")), VIEWER);
  assert.ok(await one(w.db, `select deleted_at from public.roles where key = 'editor'`));
});

test("a custom role made before is unchanged; a tick given by hand stays; running it again adds nothing", async () => {
  let custom;
  const w = await world({
    beforeAccess: async (o) => {
      const stRole = await rid(o.db, "strategist");
      custom = await as(o.db, o.owner, async (tx) => {
        const id = (await tx.query(`insert into public.roles (name, color) values ('Shooter', 'st-bank') returning id`)).rows[0].id;
        for (const k of ["footage.upload", "page.upload", "spaces.manage"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, k]);
        /* the owner gave Strategist/Editor a key by hand before the migration */
        await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'page.bank')`, [stRole]);
        return id;
      });
    },
  });
  /* the custom role: exactly its own three ticks (it was made after the space create migration, and this one touches no custom role) */
  assert.deepEqual(await liveKeys(w.db, custom), sorted(["footage.upload", "page.upload", "spaces.manage"]));
  assert.equal(await one(w.db, `select name from public.roles where id = $1`, [custom]), "Shooter");
  const st = await rid(w.db, "strategist");
  assert.deepEqual(await liveKeys(w.db, st), sorted([...STRATEGIST, "page.bank"]), "nothing is unticked");
  /* once more: no tick doubled, the description the same */
  const ticks = await one(w.db, `select count(*)::int from public.role_permissions`);
  await runAccess(w.db);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions`), ticks);
  assert.equal(await one(w.db, `select description from public.roles where key = 'strategist'`), DESCRIPTION);
});

test("it runs with nobody signed in, so the guards step aside; a signed in person is still refused", async () => {
  const w = await world({ access: false });
  const st = await rid(w.db, "strategist");
  /* the same tick by a Strategist/Editor, signed in, is refused (they may not change their own role) */
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'brand.manage')`, [st])), /row-level security|own role/);
  assert.ok(!(await liveKeys(w.db, st)).includes("brand.manage"), "not held before the migration");
  await runAccess(w.db);
  assert.ok((await liveKeys(w.db, st)).includes("brand.manage"));
  /* still: nobody changes their own role */
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'review.approve')`, [st])), /row-level security|own role/);
});

test("Strategist/Editor is still below Admin: an admin gives it, changes its ticks and manages its people", async () => {
  const w = await world();
  const st = await rid(w.db, "strategist");
  const admin = await rid(w.db, "admin");
  assert.equal(await one(w.db, `select private.role_below($1, $2)`, [st, admin]), true);
  assert.equal(await one(w.db, `select private.role_below($1, $2)`, [admin, st]), false);
  /* the viewer does less than Strategist/Editor now (it opens Analytics too) */
  assert.equal(await one(w.db, `select private.role_below($1, $2)`, [await rid(w.db, "viewer"), st]), true);
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role) values ('maria@agency.test', 'strategist')`));
  await as(w.db, w.admin, (tx) => tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = 'page.ads' and deleted_at is null`, [st]));
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'page.ads')`, [st]));
  assert.deepEqual(await liveKeys(w.db, st), sorted(STRATEGIST));
  await as(w.db, w.admin, (tx) => tx.query(`update public.profiles set access_status = 'removed' where id = $1`, [w.strat]));
  assert.equal(await one(w.db, `select access_status::text from public.profiles where id = $1`, [w.strat]), "removed");
});

test("Strategist/Editor still cannot invite, build roles, delete weeks, approve, undo or manage integrations", async () => {
  const w = await world();
  const st = await rid(w.db, "strategist");
  for (const k of NEVER) assert.equal(await one(w.db, `select private.role_has($1, $2)`, [st, k]), false, k);
  /* invite */
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`insert into public.invites (email, role) values ('x@agency.test', 'viewer')`)), /row-level security/);
  /* build roles */
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`insert into public.roles (name) values ('Nope')`)), /row-level security/);
  const viewerRole = await rid(w.db, "viewer");
  const untick = await rowsAs(w.db, w.strat, `update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = 'page.calendar' returning id`, [viewerRole]).catch((e) => e);
  assert.ok(untick instanceof Error || untick.length === 0, "unticking another role is refused");
  assert.deepEqual(await liveKeys(w.db, await rid(w.db, "viewer")), VIEWER);
  /* plan a week (yes), delete it (no) */
  const noun = await one(w.db, `select id from public.spaces where slug = 'noun'`);
  const week = await oneAs(w.db, w.strat, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-9', 'Week 9', 9, '2026-11-23') returning id`, [noun]);
  assert.ok(week, "a Strategist/Editor plans weeks");
  await assert.rejects(rowsAs(w.db, w.strat, `update public.weeks set deleted_at = now() where id = $1 returning id`, [week]), /delete weeks/);
  assert.equal(await one(w.db, `select deleted_at from public.weeks where id = $1`, [week]), null);
  /* approve (no), undo (no): a version on a card of theirs, approved by the admin */
  const card = await oneAs(w.db, w.strat, `insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Patchouli', '2026-11-24', $2) returning id`, [week, w.strat]);
  const version = await oneAs(w.db, w.strat, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', 'noun/week-9/patchouli-v1.mp4', 'patchouli-v1.mp4') returning id`, [card]);
  const decide = (who) => rowsAs(w.db, who, `insert into public.approvals (version_id, decision, decided_by) values ($1, 'approved', $2) returning id`, [version, who]);
  await assert.rejects(decide(w.strat), /row-level security|Only the owner or an admin/);
  const [approval] = await decide(w.admin);
  const undone = await rowsAs(w.db, w.strat, `update public.approvals set revoked_at = now() where id = $1 and revoked_at is null returning id`, [approval.id]);
  assert.deepEqual(undone, [], "the undo finds nothing to change");
  assert.equal(await one(w.db, `select revoked_at from public.approvals where id = $1`, [approval.id]), null);
  /* add a space (yes, the new power), rename or archive one (no) */
  const space = await oneAs(w.db, w.strat, `insert into public.spaces (slug, name, short_name, sort_order) values ('ugc-lab', 'UGC lab', 'UGC lab', 9) returning id`);
  assert.ok(space, "a Strategist/Editor adds a space");
  assert.deepEqual(await rowsAs(w.db, w.strat, `select id from public.spaces where id = $1`, [space]), [{ id: space }], "and opens it");
  const renamed = await rowsAs(w.db, w.strat, `update public.spaces set name = 'Renamed' where id = $1 returning id`, [noun]).catch((e) => e);
  assert.ok(renamed instanceof Error || renamed.length === 0, "renaming stays with spaces.manage");
  assert.equal(await one(w.db, `select name from public.spaces where id = $1`, [noun]), await one(w.db, `select name from public.spaces where slug = 'noun'`));
  assert.notEqual(await one(w.db, `select name from public.spaces where id = $1`, [noun]), "Renamed");
});
