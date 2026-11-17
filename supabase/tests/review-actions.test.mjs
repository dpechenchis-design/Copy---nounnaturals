// Behavior tests for Review on the database (no new migration: versions, review_comments, edit_requests, approvals
// and the status triggers of the existing migrations). Each test runs the same insert or update that
// src/lib/content/review-actions.ts makes, with the same person's session, on a throwaway PGlite database:
// an owner, an admin, a strategist/editor and a viewer, plus someone who opens no space. It proves who is allowed
// and who is refused, that Send to editor marks the notes sent and moves the card to Needs edits, that an approval
// moves it to Approved and records who, and that only people holding review.undo take an approval back (Owner and
// Admin, from the migration supabase/migrations/20261119000000_review_undo.sql, approved Nov 16 2026; the Owner alone
// on the old database, built with freshDb({ before: OLD })). Every migration is loaded as helpers.mjs does. Undo runs the action's
// own rule (src/lib/content/review-undo.ts) on what the database says: it is refused once the video or its card
// moved on, a half undone undo is finished by a second Undo, and nothing outside the decision's rows changes.
// Run: npm run test:db
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one, oneSpaceStrategist } from "./helpers.mjs";
import { LIVE_POST, UNDO_WORDS, liveUseOf, planUndo } from "../../src/lib/content/review-undo.ts";

const RLS = /row-level security/;

/** The database before the review undo migration: every migration up to it, never it or a later one. */
const OLD = "20261119000000";

/** `old`: the database before the review undo migration, where only the Owner revokes. */
async function world({ old = false } = {}) {
  const db = await (old ? freshDb({ before: OLD }) : freshDb());
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const invite = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await invite("steven@nounnaturals.com", "admin");
  await invite("olena@agency.test", "strategist");
  await invite("daryna@agency.test", "strategist");
  await invite("viewer@nounnaturals.com", "viewer");
  await invite("outsider@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const editor = await signUp(db, "olena@agency.test", "Olena"); // strategist/editor, uploads the versions
  const strategist = await signUp(db, "daryna@agency.test", "Daryna"); // strategist/editor, writes notes
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const outsider = await signUp(db, "outsider@agency.test", "Taras"); // opens no space
  /* Strategist/Editor opens every space now (spaces.all): the outsider holds its keys but spaces.all, and no space */
  await oneSpaceStrategist(db, owner, "Outsider", [], outsider);
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  await as(db, owner, async (tx) => {
    for (const p of [editor, strategist, viewer]) await tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [p, noun]);
  });
  const week = await oneAs(db, admin, `insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
  const card = await oneAs(db, admin, `insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Patchouli is not just a smell', '2026-11-17', $2) returning id`, [week, editor]);
  const w = { db, owner, admin, editor, strategist, viewer, outsider, noun, week, card };
  /* a version, saved the way the upload saves it (src/lib/content/edits-db.ts insertVersion) */
  w.v1 = await upload(w, editor, "noun/week-3/patchouli-v1.mp4");
  return w;
}

const upload = (w, who, key) => oneAs(w.db, who, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', $2, $2) returning id`, [w.card, key]);

/* ---------- exactly what the actions run ---------- */

/** saveReviewNote, a new note: the insert of review-actions.ts. */
const addNote = (w, who, version, { t = 3400, tag = "hook", body = "Start on the leaf close up.", drawing = [] } = {}) =>
  oneAs(w.db, who, `insert into public.review_comments (version_id, author_id, at_ms, tag_key, body, drawing) values ($1, $2, $3, $4, $5, $6) returning id`, [version, who, t, tag, body, JSON.stringify(drawing)]);

/** saveReviewNote, a change: only the author's own unsent, live note. Answers the rows changed. */
const changeNote = (w, who, version, note, { t = 5000, tag = "pacing", body = "Changed.", drawing = [] } = {}) =>
  rowsAs(
    w.db,
    who,
    `update public.review_comments set at_ms = $4, tag_key = $5, body = $6, drawing = $7
      where id = $1 and version_id = $2 and author_id = $3 and sent_at is null and deleted_at is null returning id`,
    [note, version, who, t, tag, body, JSON.stringify(drawing)],
  );

/** removeReviewNote: never a hard delete. */
const removeNote = (w, who, note) =>
  rowsAs(w.db, who, `update public.review_comments set deleted_at = now() where id = $1 and author_id = $2 and sent_at is null and deleted_at is null returning id`, [note, who]);

/** sendReviewNotes: one row; the database does the rest. */
const send = (w, who, version) => rowsAs(w.db, who, `insert into public.edit_requests (version_id, sent_by) values ($1, $2) returning id, note_count, sent_to, sent_at`, [version, who]);

/** decideReview. */
const decide = (w, who, version, decision, note = null) =>
  rowsAs(
    w.db,
    who,
    `insert into public.approvals (version_id, decision, note, decided_by) values ($1, $2, $3, $4)
     returning id, decision::text as decision, decided_by, decided_by_role_name, decided_at, note`,
    [version, decision, note, who],
  );

/** undoReviewDecision, the person's half: the revoke. Answers the rows changed (none for anyone without review.undo). */
const revoke = (w, who, approval) =>
  rowsAs(w.db, who, `update public.approvals set revoked_at = now() where id = $1 and revoked_at is null and deleted_at is null returning id, version_id, card_id, decision::text as decision`, [approval]);

const LIVE_POSTS = LIVE_POST.map((s) => `'${s}'`).join(", ");

/** undoReviewDecision's reads (undoFacts), with the person's own session, before anything is written. The decision's
    time goes back to the database as its own text, to the microsecond, as PostgREST hands it to the action. */
async function undoFacts(w, who, approval) {
  return as(w.db, who, async (tx) => {
    const q = async (sql, params = []) => (await tx.query(sql, params)).rows;
    const [a] = await q(`select version_id, decision::text as decision, decided_at::text as decided_at, revoked_at, revoked_by, deleted_at from public.approvals where id = $1`, [approval]);
    if (!a) return null;
    const facts = {
      me: who,
      decision: a.decision,
      revoked: !!a.revoked_at,
      revokedBy: a.revoked_by ?? null,
      deleted: !!a.deleted_at,
      onVersion: !!a.version_id,
      version: null,
      laterDecision: false,
      newerVersion: false,
      cardMoved: false,
      cardApproved: false,
      cardByDecision: false,
      use: null,
    };
    if (!a.version_id) return { facts, ids: null };
    const [v] = await q(`select card_id, number, review_state::text as review_state, deleted_at from public.versions where id = $1`, [a.version_id]);
    if (!v) return { facts, ids: null };
    const later = await q(`select id from public.approvals where version_id = $1 and id <> $2 and decided_at >= $3::timestamptz limit 1`, [a.version_id, approval, a.decided_at]);
    const newer = await q(`select id from public.versions where card_id = $1 and number > $2 and deleted_at is null limit 1`, [v.card_id, v.number]);
    const moved = await q(`select id from public.card_status_changes where card_id = $1 and changed_at > $2::timestamptz limit 1`, [v.card_id, a.decided_at]);
    const own = await q(`select to_status_id from public.card_status_changes where card_id = $1 and changed_at = $2::timestamptz limit 20`, [v.card_id, a.decided_at]);
    const posts = await q(`select status::text as status from public.posts where version_id = $1 and status::text in (${LIVE_POSTS}) and deleted_at is null limit 100`, [a.version_id]);
    const bank = await q(`select id from public.bank_items where version_id = $1 and retired_at is null and deleted_at is null limit 1`, [a.version_id]);
    const [card] = await q(`select status_id from public.cards where id = $1`, [v.card_id]);
    const statuses = await q(`select id, key from public.card_statuses where key in ('approved', 'review') and is_system and deleted_at is null`);
    const status = (key) => statuses.find((s) => s.key === key)?.id ?? null;
    return {
      facts: {
        ...facts,
        version: { n: v.number, state: v.review_state, deleted: !!v.deleted_at },
        laterDecision: later.length > 0,
        newerVersion: newer.length > 0,
        cardMoved: moved.length > 0,
        cardApproved: !!status("approved") && card?.status_id === status("approved"),
        cardByDecision: !!status("approved") && own.some((c) => c.to_status_id === status("approved")),
        use: liveUseOf(posts.map((p) => p.status), bank.length > 0),
      },
      ids: { version: a.version_id, card: v.card_id, approved: status("approved"), review: status("review") },
    };
  });
}

const NO_ROW = UNDO_WORDS.noRow;

/** putBack's card step (cardBack): from Approved to In review, only while the card still says Approved and no other
    live approval on the card holds it there. */
async function cardBack(w, ids) {
  const held = await rowsAs(w.db, "service", `select id from public.approvals where card_id = $1 and decision = 'approved' and revoked_at is null and deleted_at is null limit 1`, [ids.card]);
  if (held.length) return;
  await rowsAs(w.db, "service", `update public.cards set status_id = $2 where id = $1 and status_id = $3 and deleted_at is null returning id`, [ids.card, ids.review, ids.approved]);
}

const NOT_ALLOWED = "not allowed";
/** What the app's gate reads: the Owner role, or a live review.undo tick on the person's role. */
async function holdsUndo(w, who) {
  return one(w.db, `select exists (select 1 from public.profiles p join public.roles r on r.id = p.role_id
    where p.id = $1 and r.deleted_at is null and (r.key = 'owner' or exists (select 1 from public.role_permissions rp
      where rp.role_id = r.id and rp.permission_key = 'review.undo' and rp.deleted_at is null)))`, [who]);
}

/** undoReviewDecision end to end, in the action's order: the reads and the rule (refused before any write), the
    person's revoke, then our server's moves, each only while its row stands where the decision left it.
    `breakAt` "version" or "card": our server's step fails there (a lost connection), leaving a half undone undo.
    `between`: runs after the reads and the revoke, before our server's moves (someone else acting in between). */
async function undo(w, who, approval, { breakAt = null, between = null, gate = false } = {}) {
  /* `gate`: the action's own check first (enter("review.undo")); off, the database's rule is what refuses */
  if (gate && !(await holdsUndo(w, who))) return { ok: false, message: NOT_ALLOWED };
  const read = await undoFacts(w, who, approval);
  if (!read) return { ok: false, message: UNDO_WORDS.gone };
  const plan = planUndo(read.facts);
  if (plan.step === "refuse") return { ok: false, message: plan.message };
  if (plan.step === "revoke" && !(await revoke(w, who, approval)).length) return { ok: false, message: NO_ROW };
  if (!(plan.version || plan.card) || !read.ids) return { ok: true, plan };
  if (between) await between();
  if (plan.version) {
    if (breakAt === "version") return { ok: false, plan, broke: "version" };
    const back = await rowsAs(w.db, "service", `update public.versions set review_state = 'in_review' where id = $1 and review_state = $2 and deleted_at is null returning id`, [read.ids.version, plan.from]);
    if (!back.length) {
      /* the video moved between the reads and this write: the card still goes back, then a plain failure */
      if (plan.card) await cardBack(w, read.ids);
      return { ok: false, plan, movedOn: true };
    }
  }
  if (plan.card) {
    if (breakAt === "card") return { ok: false, plan, broke: "card" };
    await cardBack(w, read.ids);
  }
  return { ok: true, plan };
}

/** Every row Undo could touch, to prove it changed only the decision's own. */
async function snapshot(w) {
  const rows = async (sql) => (await w.db.query(sql)).rows.map((r) => JSON.stringify(r));
  return {
    versions: await rows(`select id, review_state::text, deleted_at from public.versions order by id`),
    cards: await rows(`select id, status_id, deleted_at from public.cards order by id`),
    approvals: await rows(`select id, revoked_at, revoked_by from public.approvals order by id`),
    changes: await rows(`select id, card_id, to_status_id from public.card_status_changes order by id`),
    posts: await rows(`select id, status::text from public.posts order by id`),
    bank: await rows(`select id, retired_at from public.bank_items order by id`),
  };
}
/** What changed between two snapshots, by table: rows added, rows gone or changed. */
function diff(before, after) {
  const out = {};
  for (const k of Object.keys(before)) {
    const b = new Set(before[k]);
    const a = new Set(after[k]);
    const added = after[k].filter((r) => !b.has(r)).map((r) => JSON.parse(r));
    const removed = before[k].filter((r) => !a.has(r)).map((r) => JSON.parse(r));
    if (added.length || removed.length) out[k] = { added, removed };
  }
  return out;
}

const statusId = (w, key) => one(w.db, `select id from public.card_statuses where key = $1 and is_system`, [key]);
/** An admin sets the card's status by hand, as on the Calendar. */
async function moveCard(w, key) {
  const to = await statusId(w, key);
  await as(w.db, w.admin, (tx) => tx.query(`update public.cards set status_id = $2 where id = $1`, [w.card, to]));
}
const revokedOf = (w, approval) => one(w.db, `select revoked_at from public.approvals where id = $1`, [approval]);

/** A TikTok account (our own server connects it) for the posting tests. */
const tiktok = (w) => oneAs(w.db, "service", `insert into public.social_accounts (platform_key, username, created_by) values ('tiktok', '@nounnaturals', $1) returning id`, [w.owner]);

/** setReviewNoteFixed. */
const tick = (w, who, note, fixed) =>
  rowsAs(w.db, who, `update public.review_comments set fixed_at = $2 where id = $1 and sent_at is not null and deleted_at is null returning id`, [note, fixed ? new Date().toISOString() : null]);

const stateOf = (w, version) => one(w.db, `select review_state::text from public.versions where id = $1`, [version]);
const statusOf = (w) => one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [w.card]);
const noteRow = async (w, id) => (await w.db.query(`select author_id, sent_at, edit_request_id, fixed_at, fixed_by, deleted_at, at_ms, tag_key, body, card_id from public.review_comments where id = $1`, [id])).rows[0];

/* ---------- the upload leaves the video waiting ---------- */

test("a new version waits for review and its card is In review", async () => {
  const w = await world();
  assert.equal(await stateOf(w, w.v1), "checking");
  assert.equal(await statusOf(w), "review");
});

/* ---------- notes ---------- */

test("notes: the owner, an admin and a strategist/editor write them; a viewer and an outsider are refused", async () => {
  const w = await world();
  for (const who of [w.owner, w.admin, w.strategist, w.editor]) {
    const id = await addNote(w, who, w.v1, { drawing: [{ k: "circle", x1: 36, y1: 16, x2: 64, y2: 40 }] });
    const row = await noteRow(w, id);
    assert.equal(row.author_id, who);
    assert.equal(row.sent_at, null, "a note starts unsent");
    assert.equal(row.card_id, w.card, "the database fills the card");
    assert.equal(row.at_ms, 3400);
  }
  await assert.rejects(addNote(w, w.viewer, w.v1), RLS);
  await assert.rejects(addNote(w, w.outsider, w.v1), RLS);
  /* a tag that is not on the list is refused by the database too */
  await assert.rejects(addNote(w, w.owner, w.v1, { tag: "nonsense" }), /foreign key/);
});

test("notes: a note can never be saved as already sent, or under someone else's name", async () => {
  const w = await world();
  const id = await oneAs(
    w.db,
    w.strategist,
    `insert into public.review_comments (version_id, author_id, at_ms, tag_key, body, sent_at, fixed_at) values ($1, $2, 1000, 'hook', 'Typed as sent', now(), now()) returning id`,
    [w.v1, w.owner],
  ).catch((e) => e);
  /* either the database refuses it, or it saves it as the person's own unsent note: never as sent, never as the owner's */
  if (!(id instanceof Error)) {
    const row = await noteRow(w, id);
    assert.equal(row.author_id, w.strategist);
    assert.equal(row.sent_at, null);
    assert.equal(row.fixed_at, null);
  }
});

test("notes: the author changes and removes an unsent note; nobody else does; nothing is hard deleted", async () => {
  const w = await world();
  const id = await addNote(w, w.strategist, w.v1);
  assert.equal((await changeNote(w, w.strategist, w.v1, id, { t: 12100, tag: "captions", body: "Fix the spelling." })).length, 1);
  const row = await noteRow(w, id);
  assert.deepEqual([row.at_ms, row.tag_key, row.body], [12100, "captions", "Fix the spelling."]);
  /* the action's own filter (author_id = me) gives another person no row */
  assert.equal((await changeNote(w, w.admin, w.v1, id)).length, 0);
  assert.equal((await removeNote(w, w.admin, id)).length, 0);
  /* and without that filter the database itself refuses */
  await assert.rejects(rowsAs(w.db, w.admin, `update public.review_comments set body = 'Mine now' where id = $1 returning id`, [id]), /Only the author can change an unsent note/);
  assert.equal((await rowsAs(w.db, w.viewer, `update public.review_comments set body = 'x' where id = $1 returning id`, [id])).length, 0);
  /* remove: deleted_at, the row stays */
  assert.equal((await removeNote(w, w.strategist, id)).length, 1);
  assert.ok((await noteRow(w, id)).deleted_at);
  assert.equal((await removeNote(w, w.strategist, id)).length, 0, "already removed");
  await assert.rejects(rowsAs(w.db, w.strategist, `delete from public.review_comments where id = $1`, [id]), /permission denied|hard delete|never deleted/i);
});

test("notes: an unsent note shows to its author and to people who write notes, not to a viewer", async () => {
  const w = await world();
  const id = await addNote(w, w.strategist, w.v1);
  const seen = (who) => rowsAs(w.db, who, `select id from public.review_comments where card_id = $1 and deleted_at is null`, [w.card]);
  for (const who of [w.strategist, w.owner, w.admin, w.editor]) assert.deepEqual((await seen(who)).map((r) => r.id), [id]);
  assert.deepEqual(await seen(w.viewer), []);
  assert.deepEqual(await seen(w.outsider), []);
  await send(w, w.strategist, w.v1);
  assert.deepEqual((await seen(w.viewer)).map((r) => r.id), [id], "once sent, everyone who sees the card reads it");
  assert.deepEqual(await seen(w.outsider), []);
});

/* ---------- Send to editor ---------- */

test("Send to editor: needs a note; marks every unsent note sent, goes to the uploader, moves the video and the card to Needs edits", async () => {
  const w = await world();
  await assert.rejects(send(w, w.strategist, w.v1), /Add at least one note before sending to the editor/);
  const mine = await addNote(w, w.strategist, w.v1);
  const theirs = await addNote(w, w.admin, w.v1, { t: 9000, tag: "captions", body: "Move the caption up." });
  const removed = await addNote(w, w.strategist, w.v1, { body: "Never mind." });
  await removeNote(w, w.strategist, removed);

  /* a viewer and an outsider cannot send */
  await assert.rejects(send(w, w.viewer, w.v1), RLS);
  await assert.rejects(send(w, w.outsider, w.v1), RLS);
  assert.equal(await stateOf(w, w.v1), "checking");

  const [req] = await send(w, w.strategist, w.v1);
  assert.equal(req.note_count, 2);
  assert.equal(req.sent_to, w.editor, "whoever uploaded the version");
  for (const id of [mine, theirs]) {
    const row = await noteRow(w, id);
    assert.ok(row.sent_at, "sent");
    assert.equal(row.edit_request_id, req.id);
  }
  assert.equal((await noteRow(w, removed)).sent_at, null, "a removed note is not sent");
  assert.equal(await stateOf(w, w.v1), "needs_edits");
  assert.equal(await statusOf(w), "edits");
  assert.equal(await one(w.db, `select sent_by from public.edit_requests where id = $1`, [req.id]), w.strategist);
  /* the change is in the card's history with who made it */
  assert.equal(await one(w.db, `select changed_by from public.card_status_changes c join public.card_statuses s on s.id = c.to_status_id where c.card_id = $1 and s.key = 'edits'`, [w.card]), w.strategist);

  /* a sent note is final: the action finds no unsent row, and the database refuses a direct change */
  assert.equal((await changeNote(w, w.strategist, w.v1, mine)).length, 0);
  assert.equal((await removeNote(w, w.strategist, mine)).length, 0);
  await assert.rejects(rowsAs(w.db, w.strategist, `update public.review_comments set body = 'Rewritten' where id = $1 returning id`, [mine]), /Only the author can change an unsent note/);
  await assert.rejects(rowsAs(w.db, w.strategist, `update public.review_comments set sent_at = null where id = $1 returning id`, [mine]), /A note is sent only with Send to editor/);
  /* a second Send with nothing new is refused; a send cannot be changed afterwards */
  await assert.rejects(send(w, w.strategist, w.v1), /Add at least one note/);
  await assert.rejects(rowsAs(w.db, w.strategist, `update public.edit_requests set note_count = 9 where id = $1 returning id`, [req.id]), /permission denied/);
});

test("Send to editor: the sender cannot type who sent it; the editor reads what was sent to them", async () => {
  const w = await world();
  await addNote(w, w.admin, w.v1);
  /* typed as the owner by an admin: the database saves the admin (or refuses), never the owner */
  const typed = await rowsAs(w.db, w.admin, `insert into public.edit_requests (version_id, sent_by) values ($1, $2) returning sent_by`, [w.v1, w.owner]).catch((e) => e);
  if (typed instanceof Error) await send(w, w.admin, w.v1);
  else assert.deepEqual(typed, [{ sent_by: w.admin }]);
  const mineOnly = await rowsAs(w.db, w.editor, `select id, sent_by, note_count from public.edit_requests where sent_to = $1 and deleted_at is null order by sent_at desc`, [w.editor]);
  assert.equal(mineOnly.length, 1);
  assert.equal(mineOnly[0].sent_by, w.admin);
  /* a new version after the notes: the old one is replaced and the card is back In review */
  const v2 = await upload(w, w.editor, "noun/week-3/patchouli-v2.mp4");
  assert.equal(await stateOf(w, w.v1), "superseded");
  assert.equal(await stateOf(w, v2), "checking");
  assert.equal(await statusOf(w), "review");
});

test("Mark fixed: people who write notes or reply tick a sent note; the database saves who; a viewer cannot", async () => {
  const w = await world();
  const id = await addNote(w, w.admin, w.v1);
  assert.equal((await tick(w, w.editor, id, true)).length, 0, "not sent yet: nothing to tick");
  await send(w, w.admin, w.v1);
  assert.equal((await tick(w, w.viewer, id, true)).length, 0);
  assert.equal((await tick(w, w.outsider, id, true)).length, 0);
  assert.equal((await noteRow(w, id)).fixed_at, null);
  assert.equal((await tick(w, w.editor, id, true)).length, 1);
  let row = await noteRow(w, id);
  assert.ok(row.fixed_at);
  assert.equal(row.fixed_by, w.editor);
  assert.equal((await tick(w, w.owner, id, false)).length, 1);
  row = await noteRow(w, id);
  assert.equal(row.fixed_at, null);
  assert.equal(row.fixed_by, null);
});

/* ---------- Approve and Reject ---------- */

test("Approve: only people with review.approve; the database saves who, their role and when, and moves the card to Approved", async () => {
  const w = await world();
  for (const who of [w.strategist, w.editor, w.viewer, w.outsider]) {
    await assert.rejects(decide(w, who, w.v1, "approved"), /row-level security|Only the owner or an admin can approve/);
  }
  assert.equal(await stateOf(w, w.v1), "checking");
  assert.equal(await statusOf(w), "review");

  const [a] = await decide(w, w.admin, w.v1, "approved");
  assert.equal(a.decision, "approved");
  assert.equal(a.decided_by, w.admin);
  assert.equal(a.decided_by_role_name, "Admin");
  assert.ok(a.decided_at);
  assert.equal(await stateOf(w, w.v1), "approved");
  assert.equal(await statusOf(w), "approved");
  assert.equal(await one(w.db, `select changed_by from public.card_status_changes c join public.card_statuses s on s.id = c.to_status_id where c.card_id = $1 and s.key = 'approved'`, [w.card]), w.admin);
  /* everyone who sees the card reads who approved it */
  for (const who of [w.viewer, w.editor, w.owner]) {
    const rows = await rowsAs(w.db, who, `select decided_by, decided_by_role_name from public.approvals where version_id = $1 and revoked_at is null and deleted_at is null`, [w.v1]);
    assert.deepEqual(rows, [{ decided_by: w.admin, decided_by_role_name: "Admin" }]);
  }
  assert.deepEqual(await rowsAs(w.db, w.outsider, `select id from public.approvals where version_id = $1`, [w.v1]), []);
  /* an approval is never rewritten, by anyone */
  await assert.rejects(rowsAs(w.db, w.owner, `update public.approvals set decision = 'rejected' where id = $1 returning id`, [a.id]), /An approval cannot be changed/);
  await assert.rejects(rowsAs(w.db, w.admin, `update public.approvals set note = 'x' where id = $1 returning id`, [a.id]), /An approval cannot be changed/);
  assert.equal((await rowsAs(w.db, w.strategist, `update public.approvals set note = 'x' where id = $1 returning id`, [a.id])).length, 0);
});

test("Approve: nobody approves in someone else's name, and a custom role with the key may approve", async () => {
  const w = await world();
  /* typed as the owner by an admin: the database saves the admin (or refuses), never the owner */
  const out = await decide(w, w.admin, w.v1, "approved").then(() => rowsAs(w.db, w.admin, `select decided_by from public.approvals where version_id = $1`, [w.v1]));
  assert.deepEqual(out, [{ decided_by: w.admin }]);
  const forged = await rowsAs(w.db, w.admin, `insert into public.approvals (version_id, decision, decided_by, decided_by_role_name) values ($1, 'approved', $2, 'Owner') returning decided_by, decided_by_role_name`, [w.v1, w.owner]).catch((e) => e);
  if (!(forged instanceof Error)) assert.deepEqual(forged, [{ decided_by: w.admin, decided_by_role_name: "Admin" }]);

  /* permissions, not role names: a custom role holding review.approve approves */
  const w2 = await world();
  await as(w2.db, w2.owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name) values ('Approver') returning id`)).rows[0].id;
    /* calendar.all_cards: without it a person sees only the cards they edit, so they could not see this video at all */
    for (const key of ["review.approve", "page.review", "calendar.all_cards"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, key]);
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, w2.viewer]);
  });
  const [a] = await decide(w2, w2.viewer, w2.v1, "approved");
  assert.equal(a.decided_by, w2.viewer);
  assert.equal(a.decided_by_role_name, "Approver");
  assert.equal(await statusOf(w2), "approved");
});

test("Reject: saved with who and why; the version is rejected and the card stays In review", async () => {
  const w = await world();
  await assert.rejects(decide(w, w.strategist, w.v1, "rejected", "no"), /row-level security|Only the owner or an admin can approve/);
  const [a] = await decide(w, w.owner, w.v1, "rejected", "Wrong product on screen");
  assert.equal(a.decision, "rejected");
  assert.equal(a.decided_by, w.owner);
  assert.equal(a.decided_by_role_name, "Owner");
  assert.equal(a.note, "Wrong product on screen");
  assert.equal(await stateOf(w, w.v1), "rejected");
  assert.equal(await statusOf(w), "review");
  await assert.rejects(decide(w, w.owner, w.v1, "maybe"), /invalid input value for enum/);
});

/* ---------- Undo ---------- */

test("Undo: only people holding review.undo take an approval back; our server then puts the video and the card back in review", async () => {
  const w = await world();
  const [a] = await decide(w, w.admin, w.v1, "approved");
  const before = await snapshot(w);
  /* two strategist/editors and a viewer get no row; an outsider does not even see it: nothing changes */
  for (const who of [w.editor, w.strategist, w.viewer]) assert.deepEqual(await undo(w, who, a.id), { ok: false, message: NO_ROW });
  assert.deepEqual(await undo(w, w.outsider, a.id), { ok: false, message: UNDO_WORDS.gone });
  assert.deepEqual(diff(before, await snapshot(w)), {}, "a refused undo changes nothing, our server's half included");
  /* a signed in person, even the owner, cannot set a version's review state: that half is our server's */
  await assert.rejects(rowsAs(w.db, w.owner, `update public.versions set review_state = 'in_review' where id = $1 returning id`, [w.v1]), /Only the system sets review_state/);

  assert.deepEqual(await undo(w, w.owner, a.id), { ok: true, plan: { step: "revoke", from: "approved", version: true, card: true } });
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [a.id]), w.owner);
  assert.equal(await stateOf(w, w.v1), "in_review");
  assert.equal(await statusOf(w), "review");
  /* undone twice: already undone, nothing changes */
  const done = await snapshot(w);
  assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.done });
  assert.deepEqual(diff(done, await snapshot(w)), {});
  /* and it can be decided again */
  const [again] = await decide(w, w.owner, w.v1, "approved");
  assert.equal(again.decided_by, w.owner);
  assert.equal(await stateOf(w, w.v1), "approved");
  assert.equal(await statusOf(w), "approved");
  assert.equal(await one(w.db, `select count(*)::int from public.approvals where version_id = $1 and revoked_at is null`, [w.v1]), 1);
  /* the old approval, pressed again from a stale screen, never drags the new one back */
  const decidedAgain = await snapshot(w);
  assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.done });
  assert.deepEqual(diff(decidedAgain, await snapshot(w)), {});
  assert.equal(await stateOf(w, w.v1), "approved");
});

test("Undo: a rejection comes back to review; its card, which the rejection never moved, stays where it is", async () => {
  const w = await world();
  const [a] = await decide(w, w.owner, w.v1, "rejected");
  const changes = await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [w.card]);
  assert.deepEqual(await undo(w, w.owner, a.id), { ok: true, plan: { step: "revoke", from: "rejected", version: true, card: false } });
  assert.equal(await stateOf(w, w.v1), "in_review");
  assert.equal(await statusOf(w), "review");
  assert.equal(await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [w.card]), changes, "the card was not touched");
});

test("Undo is refused, before any write, once the video or its card moved on", async () => {
  /* the card was moved by hand since (Scheduled) */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    await moveCard(w, "scheduled");
    const before = await snapshot(w);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.card });
    assert.deepEqual(diff(before, await snapshot(w)), {}, "the approval stays live, the video approved, the card scheduled");
    assert.equal(await revokedOf(w, a.id), null);
  }
  /* moved on and back again: the card says Approved, but not the Approved this decision gave it */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    await moveCard(w, "scheduled");
    await moveCard(w, "approved");
    assert.equal(await statusOf(w), "approved");
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.card });
    assert.equal(await revokedOf(w, a.id), null);
  }
  /* a rejection whose card moved since */
  {
    const w = await world();
    const [a] = await decide(w, w.owner, w.v1, "rejected");
    await moveCard(w, "editing");
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.card });
    assert.equal(await stateOf(w, w.v1), "rejected");
  }
  /* a newer version came in: the approved one stays approved, the new one keeps waiting */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    const v2 = await upload(w, w.editor, "noun/week-3/patchouli-v2.mp4");
    assert.equal(await stateOf(w, w.v1), "approved", "an approved version is not replaced by a new upload");
    const before = await snapshot(w);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.newer(1) });
    assert.deepEqual(diff(before, await snapshot(w)), {});
    /* and replaced by our server since: still refused, nothing is dragged back */
    await as(w.db, "service", (tx) => tx.query(`update public.versions set review_state = 'superseded' where id = $1`, [w.v1]));
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.newer(1) });
    assert.equal(await stateOf(w, w.v1), "superseded");
    assert.equal(await stateOf(w, v2), "checking");
    assert.equal(await revokedOf(w, a.id), null);
  }
  /* put in the content bank */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    await rowsAs(w.db, w.admin, `insert into public.bank_items (version_id, approval_id) values ($1, $2) returning id`, [w.v1, a.id]);
    assert.equal(await statusOf(w), "bank");
    const before = await snapshot(w);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.bank(1) });
    assert.deepEqual(diff(before, await snapshot(w)), {});
  }
  /* scheduled to post, then posted */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    const account = await tiktok(w);
    const post = await oneAs(w.db, w.admin, `insert into public.posts (version_id, account_id, status, scheduled_for, approval_id) values ($1, $2, 'scheduled', now() + interval '1 day', $3) returning id`, [w.v1, account, a.id]);
    assert.equal(await statusOf(w), "scheduled");
    let before = await snapshot(w);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.scheduled(1) });
    assert.deepEqual(diff(before, await snapshot(w)), {}, "the approval stays live, so the scheduled post still holds");
    await as(w.db, "service", async (tx) => {
      await tx.query(`update public.posts set status = 'posting' where id = $1`, [post]);
      await tx.query(`update public.posts set status = 'posted', posted_at = now() where id = $1`, [post]);
    });
    before = await snapshot(w);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.posted(1) });
    assert.deepEqual(diff(before, await snapshot(w)), {});
    assert.equal(await stateOf(w, w.v1), "approved");
    assert.equal(await revokedOf(w, a.id), null);
  }
});

test("Undo: a half undone undo from before is finished by a second Undo", async () => {
  /* the old order's failure: the owner's revoke went through, our server's half never ran */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    assert.equal((await revoke(w, w.owner, a.id)).length, 1);
    assert.equal(await stateOf(w, w.v1), "approved");
    assert.equal(await statusOf(w), "approved");
    /* nobody without review.undo touches it */
    const before = await snapshot(w);
    for (const who of [w.strategist, w.viewer]) assert.deepEqual(await undo(w, who, a.id, { gate: true }), { ok: false, message: NOT_ALLOWED });
    assert.deepEqual(diff(before, await snapshot(w)), {});
    /* an admin (holding review.undo) presses Undo: both moves are finished, the approval keeps its one revoke */
    const revokedAt = await revokedOf(w, a.id);
    assert.deepEqual(await undo(w, w.admin, a.id, { gate: true }), { ok: true, plan: { step: "finish", from: "approved", version: true, card: true } });
    assert.equal(await stateOf(w, w.v1), "in_review");
    assert.equal(await statusOf(w), "review");
    assert.deepEqual(await revokedOf(w, a.id), revokedAt);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.done });
  }
  /* the new order failing at the video: the approval is revoked (the safe side), a second Undo finishes */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    assert.equal((await undo(w, w.owner, a.id, { breakAt: "version" })).broke, "version");
    assert.ok(await revokedOf(w, a.id));
    assert.equal(await stateOf(w, w.v1), "approved");
    /* nothing can be banked on a revoked approval while it is half undone */
    await assert.rejects(rowsAs(w.db, w.admin, `insert into public.bank_items (version_id, approval_id) values ($1, $2) returning id`, [w.v1, a.id]), /live approval/);
    assert.equal((await undo(w, w.owner, a.id)).plan.step, "finish");
    assert.equal(await stateOf(w, w.v1), "in_review");
    assert.equal(await statusOf(w), "review");
  }
  /* failing at the card: the video is back, the card still says Approved; a second Undo moves only the card */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    assert.equal((await undo(w, w.owner, a.id, { breakAt: "card" })).broke, "card");
    assert.equal(await stateOf(w, w.v1), "in_review");
    assert.equal(await statusOf(w), "approved");
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: true, plan: { step: "finish", from: "approved", version: false, card: true } });
    assert.equal(await statusOf(w), "review");
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.done });
  }
  /* a half undone rejection: only the video goes back */
  {
    const w = await world();
    const [a] = await decide(w, w.owner, w.v1, "rejected");
    assert.equal((await revoke(w, w.owner, a.id)).length, 1);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: true, plan: { step: "finish", from: "rejected", version: true, card: false } });
    assert.equal(await stateOf(w, w.v1), "in_review");
    assert.equal(await statusOf(w), "review");
  }
  /* half undone, then the card moved on: refused, it stays where it is, and no live approval is left to post on */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    assert.equal((await revoke(w, w.owner, a.id)).length, 1);
    await moveCard(w, "scheduled");
    const before = await snapshot(w);
    assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.stuck(1) });
    assert.deepEqual(diff(before, await snapshot(w)), {});
  }
});

test("Undo: a card that already said Approved before the decision stays there; only the video goes back", async () => {
  const w = await world();
  await moveCard(w, "approved");
  const [a] = await decide(w, w.admin, w.v1, "approved");
  assert.equal(await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1 and changed_at = (select decided_at from public.approvals where id = $2)`, [w.card, a.id]), 0, "the database moved nothing");
  const changes = await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [w.card]);
  assert.deepEqual(await undo(w, w.owner, a.id), { ok: true, plan: { step: "revoke", from: "approved", version: true, card: false } });
  assert.equal(await stateOf(w, w.v1), "in_review");
  assert.equal(await statusOf(w), "approved", "the card it never moved is left alone");
  assert.equal(await one(w.db, `select count(*)::int from public.card_status_changes where card_id = $1`, [w.card]), changes);
  /* and a second Undo has nothing left to do */
  assert.deepEqual(await undo(w, w.owner, a.id), { ok: false, message: UNDO_WORDS.done });
  assert.equal(await statusOf(w), "approved");
});

test("Undo: the video moved between the reads and the write: a plain failure, and the card does not keep saying Approved", async () => {
  /* the video was put back in the meantime (another Undo's first half): the card follows it back */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    const between = () => as(w.db, "service", (tx) => tx.query(`update public.versions set review_state = 'in_review' where id = $1`, [w.v1]));
    const r = await undo(w, w.owner, a.id, { between });
    assert.equal(r.ok, false, "never claims it is undone");
    assert.equal(r.movedOn, true);
    assert.ok(await revokedOf(w, a.id));
    assert.equal(await stateOf(w, w.v1), "in_review");
    assert.equal(await statusOf(w), "review");
  }
  /* a newer version was approved in the meantime: its approval holds the card on Approved */
  {
    const w = await world();
    const [a] = await decide(w, w.admin, w.v1, "approved");
    let v2;
    const between = async () => {
      v2 = await upload(w, w.editor, "noun/week-3/patchouli-v2.mp4");
      await as(w.db, "service", (tx) => tx.query(`update public.versions set review_state = 'in_review' where id = $1`, [v2]));
      await decide(w, w.admin, v2, "approved");
      await as(w.db, "service", (tx) => tx.query(`update public.versions set review_state = 'superseded' where id = $1`, [w.v1]));
    };
    const r = await undo(w, w.owner, a.id, { between });
    assert.equal(r.ok, false);
    assert.equal(r.movedOn, true);
    assert.equal(await stateOf(w, w.v1), "superseded");
    assert.equal(await stateOf(w, v2), "approved");
    assert.equal(await statusOf(w), "approved", "the newer approval is never dragged back");
  }
});

test("Undo changes only the decision's own rows: its approval, its version, its card and that card's history", async () => {
  const w = await world();
  /* a second title in the same week, approved too, and an older approval on this card that was undone */
  const other = await oneAs(w.db, w.admin, `insert into public.cards (week_id, title, planned_on, assigned_editor_id) values ($1, 'Rosemary for thin hair', '2026-11-18', $2) returning id`, [w.week, w.editor]);
  const otherV1 = await oneAs(w.db, w.editor, `insert into public.versions (card_id, r2_bucket, r2_key, file_name) values ($1, 'edits', 'noun/week-3/rosemary-v1.mp4', 'rosemary-v1.mp4') returning id`, [other]);
  const [otherApproval] = await decide(w, w.admin, otherV1, "approved");
  const [old] = await decide(w, w.owner, w.v1, "rejected");
  assert.equal((await undo(w, w.owner, old.id)).ok, true);
  const [a] = await decide(w, w.admin, w.v1, "approved");

  const before = await snapshot(w);
  assert.equal((await undo(w, w.owner, a.id)).ok, true);
  const changed = diff(before, await snapshot(w));
  assert.deepEqual(Object.keys(changed).sort(), ["approvals", "cards", "changes", "versions"]);
  assert.deepEqual(changed.approvals.removed.map((r) => r.id), [a.id]);
  assert.deepEqual(changed.approvals.added.map((r) => [r.id, r.revoked_by]), [[a.id, w.owner]]);
  assert.deepEqual(changed.versions.added, [{ id: w.v1, review_state: "in_review", deleted_at: null }]);
  assert.deepEqual(changed.cards.added, [{ id: w.card, status_id: await statusId(w, "review"), deleted_at: null }]);
  assert.deepEqual(changed.changes.removed, []);
  assert.deepEqual(
    changed.changes.added.map((r) => [r.card_id, r.to_status_id]),
    [[w.card, await statusId(w, "review")]],
  );
  /* the other title is untouched */
  assert.equal(await stateOf(w, otherV1), "approved");
  assert.equal(await one(w.db, `select s.key from public.cards c join public.card_statuses s on s.id = c.status_id where c.id = $1`, [other]), "approved");
  assert.equal(await revokedOf(w, otherApproval.id), null);

  /* the same for a second Undo that finishes a half undone one */
  const [b] = await decide(w, w.admin, w.v1, "approved");
  assert.equal((await undo(w, w.owner, b.id, { breakAt: "version" })).broke, "version");
  const half = await snapshot(w);
  assert.equal((await undo(w, w.owner, b.id)).ok, true);
  const finished = diff(half, await snapshot(w));
  assert.deepEqual(Object.keys(finished).sort(), ["cards", "changes", "versions"], "the approval keeps its one revoke");
  assert.deepEqual(finished.versions.added.map((r) => r.id), [w.v1]);
  assert.deepEqual(finished.cards.added.map((r) => r.id), [w.card]);
  assert.equal(await stateOf(w, otherV1), "approved");
  assert.equal(await revokedOf(w, otherApproval.id), null);
});

/* ---------- Undo for owners and admins (the review undo migration) ---------- */

/** A custom role built by the owner from these keys, given to these people. Answers the role's id. */
const customRole = (w, name, keys, ...people) =>
  as(w.db, w.owner, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name) values ($1) returning id`, [name])).rows[0].id;
    for (const key of keys) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, key]);
    for (const p of people) await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, p]);
    return id;
  });

/** Every column of an approval but the ones a revoke may change. */
const frozen = (w, approval) => one(w.db, `select to_jsonb(a) - array['revoked_at', 'revoked_by', 'updated_at'] from public.approvals a where a.id = $1`, [approval]);

test("review undo migration: the key is seeded for Owner and Admin only, with the words of the permission list", async () => {
  const w = await world();
  const row = (await w.db.query(`select group_key, group_label, label, hint, sort_order from public.permissions where key = 'review.undo'`)).rows[0];
  assert.deepEqual(row, { group_key: "review", group_label: "Review", label: "Undo an approval or a rejection", hint: "Take a decision back so the video waits for review again.", sort_order: 85 });
  const holders = (await w.db.query(`select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id where rp.permission_key = 'review.undo' and rp.deleted_at is null order by r.key`)).rows.map((r) => r.key);
  assert.deepEqual(holders, ["admin", "owner"]);
});

test("Undo: an admin takes a decision back, the owner's too; the revoke changes only revoked_at and revoked_by", async () => {
  const w = await world();
  const [a] = await decide(w, w.owner, w.v1, "rejected", "Wrong product on screen");
  const kept = await frozen(w, a.id);
  const before = await snapshot(w);
  assert.deepEqual(await undo(w, w.admin, a.id), { ok: true, plan: { step: "revoke", from: "rejected", version: true, card: false } });
  /* who revoked it is the database's: the signed in admin */
  const after = (await w.db.query(`select revoked_at, revoked_by from public.approvals where id = $1`, [a.id])).rows[0];
  assert.ok(after.revoked_at);
  assert.equal(after.revoked_by, w.admin);
  assert.deepEqual(await frozen(w, a.id), kept, "nothing else on the approval changed");
  const changed = diff(before, await snapshot(w));
  assert.deepEqual(changed.approvals.added.map((r) => [r.id, r.revoked_by]), [[a.id, w.admin]]);
  assert.deepEqual(changed.versions.added, [{ id: w.v1, review_state: "in_review", deleted_at: null }]);
  assert.equal(changed.cards, undefined, "the rejection never moved the card, so Undo leaves it");

  /* an admin's approval, taken back by that admin: the card goes back too */
  const [b] = await decide(w, w.admin, w.v1, "approved");
  assert.deepEqual(await undo(w, w.admin, b.id), { ok: true, plan: { step: "revoke", from: "approved", version: true, card: true } });
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [b.id]), w.admin);
  assert.equal(await stateOf(w, w.v1), "in_review");
  assert.equal(await statusOf(w), "review");
});

test("Undo: a revoke is the only change, once; nobody clears it or writes who revoked it", async () => {
  const w = await world();
  const [a] = await decide(w, w.admin, w.v1, "approved");
  /* typed as someone else: the database writes the person who revoked it */
  assert.equal((await rowsAs(w.db, w.admin, `update public.approvals set revoked_at = now(), revoked_by = $2 where id = $1 returning id`, [a.id, w.owner])).length, 1);
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [a.id]), w.admin);
  const revokedAt = await revokedOf(w, a.id);
  for (const who of [w.owner, w.admin]) {
    /* never cleared (a cleared revoke would make the approval live again for posting), never stamped again */
    await assert.rejects(rowsAs(w.db, who, `update public.approvals set revoked_at = null where id = $1 returning id`, [a.id]), /An approval cannot be changed/);
    await assert.rejects(rowsAs(w.db, who, `update public.approvals set revoked_at = now() + interval '1 hour' where id = $1 returning id`, [a.id]), /An approval cannot be changed/);
    await assert.rejects(rowsAs(w.db, who, `update public.approvals set revoked_by = $2 where id = $1 returning id`, [a.id, w.owner]), /An approval cannot be changed/);
    await assert.rejects(rowsAs(w.db, who, `update public.approvals set note = 'x' where id = $1 returning id`, [a.id]), /An approval cannot be changed/);
  }
  assert.deepEqual(await revokedOf(w, a.id), revokedAt);
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [a.id]), w.admin);
  /* on a live approval, who revoked it cannot be written without a revoke */
  const v2 = await upload(w, w.editor, "noun/week-3/patchouli-v2.mp4");
  const [b] = await decide(w, w.admin, v2, "approved");
  await assert.rejects(rowsAs(w.db, w.admin, `update public.approvals set revoked_by = $2 where id = $1 returning id`, [b.id, w.owner]), /An approval cannot be changed/);
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [b.id]), null);
  assert.equal(await revokedOf(w, b.id), null);
});

test("Undo follows the key, not the role: a custom role with review.undo revokes; one with only review.approve, or an admin unticked, does not", async () => {
  const w = await world();
  /* calendar.all_cards: without it a person sees only the cards they edit, so they could not see this decision at all */
  await customRole(w, "Undoer", ["review.undo", "page.review", "calendar.all_cards"], w.viewer);
  await customRole(w, "Approver", ["review.approve", "page.review", "calendar.all_cards"], w.strategist);
  const [a] = await decide(w, w.admin, w.v1, "approved");
  const before = await snapshot(w);
  assert.deepEqual(await undo(w, w.strategist, a.id), { ok: false, message: NO_ROW });
  assert.deepEqual(diff(before, await snapshot(w)), {});
  assert.equal((await undo(w, w.viewer, a.id)).ok, true);
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [a.id]), w.viewer);
  assert.equal(await stateOf(w, w.v1), "in_review");
  assert.equal(await statusOf(w), "review");

  /* holding the key but not seeing the card: refused */
  const blind = await world();
  await customRole(blind, "Blind undoer", ["review.undo", "page.review"], blind.viewer);
  const [b] = await decide(blind, blind.admin, blind.v1, "approved");
  assert.deepEqual(await undo(blind, blind.viewer, b.id), { ok: false, message: UNDO_WORDS.gone });
  assert.equal((await revoke(blind, blind.viewer, b.id)).length, 0);
  assert.equal(await revokedOf(blind, b.id), null);

  /* the owner unticks review.undo on Admin: the same admin is refused */
  const plain = await world();
  const adminRole = await one(plain.db, `select id from public.roles where key = 'admin'`);
  await as(plain.db, plain.owner, (tx) => tx.query(`update public.role_permissions set deleted_at = now() where role_id = $1 and permission_key = 'review.undo' and deleted_at is null`, [adminRole]));
  const [c] = await decide(plain, plain.admin, plain.v1, "approved");
  assert.deepEqual(await undo(plain, plain.admin, c.id), { ok: false, message: NO_ROW });
  assert.equal(await revokedOf(plain, c.id), null);
  assert.equal((await undo(plain, plain.owner, c.id)).ok, true, "the Owner holds every key");
});

test("Undo on the old database (before the review undo migration): only the Owner revokes, an admin is refused", async () => {
  const w = await world({ old: true });
  assert.equal(await one(w.db, `select count(*)::int from public.permissions where key = 'review.undo'`), 0, "the old database has no such key");
  const [a] = await decide(w, w.admin, w.v1, "approved");
  const before = await snapshot(w);
  for (const who of [w.admin, w.strategist, w.viewer]) assert.deepEqual(await undo(w, who, a.id), { ok: false, message: NO_ROW });
  assert.deepEqual(diff(before, await snapshot(w)), {});
  assert.deepEqual(await undo(w, w.owner, a.id), { ok: true, plan: { step: "revoke", from: "approved", version: true, card: true } });
  assert.equal(await one(w.db, `select revoked_by from public.approvals where id = $1`, [a.id]), w.owner);
  assert.equal(await stateOf(w, w.v1), "in_review");
  assert.equal(await statusOf(w), "review");
});

/* ---------- what Review reads ---------- */

test("Review's list: the versions that wait, only in the spaces a person may open", async () => {
  const w = await world();
  const waiting = (who) => rowsAs(w.db, who, `select id from public.versions where review_state in ('checking', 'in_review') and deleted_at is null order by created_at desc`);
  for (const who of [w.owner, w.admin, w.strategist, w.editor, w.viewer]) assert.deepEqual((await waiting(who)).map((r) => r.id), [w.v1]);
  assert.deepEqual(await waiting(w.outsider), []);
  await decide(w, w.admin, w.v1, "approved");
  assert.deepEqual(await waiting(w.owner), []);
});
