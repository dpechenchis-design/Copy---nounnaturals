// Behavior tests for 20261121100000_frameio_links_founder.sql: Frame.io links added in Notion after the import fill
// an empty Edited video, replace only the exact old link, skip a title two cards of a week share, and the card is
// marked Shot before Noun ART.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, one, applyMigration } from "./helpers.mjs";

const MIG = "20261121100000";

async function world() {
  const db = await freshDb({ before: MIG });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  const ids = await as(db, owner, async (tx) => {
    const week = async (space, n, start, number = n) =>
      (await tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, $2, $3, $4, $5) returning id`, [space, `week-${n}`, `Week ${n}`, number, start])).rows[0].id;
    const card = async (w, title, order, extra = {}, day = null) =>
      (await tx.query(`insert into public.cards (week_id, title, sort_order, extra, planned_on) values ($1, $2, $3, $4::jsonb, $5) returning id`, [w, title, order, JSON.stringify(extra), day])).rows[0].id;
    const f1 = await week(founder, 1, "2026-11-16");
    const n1 = await week(noun, 1, "2026-11-02");
    const n2 = await week(noun, 2, "2026-11-09", null); /* no number: read from the name */
    return {
      started: await card(f1, "Why I started Noun", 1, {}, "2026-11-16"),
      setByHand: await card(f1, "The 0.5% label trick", 2, { "Edited video": "https://example.com/mine" }),
      seaSaltA: await card(f1, "Sea salt", 3),
      seaSaltB: await card(f1, "sea  salt", 4),
      live: await card(n1, "Live", 1, { "Edited video": "https://f.io/CvknLsVq" }),
      pt1: await card(n2, "Freestyle Sea Salt Spray Delivery PT1", 1, { "Edited video": "https://f.io/kIZRsxPV" }),
    };
  });
  return { db, ids };
}

const extra = (db, id) => one(db, `select extra from public.cards where id = $1`, [id]);
const shot = (db, id) => one(db, `select shot_at is not null from public.cards where id = $1`, [id]);

test("a new Founder link fills the empty card and marks it shot; a link set by hand stays", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  const e = await extra(w.db, w.ids.started);
  assert.equal(e["Edited video"], "https://f.io/iLw0Wsiv");
  assert.ok(e["Shot before Noun ART"]);
  assert.equal(await shot(w.db, w.ids.started), true);
  assert.equal((await extra(w.db, w.ids.setByHand))["Edited video"], "https://example.com/mine");
});

test("a title two cards of a week share is skipped; a newer link replaces only the exact old one", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  assert.equal((await extra(w.db, w.ids.seaSaltA))["Edited video"], undefined);
  assert.equal((await extra(w.db, w.ids.seaSaltB))["Edited video"], undefined);
  assert.equal((await extra(w.db, w.ids.pt1))["Edited video"], "https://f.io/2sg8rXYD");
  assert.equal((await extra(w.db, w.ids.live))["Edited video"], "https://f.io/CvknLsVq");
});

test("running it again changes nothing, and a database without the weeks is left alone", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  const before = await extra(w.db, w.ids.started);
  await applyMigration(w.db, MIG);
  assert.deepEqual(await extra(w.db, w.ids.started), before);
  const empty = await freshDb({ before: MIG });
  await applyMigration(empty, MIG);
  assert.equal(await one(empty, `select count(*)::int from public.cards`), 0);
});
