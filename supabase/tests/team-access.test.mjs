// Behavior tests for supabase/migrations/20261115200000_team_access.sql (custom roles and page access).
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, one, narrowEditor, FILES_READER, DRAFT_ONLY_KEYS, LIVE_LABELS, KEY_DRAFTS } from "./helpers.mjs";
import { PERMISSIONS, PREBUILT } from "../../src/lib/access/permissions.ts";

/* Two drafts add a key the code already lists: the Meta posting draft (posting.resolve, Owner and Admin) and the
   Upload/Files draft (files.manage, Owner, Admin and Strategist/Editor). While both wait the live database has 50 keys
   and the code 52; each one adds its key on the day it is live (helpers.mjs DRAFT_ONLY_KEYS). */
const LIVE_KEYS = PERMISSIONS.length - DRAFT_ONLY_KEYS.length;
const LIVE_STRATEGIST_KEYS = PREBUILT.strategist.keys.filter((k) => !DRAFT_ONLY_KEYS.includes(k)).length;

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (who, email, role) => as(db, who, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv(owner, "steven@nounnaturals.com", "admin");
  await inv(owner, "david@nounnaturals.com", "admin");
  await inv(owner, "olena@agency.test", "editor");
  const admin = await signUp(db, "steven@nounnaturals.com");
  const admin2 = await signUp(db, "david@nounnaturals.com");
  const editor = await signUp(db, "olena@agency.test");
  const editorRole = await narrowEditor(db, owner, editor); // the narrow editor persona: a custom role "Editor" with the old Editor keys (Editor was merged into Strategist/Editor by the 20261116000000 migration)
  const rid = (k) => one(db, `select id from public.roles where key = $1`, [k]);
  return { db, owner, admin, admin2, editor, editorRole, rid };
}
const mkRole = (db, who, name) => as(db, who, async (tx) => (await tx.query(`insert into public.roles (name) values ($1) returning id, key, is_system`, [name])).rows[0]);
const tick = (db, who, role, key) => as(db, who, (tx) => tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [role, key]));
const untick = (db, who, role, key) =>
  as(db, who, async (tx) => {
    const r = await tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = $2 and deleted_at is null returning id`, [role, key]);
    if (!r.rows.length) throw new Error("row-level security: no row changed");
  });

/* The 22 page keys (owner, Nov 15 2026): one per screen except Home, in sidebar order, labelled as the screen (src/lib/nav.ts). */
const PAGES = [
  ["page.analytics", "Analytics"], ["page.calendar", "Calendar"], ["page.upload", FILES_READER.live ? "Upload/Files" : "Upload"], ["page.review", "Review"],
  ["page.studio", "Studio"], ["page.carousels", "Carousels and photos"], ["page.ugc", "UGC, mentions and comments"],
  ["page.bank", "Bank and schedule"], ["page.posting", "Posting"], ["page.accounts", "Accounts"], ["page.brand", "Brand kit"],
  ["page.templates", "Templates"], ["page.library", "Library"], ["page.sounds", "Sounds"], ["page.discovery", "Discovery"],
  ["page.community", "Community"], ["page.competitors", "Competitors"], ["page.ads", "Ads"], ["page.activity", "Activity"],
  ["page.audit", "Audit trail"], ["page.rules", "Checker rules"], ["page.settings", "Settings"],
];
/* The eight screens editors opened before the Strategist/Editor access migration: Home (always open, no key) and these
   seven. The retired Editor role keeps them as history. */
const EDITOR_PAGES = ["page.brand", "page.calendar", "page.library", "page.review", "page.sounds", "page.ugc", "page.upload"];
/* Strategist/Editor's pages since 20261119200000_strategist_editor_access (owner, Nov 16 2026): the 16 of permissions.ts. */
const STRATEGIST_PAGES = PREBUILT.strategist.keys.filter((k) => k.startsWith("page.")).sort();
const livePages = async (db, role) =>
  (await db.query(`select permission_key from public.role_permissions where role_id = $1 and deleted_at is null and permission_key like 'page.%' order by 1`, [role])).rows.map((r) => r.permission_key);

test("seeds: 50 permissions (22 pages; week trash added Delete weeks, then ugc, review undo and space create one each; each key draft one more once live), 5 prebuilt roles (4 live after the merge), backfill and legacy column", async () => {
  const w = await world();
  assert.equal(await one(w.db, `select count(*)::int from public.permissions`), LIVE_KEYS);
  assert.equal(await one(w.db, `select count(*)::int from public.roles where is_system`), 5);
  assert.equal(await one(w.db, `select count(*)::int from public.roles where is_system and deleted_at is null`), 4);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'admin'`), LIVE_KEYS);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'owner'`), LIVE_KEYS);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.key = 'strategist' and rp.deleted_at is null`), LIVE_STRATEGIST_KEYS);
  const pages = (await w.db.query(`select key, group_key, group_label, label, hint, sort_order from public.permissions where group_key = 'pages' order by sort_order`)).rows;
  assert.deepEqual(pages.map((p) => [p.key, p.label]), PAGES);
  assert.ok(pages.every((p, i) => p.group_label === "Pages" && p.hint === null && p.sort_order === 300 + 10 * i));
  assert.equal(await one(w.db, `select min(sort_order)::int from public.permissions where group_key = 'pages'`), 300);
  assert.equal(await one(w.db, `select max(sort_order)::int from public.permissions where group_key <> 'pages'`) < 300, true);
  /* the prebuilt roles' pages: Strategist/Editor's wider list (owner, Nov 16 2026), the viewer's as before */
  assert.deepEqual(await livePages(w.db, await w.rid("strategist")), STRATEGIST_PAGES);
  assert.equal(STRATEGIST_PAGES.length, 16);
  /* the retired Editor role keeps its ticks as history */
  assert.deepEqual(await livePages(w.db, await w.rid("editor")), EDITOR_PAGES);
  assert.deepEqual(await livePages(w.db, await w.rid("viewer")), ["page.analytics", "page.calendar"]);
  assert.equal((await livePages(w.db, await w.rid("admin"))).length, 22);
  assert.equal(await one(w.db, `select r.key from public.profiles p join public.roles r on r.id = p.role_id where p.id = $1`, [w.owner]), "owner");
  /* the editor persona: let in by an "editor" invite (now Strategist/Editor), then given the custom "Editor" role, so the legacy column is empty */
  assert.equal(await one(w.db, `select role::text from public.profiles where id = $1`, [w.editor]), null);
  assert.equal(await one(w.db, `select r.name from public.profiles p join public.roles r on r.id = p.role_id where p.id = $1`, [w.editor]), "Editor");
  assert.equal(await one(w.db, `select count(*)::int from public.profile_role_changes where profile_id = $1`, [w.editor]), 2);
});

test("owner builds a custom role, gives it to a person, and the database enforces it", async () => {
  const w = await world();
  /* the owner and admins build roles (owner, Nov 15); an editor cannot */
  await assert.rejects(mkRole(w.db, w.editor, "Nope"), /row-level security/);
  const r = await mkRole(w.db, w.owner, "Shooter");
  assert.equal(r.key, null);
  assert.equal(r.is_system, false);
  await tick(w.db, w.owner, r.id, "footage.upload");
  await tick(w.db, w.owner, r.id, "calendar.plan");
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [r.id, w.editor]));
  assert.equal(await one(w.db, `select role from public.profiles where id = $1`, [w.editor]), null);
  assert.equal(await one(w.db, `select count(*)::int from public.profile_role_changes where profile_id = $1`, [w.editor]), 3); // sign in, the custom "Editor" role, Shooter
  const noun = await one(w.db, `select id from public.spaces where slug = 'noun'`);
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [w.editor, noun]));
  await as(w.db, w.editor, (tx) => tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-9', 'Week 9', 9, '2026-11-16')`, [noun]));
  await untick(w.db, w.owner, r.id, "calendar.plan");
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-10', 'Week 10', 10, '2026-11-23')`, [noun])), /row-level security/);
  await tick(w.db, w.owner, r.id, "calendar.plan");
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1 and permission_key = 'calendar.plan'`, [r.id]), 2);
  assert.equal((await rowsAs(w.db, w.editor, `select 1 from public.audit_log limit 1`)).length, 0);
  assert.ok((await rowsAs(w.db, w.owner, `select 1 from public.audit_log where entity_table = 'role_permissions'`)).length >= 4);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.roles set deleted_at = now() where id = $1`, [r.id])), /Move its people/);
  const viewerRole = await w.rid("viewer");
  const ownerRole = await w.rid("owner");
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.roles set deleted_at = now() where id = $1`, [viewerRole])), /prebuilt/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = 'team.roles'`, [ownerRole])), /Owner role/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.roles set name = 'Boss' where id = $1`, [ownerRole])), /Owner role/);
  /* a custom role with Approve may approve; the old column is empty, the new ones are filled */
  await tick(w.db, w.owner, r.id, "review.approve");
  await tick(w.db, w.owner, r.id, "calendar.all_cards");
  const week = await one(w.db, `select id from public.weeks where slug = 'week-9'`);
  const card = await as(w.db, w.editor, async (tx) => (await tx.query(`insert into public.cards (week_id, title) values ($1, 'A card') returning id`, [week])).rows[0].id);
  const version = await as(w.db, w.editor, async (tx) => (await tx.query(`insert into public.versions (card_id, r2_bucket, r2_key) values ($1, 'edits', 'k1') returning id`, [card])).rows[0].id);
  await w.db.query(`update public.versions set review_state = 'in_review' where id = $1`, [version]);
  const ap = await as(w.db, w.editor, async (tx) => (await tx.query(`insert into public.approvals (version_id, decision) values ($1, 'approved') returning decided_by_role, decided_by_role_name`, [version])).rows[0]);
  assert.equal(ap.decided_by_role, null);
  assert.equal(ap.decided_by_role_name, "Shooter");
});

test("limits: own role, permissions you lack, people not below you", async () => {
  const w = await world();
  const adminRole = await w.rid("admin");
  const ownerRole = await w.rid("owner");
  /* admins hold "Build and change roles" from the seed (owner, Nov 15) */
  const r = await mkRole(w.db, w.admin, "Helper");
  await tick(w.db, w.admin, r.id, "footage.reply");
  await assert.rejects(untick(w.db, w.admin, adminRole, "review.approve"), /own role/);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [r.id, w.admin2])), /does less than yours/);
  await as(w.db, w.admin, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [r.id, w.editor]));
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [ownerRole, w.editor])), /does less than yours/);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [adminRole, w.editor])), /does less than yours/);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [r.id, w.admin])), /your own role/);
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role_id) values ('new@agency.test', $1)`, [r.id]));
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role_id) values ('x@agency.test', $1)`, [adminRole])), /row-level security/);
  const invited = await signUp(w.db, "new@agency.test");
  assert.equal(await one(w.db, `select role_id from public.profiles where id = $1`, [invited]), r.id);
  /* spaces for another admin: refused; for the helper: fine */
  const noun = await one(w.db, `select id from public.spaces where slug = 'noun'`);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [w.admin2, noun])), /row-level security/);
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [invited, noun]));
  await untick(w.db, w.owner, adminRole, "team.roles");
  await assert.rejects(tick(w.db, w.admin, r.id, "footage.upload"), /row-level security/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.profiles set access_status = 'removed' where id = $1`, [w.owner])), /your own/);
  /* 5 prebuilt (Editor retired, still a row), the custom "Editor" and Helper */
  assert.equal((await rowsAs(w.db, w.editor, `select 1 from public.roles`)).length, 7);
  await assert.rejects(tick(w.db, w.editor, r.id, "footage.upload"), /own role|row-level security/);
  const stranger = await signUp(w.db, "stranger@gmail.com");
  assert.equal((await rowsAs(w.db, stranger, `select 1 from public.roles`)).length, 0);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.roles where id = $1`, [r.id])), /permission denied/);
});

/* ---------- Pages (plan: roles, pages and people search, section C) ---------- */

const listOf = (rows) => rows.map((r) => ({ key: r.key, group: r.group_key, groupLabel: r.group_label, label: r.label, hint: r.hint }));
const permissionRows = async (db) =>
  (await db.query(`select key, group_key, group_label, label, hint from public.permissions where deleted_at is null order by sort_order`)).rows;

test("the permission list equals src/lib/access/permissions.ts: 52 keys, words and order, less what still waits in a draft (the Meta posting draft adds Settle posts, the Upload/Files draft Manage folders)", async () => {
  assert.equal(PERMISSIONS.length, 52, "the code lists 52 keys");
  /* the live database: the code's list less the keys of the drafts still waiting, with the words it has today */
  const rows = await permissionRows(await freshDb());
  assert.equal(rows.length, LIVE_KEYS);
  assert.deepEqual(
    listOf(rows),
    PERMISSIONS.filter((p) => !DRAFT_ONLY_KEYS.includes(p.key)).map(({ key, group, groupLabel, label, hint }) => ({ key, group, groupLabel, label: LIVE_LABELS[key] ?? label, hint })),
  );
  /* and with every waiting draft run after it, in version order: the code's whole list, word for word */
  const all = await permissionRows(await freshDb({ extra: KEY_DRAFTS }));
  assert.equal(all.length, 52);
  assert.deepEqual(listOf(all), PERMISSIONS.map(({ key, group, groupLabel, label, hint }) => ({ key, group, groupLabel, label, hint })));
});

test("no row level security policy reads a page key: data stays behind the action keys", async () => {
  const db = await freshDb();
  const hits = (await db.query(`select tablename, policyname from pg_policies where coalesce(qual, '') like '%page.%' or coalesce(with_check, '') like '%page.%'`)).rows;
  assert.deepEqual(hits, []);
});

test("page keys: an admin gives a page they hold; without Build and change roles, refused; never on your own role", async () => {
  const w = await world();
  const r = await mkRole(w.db, w.admin, "Shooter");
  await tick(w.db, w.admin, r.id, "page.bank");
  await tick(w.db, w.admin, r.id, "page.upload");
  assert.deepEqual(await livePages(w.db, r.id), ["page.bank", "page.upload"]);
  /* an editor does not hold team.roles */
  await assert.rejects(tick(w.db, w.editor, r.id, "page.review"), /row-level security|own role|you have yourself/);
  await assert.rejects(untick(w.db, w.editor, r.id, "page.bank"), /row-level security/);
  /* an admin cannot take a page off their own role, nor put one back */
  const adminRole = await w.rid("admin");
  await assert.rejects(untick(w.db, w.admin, adminRole, "page.settings"), /own role/);
  await untick(w.db, w.owner, adminRole, "page.settings");
  await assert.rejects(tick(w.db, w.admin, adminRole, "page.settings"), /own role/);
  /* ...and now lacks it, so cannot give it to anyone */
  await assert.rejects(tick(w.db, w.admin, r.id, "page.settings"), /you have yourself/);
  /* a lead with team.roles but a few pages: gives only the pages they hold */
  const lead = await mkRole(w.db, w.owner, "Lead");
  for (const k of ["team.roles", "page.calendar", "page.review"]) await tick(w.db, w.owner, lead.id, k);
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set role_id = $1 where id = $2`, [lead.id, w.editor]));
  const helper = await mkRole(w.db, w.editor, "Helper");
  await tick(w.db, w.editor, helper.id, "page.review");
  await assert.rejects(tick(w.db, w.editor, helper.id, "page.studio"), /you have yourself/);
  await assert.rejects(untick(w.db, w.editor, lead.id, "page.review"), /own role/);
  await assert.rejects(tick(w.db, w.editor, lead.id, "page.upload"), /own role/);
  /* the Owner role stays locked */
  await assert.rejects(untick(w.db, w.owner, await w.rid("owner"), "page.analytics"), /Owner role/);
});

test("a custom role made from Editor carries the editor's pages, tick by tick through the guard", async () => {
  const w = await world();
  /* Editor is retired (20261116000000 migration); the persona's custom "Editor" role holds the old Editor keys */
  const start = (await w.db.query(`select permission_key from public.role_permissions where role_id = $1 and deleted_at is null order by 1`, [w.editorRole])).rows.map((x) => x.permission_key);
  const r = await mkRole(w.db, w.admin, "Editor, basics");
  for (const k of start) await tick(w.db, w.admin, r.id, k);
  assert.deepEqual(await livePages(w.db, r.id), EDITOR_PAGES);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1 and deleted_at is null`, [r.id]), 9);
  /* each tick names who gave it */
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1 and granted_by = $2`, [r.id, w.admin]), 9);
});

test("unticking a page sets deleted_at, the history row stays, and ticking again adds a new row", async () => {
  const w = await world();
  const r = await mkRole(w.db, w.admin, "Poster");
  await tick(w.db, w.admin, r.id, "page.posting");
  await untick(w.db, w.admin, r.id, "page.posting");
  const rows = (await w.db.query(`select deleted_at, removed_by from public.role_permissions where role_id = $1 and permission_key = 'page.posting'`, [r.id])).rows;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].deleted_at);
  assert.deepEqual(await livePages(w.db, r.id), []);
  await tick(w.db, w.admin, r.id, "page.posting");
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where role_id = $1 and permission_key = 'page.posting'`, [r.id]), 2);
  assert.deepEqual(await livePages(w.db, r.id), ["page.posting"]);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.role_permissions where role_id = $1`, [r.id])), /permission denied/);
  assert.ok((await rowsAs(w.db, w.owner, `select 1 from public.audit_log where entity_table = 'role_permissions'`)).length >= 3);
});
