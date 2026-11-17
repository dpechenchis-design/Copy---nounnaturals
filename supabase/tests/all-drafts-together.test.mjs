/* The seven drafts the owner approved on Nov 16 2026, now in supabase/migrations, applied together, in file name
   order, on a database that already holds rows, the way the live project looked before that push: a person in each
   prebuilt role (Owner, Admin, Strategist/Editor, Viewer), a custom role holding spaces.manage, two live spaces with
   twin names, a week and a card, an edited version, an approval and a revoked approval, and a Drive folder recorded
   twice. This is the push that approves them all at once: every file must run on that data in one go, and what the
   data cleaning steps promise must hold.
   The world before them is built with freshDb({ before: FIRST }) (every migration before the seven), then the rows,
   then every migration from FIRST on, in this file's own throwaway PGlite database. The drafts that wait for the
   owner's yes then run on the same rows, in version order, while they are drafts: the Meta posting draft
   (supabase/drafts/20261119300000_meta_posting.sql), then the Additional content draft
   (supabase/drafts/20261123000000_additional_content.sql), which needs the Upload/Files migration
   (supabase/migrations/20261122000000_files_and_reader.sql, live now, runs with the migrations). Once a draft is
   live it runs with the migrations instead.
   Nothing here touches the live Supabase project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { freshDb, applyMigration, signUp, as, rowsAs, oneAs, one, KEY_DRAFTS, ADDITIONAL_CONTENT } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");
/* The drafts still waiting (helpers.mjs KEY_DRAFTS: the Meta posting draft, docs/META.md section 5), then the
   Additional content draft (it adds no key and runs after the Upload/Files migration), in version order. They need
   none of the seven and run after every migration. */
const DRAFTS = [...KEY_DRAFTS, ...(ADDITIONAL_CONTENT.live ? [] : [ADDITIONAL_CONTENT.path])];
const PERMISSIONS_TS = join(HERE, "..", "..", "src", "lib", "access", "permissions.ts");

/* The seven drafts the owner approved (Nov 16 2026), in the order they run. */
const SEVEN = [
  "20261117000000_edit_intake.sql",
  "20261118000000_raw_clip_upload.sql",
  "20261118200000_ugc.sql",
  "20261118300000_spaces.sql",
  "20261119000000_review_undo.sql",
  "20261119100000_space_create.sql",
  "20261119200000_strategist_editor_access.sql",
];
const FIRST = "20261117000000";
/* Every migration from the first of the seven on, as Supabase runs them: the seven, then any newer file. */
const ON_DISK = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f >= FIRST).sort();

/* The keys from the code, read as text (src/lib/access/permissions.ts): every permission, and the
   Strategist/Editor's action and page lists. */
const SOURCE = readFileSync(PERMISSIONS_TS, "utf8");
const CODE_KEYS = [...SOURCE.matchAll(/^\s*\{ key: "([^"]+)", group:/gm)].map((m) => m[1]);
const listIn = (name) => {
  const m = SOURCE.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`${name} not found in permissions.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};
const STRATEGIST_KEYS = [...listIn("STRATEGIST_ACTIONS"), ...listIn("STRATEGIST_PAGES")];

const RLS = /row-level security/;
const sorted = (a) => [...a].sort();
const rid = (db, key) => one(db, `select id from public.roles where key = $1`, [key]);
const liveKeys = async (db, role) =>
  (await db.query(`select permission_key from public.role_permissions where role_id = $1 and deleted_at is null order by 1`, [role])).rows.map((r) => r.permission_key);
const allKeys = async (db) => (await db.query(`select key from public.permissions where deleted_at is null order by 1`)).rows.map((r) => r.key);
const count = (db, sql, params = []) => one(db, `select count(*)::int from ${sql}`, params);

/** The world as the live project looked before the seven, then every migration from them on. Built once for the whole file. */
async function build() {
  const db = await freshDb({ before: FIRST });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("steven@nounnaturals.com", "admin");
  await inv("olena@agency.test", "strategist");
  await inv("viewer@nounnaturals.com", "viewer");
  await inv("keeper@nounnaturals.com", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "olena@agency.test", "Olena");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const keeper = await signUp(db, "keeper@nounnaturals.com", "Keeper");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);

  /* a custom role holding spaces.manage, given to one person */
  const custom = await as(db, owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name, color) values ('Space keeper', 'st-bank') returning id`)).rows[0].id;
    for (const k of ["spaces.manage", "page.calendar"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, k]);
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, keeper]);
    return id;
  });
  await as(db, owner, async (tx) => {
    for (const p of [strat, viewer]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });

  /* two live spaces with twin names (the live schema checks names only in the app) */
  const addSpace = (slug, name) =>
    oneAs(db, owner, `insert into public.spaces (slug, name, short_name, sort_order) values ($1, $2, $2, 9) returning id`, [slug, name]);
  const twinOld = await addSpace("halloween", "Halloween");
  const twinNew = await addSpace("halloween-2", "HALLOWEEN");

  /* a week, a card, an edited version, an approval and a revoked approval */
  const week = await oneAs(db, admin, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
  const card = await oneAs(db, admin, `insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Patchouli is not just a smell', '2026-11-17', $2) returning id`, [week, strat]);
  const version = await oneAs(db, strat, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', 'noun/week-3/patchouli-v1.mp4', 'patchouli-v1.mp4') returning id`, [card]);
  const decide = (who) => oneAs(db, who, `insert into public.approvals (version_id, decision, decided_by) values ($1, 'approved', $2) returning id`, [version, who]);
  const revoked = await decide(admin);
  const undone = await rowsAs(db, owner, `update public.approvals set revoked_at = now() where id = $1 and revoked_at is null and deleted_at is null returning id`, [revoked]);
  assert.equal(undone.length, 1, "the Owner revokes on the live schema");
  const approval = await decide(admin);

  /* one day's Raw folder recorded twice (two uploads that started in the same second) */
  const folder = (driveId, at) =>
    as(db, "service", (tx) =>
      tx.query(`insert into public.drive_folders (drive_folder_id, purpose, space_id, day, name, created_at) values ($1, 'day_raw', $2, '2026-11-17', 'Raw', $3)`, [driveId, noun, at]));
  await folder("raw-first", "2026-11-17T08:00:00Z");
  await folder("raw-second", "2026-11-17T08:00:01Z");

  const before = {
    approvals: (await db.query(`select id, decision::text as decision, decided_by, revoked_at, revoked_by, deleted_at from public.approvals order by id`)).rows,
    versions: await count(db, `public.versions`),
    spaces: await count(db, `public.spaces`),
    weeks: await count(db, `public.weeks`),
    cards: await count(db, `public.cards`),
    folders: await count(db, `public.drive_folders`),
    unticked: await count(db, `public.role_permissions where deleted_at is not null`),
    ticks: await count(db, `public.role_permissions`),
  };

  /* every migration from the seven on, in file name order, run the way Supabase runs a migration: as the database
     owner, nobody signed in */
  const applied = [];
  const failures = [];
  for (const name of ON_DISK) {
    try {
      applied.push(await applyMigration(db, name.slice(0, FIRST.length)));
    } catch (e) {
      failures.push(`${name}: ${e.message}${e.position ? ` (at character ${e.position})` : ""}${e.where ? ` [${e.where}]` : ""}`);
      break;
    }
  }
  for (const path of DRAFTS) {
    if (failures.length) break;
    try {
      await db.exec(readFileSync(path, "utf8"));
      applied.push(`${basename(path)} (draft)`);
    } catch (e) {
      failures.push(`the draft ${basename(path)}: ${e.message}${e.position ? ` (at character ${e.position})` : ""}`);
    }
  }
  return { db, owner, admin, strat, viewer, keeper, noun, custom, twinOld, twinNew, week, card, version, revoked, approval, before, applied, failures };
}

let world;
const w = () => (world ??= build());

test("every one of the seven applies on the rows of before, in file name order, without an error", async () => {
  const { applied, failures } = await w();
  assert.deepEqual(failures, []);
  assert.deepEqual(applied, [...ON_DISK, ...DRAFTS.map((path) => `${basename(path)} (draft)`)]);
  assert.deepEqual(DRAFTS.map((path) => basename(path)), DRAFTS.map((path) => basename(path)).sort(), "the drafts run in version order");
  assert.deepEqual(applied.slice(0, SEVEN.length), SEVEN, "the seven run first, in this order, and nothing sorts between them");
});

test("the 52 permission keys exist, the same as the code's list (posting.resolve from the Meta posting draft, files.manage from the live Upload/Files migration)", async () => {
  const { db } = await w();
  assert.equal(CODE_KEYS.length, 52, "permissions.ts lists 52 keys");
  assert.deepEqual(await allKeys(db), sorted(CODE_KEYS));
});

test("Owner and Admin hold all 52; Strategist/Editor exactly the 31 of permissions.ts; Viewer is unchanged", async () => {
  const { db } = await w();
  const every = await allKeys(db);
  assert.equal(every.length, 52);
  assert.ok(every.includes("posting.resolve"), "the Meta posting draft adds Settle posts");
  assert.ok(every.includes("files.manage"), "the Upload/Files draft adds Manage folders");
  assert.deepEqual(await liveKeys(db, await rid(db, "admin")), every);
  assert.deepEqual(await liveKeys(db, await rid(db, "owner")), every);
  assert.equal(STRATEGIST_KEYS.length, 31, "permissions.ts gives Strategist/Editor 31 keys");
  assert.deepEqual(await liveKeys(db, await rid(db, "strategist")), sorted(STRATEGIST_KEYS));
  assert.deepEqual(await liveKeys(db, await rid(db, "viewer")), sorted(["calendar.all_cards", "posting.numbers", "page.analytics", "page.calendar"]));
});

test("the custom role keeps spaces.manage and gets spaces.create from the space create migration, given by nobody", async () => {
  const { db, custom } = await w();
  assert.deepEqual(await liveKeys(db, custom), sorted(["page.calendar", "spaces.create", "spaces.manage"]));
  assert.equal(await one(db, `select granted_by from public.role_permissions where role_id = $1 and permission_key = 'spaces.create' and deleted_at is null`, [custom]), null);
  assert.equal(await one(db, `select name from public.roles where id = $1`, [custom]), "Space keeper");
});

test("the newer twin space is renamed with (2), its pill name too; the older one and both addresses stay", async () => {
  const { db, twinOld, twinNew } = await w();
  const named = async (id) => (await db.query(`select name, short_name, slug, deleted_at from public.spaces where id = $1`, [id])).rows[0];
  assert.deepEqual(await named(twinOld), { name: "Halloween", short_name: "Halloween", slug: "halloween", deleted_at: null });
  assert.deepEqual(await named(twinNew), { name: "HALLOWEEN (2)", short_name: "HALLOWEEN (2)", slug: "halloween-2", deleted_at: null });
  assert.equal(await one(db, `select name from public.spaces where slug = 'noun'`), "Noun Naturals content", "the first spaces keep their names");
  assert.equal(await one(db, `select name from public.spaces where slug = 'founder'`), "Founder content");
  assert.equal(await count(db, `public.spaces where description is not null`), 0);
});

test("the doubled Drive folder: the newer record gets deleted_at, the older stays live, nothing is deleted", async () => {
  const { db, before } = await w();
  assert.equal(await one(db, `select deleted_at is null from public.drive_folders where drive_folder_id = 'raw-first'`), true);
  assert.equal(await one(db, `select deleted_at is not null from public.drive_folders where drive_folder_id = 'raw-second'`), true);
  assert.equal(await count(db, `public.drive_folders`), before.folders);
});

test("the old approval rows survive as they were: the revoked one stays revoked by the Owner", async () => {
  const { db, owner, admin, revoked, approval, before } = await w();
  const after = (await db.query(`select id, decision::text as decision, decided_by, revoked_at, revoked_by, deleted_at from public.approvals order by id`)).rows;
  assert.deepEqual(after, before.approvals);
  const byId = Object.fromEntries(after.map((a) => [a.id, a]));
  assert.ok(byId[revoked].revoked_at);
  assert.equal(byId[revoked].revoked_by, owner);
  assert.equal(byId[approval].revoked_at, null);
  assert.equal(byId[approval].decided_by, admin);
});

test("no row was lost: versions, weeks, cards and spaces are all there; no tick was taken away", async () => {
  const { db, version, before } = await w();
  assert.equal(await count(db, `public.versions`), before.versions);
  assert.equal(await count(db, `public.weeks`), before.weeks);
  /* Additional content adds its six Halloween rows and its own space, and takes nothing away */
  assert.equal(await count(db, `public.cards`), before.cards + 6);
  assert.equal(await count(db, `public.spaces`), before.spaces + 1);
  assert.equal(await count(db, `public.role_permissions where deleted_at is not null`), before.unticked, "the seven only add ticks");
  assert.ok((await count(db, `public.role_permissions`)) > before.ticks);
  /* the older version passes the edit intake check: not known */
  const v = (await db.query(`select intake_via, match_method, match_confidence, edit_upload_batch_id from public.versions where id = $1`, [version])).rows[0];
  assert.deepEqual(v, { intake_via: null, match_method: null, match_confidence: null, edit_upload_batch_id: null });
});

test("Additional content on those rows: the space of folders, its two folders and six rows; the old rows keep their week", async () => {
  const { db, strat, viewer, keeper, card, week, noun } = await w();
  const space = await one(db, `select id from public.spaces where slug = 'additional' and kind = 'folders' and deleted_at is null`);
  assert.ok(space);
  assert.equal(await count(db, `public.spaces where kind = 'folders'`), 1, "every other space is weekly");
  assert.deepEqual((await db.query(`select code from public.space_folders where space_id = $1 order by sort_order`, [space])).rows.map((r) => r.code), ["SSB", "HAL"]);
  assert.equal(await count(db, `public.cards where space_id = $1 and home_folder_id is not null and week_id is null and deleted_at is null`, [space]), 6);
  /* this world has no Week 1 of Noun Naturals, so nothing is linked */
  assert.equal(await count(db, `public.folder_cards`), 0);
  /* the card of before still lives in its week, and every row has exactly one home */
  assert.deepEqual((await db.query(`select week_id, home_folder_id, space_id from public.cards where id = $1`, [card])).rows[0], { week_id: week, home_folder_id: null, space_id: noun });
  assert.equal(await count(db, `public.cards where num_nonnulls(week_id, home_folder_id) <> 1`), 0);
  /* the two people given Noun Naturals open the new space; the person with no space does not */
  const holders = (await db.query(`select profile_id from public.person_spaces where space_id = $1 and deleted_at is null`, [space])).rows.map((r) => r.profile_id);
  assert.deepEqual(sorted(holders), sorted([strat, viewer]));
  assert.equal((await rowsAs(db, viewer, `select id from public.space_folders`)).length, 2);
  assert.deepEqual(await rowsAs(db, keeper, `select id from public.space_folders`), []);
});

test("a Strategist/Editor adds a space as themself and opens it; a Viewer is refused", async () => {
  const { db, strat, viewer } = await w();
  const id = await oneAs(db, strat, `insert into public.spaces (slug, name, short_name, sort_order) values ('ugc-lab', 'UGC lab', 'UGC lab', 9) returning id`);
  assert.ok(id);
  assert.equal(await one(db, `select created_by from public.spaces where id = $1`, [id]), strat);
  assert.deepEqual(await rowsAs(db, strat, `select id from public.spaces where id = $1`, [id]), [{ id }], "and opens it");
  await assert.rejects(oneAs(db, viewer, `insert into public.spaces (slug, name, short_name, sort_order) values ('nope', 'Nope', 'Nope', 9) returning id`), RLS);
  assert.equal(await count(db, `public.spaces where slug = 'nope'`), 0);
  /* a twin name is now refused by the lock */
  await assert.rejects(oneAs(db, strat, `insert into public.spaces (slug, name, short_name, sort_order) values ('ugc-lab-2', ' ugc LAB ', 'x', 9) returning id`), /duplicate key|spaces_live_name_key/);
});

test("the custom role's person adds a space and opens only that one", async () => {
  const { db, keeper } = await w();
  /* as createSpace sends it (src/lib/content/space-actions.ts): the id made in code, nothing read back in the insert,
     since a RETURNING is judged by the select rule before the database gives the creator the space */
  const id = randomUUID();
  await as(db, keeper, (tx) => tx.query(`insert into public.spaces (id, slug, name, short_name, sort_order) values ($1, 'keeper', 'Keeper', 'Keeper', 9)`, [id]));
  assert.deepEqual(await rowsAs(db, keeper, `select slug from public.spaces where deleted_at is null order by slug`), [{ slug: "keeper" }]);
  assert.equal(await count(db, `public.person_spaces where space_id = $1 and profile_id = $2 and deleted_at is null`, [id, keeper]), 1);
});
