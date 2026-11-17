/* Behavior tests for the Frame.io move (the DRAFT docs/drafts/frameio-import-migration-draft.sql, which becomes
   supabase/migrations/20261121000000_frameio_import.sql on the owner's yes): versions brought in with their source,
   Send to editor on a brought in version, and the two server only tables of the Frame.io connection.
   While it is a draft, the draft is loaded on top of every live migration (freshDb's `extra`); once the file is in
   supabase/migrations, helpers.mjs loads it like the others and this suite tests the live file. Nothing here touches
   the live Supabase project. Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, signUp, as, rowsAs, oneAs, one, narrowEditor } from "./helpers.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE = readdirSync(join(ROOT, "supabase", "migrations")).some((f) => f.endsWith("_frameio_import.sql"));
const DRAFT = join(ROOT, "docs", "drafts", "frameio-import-migration-draft.sql");
const extra = LIVE || !existsSync(DRAFT) ? [] : [DRAFT];

const CHECK = /check constraint|versions_intake_check|versions_source_check|versions_intake_via_check/;
const FIXED = /fixed once saved/;
const DENIED = /permission denied/;
const LINK = "https://f.io/jnOIJopy";

async function world() {
  const db = await freshDb({ extra });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("olena@agency.test", "editor");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const editor = await signUp(db, "olena@agency.test", "Olena");
  await narrowEditor(db, owner, editor);
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  await as(db, owner, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [editor, noun]));
  const ids = await as(db, admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const week = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-1', 'Week 1', 1, '2026-11-09') returning id`, [noun]);
    const cardA = await q(`insert into public.cards (week_id, title, planned_on, assigned_editor_id, extra) values ($1, 'Hard water hair', '2026-11-10', $2, $3) returning id`, [week, editor, JSON.stringify({ "Edited video": LINK })]);
    const cardB = await q(`insert into public.cards (week_id, title, planned_on, extra) values ($1, 'No editor yet', '2026-11-11', $2) returning id`, [week, JSON.stringify({ "Edited video": LINK })]);
    return { cardA, cardB };
  });
  return { db, owner, admin, editor, noun, ...ids };
}

/** A version as the save step writes it for an import. */
const imported = (w, who, card, key, over = {}) =>
  oneAs(
    w.db,
    who,
    `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via, source_kind, source_url, source_share_id, source_file_id, source_file_name, source_bytes)
     values ($1, 'edits', $2, 'hair.mp4', $3, $4, $5, $6, $7, $8, $9) returning id`,
    [card, key, over.via ?? "import", over.kind === undefined ? "frameio" : over.kind, over.url === undefined ? LINK : over.url, "share-1", over.file === undefined ? "file-1" : over.file, "hair.mp4", 52_000_000],
  );

test("the draft applies after every live migration, with its columns, and no seed rows", async () => {
  const w = await world();
  const cols = await rowsAs(
    w.db,
    w.owner,
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'versions' and column_name like 'source_%' order by column_name`,
  );
  assert.deepEqual(cols.map((r) => r.column_name), ["source_bytes", "source_file_id", "source_file_name", "source_kind", "source_share_id", "source_url"]);
  assert.equal(await one(w.db, `select count(*)::int from public.frameio_connections`), 0);
  assert.equal(await one(w.db, `select count(*)::int from public.frameio_connection_tokens`), 0);
});

test("an import saves where it came from; a planner may, an editor may not; the facts must be whole", async () => {
  const w = await world();
  const v = await imported(w, w.admin, w.cardA, "a/v1.mp4");
  const row = (await w.db.query(`select intake_via, source_kind, source_url, source_file_id, source_bytes, number from public.versions where id = $1`, [v])).rows[0];
  assert.deepEqual({ ...row, source_bytes: Number(row.source_bytes) }, { intake_via: "import", source_kind: "frameio", source_url: LINK, source_file_id: "file-1", source_bytes: 52_000_000, number: 1 });

  /* an editor uploads, but does not plan the calendar: no import */
  await assert.rejects(imported(w, w.editor, w.cardA, "a/v2.mp4"), /plans the calendar/);
  /* an import always has its source and its file id */
  await assert.rejects(imported(w, w.admin, w.cardA, "a/v3.mp4", { kind: null }), CHECK);
  await assert.rejects(imported(w, w.admin, w.cardA, "a/v4.mp4", { url: null }), CHECK);
  await assert.rejects(imported(w, w.admin, w.cardA, "a/v5.mp4", { file: null }), CHECK);
  await assert.rejects(imported(w, w.admin, w.cardA, "a/v6.mp4", { kind: "dropbox" }), CHECK);
  await assert.rejects(imported(w, w.admin, w.cardA, "a/v7.mp4", { url: "http://f.io/x" }), CHECK);
  /* a row or mass upload never carries a source */
  await assert.rejects(imported(w, w.admin, w.cardA, "a/v8.mp4", { via: "row" }), CHECK);
  await assert.rejects(
    oneAs(w.db, w.admin, `insert into public.versions (card_id, r2_bucket, r2_key, file_name, source_url) values ($1, 'edits', 'a/v9.mp4', 'x.mp4', $2) returning id`, [w.cardA, LINK]),
    CHECK,
  );
  /* the old ways still work */
  assert.ok(await oneAs(w.db, w.editor, `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via) values ($1, 'edits', 'a/v10.mp4', 'x.mp4', 'row') returning id`, [w.cardA]));
  assert.ok(await oneAs(w.db, w.editor, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', 'a/v11.mp4', 'x.mp4') returning id`, [w.cardA]));
  /* our own server may bring one in too */
  assert.ok(await imported(w, "service", w.cardB, "b/v1.mp4"));
});

test("where an import came from is fixed once saved, for everyone", async () => {
  const w = await world();
  const v = await imported(w, w.admin, w.cardA, "a/v1.mp4");
  for (const [col, value] of [
    ["source_url", "https://f.io/other"],
    ["source_file_id", "file-2"],
    ["source_bytes", "1"],
    ["source_kind", null],
    ["intake_via", "row"],
  ]) {
    await assert.rejects(rowsAs(w.db, w.owner, `update public.versions set ${col} = $2 where id = $1 returning id`, [v, value]), FIXED, col);
    await assert.rejects(rowsAs(w.db, "service", `update public.versions set ${col} = $2 where id = $1 returning id`, [v, value]), FIXED, `${col} (server)`);
  }
});

const note = (w, who, version) => oneAs(w.db, who, `insert into public.review_comments (version_id, author_id, at_ms, tag_key, body) values ($1, $2, 1000, 'hook', 'Tighter hook') returning id`, [version, who]);
const send = (w, who, version) => rowsAs(w.db, who, `insert into public.edit_requests (version_id, sent_by) values ($1, $2) returning sent_to`, [version, who]);

test("Send to editor on a brought in version goes to the card's editor, not to whoever ran the move", async () => {
  const w = await world();
  const v = await imported(w, w.admin, w.cardA, "a/v1.mp4");
  await note(w, w.owner, v);
  assert.equal((await send(w, w.owner, v))[0].sent_to, w.editor);

  /* no editor on the card: it goes to nobody (the app says to set an editor), never to the admin who moved it */
  const vb = await imported(w, w.admin, w.cardB, "b/v1.mp4");
  await note(w, w.owner, vb);
  assert.equal((await send(w, w.owner, vb))[0].sent_to, null);

  /* an upload from a row still goes back to whoever uploaded it, as before */
  const own = await oneAs(w.db, w.admin, `insert into public.versions (card_id, r2_bucket, r2_key, file_name, intake_via) values ($1, 'edits', 'b/v2.mp4', 'x.mp4', 'row') returning id`, [w.cardB]);
  await note(w, w.owner, own);
  assert.equal((await send(w, w.owner, own))[0].sent_to, w.admin);
});

test("the Frame.io connection tables: server only, RLS on, never deleted, tokens out of the audit trail", async () => {
  const w = await world();
  for (const t of ["frameio_connections", "frameio_connection_tokens"]) {
    assert.equal(await one(w.db, `select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${t}`]), true, `${t}: row level security on`);
    assert.equal(await one(w.db, `select count(*)::int from pg_policies where schemaname = 'public' and tablename = $1`, [t]), 0, `${t}: no policies`);
    const triggers = (await w.db.query(`select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname`, [`public.${t}`])).rows.map((r) => r.tgname);
    for (const name of ["no_hard_delete", "no_truncate", "z_set_updated_at"]) assert.ok(triggers.includes(name), `${t}: ${name}`);
    assert.equal(triggers.includes("zz_audit"), t === "frameio_connections", `${t}: audit only on the connection`);
    for (const role of ["anon", "authenticated"]) {
      for (const p of ["select", "insert", "update", "delete"]) assert.equal(await one(w.db, `select has_table_privilege($1, $2, $3)`, [role, `public.${t}`, p]), false, `${t}: no ${p} for ${role}`);
    }
    assert.equal(await one(w.db, `select has_table_privilege('service_role', $1, 'delete')`, [`public.${t}`]), false, `${t}: no delete for the server`);
    assert.equal(await one(w.db, `select has_table_privilege('service_role', $1, 'insert')`, [`public.${t}`]), true, `${t}: the server writes`);
  }

  const id = await oneAs(w.db, "service", `insert into public.frameio_connections (adobe_user_id, email, connected_by) values ('ADOBE1@AdobeID', 'khaled@nounnaturals.com', $1) returning id`, [w.owner]);
  await as(w.db, "service", (tx) => tx.query(`insert into public.frameio_connection_tokens (connection_id, access_token, refresh_token) values ($1, 'v1.sealed', 'v1.sealed2')`, [id]));
  /* a person's own session sees nothing */
  await assert.rejects(rowsAs(w.db, w.owner, `select * from public.frameio_connections`), DENIED);
  await assert.rejects(rowsAs(w.db, w.owner, `select * from public.frameio_connection_tokens`), DENIED);
  /* one live connection at a time */
  await assert.rejects(oneAs(w.db, "service", `insert into public.frameio_connections (adobe_user_id) values ('OTHER@AdobeID') returning id`), /duplicate key|one_live/);
  /* who signed in is fixed */
  await assert.rejects(rowsAs(w.db, "service", `update public.frameio_connections set adobe_user_id = 'X' where id = $1 returning id`, [id]), FIXED);
  /* never deleted, also not by our server */
  await assert.rejects(rowsAs(w.db, "service", `delete from public.frameio_connections where id = $1 returning id`, [id]), /permission denied|delete/i);
  /* removed, then another login may connect */
  await as(w.db, "service", (tx) => tx.query(`update public.frameio_connections set deleted_at = now() where id = $1`, [id]));
  assert.ok(await oneAs(w.db, "service", `insert into public.frameio_connections (adobe_user_id) values ('OTHER@AdobeID') returning id`));
  /* the audit trail has the connection, never a token */
  const audited = await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'frameio_connection_tokens'`);
  assert.equal(audited, 0);
  assert.ok((await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'frameio_connections'`)) >= 1);
});
