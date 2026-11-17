// Behavior tests for supabase/migrations/20261115120000_gmail_invites.sql (Gmail invites).
// Same helpers as the other suites (supabase/tests/helpers.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, one, narrowEditor } from "./helpers.mjs";

const SEALED = "v1.aXY=.dGFn.ZGF0YQ==";

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (who, email, role) => as(db, who, async (tx) => (await tx.query(`insert into public.invites (email, role) values ($1, $2) returning id`, [email, role])).rows[0].id);
  await inv(owner, "steven@nounnaturals.com", "admin");
  await inv(owner, "olena@agency.test", "editor");
  const admin = await signUp(db, "steven@nounnaturals.com");
  const editor = await signUp(db, "olena@agency.test");
  await narrowEditor(db, owner, editor); // the narrow editor persona: a custom role with the old Editor keys (Editor was merged into Strategist/Editor by the 20261116000000 migration)
  const open = await inv(owner, "maria@agency.test", "editor");
  return { db, owner, admin, editor, open, inv };
}
const link = (db, who, enc = SEALED) => as(db, who, (tx) => tx.query(`insert into public.google_links (refresh_enc, scopes) values ($1, '{https://www.googleapis.com/auth/gmail.send}')`, [enc]));
const logEmail = (db, who, invite, status = "sent", sentBy = null) =>
  as(db, who, (tx) =>
    tx.query(`insert into public.invite_emails (invite_id, to_email, subject, status${sentBy ? ", sent_by" : ""}) values ($1, 'maria@agency.test', 'Khaled invited you to Noun ART', $2${sentBy ? ", $3" : ""})`, sentBy ? [invite, status, sentBy] : [invite, status]),
  );

test("google_links: a person writes and reads only their own row", async () => {
  const w = await world();
  await link(w.db, w.owner);
  await link(w.db, w.editor);
  assert.equal((await rowsAs(w.db, w.owner, `select profile_id from public.google_links`)).length, 1);
  assert.equal((await rowsAs(w.db, w.admin, `select profile_id from public.google_links`)).length, 0);
  // nobody writes a row for someone else
  await assert.rejects(as(w.db, w.admin, (tx) => tx.query(`insert into public.google_links (profile_id, refresh_enc) values ($1, $2)`, [w.owner, SEALED])), /row-level security/);
  const r = await as(w.db, w.admin, (tx) => tx.query(`update public.google_links set refresh_enc = $1 where profile_id = $2 returning profile_id`, [SEALED, w.owner]));
  assert.equal(r.rows.length, 0);
});

test("google_links: upsert replaces your own row; Disconnect empties it, never deletes", async () => {
  const w = await world();
  await link(w.db, w.owner);
  await as(w.db, w.owner, (tx) =>
    tx.query(`insert into public.google_links (profile_id, refresh_enc, scopes) values ($1, $2, '{}') on conflict (profile_id) do update set refresh_enc = excluded.refresh_enc, deleted_at = null`, [w.owner, "v1.bmV3.dGFn.ZGF0YQ=="]),
  );
  assert.equal(await one(w.db, `select refresh_enc from public.google_links where profile_id = $1`, [w.owner]), "v1.bmV3.dGFn.ZGF0YQ==");
  await as(w.db, w.owner, (tx) => tx.query(`update public.google_links set refresh_enc = null, deleted_at = now() where profile_id = $1`, [w.owner]));
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.google_links`)));
  assert.equal(await one(w.db, `select count(*)::int from public.google_links`), 1);
});

test("google_links: only a sealed value, and a live row must have one", async () => {
  const w = await world();
  await assert.rejects(link(w.db, w.owner, "1//plain-refresh-token"), /check/);
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`insert into public.google_links (refresh_enc) values (null)`)), /check/);
});

test("google_links: anon gets nothing; the table is not in the audit trail", async () => {
  const w = await world();
  await link(w.db, w.owner);
  await assert.rejects(w.db.exec(`set role anon; select * from public.google_links`), /permission denied/);
  await w.db.query(`reset role`);
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'google_links'`), 0);
  // the service role gets nothing on either table (Supabase's default grants are taken back)
  for (const t of ["google_links", "invite_emails"])
    for (const p of ["select", "insert", "update", "delete"])
      assert.equal(await one(w.db, `select has_table_privilege('service_role', 'public.${t}', '${p}')`), false, `service_role ${p} ${t}`);
});

test("invite_emails: owner and admins log as themselves and read the log; editors do neither", async () => {
  const w = await world();
  await logEmail(w.db, w.owner, w.open, "sent");
  await logEmail(w.db, w.admin, w.open, "failed");
  await assert.rejects(logEmail(w.db, w.editor, w.open, "sent"), /row-level security/);
  // nobody logs as someone else
  await assert.rejects(logEmail(w.db, w.admin, w.open, "sent", w.owner), /row-level security/);
  assert.equal((await rowsAs(w.db, w.admin, `select id from public.invite_emails`)).length, 2);
  assert.equal((await rowsAs(w.db, w.editor, `select id from public.invite_emails`)).length, 0);
});

test("invite_emails: a fixed list of statuses; rows never change or go away", async () => {
  const w = await world();
  await assert.rejects(logEmail(w.db, w.owner, w.open, "bounced"), /check/);
  await logEmail(w.db, w.owner, w.open, "not_connected");
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.invite_emails set status = 'sent'`)));
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`delete from public.invite_emails`)));
  await assert.rejects(w.db.query(`update public.invite_emails set status = 'sent'`), /never changed/);
  assert.equal(await one(w.db, `select status from public.invite_emails`), "not_connected");
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log where entity_table = 'invite_emails'`), 1);
});
