// Behavior tests for the draft supabase/drafts/20261123200000_moved_edits_team.sql: the edits moved into Noun Naturals
// on Nov 17 2026 (made Daryna's by 20261123100000_moved_edits_uploader) lose their uploader, so their notes go to the
// whole editing team (edit_requests.sent_to null), and notes already sent on them to Daryna go to the team too. A card
// with an editor still sends to that editor; an edit uploaded in the app still goes only to the person who uploaded it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { freshDb, draftOrLive, signUp, as, one, oneAs, rowsAs, applyMigration } from "./helpers.mjs";

const DRAFT = draftOrLive("_moved_edits_team.sql");
/** Run the draft on the world as it is now, as Supabase runs a migration (nobody signed in). Once it is live,
    freshDb() ran it already on the empty database, where it changes nothing. */
const runDraft = (db) => db.exec(readFileSync(DRAFT.path, "utf8"));

const MOVED_AT = "2026-11-17 08:21:00+00";

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  await as(db, owner, (tx) =>
    tx.query(`insert into public.invites (email, role) values ('pechenchis.daryna@gmail.com', 'strategist'), ('olena@agency.test', 'strategist'), ('ivan@agency.test', 'strategist')`),
  );
  const daryna = await signUp(db, "pechenchis.daryna@gmail.com", "Daryna");
  const olena = await signUp(db, "olena@agency.test", "Olena");
  const ivan = await signUp(db, "ivan@agency.test", "Ivan");
  const space = (slug) => one(db, `select id from public.spaces where slug = $1`, [slug]);
  let weeks = 0;
  const card = async (slug, editor = null) => {
    weeks += 1;
    const week = await oneAs(db, owner, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, $2, $3, $4, '2026-11-09') returning id`, [await space(slug), `week-${weeks}`, `Week ${weeks}`, weeks]);
    const id = await oneAs(db, owner, `insert into public.cards (week_id, title) values ($1, 'A video') returning id`, [week]);
    if (editor) await as(db, owner, (tx) => tx.query(`update public.cards set assigned_editor_id = $2 where id = $1`, [id, editor]));
    return id;
  };
  /* saved the way the row upload saves it (src/lib/content/edits-db.ts: intake_via 'row') */
  const upload = async (who, cardId, key, at = MOVED_AT) => {
    const id = await oneAs(db, who, `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via) values ($1, 'edits', $2, $2, 'row') returning id`, [cardId, key]);
    await db.query(`update public.versions set created_at = $2 where id = $1`, [id, at]);
    return id;
  };
  /* one note, then Send to editor, as the owner presses it on Review */
  const send = async (versionId) => {
    await oneAs(db, owner, `insert into public.review_comments (version_id, author_id, at_ms, tag_key, body) values ($1, $2, 3000, 'captions', 'Blue text') returning id`, [versionId, owner]);
    return (await rowsAs(db, owner, `insert into public.edit_requests (version_id, sent_by) values ($1, $2) returning id, sent_to`, [versionId, owner]))[0];
  };
  /* the move: the agent uploaded as the owner, then 20261123100000_moved_edits_uploader handed the videos (and notes
     sent on them) to Daryna, which leaves its audit row */
  const handOver = () => applyMigration(db, "20261123100000");
  return { db, owner, daryna, olena, ivan, card, upload, send, handOver };
}

const by = (db, id) => one(db, `select uploaded_by from public.versions where id = $1`, [id]);
const sentTo = (db, id) => one(db, `select sent_to from public.edit_requests where id = $1`, [id]);

test("a moved v1 loses its uploader, and notes already sent on it to Daryna go to the team", async () => {
  const w = await world();
  const moved = await w.upload(w.owner, await w.card("noun"), "noun/week-1/moved-v1.mp4");
  const before = await w.send(moved);
  await w.handOver();
  assert.equal(await sentTo(w.db, before.id), w.daryna, "before: the notes went to Daryna alone");

  await runDraft(w.db);
  assert.equal(await by(w.db, moved), null);
  assert.equal(await sentTo(w.db, before.id), null);

  /* a new note and Send on it goes to the team too */
  const again = await w.send(moved);
  assert.equal(again.sent_to, null, "a new Send goes to the whole team");
});

test("a moved video on a title with an editor still sends to that editor", async () => {
  const w = await world();
  const moved = await w.upload(w.owner, await w.card("noun", w.olena), "noun/week-1/editor.mp4");
  const sent = await w.send(moved);
  await w.handOver();
  await runDraft(w.db);
  assert.equal(await by(w.db, moved), null);
  assert.equal(await sentTo(w.db, sent.id), w.olena, "notes already sent go to the title's editor");
  assert.equal((await w.send(moved)).sent_to, w.olena);
});

test("a later upload by Daryna, the founder space and other uploaders stay as they are; v2 by Olena sends to Olena", async () => {
  const w = await world();
  const nounCard = await w.card("noun");
  const moved = await w.upload(w.owner, nounCard, "noun/week-1/a.mp4");
  const ownInWindow = await w.upload(w.daryna, await w.card("noun"), "noun/week-4/own.mp4");
  const later = await w.upload(w.daryna, await w.card("noun"), "noun/week-2/b.mp4", "2026-11-17 10:00:00+00");
  const founder = await w.upload(w.owner, await w.card("founder"), "founder/week-1/c.mp4");
  const olenas = await w.upload(w.olena, await w.card("noun"), "noun/week-3/d.mp4");
  const laterSent = await w.send(later);

  await w.handOver();
  await runDraft(w.db);
  assert.equal(await by(w.db, moved), null);
  assert.equal(await by(w.db, later), w.daryna);
  assert.equal(await by(w.db, ownInWindow), w.daryna, "a video she uploaded herself in the window stays hers");
  assert.equal(await by(w.db, founder), w.owner);
  assert.equal(await by(w.db, olenas), w.olena);
  assert.equal(await sentTo(w.db, laterSent.id), w.daryna, "notes on her own later upload stay hers");

  /* Olena uploads v2 of the moved title in the app: its notes go only to her */
  const v2 = await w.upload(w.olena, nounCard, "noun/week-1/a-v2.mp4", "2026-11-17 12:00:00+00");
  assert.equal((await w.send(v2)).sent_to, w.olena);
});

test("another person on the editing team reads the team's send and its notes", async () => {
  const w = await world();
  const moved = await w.upload(w.owner, await w.card("noun"), "noun/week-1/team.mp4");
  await w.handOver();
  await runDraft(w.db);
  const sent = await w.send(moved);
  assert.equal(sent.sent_to, null);
  const seen = await rowsAs(w.db, w.ivan, `select id from public.edit_requests where sent_to is null`);
  assert.deepEqual(seen.map((r) => r.id), [sent.id]);
  const notes = await rowsAs(w.db, w.ivan, `select body from public.review_comments where edit_request_id = $1`, [sent.id]);
  assert.deepEqual(notes.map((n) => n.body), ["Blue text"]);
});

test("running it again changes nothing; a database without Daryna is left alone", async () => {
  const w = await world();
  const moved = await w.upload(w.owner, await w.card("noun"), "noun/week-1/twice.mp4");
  const sent = await w.send(moved);
  await w.handOver();
  await runDraft(w.db);
  const snapshot = async () => [await by(w.db, moved), await sentTo(w.db, sent.id), await one(w.db, `select count(*)::int from public.versions where uploaded_by is null`)];
  const once = await snapshot();
  await runDraft(w.db);
  assert.deepEqual(await snapshot(), once);

  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const s = await one(db, `select id from public.spaces where slug = 'noun'`);
  const week = await oneAs(db, owner, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-09') returning id`, [s]);
  const c = await oneAs(db, owner, `insert into public.cards (week_id, title) values ($1, 'A video') returning id`, [week]);
  const v = await oneAs(db, owner, `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via) values ($1, 'edits', 'k.mp4', 'k.mp4', 'row') returning id`, [c]);
  await db.query(`update public.versions set created_at = $2 where id = $1`, [v, MOVED_AT]);
  await runDraft(db);
  assert.equal(await by(db, v), owner);
});
