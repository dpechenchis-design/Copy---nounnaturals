// Behavior tests for 20261123100000_moved_edits_uploader.sql: the edits moved from Frame.io into Noun Naturals on
// Nov 17 2026 were saved with the owner as uploader; they become Daryna's, and notes already sent on them go to her.
// Other versions (another day, another uploader, another space) stay as they are, and running it again changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, one, oneAs, rowsAs, applyMigration } from "./helpers.mjs";

const MIG = "20261123100000";
const MOVED_AT = "2026-11-17 08:21:00+00";

async function world({ withDaryna = true } = {}) {
  const db = await freshDb({ before: MIG });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  await as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ('pechenchis.daryna@gmail.com', 'strategist'), ('olena@agency.test', 'strategist')`));
  const daryna = withDaryna ? await signUp(db, "pechenchis.daryna@gmail.com", "Daryna") : null;
  const olena = await signUp(db, "olena@agency.test", "Olena");
  const space = (slug) => one(db, `select id from public.spaces where slug = $1`, [slug]);
  const card = async (slug, n) => {
    const week = await oneAs(db, owner, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, $2, $3, $4, '2026-11-09') returning id`, [await space(slug), `week-${n}`, `Week ${n}`, n]);
    return oneAs(db, owner, `insert into public.cards (week_id, title) values ($1, 'A video') returning id`, [week]);
  };
  const nounCard = await card("noun", 1);
  const founderCard = await card("founder", 1);
  /* saved the way the row upload saves it (src/lib/content/edits-db.ts: intake_via 'row') */
  const upload = async (who, cardId, key, at = MOVED_AT) => {
    const id = await oneAs(db, who, `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via) values ($1, 'edits', $2, $2, 'row') returning id`, [cardId, key]);
    await db.query(`update public.versions set created_at = $2 where id = $1`, [id, at]);
    return id;
  };
  return { db, owner, daryna, olena, nounCard, founderCard, upload };
}

const by = (db, id) => one(db, `select uploaded_by from public.versions where id = $1`, [id]);

test("the moved edits become Daryna's, and notes already sent on them go to her", async () => {
  const w = await world();
  const moved = await w.upload(w.owner, w.nounCard, "noun/week-1/moved-v1.mp4");
  await oneAs(w.db, w.owner, `insert into public.review_comments (version_id, author_id, at_ms, tag_key, body) values ($1, $2, 3000, 'captions', 'Blue text') returning id`, [moved, w.owner]);
  const sent = (await rowsAs(w.db, w.owner, `insert into public.edit_requests (version_id, sent_by) values ($1, $2) returning id, sent_to`, [moved, w.owner]))[0];
  assert.equal(sent.sent_to, w.owner, "before: the notes went back to the owner");

  await applyMigration(w.db, MIG);
  assert.equal(await by(w.db, moved), w.daryna);
  assert.equal(await one(w.db, `select sent_to from public.edit_requests where id = $1`, [sent.id]), w.daryna);
  /* a new Send now goes to her by itself */
  assert.equal(await one(w.db, `select sent_by from public.edit_requests where id = $1`, [sent.id]), w.owner);
});

test("other days, other uploaders and other spaces stay as they are; running it again changes nothing", async () => {
  const w = await world();
  const moved = await w.upload(w.owner, w.nounCard, "noun/week-1/a.mp4");
  const earlier = await w.upload(w.owner, w.nounCard, "noun/week-1/b.mp4", "2026-11-15 12:00:00+00");
  const olenas = await w.upload(w.olena, w.nounCard, "noun/week-1/c.mp4");
  const founder = await w.upload(w.owner, w.founderCard, "founder/week-1/d.mp4");
  await applyMigration(w.db, MIG);
  await applyMigration(w.db, MIG);
  assert.equal(await by(w.db, moved), w.daryna);
  assert.equal(await by(w.db, earlier), w.owner);
  assert.equal(await by(w.db, olenas), w.olena);
  assert.equal(await by(w.db, founder), w.owner);
});

test("a database without Daryna is left alone", async () => {
  const w = await world({ withDaryna: false });
  const moved = await w.upload(w.owner, w.nounCard, "noun/week-1/a.mp4");
  await applyMigration(w.db, MIG);
  assert.equal(await by(w.db, moved), w.owner);
});
