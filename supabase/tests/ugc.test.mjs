/* Behavior tests for UGC and mentions saved (the migration supabase/migrations/20261118200000_ugc.sql, approved by
   the owner Nov 16 2026): the permission "Save UGC" (ugc.manage), ugc_posts (a saved post, with Refunnel's own rights
   word kept as it came) and card_ugc_references (a saved post sent to a card). Every migration is loaded exactly as
   helpers.mjs does; the world before it is built with freshDb({ before: UGC_MIGRATION }).
   The inserts and updates here are the ones src/lib/content/ugc-db.ts sends. Nothing here touches the live project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one, narrowEditor, oneSpaceStrategist, META_POSTING, FILES_READER } from "./helpers.mjs";

const UGC_MIGRATION = "20261118200000";

const RLS = /row-level security/;
const DENIED = /permission denied/;

/* ---------- a small world ---------- */

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("daryna@nounnaturals.com", "strategist");
  await invite("olena@agency.test", "editor");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("outsider@agency.test", "strategist");
  await invite("planner@nounnaturals.com", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strategist = await signUp(db, "daryna@nounnaturals.com", "Daryna"); // Strategist/Editor: opens every space (spaces.all)
  const editor = await signUp(db, "olena@agency.test", "Olena"); // narrow editor: cardA is hers
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const stranger = await signUp(db, "outsider@agency.test", "Taras"); // Strategist/Editor's keys but spaces.all, and no space
  const planner = await signUp(db, "planner@nounnaturals.com", "Pat"); // a custom role: plans cards, no ugc.manage, Noun Naturals only
  await narrowEditor(db, owner, editor);
  await oneSpaceStrategist(db, owner, "Outsider", [], stranger);
  await as(db, owner, async (tx) => {
    const role = (await tx.query(`insert into public.roles (name, color) values ('Planner only', 'st-idea') returning id`)).rows[0].id;
    for (const key of ["calendar.plan", "calendar.all_cards", "page.calendar", "page.ugc"]) {
      await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [role, key]);
    }
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [role, planner]);
  });

  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, owner, async (tx) => {
    for (const p of [strategist, editor, viewer, planner]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  const ids = await as(db, admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const nounWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const founderWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-16') returning id`, [founder]);
    const cardA = await q(`insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'That silky feeling might be a coating', '2026-11-17', $2) returning id`, [nounWeek, editor]);
    const cardC = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Unassigned noun card', '2026-11-19') returning id`, [nounWeek]);
    const cardF = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Founder story one', '2026-11-17') returning id`, [founderWeek]);
    const cardGone = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'A removed row', '2026-11-18') returning id`, [nounWeek]);
    await tx.query(`update public.cards set deleted_at = now() where id = $1`, [cardGone]);
    return { cardA, cardC, cardF, cardGone };
  });
  return { db, owner, admin, strategist, editor, viewer, stranger, planner, noun, founder, ...ids };
}

/** The id a person sends as themself (anon has none). */
const me = (who) => (who === "anon" || who === "service" ? null : who);

/** A post saved from the live feed, as ugc-db.ts inserts it. */
const save = (w, who, externalId, extra = {}) =>
  oneAs(
    w.db,
    who,
    `insert into public.ugc_posts (source_key, external_id, origin, platform_key, media_type, post_type, creator_username, creator_name,
       creator_followers, caption, hashtags, permalink, media, campaign_name, posted_at, first_seen_at, last_seen_at, source_usage_rights, raw, saved_by)
     values ('refunnel', $1, 'social', 'instagram', 'video', 'reel', $2, 'A creator', 1200, 'love my noun', '{noun}', $3, $4, null, '2026-11-14T10:00:00Z',
       now(), now(), 'NONE', $5, $6) returning id`,
    [
      externalId,
      extra.username ?? "maya.makes",
      extra.permalink ?? `https://www.instagram.com/reel/${externalId}`,
      JSON.stringify([{ type: "video", url: "https://cdn.refunnel.com/a.mp4", thumbnail: "https://cdn.refunnel.com/a.jpg", duration: 21 }]),
      JSON.stringify({ id: externalId }),
      extra.savedBy ?? me(who),
    ],
  );

/** A reference on a card, as ugc-db.ts inserts it. */
const attach = (w, who, card, post, note = "Use this clip", send = null) =>
  oneAs(
    w.db,
    who,
    `insert into public.card_ugc_references (card_id, post_id, send_id, note, sent_by) values ($1, $2, coalesce($3, gen_random_uuid()), $4, $5) returning id`,
    [card, post, send, note, me(who)],
  );

const update = (w, who, sql, params) => rowsAs(w.db, who, sql, params);

/* ---------- the migration itself ---------- */

test("the migration applies after the earlier ones: two tables with the house rules, one permission, no rows", async () => {
  const w = await world();
  for (const t of ["ugc_posts", "card_ugc_references"]) {
    assert.equal(await one(w.db, `select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`]), true, `${t}: row level security on`);
    const triggers = (await w.db.query(`select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname`, [`public.${t}`])).rows.map((r) => r.tgname);
    for (const name of ["no_hard_delete", "no_truncate", "zz_audit"]) assert.ok(triggers.includes(name), `${t}: ${name}`);
    for (const name of ["c_guard_fixed", "z_set_updated_at"]) assert.ok(triggers.includes(name), `${t}: ${name}`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(await one(w.db, `select has_table_privilege($1, $2, 'delete')`, [role, `public.${t}`]), false, `${t}: no delete for ${role}`);
      assert.equal(await one(w.db, `select has_table_privilege($1, $2, 'truncate')`, [role, `public.${t}`]), false, `${t}: no truncate for ${role}`);
    }
    assert.equal(await one(w.db, `select has_table_privilege('anon', $1, 'select')`, [`public.${t}`]), false, `${t}: nothing for anon`);
    assert.equal(await one(w.db, `select count(*)::int from public.${t}`), 0, `${t}: no seed rows, no demo data`);
  }
  assert.equal(await one(w.db, `select to_regclass('public.ugc_rights_events') is null`), true, "no ugc_rights_events table");
  assert.equal(await one(w.db, `select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'ugc_posts' and column_name in ('rights_status', 'rights_updated_at')`), 0, "no rights columns on ugc_posts");
  assert.equal(await one(w.db, `select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'ugc_rights%'`), 0, "no rights functions");
  assert.equal(await one(w.db, `select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'card_ugc_references'`), 1);

  /* the one new permission, in its own group after Brand, held by Owner, Admin and Strategist/Editor */
  const p = (await w.db.query(`select group_key, group_label, label, sort_order from public.permissions where key = 'ugc.manage'`)).rows[0];
  assert.deepEqual(p, { group_key: "ugc", group_label: "UGC and mentions", label: "Save UGC", sort_order: 175 });
  /* 48 once this migration ran (the 47 before it and Save UGC); review undo and space create then add one each */
  const old = await freshDb({ before: "20261119000000" });
  assert.equal(await one(old, `select count(*)::int from public.permissions where deleted_at is null`), 48);
  /* and the Meta posting and Upload/Files migrations one more each (posting.resolve, files.manage), from the day each is live */
  assert.equal(await one(w.db, `select count(*)::int from public.permissions where deleted_at is null`), 50 + (META_POSTING.live ? 1 : 0) + (FILES_READER.live ? 1 : 0));
  const holders = (await w.db.query(
    `select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id
      where rp.permission_key = 'ugc.manage' and rp.deleted_at is null and r.key is not null order by 1`,
  )).rows.map((r) => r.key);
  assert.deepEqual(holders, ["admin", "owner", "strategist"]);
  for (const [who, has] of [[w.owner, true], [w.admin, true], [w.strategist, true], [w.editor, false], [w.viewer, false], [w.planner, false]]) {
    assert.equal(await oneAs(w.db, who, `select private.has_permission('ugc.manage')`), has);
  }
});

/* ---------- saving a post ---------- */

test("saving: Owner, Admin, Strategist/Editor and a planner save; an editor, a viewer and anon are refused", async () => {
  const w = await world();
  for (const [n, who] of [w.owner, w.admin, w.strategist, w.planner, w.stranger].entries()) assert.ok(await save(w, who, `post-${n}`), `saver ${n}`);
  for (const who of [w.editor, w.viewer]) await assert.rejects(save(w, who, `nope-${who}`), RLS);
  await assert.rejects(save(w, "anon", "nope-anon"), DENIED);
  /* one row per platform post */
  await assert.rejects(save(w, w.admin, "post-0"), /duplicate key|unique/);
  assert.equal(await one(w.db, `select count(*)::int from public.ugc_posts`), 5);
});

test("saving: the saver is the caller, whatever is sent, and source_usage_rights is kept as sent", async () => {
  const w = await world();
  const id = await save(w, w.admin, "p1", { savedBy: w.owner });
  const row = (await w.db.query(`select saved_by, source_usage_rights, deleted_at from public.ugc_posts where id = $1`, [id])).rows[0];
  assert.deepEqual(row, { saved_by: w.admin, source_usage_rights: "NONE", deleted_at: null }, "Refunnel's word stays as sent");
  const other = await oneAs(w.db, w.admin, `insert into public.ugc_posts (external_id, origin, media_type, post_type, creator_username, source_usage_rights) values ('p2', 'social', 'video', 'reel', 'a', 'GRANTED') returning source_usage_rights`);
  assert.equal(other, "GRANTED");
});

test("reading: everyone active reads saved posts; anon reads nothing", async () => {
  const w = await world();
  await save(w, w.strategist, "p1");
  for (const who of [w.owner, w.editor, w.viewer, w.stranger, w.planner]) {
    assert.equal((await rowsAs(w.db, who, `select id from public.ugc_posts`)).length, 1);
  }
  await assert.rejects(rowsAs(w.db, "anon", `select id from public.ugc_posts`), DENIED);
});

test("remove from saved and save again: ugc.manage only; who removed it is stamped and cleared; never deleted", async () => {
  const w = await world();
  const id = await save(w, w.strategist, "p1");
  /* a planner without ugc.manage, an editor and a viewer change nothing */
  for (const who of [w.planner, w.editor, w.viewer]) assert.equal((await update(w, who, `update public.ugc_posts set deleted_at = now() where id = $1 returning id`, [id])).length, 0);
  assert.equal((await update(w, w.admin, `update public.ugc_posts set deleted_at = now() where id = $1 and deleted_at is null returning id`, [id])).length, 1);
  assert.equal(await one(w.db, `select removed_by from public.ugc_posts where id = $1`, [id]), w.admin);
  assert.equal((await update(w, w.strategist, `update public.ugc_posts set deleted_at = null, last_seen_at = now() where id = $1 returning id`, [id])).length, 1);
  assert.deepEqual((await w.db.query(`select removed_by, deleted_at from public.ugc_posts where id = $1`, [id])).rows[0], { removed_by: null, deleted_at: null });
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.ugc_posts where id = $1`, [id])), DENIED);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`delete from public.ugc_posts where id = $1`, [id])), DENIED);
});

test("fixed once saved: the source, its id, who saved it and when", async () => {
  const w = await world();
  const id = await save(w, w.strategist, "p1");
  for (const set of [`external_id = 'other'`, `source_key = 'instagram'`, `saved_by = '${w.owner}'`, `saved_at = now() - interval '1 day'`]) {
    await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.ugc_posts set ${set} where id = $1`, [id])), /fixed once saved/, set);
  }
  /* the links and the numbers may be refreshed */
  assert.equal((await update(w, w.strategist, `update public.ugc_posts set media = '[]'::jsonb, last_seen_at = now(), creator_followers = 1500 where id = $1 returning id`, [id])).length, 1);
});

/* ---------- references on cards ---------- */

test("references: planners who see the card attach; the space is the card's; viewers, editors and outsiders are refused", async () => {
  const w = await world();
  const post = await save(w, w.strategist, "p1");
  const ref = await attach(w, w.strategist, w.cardA, post);
  /* the space comes from the card (the app leaves it out), never from what is sent */
  assert.equal(await one(w.db, `select space_id from public.card_ugc_references where id = $1`, [ref]), w.noun);
  const odd = await oneAs(w.db, w.admin, `insert into public.card_ugc_references (card_id, space_id, post_id) values ($1, $2, $3) returning space_id`, [w.cardC, w.founder, await save(w, w.admin, "p-odd")]);
  assert.equal(odd, w.noun);
  assert.equal(await one(w.db, `select sent_by from public.card_ugc_references where id = $1`, [ref]), w.strategist);
  assert.ok(await attach(w, w.planner, w.cardC, post), "a planner without ugc.manage attaches");
  assert.ok(await attach(w, w.admin, w.cardF, post), "the admin opens every space");
  for (const who of [w.viewer, w.editor]) await assert.rejects(attach(w, who, w.cardC, post), RLS);
  await assert.rejects(attach(w, w.stranger, w.cardC, post), RLS, "a planner who does not open the space");
  await assert.rejects(attach(w, w.planner, w.cardF, post), RLS, "a card in a space they do not open");
  assert.ok(await attach(w, w.strategist, w.cardF, await save(w, w.strategist, "p-founder")), "Strategist/Editor opens every space (spaces.all)");
  await assert.rejects(attach(w, "anon", w.cardC, post), DENIED);
});

test("references: never on a removed card or a removed post; one live reference per post per card", async () => {
  const w = await world();
  const post = await save(w, w.strategist, "p1");
  await assert.rejects(attach(w, w.admin, w.cardGone, post), /removed/);
  await attach(w, w.strategist, w.cardC, post);
  await assert.rejects(attach(w, w.strategist, w.cardC, post), /duplicate key|unique/);
  const other = await save(w, w.strategist, "p2");
  await update(w, w.admin, `update public.ugc_posts set deleted_at = now() where id = $1`, [other]);
  await assert.rejects(attach(w, w.strategist, w.cardC, other), /Save the post first/);
});

test("references: seen by whoever sees the card; an editor sees them on their own card only", async () => {
  const w = await world();
  const post = await save(w, w.strategist, "p1");
  const send = await one(w.db, `select gen_random_uuid()`);
  await attach(w, w.strategist, w.cardA, post, "Match this style", send);
  await attach(w, w.strategist, w.cardC, post, "Match this style", send);
  await attach(w, w.admin, w.cardF, post);
  const seen = async (who) => (await rowsAs(w.db, who, `select card_id from public.card_ugc_references where deleted_at is null order by sent_at`)).map((r) => r.card_id).sort();
  assert.deepEqual(await seen(w.owner), [w.cardA, w.cardC, w.cardF].sort());
  assert.deepEqual(await seen(w.viewer), [w.cardA, w.cardC].sort());
  assert.deepEqual(await seen(w.editor), [w.cardA], "the narrow editor sees only their own card");
  assert.deepEqual(await seen(w.stranger), []);
  /* the two posts sent together share their send */
  assert.equal(await one(w.db, `select count(distinct send_id)::int from public.card_ugc_references where send_id = $1`, [send]), 1);
});

test("references: planners remove them (deleted_at, who is stamped) and send again; others cannot; nothing is deleted or moved", async () => {
  const w = await world();
  const post = await save(w, w.strategist, "p1");
  const ref = await attach(w, w.strategist, w.cardC, post);
  for (const who of [w.viewer, w.editor, w.stranger]) {
    assert.equal((await update(w, who, `update public.card_ugc_references set deleted_at = now() where id = $1 returning id`, [ref])).length, 0);
  }
  assert.equal((await update(w, w.planner, `update public.card_ugc_references set deleted_at = now() where id = $1 and deleted_at is null returning id`, [ref])).length, 1);
  assert.equal(await one(w.db, `select removed_by from public.card_ugc_references where id = $1`, [ref]), w.planner);
  /* the same post can go on the same card again once the old one is removed */
  assert.ok(await attach(w, w.strategist, w.cardC, post));
  for (const set of [`card_id = '${w.cardA}'`, `post_id = '${post}'::uuid, card_id = '${w.cardA}'`, `sent_by = '${w.owner}'`, `space_id = '${w.founder}'`]) {
    await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.card_ugc_references set ${set} where id = $1`, [ref])), /fixed once saved/, set);
  }
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.card_ugc_references where id = $1`, [ref])), DENIED);
});

test("every write leaves an audit row", async () => {
  const w = await world();
  const post = await save(w, w.strategist, "p1");
  await attach(w, w.strategist, w.cardC, post);
  for (const t of ["ugc_posts", "card_ugc_references"]) {
    assert.ok((await one(w.db, `select count(*)::int from public.audit_log where entity_table = $1`, [t])) >= 1, t);
  }
});

/* ---------- before the migration: what the published app does on the older schema ---------- */

test("before the migration: no UGC tables (the screen grays saving), and Send to a card writes the card's reference link as calendar.plan", async () => {
  const db = await freshDb({ before: UGC_MIGRATION });
  await assert.rejects(db.query(`select id from public.ugc_posts limit 1`), /does not exist/);
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  await as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ('daryna@nounnaturals.com', 'strategist'), ('viewer@nounnaturals.com', 'viewer')`));
  const strategist = await signUp(db, "daryna@nounnaturals.com", "Daryna");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  await as(db, owner, async (tx) => {
    for (const p of [strategist, viewer]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  const card = await as(db, owner, async (tx) => {
    const week = (await tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun])).rows[0].id;
    return (await tx.query(`insert into public.cards (week_id, title) values ($1, 'Patchouli') returning id`, [week])).rows[0].id;
  });
  const link = "https://www.instagram.com/reel/abc123";
  /* the same update updateCard sends (src/lib/content/calendar-actions.ts) */
  const set = (who) => rowsAs(db, who, `update public.cards set reference_url = $1 where id = $2 and deleted_at is null returning id`, [link, card]);
  assert.equal((await set(viewer)).length, 0, "a viewer changes nothing");
  assert.equal((await set(strategist)).length, 1);
  assert.equal(await one(db, `select reference_url from public.cards where id = $1`, [card]), link);
});
