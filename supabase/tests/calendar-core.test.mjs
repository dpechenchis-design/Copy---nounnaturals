// Behavior tests for the Calendar core on the database (no new migration: the tables, row level security and
// public.set_card_shot of the existing migrations). Each test does what src/lib/content/calendar-actions.ts does,
// with the same person's session: add a week and rows, change a row, Remove and Restore, tick Shot, save an import.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one, oneSpaceStrategist } from "./helpers.mjs";

const RLS = /row-level security/;

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("strat@nounnaturals.com", "strategist");
  await inv("noplan@agency.test", "strategist");
  await inv("outsider@agency.test", "strategist");
  const planner = await signUp(db, "strat@nounnaturals.com", "Daryna");
  const noPlan = await signUp(db, "noplan@agency.test", "Olena");
  const outsider = await signUp(db, "outsider@agency.test", "Taras");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  const founder = await one(db, `select id from public.spaces where slug = 'founder'`);
  /* Strategist/Editor opens every space (spaces.all, owner Nov 16 2026), so the people here hold custom roles that open
     only the spaces given to them: the planner and the outsider everything Strategist/Editor has but spaces.all, the
     shooter that minus calendar.plan */
  const plannerRole = await oneSpaceStrategist(db, owner, "Planner", [], planner, outsider);
  const shooterRole = await oneSpaceStrategist(db, owner, "Shooter", ["calendar.plan"], noPlan);
  /* spaces: the planner and the shooter open Noun Naturals only; the outsider opens none */
  await as(db, owner, async (tx) => {
    for (const p of [planner, noPlan]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  return { db, owner, planner, noPlan, outsider, noun, founder, plannerRole, shooterRole };
}

const addWeek = (db, who, space, start, n) =>
  oneAs(db, who, `insert into public.weeks (space_id, slug, name, number, starts_on, sort_order) values ($1, $2, $3, $4, $5, $4) returning id`, [space, `week-${n}`, `Week ${n}`, n, start]);

/** A row as addRows saves it: the card, then its formats and platforms. */
async function addCard(db, who, week, { title = "Why our shampoo foams", status = null, day = null, type = null, formats = [], platforms = [], extra = {} } = {}) {
  return as(db, who, async (tx) => {
    const statusId = status ? (await tx.query(`select id from public.card_statuses where key = $1`, [status])).rows[0].id : null;
    const id = (
      await tx.query(
        `insert into public.cards (week_id, space_id, title, status_id, planned_on, type_key, source, extra)
         values ($1, (select space_id from public.weeks where id = $1), $2, coalesce($3, (select id from public.card_statuses where key = 'idea')), $4, $5, 'app', $6) returning id`,
        [week, title, statusId, day, type, extra],
      )
    ).rows[0].id;
    for (const [i, f] of formats.entries()) await tx.query(`insert into public.card_formats (card_id, format_key, sort_order) values ($1, $2, $3)`, [id, f, i]);
    for (const p of platforms) await tx.query(`insert into public.card_platforms (card_id, platform_key) values ($1, $2)`, [id, p]);
    return id;
  });
}

test("a planner adds a week and rows in a space they open; the owner sees them", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  const card = await addCard(w.db, w.planner, week, { day: "2026-11-18", type: "talking_head", formats: ["education", "proof"], platforms: ["tiktok", "instagram"] });
  const seen = await rowsAs(
    w.db,
    w.owner,
    `select c.title, c.planned_on::text, s.key as status, c.type_key, c.created_by = $2 as mine,
            (select array_agg(format_key order by sort_order) from public.card_formats where card_id = c.id and deleted_at is null) as formats,
            (select array_agg(platform_key order by platform_key) from public.card_platforms where card_id = c.id and deleted_at is null) as platforms
       from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`,
    [card, w.planner],
  );
  assert.deepEqual(seen, [{ title: "Why our shampoo foams", planned_on: "2026-11-18", status: "idea", type_key: "talking_head", mine: true, formats: ["education", "proof"], platforms: ["instagram", "tiktok"] }]);
  /* the week is the planner's; a cell change saves; the status change is logged */
  await as(w.db, w.planner, (tx) => tx.query(`update public.cards set title = 'New name', status_id = (select id from public.card_statuses where key = 'planned') where id = $1`, [card]));
  assert.equal(await one(w.db, `select title from public.cards where id = $1`, [card]), "New name");
  assert.equal(await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [card]), 2);
  /* the database's own rules: a week starts on a Monday, one live slug per space, a day inside the week */
  await assert.rejects(addWeek(w.db, w.planner, w.noun, "2026-11-17", 2), /check constraint/);
  await assert.rejects(addWeek(w.db, w.planner, w.noun, "2026-11-23", 1), /duplicate key/);
  await assert.rejects(addCard(w.db, w.planner, week, { day: "2026-11-24" }), /not in the week starting/);
  /* a value that is not in a list is refused, which is why the app matches values first */
  await assert.rejects(addCard(w.db, w.planner, week, { type: "live" }), /foreign key/);
  /* a space they do not open: no week there */
  await assert.rejects(addWeek(w.db, w.planner, w.founder, "2026-11-16", 1), RLS);
});

test("a role without calendar.plan cannot add or change weeks, rows or imports, but still reads them", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  const card = await addCard(w.db, w.owner, week, { formats: ["education"] });
  await assert.rejects(addWeek(w.db, w.noPlan, w.noun, "2026-11-23", 2), RLS);
  await assert.rejects(addCard(w.db, w.noPlan, week), RLS);
  await assert.rejects(as(w.db, w.noPlan, (tx) => tx.query(`insert into public.card_formats (card_id, format_key) values ($1, 'proof')`, [card])), RLS);
  await assert.rejects(
    as(w.db, w.noPlan, (tx) => tx.query(`insert into public.import_batches (space_id, week_id, source_kind) values ($1, $2, 'csv')`, [w.noun, week])),
    RLS,
  );
  /* an update is simply not applied: no row is changed (the action answers "You may not change this row") */
  const changed = await rowsAs(w.db, w.noPlan, `update public.cards set title = 'x' where id = $1 returning id`, [card]);
  assert.deepEqual(changed, []);
  const removed = await rowsAs(w.db, w.noPlan, `update public.cards set deleted_at = now() where id = $1 returning id`, [card]);
  assert.deepEqual(removed, []);
  assert.equal(await one(w.db, `select title || ':' || (deleted_at is null) from public.cards where id = $1`, [card]), "Why our shampoo foams:true");
  /* it still sees the space, the week and the row (calendar.all_cards) */
  assert.equal(await oneAs(w.db, w.noPlan, `select count(*)::int from public.cards where week_id = $1`, [week]), 1);
});

test("a person without the space sees nothing of it and cannot tick Shot there", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  const card = await addCard(w.db, w.owner, week);
  assert.deepEqual(await rowsAs(w.db, w.outsider, `select id from public.spaces`), []);
  assert.deepEqual(await rowsAs(w.db, w.outsider, `select id from public.weeks`), []);
  assert.deepEqual(await rowsAs(w.db, w.outsider, `select id from public.cards`), []);
  assert.deepEqual(await rowsAs(w.db, w.outsider, `select id from public.card_formats`), []);
  await assert.rejects(rowsAs(w.db, w.outsider, `select public.set_card_shot($1, true)`, [card]), /cannot see that card/);
  await assert.rejects(addCard(w.db, w.outsider, week), RLS);
  /* the planner sees only their own space */
  assert.deepEqual((await rowsAs(w.db, w.planner, `select slug from public.spaces order by slug`)).map((r) => r.slug), ["noun"]);
});

test("Shot saves who and when and leaves the status alone", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  const card = await addCard(w.db, w.owner, week, { status: "planned" });
  const changes = await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [card]);
  /* the shooter has no calendar.plan: Shot needs only sight of the card */
  const ticked = await oneAs(w.db, w.noPlan, `select to_jsonb(public.set_card_shot($1, true))`, [card]);
  assert.equal(ticked.shot_by, w.noPlan);
  assert.ok(ticked.shot_at);
  const after = (await w.db.query(`select s.key, c.shot_by from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [card])).rows[0];
  assert.deepEqual(after, { key: "planned", shot_by: w.noPlan });
  assert.equal(await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [card]), changes);
  /* a second tick keeps the first stamp; untick clears both */
  const again = await oneAs(w.db, w.planner, `select to_jsonb(public.set_card_shot($1, true))`, [card]);
  assert.equal(again.shot_by, w.noPlan);
  const unticked = await oneAs(w.db, w.planner, `select to_jsonb(public.set_card_shot($1, false))`, [card]);
  assert.deepEqual([unticked.shot_at, unticked.shot_by], [null, null]);
  assert.equal(await one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [card]), "planned");
  /* the stamp is never typed: a planner writing it gets themselves and now */
  await as(w.db, w.planner, (tx) => tx.query(`update public.cards set shot_at = '2020-01-01', shot_by = $2 where id = $1`, [card, w.owner]));
  const typed = (await w.db.query(`select shot_by, shot_at > now() - interval '1 minute' as fresh from public.cards where id = $1`, [card])).rows[0];
  assert.deepEqual(typed, { shot_by: w.planner, fresh: true });
});

test("Remove is soft: the row stays with deleted_at, Restore brings it back, a hard delete is refused", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.owner, w.noun, "2026-11-16", 1);
  const card = await addCard(w.db, w.planner, week);
  const gone = await rowsAs(w.db, w.planner, `update public.cards set deleted_at = now() where id = $1 and deleted_at is null returning id`, [card]);
  assert.equal(gone.length, 1);
  assert.ok(await one(w.db, `select deleted_at from public.cards where id = $1`, [card]));
  /* the week table reads live rows only */
  assert.equal(await oneAs(w.db, w.planner, `select count(*)::int from public.cards where week_id = $1 and deleted_at is null`, [week]), 0);
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'cards' and entity_id = $1 and action = 'soft_delete'`, [card]), 1);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.cards where id = $1`, [card])), /permission denied|not allowed|never deleted|delete/i);
  await assert.rejects(w.db.query(`delete from public.cards where id = $1`, [card]), /delete/i);
  const back = await rowsAs(w.db, w.planner, `update public.cards set deleted_at = null where id = $1 and deleted_at is not null returning id`, [card]);
  assert.equal(back.length, 1);
  assert.equal(await oneAs(w.db, w.planner, `select count(*)::int from public.cards where week_id = $1 and deleted_at is null`, [week]), 1);
});

test("an import batch ties to its cards, by the person who imported, in its week's space", async () => {
  const w = await world();
  const week = await addWeek(w.db, w.planner, w.noun, "2026-11-16", 1);
  const other = await addWeek(w.db, w.owner, w.founder, "2026-11-16", 1);
  const batch = await as(w.db, w.planner, async (tx) => {
    const id = (
      await tx.query(
        `insert into public.import_batches (space_id, week_id, source_kind, file_name, rows_in, row_count, column_matches, value_fixes, unmatched)
         values ($1, $2, 'csv', 'Week 1.csv', 3, 3, '[]', '[]', $3) returning id`,
        [w.noun, week, { lists: [{ column: "Type", value: "Live", rows: [2] }], leftOut: [], columns: [] }],
      )
    ).rows[0].id;
    for (const [i, title] of ["One", "Two", "Three"].entries()) {
      await tx.query(
        `insert into public.cards (week_id, space_id, title, source, import_batch_id, import_row, sort_order, extra) values ($1, $2, $3, 'csv_import', $4, $5, $5, $6)`,
        [week, w.noun, title, id, i, i === 1 ? { Type: "Live" } : {}],
      );
    }
    return id;
  });
  const b = (await w.db.query(`select imported_by, space_id, row_count, unmatched -> 'lists' -> 0 ->> 'value' as unknown from public.import_batches where id = $1`, [batch])).rows[0];
  assert.deepEqual(b, { imported_by: w.planner, space_id: w.noun, row_count: 3, unknown: "Live" });
  const cards = await rowsAs(w.db, w.planner, `select title, source, import_row, extra ->> 'Type' as kept from public.cards where import_batch_id = $1 order by import_row`, [batch]);
  assert.deepEqual(cards, [
    { title: "One", source: "csv_import", import_row: 0, kept: null },
    { title: "Two", source: "csv_import", import_row: 1, kept: "Live" },
    { title: "Three", source: "csv_import", import_row: 2, kept: null },
  ]);
  /* the planner reads their batch back; the batch's week must be in its space; the shooter cannot read batches */
  assert.equal(await oneAs(w.db, w.planner, `select count(*)::int from public.import_batches where week_id = $1`, [week]), 1);
  assert.equal(await oneAs(w.db, w.noPlan, `select count(*)::int from public.import_batches`), 0);
  await assert.rejects(
    as(w.db, w.owner, (tx) => tx.query(`insert into public.import_batches (space_id, week_id, source_kind) values ($1, $2, 'csv')`, [w.noun, other])),
    /another space/,
  );
  /* an import into a space the planner does not open is refused */
  await assert.rejects(as(w.db, w.planner, (tx) => tx.query(`insert into public.import_batches (week_id, source_kind) values ($1, 'csv')`, [other])), RLS);
});
