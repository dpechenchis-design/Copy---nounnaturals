/* Behavior tests for how an edited video came in (the migration supabase/migrations/20261117000000_edit_intake.sql,
   approved by the owner Nov 16 2026): the intake columns on versions, edit_upload_batches (one mass upload) and
   edit_match_suggestions (the AI's answer for one file). Every migration is loaded exactly as helpers.mjs does; the
   "before" world is built with freshDb({ before: INTAKE_MIGRATION }) and the rest is then run with applyMigrationsFrom,
   as the live project runs them. Nothing here touches the live Supabase project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, applyMigrationsFrom, signUp, as, rowsAs, oneAs, one, narrowEditor, oneSpaceStrategist } from "./helpers.mjs";

const INTAKE_MIGRATION = "20261117000000";

const RLS = /row-level security/;
const DENIED = /permission denied/;
const FIXED = /fixed once saved/;
const INTAKE = /versions_intake_check|check constraint/;

/* ---------- a small world ---------- */

async function world({ draft = true } = {}) {
  const db = await freshDb(draft ? {} : { before: INTAKE_MIGRATION });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("olena@agency.test", "editor");
  await invite("dmytro@agency.test", "editor");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("outsider@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const editor = await signUp(db, "olena@agency.test", "Olena"); // Noun Naturals, cardA is hers
  const editor2 = await signUp(db, "dmytro@agency.test", "Dmytro"); // Noun Naturals, no cards of his own
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer"); // Noun Naturals, may not upload
  const stranger = await signUp(db, "outsider@agency.test", "Taras"); // opens no space
  await narrowEditor(db, owner, editor, editor2);
  /* Strategist/Editor opens every space now (spaces.all): the stranger holds its keys but spaces.all, and no space */
  await oneSpaceStrategist(db, owner, "Outsider", [], stranger);

  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  await as(db, owner, async (tx) => {
    for (const p of [editor, editor2, viewer]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  const ids = await as(db, admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const nounWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const founderWeek = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-16') returning id`, [founder]);
    const cardA = await q(`insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'That silky feeling might be a coating', '2026-11-17', $2) returning id`, [nounWeek, editor]);
    const cardB = await q(`insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Patchouli', '2026-11-18', $2) returning id`, [nounWeek, editor]);
    const cardC = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Unassigned noun card', '2026-11-19') returning id`, [nounWeek]);
    const cardF = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Founder story one', '2026-11-17') returning id`, [founderWeek]);
    return { cardA, cardB, cardC, cardF };
  });
  const gemini = await one(db, `select id from public.ai_models where provider_key = 'google' and model_key = 'gemini-4-hydrogen'`);
  return { db, owner, admin, editor, editor2, viewer, stranger, noun, founder, gemini, ...ids };
}

const newBatch = (w, who, space, files = 3) =>
  oneAs(w.db, who, `insert into public.edit_upload_batches (space_id, uploaded_by, file_count) values ($1, $2, $3) returning id`, [space, who, files]);

/** A version as the upload saves it, with how it came in. */
const newVersion = (w, who, card, key, { via = null, method = null, confidence = null, batch = null } = {}) =>
  oneAs(
    w.db,
    who,
    `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via, match_method, match_confidence, edit_upload_batch_id)
     values ($1, 'edits', $2, $2, $3, $4, $5, $6) returning id`,
    [card, key, via, method, confidence, batch],
  );

/** The AI's answer for one file, as our own server writes it. */
const newSuggestion = (w, batch, file, card, confidence, extra = {}) =>
  oneAs(
    w.db,
    "service",
    `insert into public.edit_match_suggestions (batch_id, file_name, card_id, confidence, reason, provider_key, model_key, ai_model_id, cost_usd, alternatives)
     values ($1, $2, $3, $4, $5, 'google', 'gemini-4-hydrogen', $6, $7, $8) returning id`,
    [batch, file, card, confidence, extra.reason ?? "Says the hook word for word.", w.gemini, extra.cost ?? 0.009, JSON.stringify(extra.alternatives ?? [])],
  );

/* ---------- the migration itself ---------- */

test("the migration applies cleanly after the earlier ones, with the house rules on both new tables", async () => {
  const w = await world();
  const cols = await rowsAs(
    w.db,
    w.owner,
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'versions'
       and column_name in ('intake_via', 'match_method', 'match_confidence', 'edit_upload_batch_id') order by column_name`,
  );
  assert.deepEqual(cols.map((r) => r.column_name), ["edit_upload_batch_id", "intake_via", "match_confidence", "match_method"]);
  for (const t of ["edit_upload_batches", "edit_match_suggestions"]) {
    assert.equal(await one(w.db, `select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`]), true, `${t}: row level security on`);
    const triggers = (await w.db.query(`select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname`, [`public.${t}`])).rows.map((r) => r.tgname);
    for (const name of ["c_guard_fixed", "no_hard_delete", "no_truncate", "z_set_updated_at", "zz_audit"]) assert.ok(triggers.includes(name), `${t}: ${name}`);
    assert.equal(await one(w.db, `select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime' and tablename = $1`, [t]), 1, `${t}: realtime`);
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(await one(w.db, `select has_table_privilege($1, $2, 'delete')`, [role, `public.${t}`]), false, `${t}: no delete for ${role}`);
      assert.equal(await one(w.db, `select has_table_privilege($1, $2, 'truncate')`, [role, `public.${t}`]), false, `${t}: no truncate for ${role}`);
    }
    assert.equal(await one(w.db, `select has_table_privilege('anon', $1, 'select')`, [`public.${t}`]), false, `${t}: nothing for anon`);
  }
  /* a person writes their batch, only reads the AI's answers */
  assert.equal(await one(w.db, `select has_table_privilege('authenticated', 'public.edit_upload_batches', 'insert')`), true);
  assert.equal(await one(w.db, `select has_table_privilege('authenticated', 'public.edit_match_suggestions', 'insert')`), false);
  assert.equal(await one(w.db, `select has_table_privilege('authenticated', 'public.edit_match_suggestions', 'update')`), false);
  assert.equal(await one(w.db, `select has_function_privilege('anon', 'public.decide_edit_match(uuid, uuid, uuid)', 'execute')`), false);
  assert.equal(await one(w.db, `select has_function_privilege('authenticated', 'public.decide_edit_match(uuid, uuid, uuid)', 'execute')`), true);
  /* no seed rows, no demo data */
  assert.equal(await one(w.db, `select count(*)::int from public.edit_upload_batches`), 0);
  assert.equal(await one(w.db, `select count(*)::int from public.edit_match_suggestions`), 0);
});

/* ---------- versions save how they came in ---------- */

test("a row upload and a mass upload save how each version came in; old style inserts still work", async () => {
  const w = await world();
  const row = await newVersion(w, w.editor, w.cardA, "a/v1.mp4", { via: "row" });
  const batch = await newBatch(w, w.editor, w.noun, 3);
  const byCode = await newVersion(w, w.editor, w.cardA, "a/v2.mp4", { via: "mass", method: "code", batch });
  const byAi = await newVersion(w, w.editor, w.cardB, "b/v1.mp4", { via: "mass", method: "ai", confidence: 93.5, batch });
  const picked = await newVersion(w, w.editor, w.cardB, "b/v2.mp4", { via: "mass", method: "picked", batch });
  const old = await newVersion(w, w.editor, w.cardA, "a/v3.mp4");
  const rows = await rowsAs(
    w.db,
    w.owner,
    `select id, number, intake_via, match_method, match_confidence::float as pct, edit_upload_batch_id as batch from public.versions order by created_at, number`,
  );
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(by[row], { id: row, number: 1, intake_via: "row", match_method: null, pct: null, batch: null });
  assert.deepEqual(by[byCode], { id: byCode, number: 2, intake_via: "mass", match_method: "code", pct: null, batch });
  assert.deepEqual(by[byAi], { id: byAi, number: 1, intake_via: "mass", match_method: "ai", pct: 93.5, batch });
  assert.deepEqual(by[picked], { id: picked, number: 2, intake_via: "mass", match_method: "picked", pct: null, batch });
  assert.deepEqual(by[old], { id: old, number: 3, intake_via: null, match_method: null, pct: null, batch: null });
  /* the first migration's rules still run: newest first, the older one superseded */
  assert.equal(await one(w.db, `select review_state::text from public.versions where id = $1`, [byCode]), "superseded");
  assert.equal(await one(w.db, `select review_state::text from public.versions where id = $1`, [old]), "checking");
});

test("inconsistent intake values are refused", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  const bad = [
    ["a confidence on a code match", { via: "mass", method: "code", confidence: 80, batch }],
    ["a confidence on a hand pick", { via: "mass", method: "picked", confidence: 80, batch }],
    ["an AI match with no confidence", { via: "mass", method: "ai", batch }],
    ["a batch on a row upload", { via: "row", batch }],
    ["a match on a row upload", { via: "row", method: "code" }],
    ["a mass upload with no batch", { via: "mass", method: "code" }],
    ["a mass upload with no match", { via: "mass", batch }],
    ["a match with no intake", { method: "code" }],
    ["a confidence with no intake", { confidence: 50 }],
    ["a batch with no intake", { batch }],
  ];
  for (const [i, [what, v]] of bad.entries()) {
    await assert.rejects(newVersion(w, w.editor, w.cardA, `bad/${i}.mp4`, v), INTAKE, what);
  }
  await assert.rejects(newVersion(w, w.editor, w.cardA, "bad/pct.mp4", { via: "mass", method: "ai", confidence: 100.5, batch }), /check constraint/);
  await assert.rejects(newVersion(w, w.editor, w.cardA, "bad/neg.mp4", { via: "mass", method: "ai", confidence: -1, batch }), /check constraint/);
  await assert.rejects(newVersion(w, w.editor, w.cardA, "bad/via.mp4", { via: "email" }), /check constraint/);
  await assert.rejects(newVersion(w, w.editor, w.cardA, "bad/how.mp4", { via: "mass", method: "guess", batch }), /check constraint/);
  assert.equal(await one(w.db, `select count(*)::int from public.versions`), 0);
});

test("a version goes only into the person's own mass upload, on a card of the same space", async () => {
  const w = await world();
  const theirs = await newBatch(w, w.editor2, w.noun);
  await assert.rejects(newVersion(w, w.editor, w.cardA, "a/x.mp4", { via: "mass", method: "code", batch: theirs }), /your own mass upload/);
  const founderBatch = await newBatch(w, w.admin, w.founder);
  await assert.rejects(newVersion(w, w.admin, w.cardC, "c/x.mp4", { via: "mass", method: "code", batch: founderBatch }), /same space/);
  /* our own server may file into any batch of the same space */
  const v = await newVersion(w, "service", w.cardA, "a/s.mp4", { via: "mass", method: "code", batch: theirs });
  assert.ok(v);
});

test("how a version came in cannot be changed after it is saved, by anyone", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  const other = await newBatch(w, w.editor, w.noun);
  const v = await newVersion(w, w.editor, w.cardA, "a/v1.mp4", { via: "mass", method: "ai", confidence: 72, batch });
  const r = await newVersion(w, w.editor, w.cardB, "b/v1.mp4", { via: "row" });
  const changes = [
    [v, `match_confidence = 99`],
    [v, `match_method = 'picked', match_confidence = null`],
    [v, `edit_upload_batch_id = '${other}'`],
    [v, `intake_via = null, match_method = null, match_confidence = null, edit_upload_batch_id = null`],
    [r, `intake_via = null`],
  ];
  for (const who of [w.editor, w.owner, "service"]) {
    for (const [id, set] of changes) {
      await assert.rejects(as(w.db, who, (tx) => tx.query(`update public.versions set ${set} where id = $1`, [id])), FIXED, `${who}: ${set}`);
    }
  }
  /* a version with no intake stays without one: it cannot be filled in later */
  const old = await newVersion(w, w.editor, w.cardA, "a/v2.mp4");
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`update public.versions set intake_via = 'row' where id = $1`, [old])), FIXED);
  /* the rest of the version still changes as before */
  await as(w.db, w.editor, (tx) => tx.query(`update public.versions set editor_note = 'Hook cut tighter' where id = $1`, [v]));
  assert.equal(await one(w.db, `select editor_note from public.versions where id = $1`, [v]), "Hook cut tighter");
  assert.deepEqual(
    await rowsAs(w.db, w.owner, `select intake_via, match_method, match_confidence::float as pct from public.versions where id = $1`, [v]),
    [{ intake_via: "mass", match_method: "ai", pct: 72 }],
  );
});

/* ---------- mass uploads ---------- */

test("an editor makes a mass upload and sees it; a stranger sees nothing and cannot make one", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun, 14);
  assert.deepEqual(await rowsAs(w.db, w.editor, `select id, uploaded_by, file_count from public.edit_upload_batches`), [{ id: batch, uploaded_by: w.editor, file_count: 14 }]);
  /* everyone who opens the space sees it; the stranger opens none */
  assert.equal(await oneAs(w.db, w.editor2, `select count(*)::int from public.edit_upload_batches`), 1);
  assert.equal(await oneAs(w.db, w.owner, `select count(*)::int from public.edit_upload_batches`), 1);
  assert.equal(await oneAs(w.db, w.stranger, `select count(*)::int from public.edit_upload_batches`), 0);
  await newSuggestion(w, batch, "IMG_8841.MOV", w.cardA, 91);
  assert.equal(await oneAs(w.db, w.stranger, `select count(*)::int from public.edit_match_suggestions`), 0);
  /* the stranger cannot make one anywhere; a viewer cannot upload; nobody makes one in someone else's name or another space */
  await assert.rejects(newBatch(w, w.stranger, w.noun), RLS);
  await assert.rejects(newBatch(w, w.viewer, w.noun), RLS);
  await assert.rejects(oneAs(w.db, w.editor, `insert into public.edit_upload_batches (space_id, uploaded_by) values ($1, $2) returning id`, [w.noun, w.editor2]), RLS);
  await assert.rejects(newBatch(w, w.editor, w.founder), RLS);
  await assert.rejects(oneAs(w.db, "anon", `select count(*)::int from public.edit_upload_batches`), DENIED);
});

test("the counts are kept by the uploader or a planner; the space and the uploader are fixed", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun, 14);
  await as(w.db, w.editor, (tx) =>
    tx.query(`update public.edit_upload_batches set matched_by_code = 6, matched_by_ai = 2, matched_by_hand = 1, unmatched = 3 where id = $1`, [batch]));
  assert.deepEqual(
    await rowsAs(w.db, w.owner, `select matched_by_code, matched_by_ai, matched_by_hand, unmatched from public.edit_upload_batches where id = $1`, [batch]),
    [{ matched_by_code: 6, matched_by_ai: 2, matched_by_hand: 1, unmatched: 3 }],
  );
  /* more matches than files, or a negative count, is refused */
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`update public.edit_upload_batches set unmatched = 9 where id = $1`, [batch])), /check constraint/);
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`update public.edit_upload_batches set matched_by_ai = -1 where id = $1`, [batch])), /check constraint/);
  /* another editor changes nothing (the row is hidden from the update); the owner may */
  const r = await as(w.db, w.editor2, (tx) => tx.query(`update public.edit_upload_batches set file_count = 1 where id = $1 returning id`, [batch]));
  assert.equal(r.rows.length, 0);
  await as(w.db, w.owner, (tx) => tx.query(`update public.edit_upload_batches set file_count = 15 where id = $1`, [batch]));
  assert.equal(await one(w.db, `select file_count from public.edit_upload_batches where id = $1`, [batch]), 15);
  for (const who of [w.editor, w.owner, "service"]) {
    await assert.rejects(as(w.db, who, (tx) => tx.query(`update public.edit_upload_batches set space_id = $2 where id = $1`, [batch, w.founder])), /fixed once saved|row-level security/);
    await assert.rejects(as(w.db, who, (tx) => tx.query(`update public.edit_upload_batches set uploaded_by = $2 where id = $1`, [batch, w.owner])), /fixed once saved|row-level security/);
  }
  /* removing it is a change, never a delete */
  await as(w.db, w.editor, (tx) => tx.query(`update public.edit_upload_batches set deleted_at = now() where id = $1`, [batch]));
  assert.ok(await one(w.db, `select deleted_at from public.edit_upload_batches where id = $1`, [batch]));
});

test("nobody can delete or truncate a mass upload or an AI answer", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  const sug = await newSuggestion(w, batch, "Sequence 01.mp4", w.cardB, 61);
  for (const who of [w.editor, w.owner, "service"]) {
    await assert.rejects(as(w.db, who, (tx) => tx.query(`delete from public.edit_upload_batches where id = $1`, [batch])), DENIED);
    await assert.rejects(as(w.db, who, (tx) => tx.query(`delete from public.edit_match_suggestions where id = $1`, [sug])), DENIED);
    await assert.rejects(as(w.db, who, (tx) => tx.query(`truncate public.edit_match_suggestions`)), DENIED);
  }
  /* not even the database owner: the triggers stop it */
  await assert.rejects(w.db.query(`delete from public.edit_match_suggestions where id = $1`, [sug]), /never hard deletes/);
  await assert.rejects(w.db.query(`delete from public.edit_upload_batches where id = $1`, [batch]), /never hard deletes/);
  await assert.rejects(w.db.query(`truncate public.edit_upload_batches cascade`), /never hard deletes/);
  assert.equal(await one(w.db, `select count(*)::int from public.edit_match_suggestions`), 1);
});

/* ---------- the AI's answers ---------- */

test("only our own server writes the AI's answer; a person cannot add one or change its server owned part", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun);
  const sug = await newSuggestion(w, batch, "IMG_8841.MOV", w.cardA, 91, { cost: 0.011, alternatives: [{ card_id: w.cardB, confidence: 40, reason: "Talks about foam too." }] });
  assert.deepEqual(
    await rowsAs(w.db, w.editor, `select file_name, card_id, confidence::float as pct, cost_usd::float as cost, provider_key, model_key, ai_model_id, jsonb_array_length(alternatives) as alts from public.edit_match_suggestions`),
    [{ file_name: "IMG_8841.MOV", card_id: w.cardA, pct: 91, cost: 0.011, provider_key: "google", model_key: "gemini-4-hydrogen", ai_model_id: w.gemini, alts: 1 }],
  );
  for (const who of [w.editor, w.owner]) {
    for (const set of [`confidence = 99`, `cost_usd = 0`, `reason = 'x'`, `model_key = 'other'`, `ai_model_id = null`, `alternatives = '[]'`, `chosen_card_id = card_id`]) {
      await assert.rejects(as(w.db, who, (tx) => tx.query(`update public.edit_match_suggestions set ${set} where id = $1`, [sug])), DENIED, `${who}: ${set}`);
    }
    await assert.rejects(
      as(w.db, who, (tx) => tx.query(`insert into public.edit_match_suggestions (batch_id, file_name, provider_key, model_key) values ($1, 'x.mp4', 'google', 'gemini-4-hydrogen')`, [batch])),
      DENIED,
    );
  }
  /* the server may correct its own answer, never the file or the title it suggested */
  await as(w.db, "service", (tx) => tx.query(`update public.edit_match_suggestions set cost_usd = 0.012 where id = $1`, [sug]));
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.edit_match_suggestions set card_id = $2 where id = $1`, [sug, w.cardB])), FIXED);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.edit_match_suggestions set file_name = 'y.mp4' where id = $1`, [sug])), FIXED);
  /* the AI's answer is shaped: a title comes with a confidence, in the batch's space, a cost is never negative */
  await assert.rejects(newSuggestion(w, batch, "a.mp4", w.cardA, null), /check constraint/);
  await assert.rejects(newSuggestion(w, batch, "b.mp4", w.cardA, 101), /check constraint/);
  await assert.rejects(newSuggestion(w, batch, "c.mp4", w.cardF, 80), /space/);
  await assert.rejects(newSuggestion(w, batch, "d.mp4", w.cardA, 80, { cost: -0.01 }), /check constraint/);
  /* no title fit: a row with no card */
  assert.ok(await newSuggestion(w, batch, "VID_20261115_101422.mp4", null, null, { reason: "No speech to read." }));
});

test("the uploader chooses through decide_edit_match: who and when are theirs, the version is linked once", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun, 2);
  const sug = await newSuggestion(w, batch, "Sequence 01.mp4", w.cardB, 61);
  /* a stranger, another editor and a viewer cannot decide */
  for (const who of [w.stranger, w.editor2, w.viewer]) {
    await assert.rejects(as(w.db, who, (tx) => tx.query(`select public.decide_edit_match($1, $2)`, [sug, w.cardA])), /chooses its titles/);
  }
  await assert.rejects(as(w.db, "anon", (tx) => tx.query(`select public.decide_edit_match($1, $2)`, [sug, w.cardA])), DENIED);
  /* the uploader picks another title */
  await as(w.db, w.editor, (tx) => tx.query(`select public.decide_edit_match($1, $2)`, [sug, w.cardA]));
  const row = (await w.db.query(`select chosen_card_id, decided_by, decided_at is not null as decided, confidence::float as pct, version_id from public.edit_match_suggestions where id = $1`, [sug])).rows[0];
  assert.deepEqual(row, { chosen_card_id: w.cardA, decided_by: w.editor, decided: true, pct: 61, version_id: null });
  /* a title in another space, or one the editor cannot see, is refused */
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`select public.decide_edit_match($1, $2)`, [sug, w.cardC])), /cannot see that title/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`select public.decide_edit_match($1, $2)`, [sug, w.cardF])), /space/);
  /* saved: the version must be on the chosen title and from this batch */
  const elsewhere = await newVersion(w, w.editor, w.cardA, "a/row.mp4", { via: "row" });
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`select public.decide_edit_match($1, $2, $3)`, [sug, w.cardA, elsewhere])), /chosen title and part of this mass upload/);
  const v = await newVersion(w, w.editor, w.cardA, "a/mass.mp4", { via: "mass", method: "picked", batch });
  await as(w.db, w.editor, (tx) => tx.query(`select public.decide_edit_match($1, $2, $3)`, [sug, w.cardA, v]));
  assert.equal(await one(w.db, `select version_id from public.edit_match_suggestions where id = $1`, [sug]), v);
  /* then the choice is final, for a planner too, and the server cannot move the version */
  await assert.rejects(as(w.db, w.editor, (tx) => tx.query(`select public.decide_edit_match($1, null)`, [sug])), /already saved/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`select public.decide_edit_match($1, $2)`, [sug, w.cardB])), /already saved/);
  const v2 = await newVersion(w, w.editor, w.cardA, "a/mass2.mp4", { via: "mass", method: "picked", batch });
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.edit_match_suggestions set version_id = $2 where id = $1`, [sug, v2])), /fixed once saved/);
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.edit_match_suggestions set version_id = $2 where id = $1`, [sug, elsewhere])), /chosen title and part of this mass upload/);
  /* a planner may decide for a file of someone else's batch; "no title" is a choice too */
  const sug2 = await newSuggestion(w, batch, "untitled (2).mp4", w.cardC, 31);
  await as(w.db, w.admin, (tx) => tx.query(`select public.decide_edit_match($1, null)`, [sug2]));
  assert.deepEqual(
    (await w.db.query(`select chosen_card_id, decided_by from public.edit_match_suggestions where id = $1`, [sug2])).rows[0],
    { chosen_card_id: null, decided_by: w.admin },
  );
});

test("who sees an AI answer: the uploader, and others only when they see its title", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor2, w.noun, 3);
  await newSuggestion(w, batch, "mine.mp4", w.cardA, 91); // cardA is Olena's
  await newSuggestion(w, batch, "open.mp4", w.cardC, 55); // unassigned
  await newSuggestion(w, batch, "none.mp4", null, null);
  const names = async (who) => (await rowsAs(w.db, who, `select file_name from public.edit_match_suggestions order by file_name`)).map((r) => r.file_name);
  assert.deepEqual(await names(w.editor2), ["mine.mp4", "none.mp4", "open.mp4"], "the uploader sees every answer of the batch");
  assert.deepEqual(await names(w.editor), ["mine.mp4"], "another editor sees only the answers about her own cards");
  assert.deepEqual(await names(w.owner), ["mine.mp4", "none.mp4", "open.mp4"]);
  assert.deepEqual(await names(w.viewer), ["mine.mp4", "none.mp4", "open.mp4"], "the viewer sees every card of the space");
  assert.deepEqual(await names(w.stranger), []);
});

/* ---------- the audit trail ---------- */

test("the audit trail records the batch, the AI's answer, the version's intake and the choice", async () => {
  const w = await world();
  const batch = await newBatch(w, w.editor, w.noun, 1);
  const sug = await newSuggestion(w, batch, "IMG_8841.MOV", w.cardA, 91);
  const v = await newVersion(w, w.editor, w.cardA, "a/v1.mp4", { via: "mass", method: "ai", confidence: 91, batch });
  await as(w.db, w.editor, (tx) => tx.query(`select public.decide_edit_match($1, $2, $3)`, [sug, w.cardA, v]));
  const log = async (table, id) =>
    (await w.db.query(`select actor_type, actor_id, action, card_id, after_data from public.audit_log where entity_table = $1 and entity_id = $2 order by id`, [table, id])).rows;
  const b = await log("edit_upload_batches", batch);
  assert.equal(b[0].action, "insert");
  assert.equal(b[0].actor_type, "person");
  assert.equal(b[0].actor_id, w.editor);
  assert.equal(b[0].after_data.file_count, 1);
  const s = await log("edit_match_suggestions", sug);
  assert.deepEqual(s.map((r) => [r.action, r.actor_type]), [["insert", "system"], ["update", "person"]]);
  assert.equal(s[0].card_id, w.cardA);
  assert.equal(s[0].after_data.model_key, "gemini-4-hydrogen");
  assert.equal(s[1].actor_id, w.editor);
  assert.equal(s[1].after_data.version_id, v);
  const ver = await log("versions", v);
  assert.equal(ver[0].action, "insert");
  assert.deepEqual(
    { via: ver[0].after_data.intake_via, how: ver[0].after_data.match_method, pct: Number(ver[0].after_data.match_confidence), batch: ver[0].after_data.edit_upload_batch_id },
    { via: "mass", how: "ai", pct: 91, batch },
  );
});

/* ---------- a database that already has versions ---------- */

test("a version saved before the migration still updates after it, and keeps its intake empty", async () => {
  const w = await world({ draft: false });
  /* the old way: no intake columns exist yet */
  assert.equal(await one(w.db, `select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'versions' and column_name = 'intake_via'`), 0);
  const old = await oneAs(w.db, w.editor, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', 'old/v1.mp4', 'old.mp4') returning id`, [w.cardA]);
  const ran = await applyMigrationsFrom(w.db, INTAKE_MIGRATION);
  assert.equal(ran[0], "20261117000000_edit_intake.sql");
  /* the migration's own guard replaced the old one: the system still sets the size, as before */
  await as(w.db, "service", (tx) => tx.query(`update public.versions set size_bytes = 4120 where id = $1`, [old]));
  assert.equal(await one(w.db, `select size_bytes::text from public.versions where id = $1`, [old]), "4120");
  /* the old row reads as "not known" and cannot be filled in afterwards */
  assert.deepEqual(
    (await w.db.query(`select intake_via, match_method, match_confidence, edit_upload_batch_id from public.versions where id = $1`, [old])).rows[0],
    { intake_via: null, match_method: null, match_confidence: null, edit_upload_batch_id: null },
  );
  await assert.rejects(as(w.db, "service", (tx) => tx.query(`update public.versions set intake_via = 'row' where id = $1`, [old])), FIXED);
  /* and a new version after the migration takes the next number as always */
  const next = await newVersion(w, w.editor, w.cardA, "a/v2.mp4", { via: "row" });
  assert.equal(await one(w.db, `select number from public.versions where id = $1`, [next]), 2);
});
