// Behavior tests for 20261120000000_notion_scripts.sql: the Notion page of each imported row (script, caption,
// reference, facts) fills the card's Script, matched by space, week number and title, and only while it is empty.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, one, applyMigration } from "./helpers.mjs";

const MIG = "20261120000000";
const CALL_OUT = "Call-out: That silky feeling might be a coating";

async function world() {
  const db = await freshDb({ before: MIG });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  const ids = await as(db, owner, async (tx) => {
    const week = async (space, n, name, number = n) =>
      (await tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on, sort_order) values ($1, $2, $3, $4, $5, $6) returning id`,
        [space, `week-${n}`, name, number, ["2026-11-02", "2026-11-09"][n - 1], n])).rows[0].id;
    const card = async (w, title, order, script = "[]") =>
      (await tx.query(`insert into public.cards (week_id, title, sort_order, script_sections) values ($1, $2, $3, $4::jsonb) returning id`, [w, title, order, script])).rows[0].id;
    const w1 = await week(noun, 1, "Week 1");
    const w2 = await week(noun, 2, "Week 2", null); /* no number: read from the name */
    const f1 = await week(founder, 1, "Week 1");
    return {
      callOut: await card(w1, `  ${CALL_OUT} `, 1),
      typed: await card(w1, "Comment reply: My scalp is dry and itchy", 2, JSON.stringify([{ heading: "Script", text: "Typed by the team" }])),
      unknown: await card(w1, "A row that was never in Notion", 3),
      wrongWeek: await card(w2, CALL_OUT, 1),
      founderWrong: await card(f1, CALL_OUT, 1),
    };
  });
  return { db, ids };
}

const script = (db, id) => one(db, `select script_sections from public.cards where id = $1`, [id]);
const text = (secs, h) => secs.filter((s) => s.heading.toLowerCase().replace(/[^a-z]/g, "") === h).map((s) => s.text).join("\n");

test("an imported row gets its Notion script and caption; typed scripts and other weeks stay as they were", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  const got = await script(w.db, w.ids.callOut);
  assert.match(text(got, "script"), /That silky feeling from your conditioner/);
  assert.match(text(got, "caption"), /#nounnaturals/);
  assert.match(text(got, "reference"), /@nounnaturals/);
  assert.deepEqual(await script(w.db, w.ids.typed), [{ heading: "Script", text: "Typed by the team" }]);
  assert.deepEqual(await script(w.db, w.ids.unknown), []);
  assert.deepEqual(await script(w.db, w.ids.wrongWeek), []);
  assert.deepEqual(await script(w.db, w.ids.founderWrong), []);
});

test("two live weeks with the same number in one space: neither is filled", async () => {
  const db = await freshDb({ before: MIG });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const cards = await as(db, owner, async (tx) => {
    const out = [];
    for (const [slug, start] of [["week-1", "2026-11-02"], ["week-1-copy", "2026-11-09"]]) {
      const w = (await tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, $2, 'Week 1', 1, $3) returning id`, [noun, slug, start])).rows[0].id;
      out.push((await tx.query(`insert into public.cards (week_id, title, sort_order) values ($1, $2, 1) returning id`, [w, CALL_OUT])).rows[0].id);
    }
    return out;
  });
  await applyMigration(db, MIG);
  for (const id of cards) assert.deepEqual(await script(db, id), []);
});

test("running it again changes nothing, and a database without the weeks is left alone", async () => {
  const w = await world();
  await applyMigration(w.db, MIG);
  const first = await script(w.db, w.ids.callOut);
  await applyMigration(w.db, MIG);
  assert.deepEqual(await script(w.db, w.ids.callOut), first);
  const empty = await freshDb({ before: MIG });
  await applyMigration(empty, MIG);
  assert.equal(await one(empty, `select count(*)::int from public.cards where script_sections <> '[]'::jsonb`), 0);
});
