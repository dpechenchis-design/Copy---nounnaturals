// Behavior tests for supabase/migrations/20261116000000_strategist_editor.sql (Strategist and Editor become one role).
// The world is built on the migrations before it (people, invites and ticks made by signed in people with the old roles),
// then the merge alone runs as Supabase runs a migration: as the database owner, nobody signed in. (The later files,
// such as 20261119200000_strategist_editor_access that widens the role again, are proven in their own suites.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, applyMigration, signUp, as, one, OLD_EDITOR_KEYS } from "./helpers.mjs";

const MERGE = "20261116000000";
const NAME = "Strategist/Editor";
const DESCRIPTION = "Plans the weeks and cards, uploads versions, writes directions and review notes, replies to notes.";
/* The Strategist seed of the team access migration. */
const SEED_STRATEGIST = [
  "calendar.plan", "calendar.all_cards", "footage.upload", "footage.direct", "footage.reply", "review.notes", "posting.numbers",
  "studio.make", "rules.propose", "page.calendar", "page.upload", "page.review", "page.ugc", "page.library", "page.sounds", "page.brand",
];
const sorted = (a) => [...a].sort();

const rid = (db, key) => one(db, `select id from public.roles where key = $1`, [key]);
const liveKeys = async (db, role) =>
  (await db.query(`select permission_key from public.role_permissions where role_id = $1 and deleted_at is null order by 1`, [role])).rows.map((r) => r.permission_key);
const history = async (db, profile) =>
  (await db.query(
    `select f.key as "from", t.key as "to", c.changed_by from public.profile_role_changes c
       left join public.roles f on f.id = c.from_role_id join public.roles t on t.id = c.to_role_id
      where c.profile_id = $1 order by c.id`,
    [profile],
  )).rows;
const invite = (db, email) => db.query(`select role::text, r.key, r.name from public.invites i join public.roles r on r.id = i.role_id where i.email = $1`, [email]).then((x) => x.rows[0]);
const mkRole = (db, who, name) => as(db, who, async (tx) => (await tx.query(`insert into public.roles (name) values ($1) returning id`, [name])).rows[0].id);

/** The live project just before the merge, then the merge. `beforeMerge(w)` runs on the old world first. */
async function world({ beforeMerge = null, merge = true } = {}) {
  const db = await freshDb({ before: MERGE });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("steven@nounnaturals.com", "admin");
  await inv("strat@nounnaturals.com", "strategist");
  await inv("olena@agency.test", "editor");
  await inv("ivan@agency.test", "editor");
  await inv("viewer@nounnaturals.com", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "strat@nounnaturals.com", "Strat");
  const editor = await signUp(db, "olena@agency.test", "Olena");
  const removed = await signUp(db, "ivan@agency.test", "Ivan");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  await as(db, owner, (tx) => tx.query(`update public.profiles set access_status = 'removed' where id = $1`, [removed]));
  await inv("maria@agency.test", "editor"); // open
  await inv("petro@agency.test", "editor"); // cancelled below
  await as(db, owner, (tx) => tx.query(`update public.invites set revoked_at = now() where email = 'petro@agency.test'`));
  const w = { db, owner, admin, strat, editor, removed, viewer };
  if (beforeMerge) await beforeMerge(w);
  if (merge) await applyMigration(db, MERGE);
  return w;
}

test("the merge: one role named Strategist/Editor with the union, Editor retired and never deleted", async () => {
  const w = await world();
  const role = (await w.db.query(`select key, name, description, color, is_system, is_locked, deleted_at from public.roles where key = 'strategist'`)).rows[0];
  assert.deepEqual(role, { key: "strategist", name: NAME, description: DESCRIPTION, color: "st-editing", is_system: true, is_locked: false, deleted_at: null });
  const strategist = await rid(w.db, "strategist");
  /* the union of both seeds, which is today's Strategist set: no tick added, none lost */
  assert.deepEqual(await liveKeys(w.db, strategist), sorted(new Set([...SEED_STRATEGIST, ...OLD_EDITOR_KEYS])));
  assert.deepEqual(await liveKeys(w.db, strategist), sorted(SEED_STRATEGIST));
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1`, [strategist]), 16);
  /* Editor: still a row with its key, flags and ticks, retired with deleted_at */
  const ed = (await w.db.query(`select name, is_system, deleted_at from public.roles where key = 'editor'`)).rows[0];
  assert.equal(ed.name, "Editor");
  assert.equal(ed.is_system, true);
  assert.ok(ed.deleted_at);
  assert.deepEqual(await liveKeys(w.db, await rid(w.db, "editor")), sorted(OLD_EDITOR_KEYS));
  assert.equal(await one(w.db, `select count(*)::int from public.roles`), 5);
  assert.equal(await one(w.db, `select count(*)::int from public.roles where deleted_at is null`), 4);
  /* the audit trail has the rename and the retirement, by nobody (the database) */
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'roles' and action = 'soft_delete' and actor_id is null`), 1);
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'roles' and action = 'update' and actor_id is null`), 1);
});

test("the merge moves every editor (removed ones too) with a history row, and only open invites", async () => {
  const w = await world();
  const people = (await w.db.query(`select p.id, p.role::text, r.key, p.access_status::text from public.profiles p join public.roles r on r.id = p.role_id`)).rows;
  const of = (id) => people.find((p) => p.id === id);
  assert.deepEqual([of(w.editor).role, of(w.editor).key, of(w.editor).access_status], ["strategist", "strategist", "active"]);
  assert.deepEqual([of(w.removed).role, of(w.removed).key, of(w.removed).access_status], ["strategist", "strategist", "removed"]);
  assert.equal(await one(w.db, `select count(*)::int from public.profiles p join public.roles r on r.id = p.role_id where r.key = 'editor'`), 0);
  assert.equal(await one(w.db, `select count(*)::int from public.profiles where role = 'editor'`), 0);
  /* one history row per moved person, written by the database; their first row stays */
  assert.deepEqual(await history(w.db, w.editor), [{ from: null, to: "editor", changed_by: null }, { from: "editor", to: "strategist", changed_by: null }]);
  assert.deepEqual(await history(w.db, w.removed), [{ from: null, to: "editor", changed_by: null }, { from: "editor", to: "strategist", changed_by: null }]);
  assert.equal(await one(w.db, `select count(*)::int from public.profile_role_changes c join public.roles r on r.id = c.from_role_id where r.key = 'editor'`), 2);
  /* nobody else got a row */
  assert.deepEqual(await history(w.db, w.strat), [{ from: null, to: "strategist", changed_by: null }]);
  assert.deepEqual(await history(w.db, w.viewer), [{ from: null, to: "viewer", changed_by: null }]);
  /* invites: the open one moves; the used and the cancelled ones keep Editor as history */
  assert.deepEqual(await invite(w.db, "maria@agency.test"), { role: "strategist", key: "strategist", name: NAME });
  assert.deepEqual(await invite(w.db, "olena@agency.test"), { role: "editor", key: "editor", name: "Editor" });
  assert.deepEqual(await invite(w.db, "petro@agency.test"), { role: "editor", key: "editor", name: "Editor" });
  /* the person on the open invite signs in as Strategist/Editor */
  const maria = await signUp(w.db, "maria@agency.test", "Maria");
  assert.equal(await one(w.db, `select role || ':' || access_status from public.profiles where id = $1`, [maria]), "strategist:active");
  /* a removed person can be let back in: their role is live */
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set access_status = 'active' where id = $1`, [w.removed]));
  assert.equal(await one(w.db, `select access_status::text from public.profiles where id = $1`, [w.removed]), "active");
});

test("the merge runs with nobody signed in, so the guards step aside; a signed in person is still refused", async () => {
  const w = await world({ merge: false });
  /* the same retirement by the owner, signed in, is refused by the role guard */
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.roles set deleted_at = now() where key = 'editor'`)), /prebuilt role/);
  await applyMigration(w.db, MERGE);
  assert.ok(await one(w.db, `select deleted_at from public.roles where key = 'editor'`));
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.roles set deleted_at = now() where key = 'viewer'`)), /prebuilt role/);
});

test("a tick moved onto Editor before the merge joins Strategist/Editor, once", async () => {
  const w = await world({
    beforeMerge: async (o) => {
      const editorRole = await rid(o.db, "editor");
      await as(o.db, o.owner, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'posting.bank')`, [editorRole]));
      /* a tick Editor once had and lost does not come back */
      await as(o.db, o.owner, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'page.posting')`, [editorRole]));
      await as(o.db, o.owner, (tx) => tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = 'page.posting'`, [editorRole]));
    },
  });
  const strategist = await rid(w.db, "strategist");
  assert.deepEqual(await liveKeys(w.db, strategist), sorted([...SEED_STRATEGIST, "posting.bank"]));
  assert.equal(await one(w.db, `select granted_by from public.role_permissions where role_id = $1 and permission_key = 'posting.bank'`, [strategist]), null);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1 and permission_key = 'page.posting'`, [strategist]), 0);
});

test("after the merge the old value 'editor' means Strategist/Editor, so the old published app keeps working", async () => {
  const w = await world();
  const strategist = await rid(w.db, "strategist");
  /* invites by the owner, an admin and our own server */
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.invites (email, role) values ('anna@agency.test', 'editor')`));
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role) values ('oleh@agency.test', 'editor')`));
  await as(w.db, "service", (tx) => tx.query(`insert into public.invites (email, role) values ('svc@agency.test', 'editor')`));
  for (const email of ["anna@agency.test", "oleh@agency.test", "svc@agency.test"]) {
    assert.deepEqual(await invite(w.db, email), { role: "strategist", key: "strategist", name: NAME }, email);
  }
  const anna = await signUp(w.db, "anna@agency.test", "Anna");
  assert.equal(await one(w.db, `select role_id from public.profiles where id = $1`, [anna]), strategist);
  /* a role change written only as the old enum value */
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set role = 'editor' where id = $1`, [w.viewer]));
  assert.equal(await one(w.db, `select role || ':' || (role_id = $2)::text from public.profiles where id = $1`, [w.viewer, strategist]), "strategist:true");
  assert.deepEqual((await history(w.db, w.viewer)).at(-1), { from: "viewer", to: "strategist", changed_by: w.owner });
  /* writing 'editor' on someone who already is Strategist/Editor changes nothing and writes no history */
  const before = (await history(w.db, w.strat)).length;
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set role = 'editor' where id = $1`, [w.strat]));
  assert.equal(await one(w.db, `select role::text from public.profiles where id = $1`, [w.strat]), "strategist");
  assert.equal((await history(w.db, w.strat)).length, before);
  /* an admin manages Strategist/Editor people as before (it does less than Admin) */
  await as(w.db, w.admin, (tx) => tx.query(`update public.profiles set role = 'viewer' where id = $1`, [w.strat]));
  assert.equal(await one(w.db, `select role::text from public.profiles where id = $1`, [w.strat]), "viewer");
});

test("nobody gives the retired Editor role, and nobody changes its ticks", async () => {
  const w = await world();
  const editorRole = await rid(w.db, "editor");
  for (const who of [w.owner, w.admin]) {
    await assert.rejects(as(w.db, who, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [editorRole, w.viewer])), /role was removed/);
  }
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`insert into public.invites (email, role_id) values ('x@agency.test', $1)`, [editorRole])), /role was removed/);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`insert into public.invites (email, role_id) values ('y@agency.test', $1)`, [editorRole])), /role was removed/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, 'posting.bank')`, [editorRole])), /role was removed/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1`, [editorRole])), /role was removed/);
  assert.equal(await one(w.db, `select count(*)::int from public.profiles where role_id = $1`, [editorRole]), 0);
});

test("the name Editor is free for a custom role; Strategist/Editor is taken", async () => {
  const w = await world();
  const id = await mkRole(w.db, w.owner, "Editor");
  assert.equal(await one(w.db, `select key from public.roles where id = $1`, [id]), null);
  await assert.rejects(mkRole(w.db, w.owner, "editor"), /duplicate key|unique/);
  await assert.rejects(mkRole(w.db, w.owner, "strategist/editor"), /duplicate key|unique/);
});

test("history: a role changed by writing only profiles.role writes a row (before the merge it did not)", async () => {
  /* the old trigger, `update of role_id`, never saw a change made through profiles.role */
  const old = await world({ merge: false });
  const n = (await history(old.db, old.viewer)).length;
  await as(old.db, old.owner, (tx) => tx.query(`update public.profiles set role = 'strategist' where id = $1`, [old.viewer]));
  assert.equal(await one(old.db, `select role::text from public.profiles where id = $1`, [old.viewer]), "strategist");
  assert.equal((await history(old.db, old.viewer)).length, n);

  const w = await world();
  assert.doesNotMatch(await one(w.db, `select pg_get_triggerdef(oid) from pg_trigger where tgname = 'd_log_role_change'`), /UPDATE OF/i);
  const before = (await history(w.db, w.viewer)).length;
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set role = 'strategist' where id = $1`, [w.viewer]));
  assert.deepEqual((await history(w.db, w.viewer)).slice(before), [{ from: "viewer", to: "strategist", changed_by: w.owner }]);
  /* an update that does not change the role writes nothing */
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.viewer]));
  await as(w.db, w.viewer, (tx) => tx.query(`update public.profiles set full_name = 'Vika' where id = $1`, [w.viewer]));
  assert.equal((await history(w.db, w.viewer)).length, before + 1);
  /* role_id written directly still writes exactly one row */
  await as(w.db, w.owner, async (tx) => tx.query(`update public.profiles set role_id = (select id from public.roles where key = 'viewer') where id = $1`, [w.viewer]));
  assert.deepEqual((await history(w.db, w.viewer)).at(-1), { from: "strategist", to: "viewer", changed_by: w.owner });
  assert.equal((await history(w.db, w.viewer)).length, before + 2);
});
