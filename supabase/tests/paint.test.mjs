/* Behavior tests for the pill paint draft migration (docs/drafts/paint-migration-draft.sql), loaded after the
   init migration on a throwaway in memory Postgres (PGlite). Nothing here touches the live Supabase project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, signUp, as, rowsAs, one, narrowEditor } from "./helpers.mjs";

const DRAFT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "drafts", "paint-migration-draft.sql");

async function world() {
  const db = await freshDb({ extra: [DRAFT] });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = async (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("olena@agency.test", "editor");
  await invite("viewer@nounnaturals.com", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const editor = await signUp(db, "olena@agency.test", "Olena");
  await narrowEditor(db, owner, editor); // the narrow editor persona: a custom role with the old Editor keys (Editor was merged into Strategist/Editor by the 20261116000000 migration)
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  return { db, owner, admin, editor, viewer };
}

const j = (v) => JSON.stringify(v);
const paintOf = (db, table, key) => one(db, `select paint from public.${table} where key = $1`, [key]);

test("the 12 preset colors are seeded, statuses keep their tokens", async () => {
  const { db } = await world();
  assert.equal(await one(db, `select count(*)::int from public.content_types where paint is not null`), 8);
  assert.equal(await one(db, `select count(*)::int from public.content_formats where paint is not null`), 4);
  assert.deepEqual(await paintOf(db, "content_types", "talking_head"), { hex: "#5A4FD8" });
  assert.deepEqual(await paintOf(db, "content_formats", "proof"), { hex: "#1FA38A" });
  assert.equal(await one(db, `select count(*)::int from public.card_statuses where paint is not null`), 0);
});

test("an admin and the owner change a color; an editor and a viewer cannot", async () => {
  const { db, owner, admin, editor, viewer } = await world();
  const r = await as(db, admin, (tx) => tx.query(`update public.content_types set paint = $1::jsonb where key = 'bts' returning key`, [j({ hex: "#2F7FD8" })]));
  assert.equal(r.rows.length, 1);
  assert.deepEqual(await paintOf(db, "content_types", "bts"), { hex: "#2F7FD8" });
  await as(db, owner, (tx) => tx.query(`update public.card_statuses set paint = $1::jsonb where key = 'review'`, [j({ gradient: "ocean-1" })]));
  assert.deepEqual(await paintOf(db, "card_statuses", "review"), { gradient: "ocean-1" });

  for (const who of [editor, viewer]) {
    const e = await as(db, who, (tx) => tx.query(`update public.content_formats set paint = $1::jsonb where key = 'proof' returning key`, [j({ hex: "#D83A3A" })]));
    assert.equal(e.rows.length, 0, "row level security hides the row from the update");
    const s = await as(db, who, (tx) => tx.query(`update public.card_statuses set paint = $1::jsonb where key = 'idea' returning key`, [j({ hex: "#D83A3A" })]));
    assert.equal(s.rows.length, 0);
  }
  assert.deepEqual(await paintOf(db, "content_formats", "proof"), { hex: "#1FA38A" });
  assert.equal(await paintOf(db, "card_statuses", "idea"), null);
});

test("everyone active reads the colors", async () => {
  const { db, admin, editor, viewer } = await world();
  await as(db, admin, (tx) => tx.query(`update public.card_statuses set paint = $1::jsonb where key = 'shot'`, [j({ hex: "#3F9A4A" })]));
  for (const who of [admin, editor, viewer]) {
    const rows = await rowsAs(db, who, `select key, paint from public.card_statuses where key = 'shot'`);
    assert.deepEqual(rows, [{ key: "shot", paint: { hex: "#3F9A4A" } }]);
    assert.equal((await rowsAs(db, who, `select key from public.content_types where paint is not null`)).length, 8);
  }
});

test("bad shapes are refused by the domain", async () => {
  const { db, admin } = await world();
  const bad = [
    { hex: "red" },
    { hex: "#FFF" },
    { hex: "#2F7FD8", gradient: "x" },
    { gradient: "" },
    { stops: ["#AAAAAA"] },
    { stops: ["#AAAAAA", "blue"] },
    { stops: ["#AAAAAA", "#BBBBBB"], type: "conic" },
    { stops: ["#AAAAAA", "#BBBBBB"], angle: "90" },
    {},
    ["#2F7FD8"],
    "#2F7FD8",
  ];
  for (const v of bad) {
    await assert.rejects(
      as(db, admin, (tx) => tx.query(`update public.content_types set paint = $1::jsonb where key = 'drop'`, [JSON.stringify(v)])),
      /pill_paint|violates check constraint/,
      JSON.stringify(v),
    );
  }
  /* good shapes and back to the default */
  for (const v of [{ hex: "#2f7fd8" }, { gradient: "ui-sunset" }, { stops: ["#AAAAAA", "#BBBBBB", "#CCCCCC"], angle: 90, type: "radial" }, null]) {
    await as(db, admin, (tx) => tx.query(`update public.content_types set paint = $1::jsonb where key = 'drop'`, [v === null ? null : JSON.stringify(v)]));
  }
  assert.equal(await paintOf(db, "content_types", "drop"), null);
});

test("a system status still cannot change its key or stage", async () => {
  const { db, admin } = await world();
  await as(db, admin, (tx) => tx.query(`update public.card_statuses set paint = $1::jsonb where key = 'edits'`, [j({ hex: "#D83A3A" })]));
  await assert.rejects(as(db, admin, (tx) => tx.query(`update public.card_statuses set key = 'fixes', paint = $1::jsonb where key = 'edits'`, [j({ hex: "#E8603C" })])), /key and stage cannot change/);
  await assert.rejects(as(db, admin, (tx) => tx.query(`update public.card_statuses set stage = 'posted' where key = 'edits'`)), /key and stage cannot change/);
  assert.equal(await one(db, `select key || ':' || stage from public.card_statuses where key = 'edits'`), "edits:review");
});

test("one audit_log row per change, with the old and the new paint", async () => {
  const { db, admin } = await world();
  const before = await one(db, `select count(*)::int from public.audit_log where entity_table = 'content_formats'`);
  await as(db, admin, (tx) => tx.query(`update public.content_formats set paint = $1::jsonb where key = 'education'`, [j({ hex: "#5A4FD8" })]));
  const rows = (
    await db.query(
      `select actor_id, action, changed_fields, before_data, after_data from public.audit_log where entity_table = 'content_formats' order by id desc`,
    )
  ).rows;
  assert.equal(rows.length, before + 1);
  const row = rows[0];
  assert.equal(row.actor_id, admin);
  assert.equal(row.action, "update");
  assert.deepEqual(row.changed_fields, ["paint"]);
  assert.deepEqual(row.before_data, { paint: { hex: "#2F7FD8" } });
  assert.deepEqual(row.after_data, { paint: { hex: "#5A4FD8" } });
});
