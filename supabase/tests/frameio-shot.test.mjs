// Behavior tests for 20261120100000_frameio_shot.sql (it was the draft docs/drafts/frameio-shot-migration-draft.sql;
// supabase/migrations/20261120100000_frameio_shot.sql on its own push): every live card with an edited video link
// and no Shot yet is ticked as shot before Noun ART; hand ticks, cards without a link and removed cards stay as they
// were; running it again changes nothing. While it is a draft the suite runs the draft; once live, the live file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, signUp, as, one, applyMigration } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIG = "20261120100000";
const LIVE = readdirSync(join(ROOT, "supabase", "migrations")).some((f) => f.startsWith(MIG));
const DRAFT = join(ROOT, "docs", "drafts", "frameio-shot-migration-draft.sql");
const run = (db) => (LIVE ? applyMigration(db, MIG) : db.exec(readFileSync(DRAFT, "utf8")));
const LINK = "https://f.io/jnOIJopy";

async function world() {
  const db = await freshDb(LIVE ? { before: MIG } : {});
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const ids = await as(db, owner, async (tx) => {
    const w = (await tx.query(`insert into public.weeks (space_id, slug, name, number, starts_on, sort_order) values ($1, 'week-1', 'Week 1', 1, '2026-11-02', 1) returning id`, [noun])).rows[0].id;
    const card = async (title, order, extra, day = null) =>
      (await tx.query(`insert into public.cards (week_id, title, sort_order, extra, planned_on) values ($1, $2, $3, $4::jsonb, $5) returning id`, [w, title, order, JSON.stringify(extra), day])).rows[0].id;
    const ids = {
      linked: await card("Call-out", 1, { "Edited video": LINK }, "2026-11-02"),
      noDay: await card("No day", 2, { "Edited video": LINK }),
      noLink: await card("Nothing edited", 3, {}),
      blank: await card("Blank link", 4, { "Edited video": "  " }),
      byHand: await card("Ticked by hand", 5, { "Edited video": LINK }),
      removed: await card("Removed", 6, { "Edited video": LINK }),
    };
    await tx.query(`select public.set_card_shot($1, true)`, [ids.byHand]);
    await tx.query(`update public.cards set deleted_at = now() where id = $1`, [ids.removed]);
    return ids;
  });
  return { db, owner, ids };
}

const shot = (db, id) => one(db, `select json_build_object('at', shot_at, 'by', shot_by, 'mark', extra -> 'Shot before Noun ART') from public.cards where id = $1`, [id]);

test("a card with an edited video link is ticked as shot before Noun ART, at noon New York on its day", async () => {
  const w = await world();
  const handBefore = await shot(w.db, w.ids.byHand);
  await run(w.db);
  const linked = await shot(w.db, w.ids.linked);
  assert.equal(Date.parse(linked.mark), Date.parse(linked.at), "the mark holds the time it saved");
  assert.ok(linked.by, "Shot names a person");
  assert.equal(new Date(linked.at).toISOString(), "2026-11-02T17:00:00.000Z");
  const noDay = await shot(w.db, w.ids.noDay);
  assert.equal(Date.parse(noDay.mark), Date.parse(noDay.at));
  assert.ok(noDay.at);
  for (const k of ["noLink", "blank", "removed"]) assert.deepEqual(await shot(w.db, w.ids[k]), { at: null, by: null, mark: null }, k);
  assert.deepEqual(await shot(w.db, w.ids.byHand), handBefore);
  assert.equal(handBefore.mark, null);
});

test("running it again changes nothing, and a database without such cards is left alone", async () => {
  const w = await world();
  await run(w.db);
  const first = await shot(w.db, w.ids.linked);
  await run(w.db);
  assert.deepEqual(await shot(w.db, w.ids.linked), first);
  const empty = await freshDb(LIVE ? { before: MIG } : {});
  await run(empty);
  assert.equal(await one(empty, `select count(*)::int from public.cards where shot_at is not null`), 0);
});

test("the draft or the live file exists", () => {
  assert.ok(LIVE || existsSync(DRAFT));
});
