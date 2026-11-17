/* Behavior tests for Additional content, a space of folders: the DRAFT
   supabase/drafts/20261123000000_additional_content.sql, which becomes
   supabase/migrations/20261123000000_additional_content.sql on its own push once the owner approves it (after
   Upload/Files, 20261122000000_files_and_reader.sql). While it is a draft the suite loads it after every live migration
   and after the Upload/Files draft; once it is live, the live file (found by the end of its name).

   The world before it holds what the live project holds: people, Noun Naturals Week 1 with a few rows named SSB/0NN
   (a fixture: the live week has 15) and one other row. Then the file runs the way Supabase runs a migration, with
   nobody signed in.

   What is proven: the seeds (space, access copied from Noun Naturals, two folders, six Halloween rows, the links),
   that the seeds twice change nothing, a row lives in a week or a folder (never both, never neither), the space of a
   folder row, its free day, who sees and changes folders and links, that a folder with rows cannot be removed, that a
   week in the Trash keeps its links, the Drive folder of a folder, the reader's candidates, and no hard delete.
   Nothing here touches the live Supabase project. Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, applyMigration, signUp, as, rowsAs, oneAs, one, oneSpaceStrategist, FILES_READER, ADDITIONAL_CONTENT } from "./helpers.mjs";

const LIVE = ADDITIONAL_CONTENT.live;
const MIG = ADDITIONAL_CONTENT.file.slice(0, 14);
const SQL = readFileSync(ADDITIONAL_CONTENT.path, "utf8");
/** The seeds alone (section 10 to the end of the file): what may run twice. */
const SEEDS = SQL.slice(SQL.indexOf("-- 10. Seeds"));
/** The world just before the file: every live migration, and Upload/Files (its draft while that one waits). */
const before = () => freshDb(LIVE ? { before: MIG } : FILES_READER.live ? {} : { extra: [FILES_READER.path] });
const run = (db) => (LIVE ? applyMigration(db, MIG) : db.exec(SQL));

const RLS = /row-level security/;
const UNIQUE = /duplicate key|unique constraint/;
const NO_TABLE = /permission denied for table/;
const NO_FUNCTION = /permission denied for function/;
const count = (db, sql, params = []) => one(db, `select count(*)::int from ${sql}`, params);

async function people(db) {
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("daryna@agency.test", "strategist");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("outsider@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "daryna@agency.test", "Daryna"); // Strategist/Editor: plans, opens every space
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer"); // reads; given Noun Naturals before the file runs
  const outsider = await signUp(db, "outsider@agency.test", "Taras"); // plans, but opens only Additional content (given after)
  return { owner, admin, strat, viewer, outsider };
}

/** Week 1 of Noun Naturals as on the live project (in small), then the file. `ssb`: the SSB rows of the fixture. */
async function world({ week1 = true, ssb = ["SSB/016 Beach waves", "SSB/001 What is sea salt spray", "SSB/002 Damp or dry"] } = {}) {
  const db = await before();
  const p = await people(db);
  await oneSpaceStrategist(db, p.owner, "Outsider", [], p.outsider);
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, p.owner, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p.viewer, noun]));
  let week = null;
  const ssbCards = [];
  let other = null;
  if (week1) {
    week = await oneAs(db, p.admin, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-02') returning id`, [noun]);
    const add = (title) => oneAs(db, p.admin, `insert into public.cards (week_id, title, planned_on) values ($1, $2, '2026-11-03') returning id`, [week, title]);
    for (const title of ssb) ssbCards.push(await add(title));
    other = await add("Patchouli bar restock");
  }
  await run(db);
  const space = await one(db, `select id from public.spaces where slug = 'additional'`);
  const folder = (slug) => one(db, `select id from public.space_folders where space_id = $1 and slug = $2`, [space, slug]);
  const w = { db, ...p, noun, founder, week, ssbCards, other, space, ssb: await folder("sea-salt-spray-batch"), hal: await folder("halloween-special") };
  await as(db, p.owner, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p.outsider, space]));
  return w;
}

const addFolder = (w, who, { space = w.space, slug = "ugc-extras", name = "UGC extras", code = "UGC" } = {}) =>
  oneAs(w.db, who, `insert into public.space_folders (space_id, slug, name, code) values ($1, $2, $3, $4) returning id`, [space, slug, name, code]);
const addFolderCard = (w, who, folder, title, more = {}) =>
  oneAs(w.db, who, `insert into public.cards (home_folder_id, title, planned_on, space_id) values ($1, $2, $3, $4) returning id`, [folder, title, more.day ?? null, more.space ?? null]);
const link = (w, who, folder, card) =>
  oneAs(w.db, who, `insert into public.folder_cards (folder_id, card_id) values ($1, $2) returning id`, [folder, card]);
const removeFolder = (w, who, folder) =>
  rowsAs(w.db, who, `update public.space_folders set deleted_at = now() where id = $1 and deleted_at is null returning id`, [folder]);

/* ---------- shape and seeds ---------- */

test("it stops with a clear error when Upload/Files has not run", { skip: LIVE || FILES_READER.live }, async () => {
  const db = await freshDb();
  await assert.rejects(db.exec(SQL), /runs after Upload\/Files/);
});

test("spaces have a kind: the first two are weekly, Additional content is a space of folders", async () => {
  const w = await world();
  const rows = (await w.db.query(`select slug, name, short_name, kind, deleted_at from public.spaces order by sort_order, slug`)).rows;
  assert.deepEqual(rows.map((r) => [r.slug, r.kind]), [["noun", "weekly"], ["founder", "weekly"], ["additional", "folders"]]);
  assert.deepEqual(rows[2], { slug: "additional", name: "Additional content", short_name: "Additional", kind: "folders", deleted_at: null });
  await assert.rejects(w.db.exec(`update public.spaces set kind = 'monthly' where slug = 'noun'`), /check constraint/);
});

test("everyone who opens Noun Naturals content opens the new space; nobody else gets a row", async () => {
  const w = await world();
  const rows = (await w.db.query(`select profile_id, granted_by from public.person_spaces where space_id = $1 and deleted_at is null and profile_id <> $2`, [w.space, w.outsider])).rows;
  assert.deepEqual(rows, [{ profile_id: w.viewer, granted_by: null }]);
  assert.deepEqual(await rowsAs(w.db, w.viewer, `select slug from public.spaces where deleted_at is null order by slug`), [{ slug: "additional" }, { slug: "noun" }]);
});

test("the two folders, the six Halloween rows with both cuts, the No music label", async () => {
  const w = await world();
  const folders = (await w.db.query(`select slug, name, code, sort_order, created_by, deleted_at from public.space_folders where space_id = $1 order by sort_order`, [w.space])).rows;
  assert.deepEqual(folders, [
    { slug: "sea-salt-spray-batch", name: "Sea salt spray batch", code: "SSB", sort_order: 1, created_by: null, deleted_at: null },
    { slug: "halloween-special", name: "Halloween special", code: "HAL", sort_order: 2, created_by: null, deleted_at: null },
  ]);
  const cards = (await w.db.query(
    `select c.title, c.sort_order, c.week_id, c.space_id, c.source, c.planned_on, s.key as status, c.extra
       from public.cards c join public.card_statuses s on s.id = c.status_id where c.home_folder_id = $1 order by c.sort_order`, [w.hal])).rows;
  assert.deepEqual(cards.map((c) => c.title), ["Trick or Shampoo", "Candy or Shampoo", "Giving Away Shampoo", "Halloween Giveaway", "Treats and Free Shampoo", "Candy AND Shampoo"]);
  for (const [i, c] of cards.entries()) {
    assert.deepEqual({ ...c, title: null }, {
      title: null, sort_order: i + 1, week_id: null, space_id: w.space, source: "notion_import", planned_on: null, status: "review",
      extra: { "Edited video": "https://f.io/mNs2JX-8", "Edited video (no music)": "https://f.io/mNs2JX-8" },
    });
  }
  assert.equal(await count(w.db, `public.cards where home_folder_id = $1`, [w.ssb]), 0, "the Sea salt rows are links, not copies");
  assert.deepEqual((await w.db.query(`select key, label from public.variant_kinds where key = 'no_music'`)).rows, [{ key: "no_music", label: "No music cut" }]);
});

test("every Week 1 row named SSB/0NN is linked into the Sea salt folder, in title order; other rows are not", async () => {
  const w = await world();
  const links = (await w.db.query(
    `select c.title, l.sort_order, l.added_by, c.week_id, c.space_id from public.folder_cards l join public.cards c on c.id = l.card_id
      where l.folder_id = $1 and l.deleted_at is null order by l.sort_order`, [w.ssb])).rows;
  assert.deepEqual(links.map((l) => [l.title, l.sort_order]), [["SSB/001 What is sea salt spray", 1], ["SSB/002 Damp or dry", 2], ["SSB/016 Beach waves", 3]]);
  for (const l of links) assert.deepEqual([l.added_by, l.week_id, l.space_id], [null, w.week, w.noun], "the row stays in Noun Naturals, Week 1");
  assert.equal(await count(w.db, `public.folder_cards`), 3);
});

test("a database without that week gets the space, the folders and the six rows, and no link", async () => {
  const w = await world({ week1: false });
  assert.equal(await count(w.db, `public.space_folders`), 2);
  assert.equal(await count(w.db, `public.cards where home_folder_id = $1`, [w.hal]), 6);
  assert.equal(await count(w.db, `public.folder_cards`), 0);
});

test("with the week but not one SSB row, the file stops instead of leaving the folder empty", async () => {
  await assert.rejects(world({ ssb: [] }), /no row named SSB\/0NN/);
});

test("two live weeks numbered 1 in Noun Naturals: the SSB rows of both are linked, and a row already linked stays as it is", async () => {
  const db = await before();
  const p = await people(db);
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const addWeek = (slug, start) => oneAs(db, p.admin, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, $2, 'Week 1', 1, $3) returning id`, [noun, slug, start]);
  const add = (week, title) => oneAs(db, p.admin, `insert into public.cards (week_id, title) values ($1, $2) returning id`, [week, title]);
  const first = await addWeek("week-1", "2026-11-02");
  const second = await addWeek("week-1-2", "2026-11-09");
  const a1 = await add(first, "SSB/001 What is sea salt spray");
  const a3 = await add(first, "SSB/003 Three ways");
  await add(first, "Patchouli bar restock");
  const b2 = await add(second, "SSB/002 Damp or dry");
  await add(second, "Founder story");
  await run(db);
  const ssb = await one(db, `select id from public.space_folders where slug = 'sea-salt-spray-batch'`);
  const links = async () => (await db.query(`select card_id, sort_order, deleted_at is null as live from public.folder_cards where folder_id = $1 order by sort_order`, [ssb])).rows;
  assert.deepEqual(await links(), [{ card_id: a1, sort_order: 1, live: true }, { card_id: b2, sort_order: 2, live: true }, { card_id: a3, sort_order: 3, live: true }]);
  /* a link unlinked by hand stays unlinked, the others stay as they are, and a new SSB row in either week joins after them */
  await as(db, p.admin, (tx) => tx.query(`update public.folder_cards set deleted_at = now() where card_id = $1`, [b2]));
  const b4 = await add(second, "SSB/004 Beach waves");
  await db.exec(SEEDS);
  assert.deepEqual(await links(), [{ card_id: a1, sort_order: 1, live: true }, { card_id: b2, sort_order: 2, live: false }, { card_id: a3, sort_order: 3, live: true }, { card_id: b4, sort_order: 4, live: true }]);
});

test("two live weeks numbered 1 and not one SSB row in either: the file stops", async () => {
  const db = await before();
  const p = await people(db);
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  for (const [slug, start] of [["week-1", "2026-11-02"], ["week-1-2", "2026-11-09"]]) {
    const week = await oneAs(db, p.admin, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, $2, 'Week 1', 1, $3) returning id`, [noun, slug, start]);
    await oneAs(db, p.admin, `insert into public.cards (week_id, title) values ($1, 'Patchouli bar restock') returning id`, [week]);
  }
  await assert.rejects(run(db), /no row named SSB\/0NN/);
});

test("running the seeds twice changes nothing", async () => {
  const w = await world();
  const snapshot = async () => ({
    spaces: await count(w.db, `public.spaces`),
    access: await count(w.db, `public.person_spaces`),
    folders: await count(w.db, `public.space_folders`),
    cards: await count(w.db, `public.cards`),
    links: await count(w.db, `public.folder_cards`),
    kinds: await count(w.db, `public.variant_kinds`),
    audit: await count(w.db, `public.audit_log`),
    stamps: await one(w.db, `select max(updated_at)::text from public.cards`),
  });
  const first = await snapshot();
  assert.deepEqual([first.folders, first.links], [2, 3]);
  await w.db.exec(SEEDS);
  await w.db.exec(SEEDS);
  assert.deepEqual(await snapshot(), first);
  /* a row someone removed by hand does not come back either */
  await as(w.db, w.admin, (tx) => tx.query(`update public.cards set deleted_at = now() where home_folder_id = $1 and title = 'Candy or Shampoo'`, [w.hal]));
  await as(w.db, w.admin, (tx) => tx.query(`update public.folder_cards set deleted_at = now() where card_id = $1`, [w.ssbCards[0]]));
  await w.db.exec(SEEDS);
  assert.equal(await count(w.db, `public.cards where home_folder_id = $1`, [w.hal]), 6);
  assert.equal(await count(w.db, `public.folder_cards where deleted_at is null`), 2);
});

test("both new tables: row level security, no hard delete, no truncate, updated_at, the audit trail, realtime, no delete right", async () => {
  const w = await world();
  for (const t of ["space_folders", "folder_cards"]) {
    assert.equal(await one(w.db, `select relrowsecurity from pg_class where oid = 'public.${t}'::regclass`), true, t);
    const triggers = (await w.db.query(`select tgname from pg_trigger where tgrelid = 'public.${t}'::regclass and not tgisinternal order by 1`)).rows.map((r) => r.tgname);
    for (const name of ["no_hard_delete", "no_truncate", "z_set_updated_at", "zz_audit"]) assert.ok(triggers.includes(name), `${t} ${name}`);
    const rights = (await w.db.query(
      `select grantee, string_agg(privilege_type, ',' order by privilege_type) as p from information_schema.role_table_grants
        where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') group by 1 order by 1`, [t])).rows;
    assert.deepEqual(rights, [{ grantee: "authenticated", p: "INSERT,SELECT,UPDATE" }, { grantee: "service_role", p: "INSERT,SELECT,UPDATE" }], t);
    assert.equal(await count(w.db, `pg_publication_tables where pubname = 'supabase_realtime' and tablename = $1`, [t]), 1, t);
    await assert.rejects(rowsAs(w.db, w.owner, `delete from public.${t}`), NO_TABLE);
    await assert.rejects(rowsAs(w.db, "service", `delete from public.${t}`), NO_TABLE);
    await assert.rejects(rowsAs(w.db, "anon", `select 1 from public.${t}`), NO_TABLE);
    await assert.rejects(w.db.exec(`delete from public.${t}`), /never hard deletes/);
    await assert.rejects(w.db.exec(`truncate public.${t} cascade`), /never hard deletes/);
  }
  await assert.rejects(w.db.exec(`delete from public.cards where home_folder_id is not null`), /never hard deletes/);
  /* the audit trail records a person's folder and link */
  const folder = await addFolder(w, w.strat);
  const l = await link(w, w.strat, folder, w.other);
  assert.equal(await one(w.db, `select actor_id from public.audit_log where entity_table = 'space_folders' and entity_id = $1`, [folder]), w.strat);
  assert.equal(await one(w.db, `select actor_id from public.audit_log where entity_table = 'folder_cards' and entity_id = $1`, [l]), w.strat);
  for (const fn of ["guard_space_kind()", "weeks_space_kind()", "space_folders_before_write()", "space_folder_removed()", "folder_cards_before_write()"]) {
    await assert.rejects(rowsAs(w.db, w.owner, `select private.${fn}`), /permission denied|trigger functions can only be called as triggers/, fn);
  }
});

/* ---------- a row lives in a week or in a folder ---------- */

test("a row needs a week or a folder, and never both", async () => {
  const w = await world();
  await assert.rejects(oneAs(w.db, w.admin, `insert into public.cards (title, space_id) values ('Homeless', $1) returning id`, [w.space]), /needs a week or a folder/);
  await assert.rejects(oneAs(w.db, w.admin, `insert into public.cards (title, week_id, home_folder_id) values ('Two homes', $1, $2) returning id`, [w.week, w.hal]), /never both/);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set home_folder_id = $1 where id = $2 returning id`, [w.hal, w.other]), /never both/);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set week_id = null where id = $1 returning id`, [w.other]), /needs a week or a folder/);
  /* behind the trigger, the table's own check */
  assert.equal(await count(w.db, `pg_constraint where conrelid = 'public.cards'::regclass and conname = 'cards_one_home'`), 1);
  assert.equal(await count(w.db, `public.cards where num_nonnulls(week_id, home_folder_id) <> 1`), 0);
});

test("a folder row takes its space from the folder; another space is refused; its day is free", async () => {
  const w = await world();
  const card = await addFolderCard(w, w.strat, w.hal, "Pumpkin wash", { day: "2031-02-09" });
  const row = (await w.db.query(`select c.space_id, c.week_id, c.planned_on::text as day, c.created_by, s.key as status from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [card])).rows[0];
  assert.deepEqual(row, { space_id: w.space, week_id: null, day: "2031-02-09", created_by: w.strat, status: "idea" });
  await assert.rejects(addFolderCard(w, w.admin, w.hal, "Wrong space", { space: w.noun }), /folder belongs to another space/);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set space_id = $1 where id = $2 returning id`, [w.noun, card]), /folder belongs to another space/);
  /* any day, changed freely */
  assert.equal((await rowsAs(w.db, w.strat, `update public.cards set planned_on = '2026-01-01' where id = $1 returning id`, [card])).length, 1);
  /* a week row keeps its rules */
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set planned_on = '2026-12-25' where id = $1 returning id`, [w.other]), /is not in the week starting/);
  await assert.rejects(oneAs(w.db, w.admin, `insert into public.cards (week_id, space_id, title) values ($1, $2, 'x') returning id`, [w.week, w.space]), /week belongs to another space/);
  /* a week row moves into a folder of its own kind of space only with its space */
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set week_id = null, home_folder_id = $1 where id = $2 returning id`, [w.hal, w.other]), /folder belongs to another space/);
  assert.equal((await rowsAs(w.db, w.admin, `update public.cards set week_id = null, home_folder_id = $1, space_id = $2, planned_on = null where id = $3 returning id`, [w.hal, w.space, w.other])).length, 1);
});

test("what works by card works on a folder row: the Shot box, a new version, the status", async () => {
  const w = await world();
  const card = await one(w.db, `select id from public.cards where home_folder_id = $1 and title = 'Trick or Shampoo'`, [w.hal]);
  const shot = (await rowsAs(w.db, w.viewer, `select shot_by, shot_at is not null as ticked from public.set_card_shot($1, true)`, [card]))[0];
  assert.deepEqual(shot, { shot_by: w.viewer, ticked: true });
  const version = (await rowsAs(w.db, w.strat, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', 'additional/hal/trick-v1.mp4', 'trick-v1.mp4') returning number, label`, [card]))[0];
  assert.deepEqual(version, { number: 1, label: "v1" });
  assert.equal(await one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [card]), "review");
  assert.equal((await rowsAs(w.db, w.strat, `update public.cards set status_id = (select id from public.card_statuses where key = 'approved') where id = $1 returning id`, [card])).length, 1);
});

/* ---------- folders ---------- */

test("folders: a planner adds one as themself; names, addresses and codes are one per space; the space never changes", async () => {
  const w = await world();
  const folder = await addFolder(w, w.strat);
  assert.equal(await one(w.db, `select created_by from public.space_folders where id = $1`, [folder]), w.strat);
  await assert.rejects(addFolder(w, w.strat, { slug: "ugc-extras", name: "Another", code: "ANO" }), UNIQUE);
  await assert.rejects(addFolder(w, w.strat, { slug: "ugc-2", name: "  ugc EXTRAS ", code: "ANO" }), UNIQUE);
  await assert.rejects(addFolder(w, w.strat, { slug: "ugc-2", name: "Another", code: "UGC" }), UNIQUE);
  for (const code of ["u", "ugc", "UGCEX", "U1"]) await assert.rejects(addFolder(w, w.strat, { slug: "bad", name: "Bad", code }), /check constraint/, code);
  await assert.rejects(addFolder(w, w.strat, { slug: "Bad Slug", name: "Bad", code: "BAD" }), /check constraint/);
  /* rename and reorder */
  assert.equal((await rowsAs(w.db, w.strat, `update public.space_folders set name = 'UGC extra cuts', sort_order = 9 where id = $1 returning id`, [folder])).length, 1);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.space_folders set space_id = $1 where id = $2 returning id`, [w.noun, folder]), /stays in its space/);
  /* a removed folder frees its name, address and code */
  assert.equal((await removeFolder(w, w.strat, folder)).length, 1);
  assert.ok(await addFolder(w, w.strat, { slug: "ugc-extras", name: "UGC extra cuts", code: "UGC" }));
});

test("folders go in a space of folders, weeks in a weekly space, and a space keeps its kind", async () => {
  const w = await world();
  await assert.rejects(addFolder(w, w.admin, { space: w.noun }), /Folders go in a space of folders/);
  await assert.rejects(
    oneAs(w.db, w.admin, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-02') returning id`, [w.space]),
    /holds folders, not weeks/);
  await assert.rejects(rowsAs(w.db, w.owner, `update public.spaces set kind = 'weekly' where id = $1 returning id`, [w.space]), /stays what it is/);
  await assert.rejects(rowsAs(w.db, "service", `update public.spaces set kind = 'folders' where id = $1 returning id`, [w.founder]), /stays what it is/);
  /* a new space of folders, added by someone with spaces.create */
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.spaces (slug, name, short_name, kind, sort_order) values ('ugc-lab', 'UGC lab', 'UGC lab', 'folders', 9)`));
  const lab = await one(w.db, `select id from public.spaces where slug = 'ugc-lab'`);
  assert.ok(await addFolder(w, w.strat, { space: lab }));
});

test("a folder with rows cannot be removed; an empty one can, and its links go with it", async () => {
  const w = await world();
  await assert.rejects(removeFolder(w, w.admin, w.hal), /still holds videos/);
  await assert.rejects(removeFolder(w, "service", w.hal), /still holds videos/);
  assert.equal(await one(w.db, `select deleted_at from public.space_folders where id = $1`, [w.hal]), null);
  /* once its rows are removed, it goes */
  await as(w.db, w.admin, (tx) => tx.query(`update public.cards set deleted_at = now() where home_folder_id = $1`, [w.hal]));
  assert.equal((await removeFolder(w, w.admin, w.hal)).length, 1);
  /* the Sea salt folder holds only links: it goes, and its three links are marked removed, never deleted */
  assert.equal((await removeFolder(w, w.strat, w.ssb)).length, 1);
  assert.equal(await count(w.db, `public.folder_cards where folder_id = $1 and deleted_at is null`, [w.ssb]), 0);
  assert.equal(await count(w.db, `public.folder_cards where folder_id = $1`, [w.ssb]), 3);
  assert.equal(await count(w.db, `public.cards where id = any($1::uuid[]) and deleted_at is null`, [w.ssbCards]), 3, "the rows themselves stay in Week 1");
  /* nothing joins a removed folder */
  await assert.rejects(addFolderCard(w, w.admin, w.hal, "Late"), /folder was removed/);
  await assert.rejects(link(w, w.admin, w.ssb, w.other), /folder was removed/);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.folder_cards set deleted_at = null where folder_id = $1 returning id`, [w.ssb]), /folder was removed/);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set deleted_at = null where home_folder_id = $1 returning id`, [w.hal]), /folder was removed/);
});

/* ---------- links ---------- */

test("links: one live link per folder and row, fixed once made, only to a live row that does not already live there", async () => {
  const w = await world();
  const id = await link(w, w.strat, w.hal, w.other);
  assert.equal(await one(w.db, `select added_by from public.folder_cards where id = $1`, [id]), w.strat);
  await assert.rejects(link(w, w.strat, w.hal, w.other), UNIQUE);
  await assert.rejects(link(w, w.strat, w.ssb, w.ssbCards[0]), UNIQUE);
  const own = await one(w.db, `select id from public.cards where home_folder_id = $1 limit 1`, [w.hal]);
  await assert.rejects(link(w, w.strat, w.hal, own), /already lives in this folder/);
  assert.ok(await link(w, w.strat, w.ssb, own), "a row of one folder may show in another");
  await assert.rejects(rowsAs(w.db, w.strat, `update public.folder_cards set card_id = $1 where id = $2 returning id`, [w.ssbCards[0], id]), /keeps its folder and its row/);
  await assert.rejects(rowsAs(w.db, w.strat, `update public.folder_cards set folder_id = $1 where id = $2 returning id`, [w.ssb, id]), /keeps its folder and its row/);
  /* unlink, then link again */
  assert.equal((await rowsAs(w.db, w.strat, `update public.folder_cards set deleted_at = now() where id = $1 returning id`, [id])).length, 1);
  assert.ok(await link(w, w.strat, w.hal, w.other));
  /* a removed row is not linked */
  await as(w.db, w.admin, (tx) => tx.query(`update public.cards set deleted_at = now() where id = $1`, [w.ssbCards[2]]));
  await assert.rejects(link(w, w.strat, w.hal, w.ssbCards[2]), /row was removed/);
});

test("Week 1 to the Trash and back: its rows go and come back, the links stay as they are", async () => {
  const w = await world();
  const links = async () => (await w.db.query(`select id, card_id, sort_order, deleted_at, updated_at::text from public.folder_cards where folder_id = $1 order by sort_order`, [w.ssb])).rows;
  const beforeTrash = await links();
  assert.equal(beforeTrash.length, 3);
  assert.equal((await rowsAs(w.db, w.admin, `update public.weeks set deleted_at = now() where id = $1 and deleted_at is null returning id`, [w.week])).length, 1);
  assert.equal(await count(w.db, `public.cards where week_id = $1 and deleted_at is null`, [w.week]), 0);
  assert.deepEqual(await links(), beforeTrash, "in the Trash: the link rows are untouched");
  /* the folder's own rows never go with a week */
  assert.equal(await count(w.db, `public.cards where home_folder_id = $1 and deleted_at is null`, [w.hal]), 6);
  assert.equal(await count(w.db, `public.cards where home_folder_id is not null and deleted_with_week_id is not null`), 0);
  assert.equal((await rowsAs(w.db, w.admin, `update public.weeks set deleted_at = null where id = $1 and deleted_at is not null returning id`, [w.week])).length, 1);
  assert.equal(await count(w.db, `public.cards where week_id = $1 and deleted_at is null`, [w.week]), 4);
  assert.deepEqual(await links(), beforeTrash, "and back: still the same three links");
  /* a folder row cannot be given a Trash mark by hand */
  await assert.rejects(rowsAs(w.db, w.admin, `update public.cards set deleted_with_week_id = $1 where home_folder_id = $2 returning id`, [w.week, w.hal]), /only with its week/);
});

/* ---------- who sees and changes what ---------- */

test("a person without Noun Naturals sees the Sea salt folder but none of its rows; the Halloween rows are theirs to see", async () => {
  const w = await world();
  const seen = (sql, params) => rowsAs(w.db, w.outsider, sql, params);
  assert.deepEqual(await seen(`select slug from public.spaces where deleted_at is null`), [{ slug: "additional" }]);
  assert.deepEqual((await seen(`select code from public.space_folders order by sort_order`)).map((r) => r.code), ["SSB", "HAL"]);
  assert.deepEqual(await seen(`select id from public.folder_cards where folder_id = $1`, [w.ssb]), [], "the links to Week 1 rows are hidden");
  assert.deepEqual(await seen(`select id from public.cards where id = any($1::uuid[])`, [w.ssbCards]), []);
  assert.equal((await seen(`select id from public.cards where home_folder_id = $1`, [w.hal])).length, 6);
  /* they plan in their own space, and cannot link a row they cannot see */
  assert.ok(await addFolderCard(w, w.outsider, w.hal, "Costume wash day"));
  await assert.rejects(link(w, w.outsider, w.hal, w.other), RLS);
  /* a link between two things they do see is theirs to add and to see */
  const own = await one(w.db, `select id from public.cards where home_folder_id = $1 limit 1`, [w.hal]);
  const mine = await link(w, w.outsider, w.ssb, own);
  assert.deepEqual(await seen(`select id from public.folder_cards where folder_id = $1`, [w.ssb]), [{ id: mine }]);
  /* someone who opens both spaces sees all of it */
  assert.equal((await rowsAs(w.db, w.viewer, `select id from public.folder_cards where folder_id = $1`, [w.ssb])).length, 4);
  assert.equal((await rowsAs(w.db, w.strat, `select id from public.folder_cards where folder_id = $1`, [w.ssb])).length, 4);
});

test("only planners change folders and links, and only in a space they open", async () => {
  const w = await world();
  /* a Viewer reads */
  await assert.rejects(addFolder(w, w.viewer), RLS);
  await assert.rejects(link(w, w.viewer, w.hal, w.other), RLS);
  await assert.rejects(addFolderCard(w, w.viewer, w.hal, "Nope"), RLS);
  assert.deepEqual(await rowsAs(w.db, w.viewer, `update public.space_folders set name = 'Nope' where id = $1 returning id`, [w.hal]), []);
  assert.deepEqual(await rowsAs(w.db, w.viewer, `update public.folder_cards set deleted_at = now() where folder_id = $1 returning id`, [w.ssb]), []);
  /* a planner without the space: a second space of folders the outsider was not given */
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.spaces (slug, name, short_name, kind, sort_order) values ('vault', 'Vault', 'Vault', 'folders', 9)`));
  const vault = await one(w.db, `select id from public.spaces where slug = 'vault'`);
  const closed = await addFolder(w, w.admin, { space: vault, slug: "closed", name: "Closed", code: "CLO" });
  await assert.rejects(addFolder(w, w.outsider, { space: vault, slug: "mine", name: "Mine", code: "MIN" }), RLS);
  assert.deepEqual(await rowsAs(w.db, w.outsider, `select id from public.space_folders where id = $1`, [closed]), []);
  assert.deepEqual(await rowsAs(w.db, w.outsider, `update public.space_folders set name = 'Mine' where id = $1 returning id`, [closed]), []);
  const own = await one(w.db, `select id from public.cards where home_folder_id = $1 limit 1`, [w.hal]);
  await assert.rejects(link(w, w.outsider, closed, own), RLS);
  /* a person never let in sees nothing */
  const pending = await signUp(w.db, "nobody@elsewhere.test", "Nobody");
  assert.deepEqual(await rowsAs(w.db, pending, `select id from public.space_folders`), []);
  assert.deepEqual(await rowsAs(w.db, pending, `select id from public.folder_cards`), []);
});

/* ---------- Drive and the reader ---------- */

test("Drive: a folder's own Drive folder names its folder and its space, one live per folder", async () => {
  const w = await world();
  const add = (who, driveId, folder = w.hal, space = w.space) =>
    oneAs(w.db, who, `insert into public.drive_folders (drive_folder_id, purpose, space_id, folder_id, name) values ($1, 'folder', $2, $3, 'Halloween special') returning id`, [driveId, space, folder]);
  const id = await add(w.strat, "drive-hal");
  assert.ok(id);
  await assert.rejects(add("service", "drive-hal-2"), UNIQUE);
  await assert.rejects(add("service", "drive-none", null), /drive_folders_folder_folder/);
  await assert.rejects(add("service", "drive-nospace", w.ssb, null), /drive_folders_folder_folder/);
  assert.ok(await add("service", "drive-ssb", w.ssb));
  /* seen by who opens the space; a removed record frees the place */
  assert.equal((await rowsAs(w.db, w.outsider, `select id from public.drive_folders where folder_id is not null`)).length, 2);
  await as(w.db, w.strat, (tx) => tx.query(`update public.drive_folders set deleted_at = now() where id = $1`, [id]));
  assert.ok(await add("service", "drive-hal-2"));
  /* the kinds from before are all still allowed */
  assert.ok(await oneAs(w.db, "service", `insert into public.drive_folders (drive_folder_id, purpose, space_id, name) values ('drive-team', 'team', $1, 'Team') returning id`, [w.space]));
});

test("the reader's candidates include rows that live in a folder; signed in people are refused", async () => {
  const w = await world();
  const clip = await oneAs(w.db, "service",
    `insert into public.raw_clips (space_id, drive_file_id, drive_folder_id, file_name, mime_type) values ($1, 'file-1', 'folder-new-uploads', 'trick or shampoo.mov', 'video/quicktime') returning id`, [w.space]);
  const rows = await rowsAs(w.db, "service", `select card_id, title, week_id, week_name, week_number from public.clip_card_candidates($1)`, [clip]);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].title, "Trick or Shampoo", "the file's name finds its row");
  for (const r of rows) assert.deepEqual([r.week_id, r.week_name, r.week_number], [null, "Halloween special", null]);
  /* a week row still comes back with its week */
  const nounClip = await oneAs(w.db, "service",
    `insert into public.raw_clips (space_id, drive_file_id, drive_folder_id, file_name, mime_type) values ($1, 'file-2', 'folder-new-uploads', 'IMG_2.MOV', 'video/quicktime') returning id`, [w.noun]);
  const weekRows = await rowsAs(w.db, "service", `select week_id, week_name, week_number from public.clip_card_candidates($1)`, [nounClip]);
  assert.equal(weekRows.length, 4);
  for (const r of weekRows) assert.deepEqual(r, { week_id: w.week, week_name: "Week 1", week_number: 1 });
  await assert.rejects(rowsAs(w.db, w.owner, `select * from public.clip_card_candidates($1)`, [clip]), NO_FUNCTION);
});
