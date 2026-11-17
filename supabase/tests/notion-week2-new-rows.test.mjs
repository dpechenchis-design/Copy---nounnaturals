// Behavior tests for 20261121200000_notion_week2_new_rows.sql: the seven Week 2 rows added in Notion after the import
// become cards in Noun Naturals Week 2 with their day, type, formats, TikTok and Frame.io link, marked shot; a title the
// week already has is skipped, running it again adds nothing, and a database without that week is left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, one, applyMigration } from "./helpers.mjs";

const MIG = "20261121200000";

async function world({ withWeek = true } = {}) {
  const db = await freshDb({ before: MIG });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const ids = await as(db, owner, async (tx) => {
    if (!withWeek) return {};
    const w2 = (await tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-2', 'Week 2', 2, '2026-11-09') returning id`, [noun])).rows[0].id;
    await tx.query(`insert into public.cards (week_id, title, sort_order) values ($1, 'SS Freestyle C0017', 40)`, [w2]);
    const byHand = (await tx.query(`insert into public.cards (week_id, title, sort_order, extra) values ($1, 'freestyle  tag sss promo', 41, '{"Edited video":"https://example.com/mine"}'::jsonb) returning id`, [w2])).rows[0].id;
    return { w2, byHand };
  });
  return { db, owner, ids };
}

const rows = (db, week) =>
  db.query(
    `select c.title, c.planned_on::text as day, c.type_key, s.key as status, c.extra, c.sort_order, c.source, c.notion_page_id,
            c.shot_at is not null as shot,
            (select array_agg(f.format_key order by f.sort_order) from public.card_formats f where f.card_id = c.id and f.deleted_at is null) as formats,
            (select array_agg(p.platform_key) from public.card_platforms p where p.card_id = c.id and p.deleted_at is null) as platforms
       from public.cards c join public.card_statuses s on s.id = c.status_id
      where c.week_id = $1 and c.source = 'notion_import' order by c.sort_order`,
    [week],
  ).then((r) => r.rows);

test("the new Notion rows become Week 2 cards with their day, type, formats, TikTok, link and the Shot mark", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  const list = await rows(w.db, w.ids.w2);
  assert.equal(list.length, 6, "six added; the seventh title is already in the week");
  const damp = list.find((r) => r.title === "Freestyle Damp vs Dry SSS");
  assert.equal(damp.day, "2026-11-15", "Sunday of the week starting Monday Nov 9");
  assert.equal(damp.type_key, "talking_head");
  assert.equal(damp.status, "qa");
  assert.deepEqual(damp.formats, ["education", "connection"]);
  assert.deepEqual(damp.platforms, ["tiktok"]);
  assert.equal(damp.extra["Edited video"], "https://f.io/j3iwYjDm");
  assert.ok(damp.extra["Shot before Noun ART"]);
  assert.equal(damp.shot, true);
  assert.equal(damp.notion_page_id, "41909f44-7f80-809e-b284-df6f63060cfe");
  assert.ok(list.every((r) => r.sort_order > 41), "after the week's other cards");
  assert.equal(list.find((r) => r.title.startsWith("Freestyle Why People")).day, "2026-11-09");
});

test("a title the week already has keeps its own link; running it again adds nothing", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  assert.equal((await one(w.db, `select extra from public.cards where id = $1`, [w.ids.byHand]))["Edited video"], "https://example.com/mine");
  await applyMigration(w.db, MIG);
  assert.equal((await rows(w.db, w.ids.w2)).length, 6);
  assert.equal(await one(w.db, `select count(*)::int from public.card_formats`), 9);
});

test("a database without Week 2 is left alone", async () => {
  const w = await world({ withWeek: false });
  await applyMigration(w.db, MIG);
  assert.equal(await one(w.db, `select count(*)::int from public.cards`), 0);
});
