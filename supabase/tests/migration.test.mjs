/* Behavior tests for the Noun ART database migration, run on a throwaway in memory Postgres (PGlite).
   Each test builds its own fresh database, so tests never depend on each other.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one, narrowEditor, oneSpaceStrategist, MIGRATION_PATH, FILES_READER, ADDITIONAL_CONTENT, SEEDED_SPACES, SEEDED_CARDS } from "./helpers.mjs";

const RLS = /row-level security/;
const DENIED = /permission denied/;
/* Refused by the posts trigger (it runs before the row level security check) or by the policy itself. */
const NO_CHANNEL = /posting permission|row-level security/;

/* ---------- a small world: people, spaces, weeks, cards, clips, accounts ---------- */

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = async (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("strat@nounnaturals.com", "strategist");
  await invite("olena@agency.test", "editor");
  await invite("dmytro@agency.test", "editor");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("planner@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "strat@nounnaturals.com", "Strat"); // the prebuilt Strategist/Editor: opens every space (spaces.all)
  const editor = await signUp(db, "olena@agency.test", "Olena"); // Noun Naturals only
  const editor2 = await signUp(db, "dmytro@agency.test", "Dmytro"); // Founder only
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer"); // Noun Naturals only
  const planner = await signUp(db, "planner@agency.test", "Planner"); // Strategist/Editor's keys but spaces.all: Noun Naturals only
  // Editor was merged into Strategist/Editor (20261116000000 migration); the narrow editor persona is a custom role with the old Editor keys.
  await narrowEditor(db, owner, editor, editor2);
  await oneSpaceStrategist(db, owner, "Planner", [], planner);

  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, owner, async (tx) => {
    for (const [p, s] of [[strat, noun], [editor, noun], [editor2, founder], [viewer, noun], [planner, noun]]) {
      await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, s]);
    }
  });

  const status = async (key) => one(db, `select id from public.card_statuses where key = $1`, [key]);
  const ids = await as(db, admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const nounWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const founderWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-16') returning id`, [founder]);
    const cardA = await q(`insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Our first shampoo did not foam', '2026-11-16', $2) returning id`, [nounWeek, editor]);
    const cardC = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Unassigned noun card', null) returning id`, [nounWeek]);
    const cardF = await q(`insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Founder story one', '2026-11-17', $2) returning id`, [founderWeek, editor2]);
    const nounBatch = await q(`insert into public.upload_batches (space_id, day, device) values ($1, '2026-11-18', 'iPhone') returning id`, [noun]);
    const founderBatch = await q(`insert into public.upload_batches (space_id, day, device) values ($1, '2026-11-18', 'Camera card') returning id`, [founder]);
    const clipN1 = await q(`insert into public.raw_clips (upload_batch_id, drive_file_id, file_name) values ($1, 'drive-n1', 'IMG_4409.MOV') returning id`, [nounBatch]);
    const clipN2 = await q(`insert into public.raw_clips (upload_batch_id, drive_file_id, file_name) values ($1, 'drive-n2', 'IMG_4410.MOV') returning id`, [nounBatch]);
    const clipF1 = await q(`insert into public.raw_clips (upload_batch_id, drive_file_id, file_name) values ($1, 'drive-f1', 'C0001.MP4') returning id`, [founderBatch]);
    const tt1 = await q(`insert into public.social_accounts (platform_key, username) values ('tiktok', 'nounnaturals') returning id`);
    const ig1 = await q(`insert into public.social_accounts (platform_key, username) values ('instagram', 'nounnaturals') returning id`);
    return { nounWeek, founderWeek, cardA, cardC, cardF, nounBatch, founderBatch, clipN1, clipN2, clipF1, tt1, ig1 };
  });
  return { db, owner, admin, strat, editor, editor2, viewer, planner, noun, founder, status, ...ids };
}

const statusOf = (db, card) => one(db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [card]);

async function newVersion(w, who, card, key) {
  return as(w.db, who, async (tx) => (await tx.query(`insert into public.versions (card_id, r2_bucket, r2_key) values ($1, 'edits', $2) returning id`, [card, key])).rows[0].id);
}
async function approve(w, who, col, id) {
  return as(w.db, who, async (tx) => (await tx.query(`insert into public.approvals (${col}, decision) values ($1, 'approved') returning id`, [id])).rows[0].id);
}
async function schedule(w, who, { version = null, variant = null, account, approval = null }) {
  return as(w.db, who, async (tx) =>
    (await tx.query(
      `insert into public.posts (version_id, variant_id, account_id, status, scheduled_for, approval_id)
       values ($1, $2, $3, 'scheduled', now() + interval '1 day', $4) returning id, posted_without_approval, approved_by`,
      [version, variant, account, approval],
    )).rows[0]);
}

/* ---------- the migration itself ---------- */

test("the migration runs from an empty database without error, twice in two fresh databases", async () => {
  assert.match(MIGRATION_PATH, /0001_init\.sql$|_init\.sql$/);
  for (let i = 0; i < 2; i++) {
    const db = await freshDb();
    assert.equal(await one(db, `select count(*)::int from public.spaces`), SEEDED_SPACES.length);
    assert.equal(await one(db, `select count(*)::int from public.card_statuses where is_system`), 13);
    await db.close();
  }
});

test("table count and every table in public has row level security on", async () => {
  const db = await freshDb();
  // 79 from init, 2 from gmail_invites, 4 from team_access, 2 from edit_intake (edit_upload_batches, edit_match_suggestions),
  // 2 from ugc (ugc_posts, card_ugc_references; no rights table),
  // 2 from frameio_import (frameio_connections, frameio_connection_tokens),
  // and 1 from files_and_reader (raw_clip_moves), from the day that draft is live (the Meta posting draft adds none in public)
  // and 2 from additional_content (space_folders, folder_cards), from the day that draft is live
  assert.equal(await one(db, `select count(*)::int from pg_tables where schemaname = 'public'`), 91 + (FILES_READER.live ? 1 : 0) + (ADDITIONAL_CONTENT.live ? 2 : 0));
  const off = await db.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`,
  );
  assert.deepEqual(off.rows, []);
});

test("grants match the policies: anon nothing, no delete or truncate, account_tokens locked", async () => {
  const db = await freshDb();
  const tables = (await db.query(`select tablename from pg_tables where schemaname = 'public' order by 1`)).rows.map((r) => r.tablename);
  const problems = [];
  for (const t of tables) {
    for (const priv of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
      if (await one(db, `select has_table_privilege('anon', $1, $2)`, [`public.${t}`, priv])) problems.push(`anon ${priv} ${t}`);
    }
    for (const priv of ["delete", "truncate"]) {
      for (const role of ["authenticated", "service_role"]) {
        if (await one(db, `select has_table_privilege($1, $2, $3)`, [role, `public.${t}`, priv])) problems.push(`${role} ${priv} ${t}`);
      }
    }
    for (const cmd of ["select", "insert", "update"]) {
      const granted = await one(db, `select has_table_privilege('authenticated', $1, $2)`, [`public.${t}`, cmd]);
      const policy = await one(
        db,
        `select exists (select 1 from pg_policies where schemaname = 'public' and tablename = $1 and cmd = upper($2)
                        and 'authenticated' = any (roles))`,
        [t, cmd],
      );
      if (granted !== policy) problems.push(`authenticated ${cmd} ${t}: grant ${granted}, policy ${policy}`);
    }
  }
  assert.deepEqual(problems, []);
  assert.equal(await one(db, `select has_table_privilege('authenticated', 'public.account_tokens', 'select')`), false);
  assert.equal(await one(db, `select count(*)::int from pg_policies where tablename = 'account_tokens'`), 0);
  assert.equal(await one(db, `select has_function_privilege('anon', 'public.set_card_shot(uuid, boolean)', 'execute')`), false);
});

test("anon can read nothing", async () => {
  const w = await world();
  for (const t of ["cards", "spaces", "card_statuses", "profiles", "raw_clips", "posts", "platforms"]) {
    await assert.rejects(rowsAs(w.db, "anon", `select * from public.${t}`), DENIED, t);
  }
});

test("nobody can delete or truncate: app roles have no grant, the owner of the tables is stopped by the trigger", async () => {
  const w = await world();
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.cards where id = $1`, [w.cardA])), DENIED);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`delete from public.cards where id = $1`, [w.cardA])), DENIED);
  await assert.rejects(w.db.query(`delete from public.cards where id = $1`, [w.cardA]), /never hard deletes/);
  await assert.rejects(w.db.query(`delete from public.audit_log`), /never hard deletes/);
  await assert.rejects(w.db.exec(`truncate public.platforms cascade`), /never hard deletes/);
  assert.equal(await one(w.db, `select count(*)::int from public.cards`), 3 + SEEDED_CARDS);
});

/* ---------- first sign in ---------- */

test("first sign in: the seeded owner invite makes an owner; an uninvited person is pending and sees nothing", async () => {
  const w = await world();
  const me = await one(w.db, `select role || ':' || access_status from public.profiles where id = $1`, [w.owner]);
  assert.equal(me, "owner:active");
  // An invite for the old value "editor" let Olena in as Strategist/Editor; the world then gave her the narrow custom "Editor" role.
  assert.equal(await one(w.db, `select r.key from public.profile_role_changes c join public.roles r on r.id = c.to_role_id where c.profile_id = $1 order by c.id limit 1`, [w.editor]), "strategist");
  assert.equal(await one(w.db, `select coalesce(p.role::text, 'none') || ':' || r.name from public.profiles p join public.roles r on r.id = p.role_id where p.id = $1`, [w.editor]), "none:Editor");

  const stranger = await signUp(w.db, "stranger@gmail.test");
  assert.equal(await one(w.db, `select role || ':' || access_status from public.profiles where id = $1`, [stranger]), "viewer:pending");
  for (const t of ["cards", "spaces", "weeks", "card_statuses", "raw_clips", "platforms", "social_accounts", "clip_directions"]) {
    assert.equal(await oneAs(w.db, stranger, `select count(*)::int from public.${t}`), 0, t);
  }
  // A pending person sees only their own profile row.
  assert.deepEqual((await rowsAs(w.db, stranger, `select id from public.profiles`)).map((r) => r.id), [stranger]);
});

/* ---------- spaces ---------- */

test("spaces: an editor with only Noun Naturals sees no founder card, week, raw clip or direction; an admin sees both", async () => {
  const w = await world();
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.clip_directions (raw_clip_id, body) values ($1, 'Founder hook here')`, [w.clipF1]));

  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.cards where space_id = $1`, [w.founder]), 0);
  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.weeks where space_id = $1`, [w.founder]), 0);
  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.raw_clips where space_id = $1`, [w.founder]), 0);
  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.clip_directions where space_id = $1`, [w.founder]), 0);
  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.upload_batches where space_id = $1`, [w.founder]), 0);
  assert.deepEqual((await rowsAs(w.db, w.editor, `select slug from public.spaces`)).map((r) => r.slug), ["noun"]);

  assert.equal(await oneAs(w.db, w.admin, `select count(*)::int from public.cards`), 3 + SEEDED_CARDS);
  assert.equal(await oneAs(w.db, w.admin, `select count(*)::int from public.weeks`), 2);
  assert.equal(await oneAs(w.db, w.admin, `select count(*)::int from public.raw_clips`), 3);
  assert.equal(await oneAs(w.db, w.admin, `select count(*)::int from public.spaces`), SEEDED_SPACES.length);

  // A planner with only Noun Naturals (Strategist/Editor's keys but spaces.all) sees no founder card and cannot add a card there.
  assert.equal(await oneAs(w.db, w.planner, `select count(*)::int from public.cards where space_id = $1`, [w.founder]), 0);
  assert.deepEqual((await rowsAs(w.db, w.planner, `select slug from public.spaces`)).map((r) => r.slug), ["noun"]);
  await assert.rejects(
    as(w.db, w.planner, (tx) => tx.query(`insert into public.cards (week_id, title) values ($1, 'sneaky')`, [w.founderWeek])),
    RLS,
  );
  // The prebuilt Strategist/Editor opens every space (spaces.all, owner Nov 16 2026), though given only Noun Naturals.
  assert.equal(await oneAs(w.db, w.strat, `select count(*)::int from public.cards where space_id = $1`, [w.founder]), 1);
  assert.deepEqual((await rowsAs(w.db, w.strat, `select slug from public.spaces order by slug`)).map((r) => r.slug), [...SEEDED_SPACES].sort());
});

test("a card's space follows its week, and its day must be inside the week", async () => {
  const w = await world();
  assert.equal(await one(w.db, `select space_id from public.cards where id = $1`, [w.cardF]), w.founder);
  await assert.rejects(
    as(w.db, w.admin, (tx) => tx.query(`insert into public.cards (week_id, title, planned_on) values ($1, 'x', '2026-11-30')`, [w.nounWeek])),
    /not in the week/,
  );
  await assert.rejects(
    as(w.db, w.admin, (tx) => tx.query(`insert into public.cards (space_id, week_id, title) values ($1, $2, 'x')`, [w.founder, w.nounWeek])),
    /another space/,
  );
  await assert.rejects(
    as(w.db, w.admin, (tx) => tx.query(`insert into public.weeks (space_id, slug, name, starts_on) values ($1, 'week-9', 'Week 9', '2026-11-18')`, [w.noun])),
    /check constraint/,
  );
});

test("editors see every raw clip of a space they may open, but only their own cards", async () => {
  const w = await world();
  // Both noun clips were uploaded by the admin and are linked to no card of the editor.
  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.raw_clips`), 2);
  assert.deepEqual((await rowsAs(w.db, w.editor, `select id from public.cards`)).map((r) => r.id), [w.cardA]);
  // The viewer of Noun Naturals sees every noun card, read only.
  assert.equal(await oneAs(w.db, w.viewer, `select count(*)::int from public.cards`), 2);
  // An editor may upload into a space they may open, not into another.
  await as(w.db, w.editor, (tx) => tx.query(`insert into public.upload_batches (space_id, day, upload_source, device) values ($1, '2026-11-18', 'phone', 'iPhone')`, [w.noun]));
  await assert.rejects(
    as(w.db, w.editor, (tx) => tx.query(`insert into public.upload_batches (space_id, day) values ($1, '2026-11-18')`, [w.founder])),
    RLS,
  );
  // An editor cannot change cards directly.
  const r = await as(w.db, w.editor, (tx) => tx.query(`update public.cards set title = 'hacked' where id = $1`, [w.cardA]));
  assert.equal(r.affectedRows, 0);
});

/* ---------- Shot ---------- */

test("Shot: an editor ticks and unticks through the function; status stays; who and when are saved; others are refused", async () => {
  const w = await world();
  const before = await statusOf(w.db, w.cardA);
  const ticked = await oneAs(w.db, w.editor, `select to_jsonb(public.set_card_shot($1, true))`, [w.cardA]);
  assert.equal(ticked.shot_by, w.editor);
  assert.ok(ticked.shot_at);
  assert.equal(await statusOf(w.db, w.cardA), before);
  assert.equal(await one(w.db, `select action from public.audit_log where entity_table = 'cards' and entity_id = $1 order by id desc limit 1`, [w.cardA]), "shot");

  const unticked = await oneAs(w.db, w.editor, `select to_jsonb(public.set_card_shot($1, false))`, [w.cardA]);
  assert.equal(unticked.shot_by, null);
  assert.equal(unticked.shot_at, null);
  assert.equal(await statusOf(w.db, w.cardA), before);
  assert.equal(await one(w.db, `select action from public.audit_log where entity_table = 'cards' and entity_id = $1 order by id desc limit 1`, [w.cardA]), "unshot");

  // The founder editor has no Noun Naturals space: refused.
  await assert.rejects(rowsAs(w.db, w.editor2, `select public.set_card_shot($1, true)`, [w.cardA]), /cannot see that card/);
  // A pending stranger: refused.
  const stranger = await signUp(w.db, "stranger@gmail.test");
  await assert.rejects(rowsAs(w.db, stranger, `select public.set_card_shot($1, true)`, [w.cardA]), /Sign in first/);
  // Typing a fake stamp is overwritten with the real person and time.
  await as(w.db, w.strat, (tx) => tx.query(`update public.cards set shot_at = '2020-01-01', shot_by = $2 where id = $1`, [w.cardC, w.owner]));
  const stamp = (await w.db.query(`select shot_by, shot_at from public.cards where id = $1`, [w.cardC])).rows[0];
  assert.equal(stamp.shot_by, w.strat);
  assert.ok(new Date(stamp.shot_at).getFullYear() >= 2026);
});

/* ---------- statuses ---------- */

test("statuses: raw clip to shot, version to review, send to editor to edits and back, never backward otherwise", async () => {
  const w = await world();
  const planned = await w.status("planned"); // read first: PGlite has one connection, so no outside query inside a transaction
  await as(w.db, w.strat, (tx) => tx.query(`update public.cards set status_id = $2 where id = $1`, [w.cardA, planned]));
  assert.equal(await statusOf(w.db, w.cardA), "planned");

  await as(w.db, w.strat, (tx) => tx.query(`insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2)`, [w.cardA, w.clipN1]));
  assert.equal(await statusOf(w.db, w.cardA), "shot");

  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  assert.equal(await statusOf(w.db, w.cardA), "review");

  const sendNotes = async (version) => {
    await as(w.db, w.strat, (tx) => tx.query(`insert into public.review_comments (version_id, at_ms, body) values ($1, 2400, 'Tighter hook')`, [version]));
    await as(w.db, w.strat, (tx) => tx.query(`insert into public.edit_requests (version_id) values ($1)`, [version]));
  };
  await sendNotes(v1);
  assert.equal(await statusOf(w.db, w.cardA), "edits");

  const v2 = await newVersion(w, w.editor, w.cardA, "a/v2.mp4");
  assert.equal(await statusOf(w.db, w.cardA), "review");
  await sendNotes(v2);
  assert.equal(await statusOf(w.db, w.cardA), "edits");
  const v3 = await newVersion(w, w.editor, w.cardA, "a/v3.mp4");
  assert.equal(await statusOf(w.db, w.cardA), "review");

  await approve(w, w.admin, "version_id", v3);
  assert.equal(await statusOf(w.db, w.cardA), "approved");

  // Never backward: another raw clip or a new version after the approval leaves it approved.
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2)`, [w.cardA, w.clipN2]));
  assert.equal(await statusOf(w.db, w.cardA), "approved");
  await newVersion(w, w.editor, w.cardA, "a/v4.mp4");
  assert.equal(await statusOf(w.db, w.cardA), "approved");

  // Every change is logged with from and to.
  const log = await rowsAs(
    w.db,
    w.admin,
    `select f.key as "from", t.key as "to" from public.card_status_changes x
       left join public.card_statuses f on f.id = x.from_status_id join public.card_statuses t on t.id = x.to_status_id
      where x.card_id = $1 order by x.changed_at, x.id`,
    [w.cardA],
  );
  assert.ok(log.length >= 8);
  assert.equal(log.at(-1).to, "approved");
  // A raw clip cannot feed a card of another space.
  await assert.rejects(
    as(w.db, w.admin, (tx) => tx.query(`insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2)`, [w.cardA, w.clipF1])),
    /its own space/,
  );
});

test("statuses: a custom status behaves by its stage, system statuses stay, only people with calendar.setup add statuses", async () => {
  const w = await world();
  const custom = async (key, stage, sort) =>
    as(w.db, w.admin, async (tx) =>
      (await tx.query(`insert into public.card_statuses (key, label, stage, color, sort_order) values ($1, $1, $2, '#7A5CFA', $3) returning id`, [key, stage, sort])).rows[0].id);
  const grading = await custom("color_grading", "editing", 65);
  const secondLook = await custom("second_look", "review", 75);

  // On a custom Editing status, linking a raw clip (Shot, an earlier stage) does nothing; a new version moves it to review.
  await as(w.db, w.strat, (tx) => tx.query(`update public.cards set status_id = $2 where id = $1`, [w.cardA, grading]));
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.card_raw_clips (card_id, raw_clip_id) values ($1, $2)`, [w.cardA, w.clipN1]));
  assert.equal(await statusOf(w.db, w.cardA), "color_grading");
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  assert.equal(await statusOf(w.db, w.cardA), "review");

  // On a custom Review status, Send to editor moves to Needs edits, and a new version back to In review.
  await as(w.db, w.strat, (tx) => tx.query(`update public.cards set status_id = $2 where id = $1`, [w.cardA, secondLook]));
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.review_comments (version_id, body) values ($1, 'Color is off')`, [v1]));
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.edit_requests (version_id) values ($1)`, [v1]));
  assert.equal(await statusOf(w.db, w.cardA), "edits");

  // System statuses: cannot be removed, key and stage fixed; label and color may change.
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.card_statuses set deleted_at = now() where key = 'shot'`)), /cannot be removed/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.card_statuses set key = 'filmed' where key = 'shot'`)), /cannot be removed/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.card_statuses set stage = 'editing' where key = 'shot'`)), /cannot be removed/);
  await as(w.db, w.owner, (tx) => tx.query(`update public.card_statuses set label = 'Filmed', color = '#22789A' where key = 'shot'`));
  assert.equal(await one(w.db, `select label from public.card_statuses where key = 'shot'`), "Filmed");
  await assert.rejects(
    as(w.db, w.owner, (tx) => tx.query(`insert into public.card_statuses (key, label, stage, color, is_system) values ('x', 'x', 'review', 'st-review', true)`)),
    /Only the system/,
  );
  // A custom status may be removed (soft delete).
  await as(w.db, w.admin, (tx) => tx.query(`update public.card_statuses set deleted_at = now() where id = $1`, [grading]));
  // Editors and viewers cannot add statuses (no calendar.setup).
  for (const who of [w.editor, w.viewer]) {
    await assert.rejects(
      as(w.db, who, (tx) => tx.query(`insert into public.card_statuses (key, label, stage, color) values ('y', 'y', 'review', 'st-review')`)),
      RLS,
    );
  }
  // Strategist/Editor holds calendar.setup (owner, Nov 16 2026) and adds one.
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.card_statuses (key, label, stage, color) values ('y', 'y', 'review', 'st-review')`));
  assert.equal(await one(w.db, `select count(*)::int from public.card_statuses where key = 'y' and deleted_at is null`), 1);
});

/* ---------- directions on raw clips ---------- */

test("directions: a strategist writes, an editor replies, an editor cannot write one, another space sees none", async () => {
  const w = await world();
  const dir = await as(w.db, w.strat, async (tx) =>
    (await tx.query(
      `insert into public.clip_directions (raw_clip_id, at_ms, tag_key, body, body_uk, drawing)
       values ($1, 2400, 'use_this', 'Start here: the leaf in my hand.', 'Почніть звідси.', '[{"k":"circle","x1":34,"y1":26,"x2":66,"y2":52}]')
       returning id, space_id, author_id`,
      [w.clipN1],
    )).rows[0]);
  assert.equal(dir.space_id, w.noun);
  assert.equal(dir.author_id, w.strat);
  // A direction for a whole upload batch.
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.clip_directions (upload_batch_id, body) values ($1, 'Use the brighter takes')`, [w.nounBatch]));

  assert.equal(await oneAs(w.db, w.editor, `select count(*)::int from public.clip_directions`), 2);
  await as(w.db, w.editor, (tx) => tx.query(`insert into public.clip_direction_replies (direction_id, body) values ($1, 'Keep the breath before the line?')`, [dir.id]));
  assert.equal(await oneAs(w.db, w.strat, `select count(*)::int from public.clip_direction_replies where direction_id = $1`, [dir.id]), 1);

  await assert.rejects(
    as(w.db, w.editor, (tx) => tx.query(`insert into public.clip_directions (raw_clip_id, body) values ($1, 'I direct myself')`, [w.clipN1])),
    RLS,
  );
  // The founder editor sees neither the directions nor the replies, and cannot reply.
  assert.equal(await oneAs(w.db, w.editor2, `select count(*)::int from public.clip_directions`), 0);
  assert.equal(await oneAs(w.db, w.editor2, `select count(*)::int from public.clip_direction_replies`), 0);
  await assert.rejects(
    as(w.db, w.editor2, (tx) => tx.query(`insert into public.clip_direction_replies (direction_id, body) values ($1, 'hi')`, [dir.id])),
    RLS,
  );
  // A viewer of the space reads them but does not reply.
  assert.equal(await oneAs(w.db, w.viewer, `select count(*)::int from public.clip_directions`), 2);
  await assert.rejects(
    as(w.db, w.viewer, (tx) => tx.query(`insert into public.clip_direction_replies (direction_id, body) values ($1, 'hi')`, [dir.id])),
    RLS,
  );
  // A direction stays on its clip.
  await assert.rejects(
    as(w.db, w.strat, (tx) => tx.query(`update public.clip_directions set raw_clip_id = $2 where id = $1`, [dir.id, w.clipN2])),
    /stays on its clip/,
  );
});

/* ---------- posting permissions and approval before posting ---------- */

test("posting: channel permission, admin approval, the per person flag, admins, likeness, and nobody changes their own", async () => {
  const w = await world();
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");

  // (a) An editor with no channel cannot schedule, not even with an approval.
  const adminOk = await approve(w, w.admin, "version_id", v1);
  await assert.rejects(schedule(w, w.editor, { version: v1, account: w.tt1, approval: adminOk }), NO_CHANNEL);

  // The owner gives the strategist the TikTok channel.
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [w.strat, w.tt1]));
  assert.equal(await oneAs(w.db, w.strat, `select count(*)::int from public.person_posting_accounts`), 1);

  // (b) With the channel but no approval: refused.
  await assert.rejects(schedule(w, w.strat, { version: v1, account: w.tt1 }), /needs an approval/);
  // Not on a channel they were not given.
  await assert.rejects(schedule(w, w.strat, { version: v1, account: w.ig1, approval: adminOk }), NO_CHANNEL);

  // (c) With an admin approval of that exact video: scheduled, and the approver is recorded.
  const c = await schedule(w, w.strat, { version: v1, account: w.tt1, approval: adminOk });
  assert.equal(c.posted_without_approval, false);
  assert.equal(c.approved_by, w.admin);
  assert.equal(await statusOf(w.db, w.cardA), "scheduled");

  // An approval of another video does not count.
  const v2 = await newVersion(w, w.editor, w.cardA, "a/v2.mp4");
  await assert.rejects(schedule(w, w.strat, { version: v2, account: w.tt1, approval: adminOk }), /different video/);

  // (d) The owner unticks "needs admin approval" for the strategist: no approval needed, and the post says so.
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.strat]));
  const d = await schedule(w, w.strat, { version: v2, account: w.tt1 });
  assert.equal(d.posted_without_approval, true);
  assert.equal(d.approved_by, null);

  // (e) An admin schedules on any account without an approval; recorded as without approval.
  const e = await schedule(w, w.admin, { version: v2, account: w.ig1 });
  assert.equal(e.posted_without_approval, true);

  // The automatic scheduler (our server) always needs an approval.
  await assert.rejects(schedule(w, "service", { version: v2, account: w.ig1 }), /needs an approval/);
  const v2ok = await approve(w, w.admin, "version_id", v2);
  const s = await schedule(w, "service", { version: v2, account: w.ig1, approval: v2ok });
  assert.equal(s.posted_without_approval, false);

  // (f) A variant using someone's likeness needs the owner's approval, even for the admin and the unticked strategist.
  const face = await as(w.db, w.owner, async (tx) => (await tx.query(`insert into public.faces (name, consent_signed_at) values ('Khaled', now()) returning id`)).rows[0].id);
  const variant = await as(w.db, w.strat, async (tx) =>
    (await tx.query(
      `insert into public.variants (version_id, kind_key, label, what_changed, r2_bucket, r2_key) values ($1, 'avatar', 'Avatar', 'Avatar of Khaled', 'variants', 'a/avatar.mp4') returning id`,
      [v1],
    )).rows[0].id);
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.variant_faces (variant_id, face_id) values ($1, $2)`, [variant, face]));
  await assert.rejects(schedule(w, w.strat, { variant, account: w.tt1 }), /needs an approval/);
  await assert.rejects(schedule(w, w.admin, { variant, account: w.tt1 }), /needs an approval/);
  const byAdmin = await approve(w, w.admin, "variant_id", variant);
  await assert.rejects(schedule(w, w.admin, { variant, account: w.tt1, approval: byAdmin }), /likeness/);
  await assert.rejects(schedule(w, w.strat, { variant, account: w.tt1, approval: byAdmin }), /likeness/);
  const byOwner = await approve(w, w.owner, "variant_id", variant);
  const f = await schedule(w, w.strat, { variant, account: w.tt1, approval: byOwner });
  assert.equal(f.approved_by, w.owner);

  // (g) Nobody changes their own flag or their own channels or spaces.
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.profiles set needs_post_approval = true where id = $1`, [w.strat])), /your own/);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.admin])), /your own/);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [w.admin, w.tt1])), RLS);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [w.strat, w.ig1])), RLS);
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [w.editor, w.founder])), RLS);
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [w.admin, w.founder])), RLS);
  const own = await as(w.db, w.strat, (tx) => tx.query(`update public.person_posting_accounts set deleted_at = now() where profile_id = $1`, [w.strat]));
  assert.equal(own.affectedRows, 0);
  // A strategist cannot change someone else's flag either.
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.editor])).then((r) => {
    if (r.affectedRows === 0) throw new Error("no rows: refused by policy");
  }), /refused by policy|Only the owner or an admin/);
});

/* ---------- account tokens ---------- */

test("account_tokens cannot be read by anyone signed in, not even the owner", async () => {
  const w = await world();
  await as(w.db, "service", (tx) => tx.query(`insert into public.account_tokens (account_id, access_token) values ($1, 'secret')`, [w.tt1]));
  await assert.rejects(rowsAs(w.db, w.owner, `select * from public.account_tokens`), DENIED);
  await assert.rejects(rowsAs(w.db, w.admin, `select access_token from public.account_tokens`), DENIED);
  assert.equal(await oneAs(w.db, "service", `select access_token from public.account_tokens`), "secret");
});

/* ---------- audit trail ---------- */

test("the audit log gets a row for a card change and cannot be edited", async () => {
  const w = await world();
  await as(w.db, w.strat, (tx) => tx.query(`update public.cards set title = 'What makes our shampoo foam' where id = $1`, [w.cardC]));
  const row = (await rowsAs(
    w.db,
    w.admin,
    `select id, actor_type, actor_id, action, changed_fields from public.audit_log
      where entity_table = 'cards' and entity_id = $1 order by id desc limit 1`,
    [w.cardC],
  ))[0];
  assert.equal(row.actor_type, "person");
  assert.equal(row.actor_id, w.strat);
  assert.equal(row.action, "update");
  assert.deepEqual(row.changed_fields, ["title"]);
  // Editors and strategists do not read the audit trail.
  assert.equal(await oneAs(w.db, w.strat, `select count(*)::int from public.audit_log`), 0);
  // Nobody edits it: not the app, not our server, not the table owner.
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.audit_log set action = 'x' where id = $1`, [row.id])), DENIED);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.audit_log set action = 'x' where id = $1`, [row.id])), DENIED);
  await assert.rejects(w.db.query(`update public.audit_log set action = 'x' where id = $1`, [row.id]), /append only/);
});

/* ---------- imports and to do lists ---------- */

test("imports and to do items belong to a space; who ticked a to do is saved", async () => {
  const w = await world();
  const batch = await as(w.db, w.strat, async (tx) =>
    (await tx.query(
      `insert into public.import_batches (week_id, source_kind, file_name, row_count, column_matches)
       values ($1, 'csv', 'week3.csv', 1, '[{"column":"Name","to":"title"}]') returning id, space_id, imported_by`,
      [w.nounWeek],
    )).rows[0]);
  assert.equal(batch.space_id, w.noun);
  assert.equal(batch.imported_by, w.strat);
  await as(w.db, w.strat, (tx) =>
    tx.query(
      `insert into public.cards (week_id, title, source, import_batch_id, import_row, extra, script_sections)
       values ($1, 'Imported row', 'csv_import', $2, 0, '{"Mood":"calm"}', '[{"heading":"Hook","text":"..."}]')`,
      [w.nounWeek, batch.id],
    ));
  // a planner who does not open Founder cannot import there (the prebuilt Strategist/Editor opens every space)
  await assert.rejects(
    as(w.db, w.planner, (tx) => tx.query(`insert into public.import_batches (week_id, source_kind) values ($1, 'csv')`, [w.founderWeek])),
    RLS,
  );
  const todo = await as(w.db, w.strat, async (tx) =>
    (await tx.query(`insert into public.space_todos (space_id, task) values ($1, 'Book the barber shop') returning id`, [w.noun])).rows[0].id);
  await as(w.db, w.strat, (tx) => tx.query(`update public.space_todos set done_at = now(), done_by = $2 where id = $1`, [todo, w.owner]));
  assert.equal(await one(w.db, `select done_by from public.space_todos where id = $1`, [todo]), w.strat);
  assert.equal(await oneAs(w.db, w.editor2, `select count(*)::int from public.space_todos`), 0);
});

/* ---------- review fixes (Nov 15 2026): one test per finding ---------- */

const FIXED = /fixed once saved/;
const SYSTEM = /Only the system/;

async function strategistWithChannel(w, { flag = true } = {}) {
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [w.strat, w.tt1]));
  if (!flag) await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.strat]));
}
const setPost = (w, who, post, sql, params = []) => as(w.db, who, (tx) => tx.query(`update public.posts set ${sql} where id = $1`, [post, ...params]));

test("1. the file of a video is fixed at insert, for everyone; measured facts are the server's", async () => {
  const w = await world();
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  await approve(w, w.admin, "version_id", v1);
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`update public.versions set r2_key = 'a/other.mp4' where id = $1`, [v1])), FIXED);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.versions set r2_bucket = 'x' where id = $1`, [v1])), FIXED);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.versions set r2_key = 'a/other.mp4' where id = $1`, [v1])), FIXED);
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`update public.versions set duration_ms = 1 where id = $1`, [v1])), SYSTEM);
  await as(w.db, "service", (tx) => tx.query(`update public.versions set duration_ms = 31000, size_bytes = 9000000 where id = $1`, [v1]));
  await as(w.db, w.editor, (tx) => tx.query(`update public.versions set editor_note = 'Shorter intro' where id = $1`, [v1]));
  assert.equal(await one(w.db, `select duration_ms from public.versions where id = $1`, [v1]), 31000);

  const variant = await as(w.db, w.strat, async (tx) =>
    (await tx.query(`insert into public.variants (version_id, kind_key, label, what_changed, r2_bucket, r2_key) values ($1, 'new_hook', 'Hook 2', 'New hook', 'variants', 'a/h2.mp4') returning id`, [v1])).rows[0].id);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.variants set r2_key = 'a/swap.mp4' where id = $1`, [variant])), FIXED);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.variants set r2_bucket = 'other' where id = $1`, [variant])), FIXED);

  const output = await as(w.db, "service", async (tx) => {
    const g = (await tx.query(`insert into public.ai_generations (mode, requested_by, provider_key, model_key) values ('video', $1, 'higgsfield', 'soul') returning id`, [w.strat])).rows[0].id;
    return (await tx.query(`insert into public.ai_generation_outputs (generation_id, r2_bucket, r2_key) values ($1, 'gen', 'g/1.mp4') returning id`, [g])).rows[0].id;
  });
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.ai_generation_outputs set r2_key = 'g/2.mp4' where id = $1`, [output])), FIXED);
  await as(w.db, "service", (tx) => tx.query(`update public.ai_generation_outputs set virality_score = 71 where id = $1`, [output]));

  // A raw clip's Drive file is fixed too.
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.raw_clips set drive_file_id = 'other' where id = $1`, [w.clipN1])), FIXED);
});

test("2. a revoked approval or a removed channel stops a post that is already scheduled", async () => {
  const w = await world();
  await strategistWithChannel(w);
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const ok = await approve(w, w.admin, "version_id", v1);
  const post = await schedule(w, w.strat, { version: v1, account: w.tt1, approval: ok });
  await as(w.db, w.owner, (tx) => tx.query(`update public.approvals set revoked_at = now() where id = $1`, [ok]));
  await assert.rejects(setPost(w, "service", post.id, `status = 'posting'`), /live approval/);
  assert.equal(await one(w.db, `select status::text from public.posts where id = $1`, [post.id]), "scheduled");

  // Unticked person, no approval needed, but the owner takes the channel away before it goes out.
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.strat]));
  const p2 = await schedule(w, w.strat, { version: v1, account: w.tt1 });
  await as(w.db, w.owner, (tx) => tx.query(`update public.person_posting_accounts set deleted_at = now() where profile_id = $1`, [w.strat]));
  await assert.rejects(setPost(w, "service", p2.id, `status = 'posting'`), /posting permission/);
});

test("3. the scheduler retries a post judged by the person who scheduled it", async () => {
  const w = await world();
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const p = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  assert.equal(p.posted_without_approval, true);
  await setPost(w, "service", p.id, `status = 'posting'`);
  await setPost(w, "service", p.id, `status = 'failed', failed_reason = 'timeout', attempt_count = 1`);
  await setPost(w, "service", p.id, `status = 'scheduled'`);
  const row = (await w.db.query(`select status::text, scheduled_by, posted_without_approval from public.posts where id = $1`, [p.id])).rows[0];
  assert.deepEqual(row, { status: "scheduled", scheduled_by: w.owner, posted_without_approval: true });

  // A strategist with the box ticked: the retry needs the approval, which is there.
  await strategistWithChannel(w);
  const ok = await approve(w, w.admin, "version_id", v1);
  const p2 = await schedule(w, w.strat, { version: v1, account: w.tt1, approval: ok });
  await setPost(w, "service", p2.id, `status = 'failed'`);
  await setPost(w, "service", p2.id, `status = 'scheduled'`);
  // A post nobody scheduled always needs the approval.
  await assert.rejects(schedule(w, "service", { version: v1, account: w.tt1 }), /needs an approval/);
});

test("4. who scheduled and approved a post, and 'without approval', cannot be forged", async () => {
  const w = await world();
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const row = await as(w.db, w.admin, async (tx) =>
    (await tx.query(
      `insert into public.posts (version_id, account_id, status, scheduled_for, approved_by, posted_without_approval, scheduled_by, scheduled_at)
       values ($1, $2, 'scheduled', now() + interval '1 day', $3, false, $4, '2020-01-01') returning id, approved_by, posted_without_approval, scheduled_by, scheduled_at`,
      [v1, w.tt1, w.owner, w.strat],
    )).rows[0]);
  assert.equal(row.approved_by, null);
  assert.equal(row.posted_without_approval, true);
  assert.equal(row.scheduled_by, w.admin);
  assert.ok(new Date(row.scheduled_at).getFullYear() >= 2026);
  await setPost(w, w.admin, row.id, `approved_by = $2, posted_without_approval = false, scheduled_by = $2, caption = 'hi'`, [w.owner]);
  const after = (await w.db.query(`select approved_by, posted_without_approval, scheduled_by from public.posts where id = $1`, [row.id])).rows[0];
  assert.deepEqual(after, { approved_by: null, posted_without_approval: true, scheduled_by: w.admin });
  // The server cannot claim the owner scheduled a post: it stays nobody's, and needs an approval.
  await assert.rejects(
    as(w.db, "service", (tx) => tx.query(`insert into public.posts (version_id, account_id, status, scheduled_for, scheduled_by) values ($1, $2, 'scheduled', now(), $3)`, [v1, w.tt1, w.owner])),
    /needs an approval/,
  );
  // A person cannot mark a post as posting or failed.
  await assert.rejects(setPost(w, w.admin, row.id, `status = 'posting'`), /Only the system moves a post/);
});

test("5. server owned rows: read only for people; a Studio request starts empty", async () => {
  const w = await world();
  const gen = await as(w.db, w.strat, async (tx) =>
    (await tx.query(
      `insert into public.ai_generations (mode, requested_by, provider_key, model_key, status, cost_usd, est_cost_usd)
       values ('image', $1, 'higgsfield', 'soul', 'done', 99, 1) returning status::text, cost_usd, est_cost_usd`,
      [w.owner],
    )).rows[0]);
  assert.deepEqual(gen, { status: "queued", cost_usd: null, est_cost_usd: null });
  for (const t of ["agent_runs", "ai_generations", "ai_generation_outputs", "check_results", "notifications"]) {
    assert.equal(await one(w.db, `select has_table_privilege('authenticated', $1, 'update')`, [`public.${t}`]), false, t);
    await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.${t} set updated_at = now()`)), DENIED, t);
  }
  // Same pattern elsewhere: a note is never inserted as sent; Gemini's fields are not the uploader's.
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const note = await as(w.db, w.strat, async (tx) =>
    (await tx.query(`insert into public.review_comments (version_id, body, sent_at) values ($1, 'x', now()) returning sent_at`, [v1])).rows[0]);
  assert.equal(note.sent_at, null);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.review_comments set sent_at = now() where version_id = $1`, [v1])), /Send to editor/);
  const clip = await as(w.db, w.editor, async (tx) =>
    (await tx.query(`insert into public.raw_clips (upload_batch_id, drive_file_id, file_name, ai_index, index_status) values ($1, 'drive-x', 'x.mov', '{"hooks":["fake"]}', 'done') returning ai_index, index_status::text`, [w.nounBatch])).rows[0]);
  assert.deepEqual(clip, { ai_index: {}, index_status: "queued" });
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.raw_clips set transcript = 'fake' where id = $1`, [w.clipN1])), SYSTEM);
  const sug = await as(w.db, "service", async (tx) =>
    (await tx.query(`insert into public.clip_match_suggestions (raw_clip_id, card_id, confidence) values ($1, $2, 55) returning id`, [w.clipN1, w.cardA])).rows[0].id);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.clip_match_suggestions set confidence = 99 where id = $1`, [sug])), SYSTEM);
  await as(w.db, w.strat, (tx) => tx.query(`update public.clip_match_suggestions set outcome = 'accepted', decided_by = $2 where id = $1`, [sug, w.owner]));
  assert.equal(await one(w.db, `select decided_by from public.clip_match_suggestions where id = $1`, [sug]), w.strat);
});

test("6. personal details belong to the person; nobody changes their own email", async () => {
  const w = await world();
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`update public.profiles set telegram_chat_id = 42 where id = $1`, [w.owner])), /themself/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.profiles set full_name = 'x' where id = $1`, [w.editor])), /themself/);
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set telegram_chat_id = 7, full_name = 'Khaled N' where id = $1`, [w.owner]));
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`update public.profiles set email = 'new@agency.test' where id = $1`, [w.editor])), /Your email/);
  // The owner still manages roles, access and the approval box of others.
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = false, access_status = 'removed' where id = $1`, [w.viewer]));
  await as(w.db, "service", (tx) => tx.query(`update public.profiles set email = 'olena@new.test' where id = $1`, [w.editor]));
  assert.equal(await one(w.db, `select email from public.profiles where id = $1`, [w.editor]), "olena@new.test");
});

test("7. only a Google sign in makes a profile; an email sign up cannot take the owner invite", async () => {
  const db = await freshDb();
  const fake = await signUp(db, "khaled@nounnaturals.com", "Fake", "email");
  assert.equal(await one(db, `select count(*)::int from public.profiles`), 0);
  assert.equal(await one(db, `select count(*)::int from public.invites where accepted_at is null`), 1);
  assert.equal(await oneAs(db, fake, `select count(*)::int from public.spaces`), 0);
  await signUp(db, "someone@github.test", "Gh", "github");
  assert.equal(await one(db, `select count(*)::int from public.profiles`), 0);
  const real = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  assert.equal(await one(db, `select role || ':' || access_status from public.profiles where id = $1`, [real]), "owner:active");
});

test("8. Google sign ins without an email make no profile and do not crash", async () => {
  const db = await freshDb();
  await signUp(db, null, "No mail one");
  await signUp(db, null, "No mail two");
  await signUp(db, "  ", "Blank");
  assert.equal(await one(db, `select count(*)::int from public.profiles`), 0);
});

test("9. functions: anon and public run none; signed in people only the policy helpers, the Shot box and the edit match choice", async () => {
  const db = await freshDb();
  const open = await db.query(
    `select n.nspname || '.' || p.proname as fn
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
            aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'private')
        and (a.grantee = 0 or a.grantee = 'anon'::regrole) and a.privilege_type = 'EXECUTE'`,
  );
  assert.deepEqual(open.rows, []);
  const pub = await db.query(
    `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute') order by 1`,
  );
  // decide_edit_match: 20261117000000_edit_intake (the uploader picks the AI's suggested title)
  // files_and_reader, once live: the meter, a match and its undo, Read this folder, Retry, the requeue of a folder back from the trash (the reader's own functions are the server's)
  const filesReader = FILES_READER.live ? ["ai_spend_today", "decide_clip_suggestion", "request_folder_read", "requeue_folder_clips", "retry_clip", "undo_clip_move"] : [];
  assert.deepEqual(pub.rows.map((r) => r.proname), [...filesReader, "decide_edit_match", "set_card_shot"].sort());
  assert.equal(await one(db, `select has_function_privilege('authenticated', 'private.advance_card_status(uuid, text)', 'execute')`), false);
  assert.equal(await one(db, `select has_function_privilege('authenticated', 'private.can_see_card(uuid)', 'execute')`), true);
});

test("10. review state, score, reference mark and cost are the system's on versions, variants and assets", async () => {
  const w = await world();
  const v = await as(w.db, w.editor, async (tx) =>
    (await tx.query(
      `insert into public.versions (card_id, r2_bucket, r2_key, review_state, virality_score, is_reference, duration_ms)
       values ($1, 'edits', 'a/v1.mp4', 'approved', 99, true, 5) returning id, review_state::text, virality_score, is_reference, duration_ms`,
      [w.cardA],
    )).rows[0]);
  assert.deepEqual(
    { review_state: v.review_state, virality_score: v.virality_score, is_reference: v.is_reference, duration_ms: v.duration_ms },
    { review_state: "checking", virality_score: null, is_reference: false, duration_ms: null },
  );
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.versions set review_state = 'approved' where id = $1`, [v.id])), SYSTEM);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.versions set is_reference = true where id = $1`, [v.id])), SYSTEM);
  const variant = await as(w.db, w.strat, async (tx) =>
    (await tx.query(
      `insert into public.variants (version_id, kind_key, label, what_changed, r2_bucket, r2_key, review_state, virality_score, cost_usd)
       values ($1, 'new_hook', 'H', 'Hook', 'variants', 'a/h.mp4', 'approved', 99, 5) returning id, review_state::text, virality_score, cost_usd`,
      [v.id],
    )).rows[0]);
  assert.equal(variant.review_state, "checking");
  assert.equal(variant.virality_score, null);
  assert.equal(Number(variant.cost_usd), 0);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.variants set review_state = 'approved' where id = $1`, [variant.id])), SYSTEM);
  // Approving through the approvals table still works (the database's own trigger sets the state).
  await approve(w, w.admin, "variant_id", variant.id);
  assert.equal(await one(w.db, `select review_state::text from public.variants where id = $1`, [variant.id]), "approved");

  const asset = await as(w.db, w.strat, async (tx) =>
    (await tx.query(`insert into public.assets (kind_key, card_id, title, review_state, cost_usd) values ('carousel', $1, 'Hard water', 'approved', 5) returning id, review_state::text`, [w.cardA])).rows[0]);
  assert.equal(asset.review_state, "checking");
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.assets set virality_score = 90 where id = $1`, [asset.id])), SYSTEM);
  await as(w.db, w.strat, (tx) => tx.query(`insert into public.asset_slides (asset_id, position, heading) values ($1, 1, 'hard water')`, [asset.id]));
  await approve(w, w.admin, "asset_id", asset.id);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`update public.asset_slides set heading = 'soft water' where asset_id = $1`, [asset.id])), /approved/);
  await assert.rejects(as(w.db, w.strat, (tx) => tx.query(`insert into public.asset_slides (asset_id, position) values ($1, 2)`, [asset.id])), /approved/);
});

test("11. an invite lets in a person who is already waiting, within the inviter's limits", async () => {
  const w = await world();
  const waiting = await signUp(w.db, "late@agency.test", "Late");
  assert.equal(await one(w.db, `select access_status::text from public.profiles where id = $1`, [waiting]), "pending");
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role) values ('late@agency.test', 'admin')`)), RLS);
  assert.equal(await one(w.db, `select access_status::text from public.profiles where id = $1`, [waiting]), "pending");
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role) values ('LATE@agency.test', 'editor')`));
  const p = (await w.db.query(`select role::text, access_status::text, invited_by from public.profiles where id = $1`, [waiting])).rows[0];
  // The old value "editor" means Strategist/Editor since the 20261116000000 migration.
  assert.deepEqual(p, { role: "strategist", access_status: "active", invited_by: w.admin });
  assert.equal(await one(w.db, `select accepted_by from public.invites where lower(email) = 'late@agency.test'`), waiting);
});

test("12. anything created later gives nothing to anon, authenticated or public until granted", async () => {
  const db = await freshDb();
  await db.exec(`create table public.later_table (id int primary key);
                 create function public.later_fn() returns int language sql as 'select 1';
                 create function private.later_helper() returns int language sql as 'select 1';
                 create sequence public.later_seq;`);
  for (const role of ["anon", "authenticated"]) {
    for (const priv of ["select", "insert", "update", "delete"]) {
      assert.equal(await one(db, `select has_table_privilege($1, 'public.later_table', $2)`, [role, priv]), false, `${role} ${priv}`);
    }
    assert.equal(await one(db, `select has_function_privilege($1, 'public.later_fn()', 'execute')`, [role]), false);
    assert.equal(await one(db, `select has_function_privilege($1, 'private.later_helper()', 'execute')`, [role]), false);
    assert.equal(await one(db, `select has_sequence_privilege($1, 'public.later_seq', 'usage')`, [role]), false);
  }
  const pub = await db.query(
    `select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.proname in ('later_fn', 'later_helper') and a.grantee = 0`,
  );
  assert.equal(pub.rows.length, 0);
});

/* ---------- third round (Nov 15 2026): stale scheduled_by and invite emails ---------- */

const postRow = async (w, id) =>
  (await w.db.query(`select status::text, scheduled_by, approved_by, posted_without_approval from public.posts where id = $1`, [id])).rows[0];

test("A1. back to draft clears who scheduled it, so the server cannot then post it as the owner", async () => {
  const w = await world();
  await strategistWithChannel(w, { flag: false });
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const p = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  await setPost(w, w.strat, p.id, `status = 'draft'`);
  assert.deepEqual(await postRow(w, p.id), { status: "draft", scheduled_by: null, approved_by: null, posted_without_approval: false });
  await assert.rejects(setPost(w, "service", p.id, `status = 'scheduled'`), /needs an approval/);
  await assert.rejects(setPost(w, "service", p.id, `status = 'posting'`), /needs an approval/);
  // Cancelled clears it too.
  const p2 = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  await setPost(w, w.owner, p2.id, `status = 'cancelled'`);
  assert.equal((await postRow(w, p2.id)).scheduled_by, null);
});

test("A2. a different video or account on a post drops who scheduled it", async () => {
  const w = await world();
  await strategistWithChannel(w, { flag: false });
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const v2 = await newVersion(w, w.editor, w.cardA, "a/v2.mp4");
  const p = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  await setPost(w, "service", p.id, `status = 'posting'`);
  await setPost(w, "service", p.id, `status = 'failed', failed_reason = 'timeout'`);
  await setPost(w, w.strat, p.id, `version_id = $2`, [v2]);
  assert.equal((await postRow(w, p.id)).scheduled_by, null);
  await assert.rejects(setPost(w, "service", p.id, `status = 'scheduled'`), /needs an approval/);

  // The server swapping the video in the same write as a retry is refused too.
  const q = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  await assert.rejects(setPost(w, "service", q.id, `status = 'posting', version_id = $2`, [v2]), /needs an approval/);
  assert.deepEqual(await postRow(w, q.id), { status: "scheduled", scheduled_by: w.owner, approved_by: null, posted_without_approval: true });
});

test("A3. the server carries on or retries only exactly what a person scheduled", async () => {
  const w = await world();
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const p = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  for (const step of ["posting", "failed", "scheduled", "posting", "posted"]) {
    await setPost(w, "service", p.id, `status = '${step}'`);
  }
  assert.deepEqual(await postRow(w, p.id), { status: "posted", scheduled_by: w.owner, approved_by: null, posted_without_approval: true });

  // Normal approved flow: a strategist with the box ticked, with an admin approval.
  await strategistWithChannel(w);
  const ok = await approve(w, w.admin, "version_id", v1);
  const a = await schedule(w, w.strat, { version: v1, account: w.tt1, approval: ok });
  await setPost(w, "service", a.id, `status = 'posting'`);
  await setPost(w, "service", a.id, `status = 'posted'`);
  assert.deepEqual(await postRow(w, a.id), { status: "posted", scheduled_by: w.strat, approved_by: w.admin, posted_without_approval: false });

  // An unticked strategist loses the exemption the moment the owner ticks the box again.
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = false where id = $1`, [w.strat]));
  const b = await schedule(w, w.strat, { version: v1, account: w.tt1 });
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set needs_post_approval = true where id = $1`, [w.strat]));
  await assert.rejects(setPost(w, "service", b.id, `status = 'posting'`), /needs an approval/);
});

test("A4. a person who schedules again is judged as themself", async () => {
  const w = await world();
  await strategistWithChannel(w); // box ticked
  const v1 = await newVersion(w, w.editor, w.cardA, "a/v1.mp4");
  const p = await schedule(w, w.owner, { version: v1, account: w.tt1 });
  await setPost(w, w.owner, p.id, `status = 'draft'`);
  await assert.rejects(setPost(w, w.strat, p.id, `status = 'scheduled'`), /needs an approval/);
  await setPost(w, w.admin, p.id, `status = 'scheduled'`);
  assert.equal((await postRow(w, p.id)).scheduled_by, w.admin);
  // A person changing the video on a scheduled post schedules it again as themself.
  const v2 = await newVersion(w, w.editor, w.cardA, "a/v2.mp4");
  await assert.rejects(setPost(w, w.strat, p.id, `version_id = $2`, [v2]), /needs an approval/);
  await setPost(w, w.owner, p.id, `version_id = $2`, [v2]);
  assert.equal((await postRow(w, p.id)).scheduled_by, w.owner);
});

test("B. invite emails are trimmed and lower cased; who invited cannot be forged", async () => {
  const w = await world();
  const waiting = await signUp(w.db, "new.person@x.com", "New");
  await as(w.db, w.admin, (tx) => tx.query(`insert into public.invites (email, role, invited_by) values ('  New.Person@X.com ', 'editor', $1)`, [w.owner]));
  const inv = (await w.db.query(`select email, invited_by, accepted_by from public.invites where email = 'new.person@x.com'`)).rows[0];
  assert.deepEqual(inv, { email: "new.person@x.com", invited_by: w.admin, accepted_by: waiting });
  const p = (await w.db.query(`select role::text, access_status::text, invited_by from public.profiles where id = $1`, [waiting])).rows[0];
  assert.deepEqual(p, { role: "strategist", access_status: "active", invited_by: w.admin }); // "editor" means Strategist/Editor

  await as(w.db, w.owner, (tx) => tx.query(`insert into public.invites (email, role) values (' Later.One@X.COM', 'strategist')`));
  const later = await signUp(w.db, "later.one@x.com ", "Later");
  assert.equal(await one(w.db, `select role || ':' || access_status from public.profiles where id = $1`, [later]), "strategist:active");
  // Our own server may name the inviter.
  await as(w.db, "service", (tx) => tx.query(`insert into public.invites (email, role, invited_by) values ('svc@x.com', 'viewer', $1)`, [w.owner]));
  assert.equal(await one(w.db, `select invited_by from public.invites where email = 'svc@x.com'`), w.owner);
});
