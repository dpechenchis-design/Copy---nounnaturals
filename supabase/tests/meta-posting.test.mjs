/* Behavior tests for the draft supabase/drafts/20261119300000_meta_posting.sql (docs/META.md, section 5, "The
   database change"): the fix to the posting rule (a post that is posting or posted is read only for people), the one
   time publish switch (public.claim_post_publish), who settled a post (resolved_by, resolved_at), the permission
   "Settle posts that need a check" (posting.resolve) and the posting timer.
   Every live migration is loaded exactly as helpers.mjs does, then this draft, in this file's own throwaway PGlite
   database, so the draft is proven without becoming part of what the other test files load. Once the draft is
   approved and moved into supabase/migrations, its drafts file is gone and the same assertions run against the
   migrations alone. Nothing here touches the live Supabase project.
   Run: npm run test:db */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { freshDb, signUp, as, oneAs, one } from "./helpers.mjs";

const DRAFT = join(dirname(fileURLToPath(import.meta.url)), "..", "drafts", "20261119300000_meta_posting.sql");
const EXTRA = existsSync(DRAFT) ? [DRAFT] : [];

const MOVED = /A post that is posting or posted cannot be moved/;
const CHANGED = /A post that is posting or posted cannot be changed/;
const DENIED = /permission denied/;

/** Owner, Admin and a Strategist/Editor (who holds one Instagram account and needs an approval), a week, a card and
    an edited version approved by the admin. */
async function world() {
  const db = await freshDb({ extra: EXTRA });
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("steven@nounnaturals.com", "admin");
  await inv("olena@agency.test", "strategist");
  await inv("viewer@nounnaturals.com", "viewer");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strat = await signUp(db, "olena@agency.test", "Olena");
  const viewer = await signUp(db, "viewer@nounnaturals.com", "Viewer");
  const noun = await one(db, `select id from public.spaces where slug = 'noun'`);
  await as(db, owner, (tx) => tx.query(`insert into public.person_spaces (profile_id, space_id) values ($1, $2)`, [strat, noun]));
  const ids = await as(db, admin, async (tx) => {
    const q = async (sql, params) => (await tx.query(sql, params)).rows[0].id;
    const week = await q(`insert into public.weeks (space_id, slug, name, number, starts_on) values ($1, 'week-3', 'Week 3', 3, '2026-11-16') returning id`, [noun]);
    const card = await q(`insert into public.cards (week_id, title, planned_on) values ($1, 'Patchouli is not just a smell', '2026-11-17') returning id`, [week]);
    const version = await q(`insert into public.versions (card_id, r2_bucket, r2_key) values ($1, 'edits', 'noun/week-3/patchouli-v1.mp4') returning id`, [card]);
    const ig = await q(`insert into public.social_accounts (platform_key, username) values ('instagram', 'nounnaturals') returning id`);
    const fb = await q(`insert into public.social_accounts (platform_key, username) values ('facebook', 'Noun Naturals') returning id`);
    return { week, card, version, ig, fb };
  });
  await as(db, owner, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [strat, ids.ig]));
  const approval = await oneAs(db, admin, `insert into public.approvals (version_id, decision) values ($1, 'approved') returning id`, [ids.version]);
  return { db, owner, admin, strat, viewer, noun, approval, ...ids };
}

const status = (w, post) => one(w.db, `select status::text from public.posts where id = $1`, [post]);
const setPost = (w, who, post, sql, params = []) => as(w.db, who, (tx) => tx.query(`update public.posts set ${sql} where id = $1`, [post, ...params]));

/** A post scheduled by a person, with the approval unless told otherwise. fresh: a new version of the card with its own
    approval (none when approval is null), since one video holds one live post per account. */
async function scheduled(w, who, { account = w.ig, approval, fresh = false } = {}) {
  let version = w.version;
  let appr = approval === undefined ? w.approval : approval;
  if (fresh) {
    version = await oneAs(w.db, w.admin, `insert into public.versions (card_id, r2_bucket, r2_key) values ($1, 'edits', 'noun/week-3/patchouli-' || gen_random_uuid() || '.mp4') returning id`, [w.card]);
    appr = approval === null ? null : await oneAs(w.db, w.admin, `insert into public.approvals (version_id, decision) values ($1, 'approved') returning id`, [version]);
  }
  return oneAs(w.db, who,
    `insert into public.posts (version_id, account_id, status, scheduled_for, approval_id, caption)
     values ($1, $2, 'scheduled', now() + interval '1 hour', $3, 'Patchouli') returning id`,
    [version, account, appr]);
}

/** What the run does: claim it (scheduled to posting, attempt_count + 1), then write the try. Answers the try's id. */
async function startTry(w, post) {
  return as(w.db, "service", async (tx) => {
    const n = (await tx.query(`update public.posts set status = 'posting', attempt_count = attempt_count + 1 where id = $1 returning attempt_count`, [post])).rows[0].attempt_count;
    return (await tx.query(`insert into public.post_attempts (post_id, attempt_no) values ($1, $2) returning id`, [post, n])).rows[0].id;
  });
}
const claim = (w, attempt, who = "service") => oneAs(w.db, who, `select public.claim_post_publish($1)`, [attempt]);
const claimedAt = (w, attempt) => one(w.db, `select publish_claimed_at from public.post_attempts where id = $1`, [attempt]);

/* ---------- 1. the hole: posting and posted are read only for people ---------- */

test("a person cannot move a posting or posted post back: posted to scheduled or draft, posting to scheduled or cancelled", async () => {
  const w = await world();
  const posting = await scheduled(w, w.owner);
  await startTry(w, posting);
  const posted = await scheduled(w, w.admin, { fresh: true });
  await startTry(w, posted);
  await setPost(w, "service", posted, `status = 'posted', external_post_id = 'ig-1'`);
  assert.equal(await status(w, posted), "posted");

  for (const who of [w.owner, w.admin, w.strat]) {
    await assert.rejects(setPost(w, who, posting, `status = 'scheduled', scheduled_for = now() + interval '1 day'`), MOVED);
    await assert.rejects(setPost(w, who, posting, `status = 'cancelled'`), MOVED);
    await assert.rejects(setPost(w, who, posting, `status = 'draft'`), MOVED);
    await assert.rejects(setPost(w, who, posted, `status = 'scheduled', scheduled_for = now() + interval '1 day'`), MOVED);
    await assert.rejects(setPost(w, who, posted, `status = 'draft'`), MOVED);
    await assert.rejects(setPost(w, who, posted, `status = 'cancelled'`), MOVED);
  }
  assert.equal(await status(w, posting), "posting");
  assert.equal(await status(w, posted), "posted");
});

test("a person cannot change anything on a posting or posted post; the server still moves it on", async () => {
  const w = await world();
  const posting = await scheduled(w, w.owner);
  await startTry(w, posting);
  await assert.rejects(setPost(w, w.owner, posting, `caption = 'Changed while posting'`), CHANGED);
  await assert.rejects(setPost(w, w.owner, posting, `account_id = $2`, [w.fb]), CHANGED);
  await assert.rejects(setPost(w, w.owner, posting, `deleted_at = now()`), CHANGED);
  await assert.rejects(setPost(w, w.owner, posting, `scheduled_for = now() + interval '3 days'`), CHANGED);
  assert.equal(await one(w.db, `select caption from public.posts where id = $1`, [posting]), "Patchouli");

  /* the server: posting to posted, and posting to failed then a retry */
  await setPost(w, "service", posting, `status = 'posted', external_post_id = 'ig-2', permalink = 'https://www.instagram.com/reel/x'`);
  assert.equal(await status(w, posting), "posted");
  await assert.rejects(setPost(w, w.owner, posting, `permalink = 'https://example.test/fake'`), CHANGED);
  await assert.rejects(setPost(w, w.owner, posting, `external_post_id = null`), CHANGED);

  const again = await scheduled(w, w.owner, { fresh: true });
  await startTry(w, again);
  await setPost(w, "service", again, `status = 'failed', failed_reason = 'Instagram could not fetch the video'`);
  assert.equal(await status(w, again), "failed");
  /* a failed post is a person's again: edit it */
  await setPost(w, w.owner, again, `caption = 'Fixed caption'`);
  assert.equal(await one(w.db, `select caption from public.posts where id = $1`, [again]), "Fixed caption");
  /* the server sends a post to TikTok's inbox from posting, as before */
  const tt = await scheduled(w, w.owner, { fresh: true });
  await startTry(w, tt);
  await setPost(w, "service", tt, `status = 'finish_in_tiktok'`);
  assert.equal(await status(w, tt), "finish_in_tiktok");
});

test("a person's moves: failed to scheduled with the approval, failed to cancelled, cancelled to draft and back to scheduled", async () => {
  const w = await world();
  const post = await scheduled(w, w.strat);
  await startTry(w, post);
  await setPost(w, "service", post, `status = 'failed', failed_reason = 'timeout'`);
  /* the Strategist/Editor schedules it again: judged as themself, with the approval */
  await setPost(w, w.strat, post, `status = 'scheduled', scheduled_for = now() + interval '2 hours'`);
  const row = (await w.db.query(`select status::text, scheduled_by, approved_by, posted_without_approval, attempt_count from public.posts where id = $1`, [post])).rows[0];
  assert.deepEqual(row, { status: "scheduled", scheduled_by: w.strat, approved_by: w.admin, posted_without_approval: false, attempt_count: 1 });
  /* edits while scheduled are fine */
  await setPost(w, w.strat, post, `caption = 'New words', scheduled_for = now() + interval '3 hours'`);
  /* without the approval it is refused, as before */
  await assert.rejects(setPost(w, w.strat, post, `approval_id = null`), /needs an approval/);

  await setPost(w, w.strat, post, `status = 'cancelled'`);
  assert.equal(await status(w, post), "cancelled");
  await setPost(w, w.strat, post, `status = 'draft'`);
  assert.equal(await status(w, post), "draft");
  await setPost(w, w.strat, post, `status = 'scheduled', scheduled_for = now() + interval '1 day'`);
  assert.equal(await status(w, post), "scheduled");
  await setPost(w, w.strat, post, `status = 'draft'`);
  await setPost(w, w.strat, post, `status = 'cancelled'`);
  assert.equal(await status(w, post), "cancelled");

  /* failed to draft */
  const p2 = await scheduled(w, w.strat);
  await startTry(w, p2);
  await setPost(w, "service", p2, `status = 'failed'`);
  await setPost(w, w.strat, p2, `status = 'draft'`);
  assert.equal(await status(w, p2), "draft");
  /* the system's statuses stay the system's */
  await assert.rejects(setPost(w, w.strat, p2, `status = 'posting'`), /Only the system moves a post to posting/);
  await assert.rejects(setPost(w, w.owner, p2, `status = 'failed'`), /Only the system moves a post to failed/);
  await assert.rejects(setPost(w, w.owner, p2, `status = 'posted'`), /Only the system moves a post to posted/);
});

test("a post waiting in TikTok: a person marks it posted or cancels it, and moves it nowhere else", async () => {
  const w = await world();
  const toTikTok = async () => {
    const p = await scheduled(w, w.owner, { fresh: true });
    await startTry(w, p);
    await setPost(w, "service", p, `status = 'finish_in_tiktok'`);
    return p;
  };
  const a = await toTikTok();
  await assert.rejects(setPost(w, w.owner, a, `status = 'scheduled', scheduled_for = now() + interval '1 day'`), /finished in TikTok can only be marked posted or cancelled/);
  await assert.rejects(setPost(w, w.owner, a, `status = 'draft'`), /finished in TikTok can only be marked posted or cancelled/);
  await setPost(w, w.admin, a, `status = 'posted'`);
  const row = (await w.db.query(`select status::text, finished_by, posted_at is not null as out from public.posts where id = $1`, [a])).rows[0];
  assert.deepEqual(row, { status: "posted", finished_by: w.admin, out: true });
  /* and once posted it is read only */
  await assert.rejects(setPost(w, w.owner, a, `status = 'cancelled'`), MOVED);

  const b = await toTikTok();
  await setPost(w, w.owner, b, `status = 'cancelled'`);
  assert.equal(await status(w, b), "cancelled");
});

/* ---------- 2. the one time publish switch ---------- */

test("claim_post_publish: true once, then false; the time is saved on that try only", async () => {
  const w = await world();
  const post = await scheduled(w, w.strat);
  const attempt = await startTry(w, post);
  assert.equal(await claimedAt(w, attempt), null);
  assert.equal(await claim(w, attempt), true);
  const at = await claimedAt(w, attempt);
  assert.ok(at instanceof Date);
  assert.equal(await claim(w, attempt), false);
  assert.equal(await claim(w, attempt), false);
  assert.deepEqual(await claimedAt(w, attempt), at, "the first time stays");
  assert.equal(await status(w, post), "posting", "the switch never moves the post");
  /* an unknown try */
  assert.equal(await claim(w, "00000000-0000-4000-8000-000000000000"), false);
});

test("claim_post_publish: false when the try is finished or removed, is not the latest, or the post is not posting", async () => {
  const w = await world();
  /* a finished try */
  const p1 = await scheduled(w, w.owner);
  const a1 = await startTry(w, p1);
  await as(w.db, "service", (tx) => tx.query(`update public.post_attempts set finished_at = now(), ok = false where id = $1`, [a1]));
  assert.equal(await claim(w, a1), false);
  assert.equal(await claimedAt(w, a1), null);

  /* a removed try */
  const p2 = await scheduled(w, w.owner, { fresh: true });
  const a2 = await startTry(w, p2);
  await as(w.db, "service", (tx) => tx.query(`update public.post_attempts set deleted_at = now() where id = $1`, [a2]));
  assert.equal(await claim(w, a2), false);

  /* the post is not posting: failed, then scheduled again */
  const p3 = await scheduled(w, w.owner, { fresh: true });
  const a3 = await startTry(w, p3);
  await setPost(w, "service", p3, `status = 'failed'`);
  assert.equal(await claim(w, a3), false);
  await setPost(w, w.owner, p3, `status = 'scheduled', scheduled_for = now() + interval '1 hour'`);
  assert.equal(await claim(w, a3), false);
  /* a new try on the same post: the old one is not the latest, the new one is */
  const a3b = await startTry(w, p3);
  assert.equal(await claim(w, a3), false, "an older try never claims");
  assert.equal(await claim(w, a3b), true);

  /* the post posted already, or removed */
  const p4 = await scheduled(w, w.owner, { fresh: true });
  const a4 = await startTry(w, p4);
  await setPost(w, "service", p4, `status = 'posted'`);
  assert.equal(await claim(w, a4), false);
  const p5 = await scheduled(w, w.owner, { fresh: true });
  const a5 = await startTry(w, p5);
  await setPost(w, "service", p5, `deleted_at = now()`);
  assert.equal(await claim(w, a5), false);
});

test("claim_post_publish raises when the approval was revoked meanwhile, and nothing is claimed", async () => {
  const w = await world();
  const post = await scheduled(w, w.strat);
  const attempt = await startTry(w, post);
  await as(w.db, w.owner, (tx) => tx.query(`update public.approvals set revoked_at = now() where id = $1`, [w.approval]));
  await assert.rejects(claim(w, attempt), (e) => e.code === "P0001" && e.message === "This needs a live approval (approved, not revoked)");
  assert.equal(await claimedAt(w, attempt), null);
});

test("an approval undone after the switch: our server still records posted (it is already out), and a person's move from scheduled is still judged", async () => {
  const w = await world();
  const post = await scheduled(w, w.strat);
  const attempt = await startTry(w, post);
  assert.equal(await claim(w, attempt), true);
  await as(w.db, w.owner, (tx) => tx.query(`update public.approvals set revoked_at = now() where id = $1`, [w.approval]));
  await as(w.db, "service", (tx) => tx.query(`update public.posts set status = 'posted', external_post_id = '1789' where id = $1`, [post]));
  assert.equal(await one(w.db, `select status::text from public.posts where id = $1`, [post]), "posted");
  /* the same undone approval still stops a new post of that video */
  await assert.rejects(scheduled(w, w.strat), (e) => e.code === "P0001");
});

test("claim_post_publish raises when the scheduler lost posting permission, was removed, or needs an approval that is not there", async () => {
  const w = await world();
  /* the channel is taken away while Instagram prepares */
  const p1 = await scheduled(w, w.strat);
  const a1 = await startTry(w, p1);
  await as(w.db, w.owner, (tx) => tx.query(`update public.person_posting_accounts set deleted_at = now() where profile_id = $1`, [w.strat]));
  await assert.rejects(claim(w, a1), (e) => e.code === "P0001" && e.message === "You do not have posting permission on this account");
  assert.equal(await claimedAt(w, a1), null);

  /* the scheduler is removed from the team */
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [w.strat, w.ig]));
  const p2 = await scheduled(w, w.strat, { fresh: true });
  const a2 = await startTry(w, p2);
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set access_status = 'removed' where id = $1`, [w.strat]));
  await assert.rejects(claim(w, a2), (e) => e.code === "P0001" && e.message === "Only active people can schedule or post");
  assert.equal(await claimedAt(w, a2), null);

  /* an owner's post without an approval passes; the same for nobody's would not (the server cannot post on its own) */
  const p3 = await scheduled(w, w.owner, { approval: null, fresh: true });
  const a3 = await startTry(w, p3);
  assert.equal(await claim(w, a3), true);
  const p4 = await scheduled(w, w.owner, { approval: null, fresh: true });
  const a4 = await startTry(w, p4);
  /* nobody scheduled it any more (as a database owner writing directly would leave it) */
  await w.db.query(`alter table public.posts disable trigger b_posts_before_write`);
  await w.db.query(`update public.posts set scheduled_by = null where id = $1`, [p4]);
  await w.db.query(`alter table public.posts enable trigger b_posts_before_write`);
  await assert.rejects(claim(w, a4), (e) => e.code === "P0001" && e.message === "This post needs an approval of this video first");
});

test("claim_post_publish is our server's alone: not for signed in people or anon", async () => {
  const w = await world();
  const post = await scheduled(w, w.owner);
  const attempt = await startTry(w, post);
  for (const who of [w.owner, w.admin, w.strat, "anon"]) await assert.rejects(claim(w, attempt, who), DENIED, String(who));
  for (const role of ["anon", "authenticated", "public"]) {
    assert.equal(await one(w.db, `select has_function_privilege($1, 'public.claim_post_publish(uuid)', 'execute')`, [role]), false, role);
  }
  assert.equal(await one(w.db, `select has_function_privilege('service_role', 'public.claim_post_publish(uuid)', 'execute')`), true);
  for (const fn of ["private.judge_post(uuid, uuid, uuid, uuid, uuid, uuid)", "private.call_posting_run()"]) {
    for (const role of ["anon", "authenticated", "service_role"]) {
      assert.equal(await one(w.db, `select has_function_privilege($1, $2, 'execute')`, [role, fn]), false, `${role} ${fn}`);
    }
  }
  /* and nobody writes the switch by hand: the tries are read only for people */
  await assert.rejects(as(w.db, w.owner, (tx) => tx.query(`update public.post_attempts set publish_claimed_at = now() where id = $1`, [attempt])), DENIED);
  assert.equal(await claimedAt(w, attempt), null);
});

/* ---------- 3. who settled a post ---------- */

test("resolved_by and resolved_at: a person cannot write them; our server writes them for someone holding posting.resolve", async () => {
  const w = await world();
  const fresh = await oneAs(w.db, w.owner,
    `insert into public.posts (version_id, account_id, status, scheduled_for, approval_id, resolved_by, resolved_at)
     values ($1, $2, 'scheduled', now() + interval '1 hour', $3, $4, now()) returning id`, [w.version, w.ig, w.approval, w.owner]);
  assert.deepEqual((await w.db.query(`select resolved_by, resolved_at from public.posts where id = $1`, [fresh])).rows[0], { resolved_by: null, resolved_at: null });
  await setPost(w, w.owner, fresh, `resolved_by = $2, resolved_at = now(), caption = 'hi'`, [w.owner]);
  assert.deepEqual((await w.db.query(`select resolved_by, resolved_at, caption from public.posts where id = $1`, [fresh])).rows[0], { resolved_by: null, resolved_at: null, caption: "hi" });

  /* a post that needed a check: the server settles it for the admin ("It is posted") */
  const post = await scheduled(w, w.owner, { fresh: true });
  await startTry(w, post);
  await setPost(w, "service", post, `status = 'posted', resolved_by = $2`, [w.admin]);
  const row = (await w.db.query(`select status::text, resolved_by, resolved_at is not null as at from public.posts where id = $1`, [post])).rows[0];
  assert.deepEqual(row, { status: "posted", resolved_by: w.admin, at: true });
  /* not for someone without the permission, nor for someone removed */
  const other = await scheduled(w, w.owner, { fresh: true });
  await startTry(w, other);
  await assert.rejects(setPost(w, "service", other, `status = 'failed', resolved_by = $2`, [w.strat]), /Only someone who may settle posts/);
  await as(w.db, w.owner, (tx) => tx.query(`update public.profiles set access_status = 'removed' where id = $1`, [w.viewer]));
  await assert.rejects(setPost(w, "service", other, `status = 'failed', resolved_by = $2`, [w.viewer]), /Only someone who may settle posts/);
  await setPost(w, "service", other, `status = 'failed', resolved_by = $2, failed_reason = 'Not posted (checked by hand)'`, [w.owner]);
  assert.equal(await one(w.db, `select resolved_by from public.posts where id = $1`, [other]), w.owner);
  /* and a person's later edit keeps who settled it */
  await setPost(w, w.admin, other, `resolved_by = null, resolved_at = null, caption = 'try again'`);
  const kept = (await w.db.query(`select resolved_by, resolved_at is not null as at from public.posts where id = $1`, [other])).rows[0];
  assert.deepEqual(kept, { resolved_by: w.owner, at: true });
});

/* ---------- 4. the permission ---------- */

test("posting.resolve: in the list with its words, ticked for Owner and Admin only", async () => {
  const w = await world();
  const p = (await w.db.query(`select group_key, group_label, label, hint, deleted_at from public.permissions where key = 'posting.resolve'`)).rows[0];
  assert.deepEqual(p, {
    group_key: "posting", group_label: "Posting", label: "Settle posts that need a check",
    hint: "Mark a post Meta did not answer clearly about as posted or not posted.", deleted_at: null,
  });
  const holders = (await w.db.query(
    `select r.key from public.role_permissions rp join public.roles r on r.id = rp.role_id
     where rp.permission_key = 'posting.resolve' and rp.deleted_at is null order by 1`)).rows.map((r) => r.key);
  assert.deepEqual(holders, ["admin", "owner"]);
  assert.equal(await one(w.db, `select count(*)::int from public.role_permissions where permission_key = 'posting.resolve' and granted_by is not null`), 0);
  /* as the app asks it */
  assert.equal(await oneAs(w.db, w.admin, `select private.has_permission('posting.resolve')`), true);
  assert.equal(await oneAs(w.db, w.strat, `select private.has_permission('posting.resolve')`), false);
});

/* ---------- 5. the posting timer ---------- */

test("the posting timer: quiet without Vault or the secret; with it, one call to /api/posting/run with the secret", async () => {
  const w = await world();
  /* the throwaway database has no pg_cron: the job is skipped, the function is there */
  assert.equal(await one(w.db, `select count(*)::int from pg_available_extensions where name in ('pg_cron', 'pg_net')`), 0);
  assert.equal(await one(w.db, `select to_regnamespace('cron') is null`), true);
  await w.db.query(`select private.call_posting_run()`);

  /* stand ins for Supabase Vault and pg_net */
  await w.db.exec(`
    create schema vault;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
    create schema net;
    create table net.calls (url text, headers jsonb, body jsonb, timeout_ms int);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
    returns bigint language sql as $$ insert into net.calls values (url, headers, body, timeout_milliseconds) returning 1::bigint $$;
  `);
  await w.db.query(`select private.call_posting_run()`);
  assert.equal(await one(w.db, `select count(*)::int from net.calls`), 0, "no secret: nothing is called");
  await w.db.query(`insert into vault.decrypted_secrets values ('posting_run_secret', '')`);
  await w.db.query(`select private.call_posting_run()`);
  assert.equal(await one(w.db, `select count(*)::int from net.calls`), 0, "an empty secret: nothing is called");
  await w.db.query(`update vault.decrypted_secrets set decrypted_secret = 'shh-test-secret' where name = 'posting_run_secret'`);
  await w.db.query(`select private.call_posting_run()`);
  const calls = (await w.db.query(`select url, headers, body, timeout_ms from net.calls`)).rows;
  assert.deepEqual(calls, [{
    url: "https://art.incivera.ai/api/posting/run",
    headers: { "content-type": "application/json", "x-posting-secret": "shh-test-secret" },
    body: {},
    timeout_ms: 55000,
  }]);
  /* nobody but the timer runs it */
  for (const who of [w.owner, "service", "anon"]) {
    await assert.rejects(as(w.db, who, (tx) => tx.query(`select private.call_posting_run()`)), DENIED, String(who));
  }
});

/* ---------- 6. the run's lease ---------- */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const takeLease = (w, who = "service", seconds = 90) => oneAs(w.db, who, `select public.take_posting_lease($1)`, [seconds]);
const releaseLease = (w, token, who = "service") => oneAs(w.db, who, `select public.release_posting_lease($1)`, [token]);
const leaseRow = async (w) => (await w.db.query(`select holder, expires_at from private.posting_run_lease`)).rows;

test("the run's lease: a token once, null while held, a new token after it runs out; only its own token gives it back", async () => {
  const w = await world();
  assert.deepEqual(await leaseRow(w), [{ holder: null, expires_at: null }], "one row, free");
  const audit = await one(w.db, `select count(*)::int from public.audit_log`);
  const t1 = await takeLease(w);
  assert.match(t1, UUID);
  const [row] = await leaseRow(w);
  assert.equal(row.holder, t1);
  const ms = new Date(row.expires_at).getTime() - Date.now();
  assert.ok(ms > 80_000 && ms <= 91_000, `about 90 seconds ahead (${ms} ms)`);
  assert.equal(await takeLease(w), null, "held");
  assert.equal(await takeLease(w), null, "still held");
  /* a wrong token, or none, gives nothing back */
  assert.equal(await releaseLease(w, "00000000-0000-4000-8000-000000000000"), false);
  assert.equal(await releaseLease(w, null), false);
  assert.equal((await leaseRow(w))[0].holder, t1);
  /* it runs out by itself; the late run's token then frees nothing */
  await w.db.query(`update private.posting_run_lease set expires_at = now() - interval '1 second'`);
  const t2 = await takeLease(w);
  assert.match(t2, UUID);
  assert.notEqual(t2, t1);
  assert.equal(await releaseLease(w, t1), false, "the run that went long cannot free the next run's lease");
  assert.equal(await takeLease(w), null);
  assert.equal(await releaseLease(w, t2), true);
  assert.deepEqual(await leaseRow(w), [{ holder: null, expires_at: null }]);
  assert.match(await takeLease(w), UUID, "free again");
  await assert.rejects(takeLease(w, "service", 0), /1 to 600 seconds/);
  await assert.rejects(takeLease(w, "service", 601), /1 to 600 seconds/);
  assert.equal(await one(w.db, `select count(*)::int from public.audit_log`), audit, "no audit rows");
  await assert.rejects(w.db.query(`delete from private.posting_run_lease`), /delete|Never|not/i);
});

test("the run's lease is our server's alone: not for signed in people or anon, and its table is closed to every app role", async () => {
  const w = await world();
  for (const who of [w.owner, w.admin, w.strat, "anon"]) {
    await assert.rejects(takeLease(w, who), DENIED, `take ${who}`);
    await assert.rejects(releaseLease(w, "00000000-0000-4000-8000-000000000000", who), DENIED, `release ${who}`);
  }
  for (const fn of ["public.take_posting_lease(int)", "public.release_posting_lease(uuid)"]) {
    for (const role of ["anon", "authenticated", "public"]) {
      assert.equal(await one(w.db, `select has_function_privilege($1, $2, 'execute')`, [role, fn]), false, `${role} ${fn}`);
    }
    assert.equal(await one(w.db, `select has_function_privilege('service_role', $1, 'execute')`, [fn]), true, fn);
  }
  for (const who of [w.owner, "service", "anon"]) {
    await assert.rejects(rowsOf(w, who), DENIED, `read ${who}`);
  }
  for (const role of ["anon", "authenticated", "service_role"]) {
    for (const priv of ["select", "insert", "update", "delete"]) {
      assert.equal(await one(w.db, `select has_table_privilege($1, 'private.posting_run_lease', $2)`, [role, priv]), false, `${role} ${priv}`);
    }
  }
  assert.equal(await one(w.db, `select relrowsecurity from pg_class where oid = 'private.posting_run_lease'::regclass`), true, "RLS on");
  assert.equal(await one(w.db, `select count(*)::int from pg_policies where schemaname = 'private' and tablename = 'posting_run_lease'`), 0, "no policies");
  assert.equal(await one(w.db, `select count(*)::int from pg_trigger where tgrelid = 'private.posting_run_lease'::regclass and tgname = 'zz_audit'`), 0, "no audit trigger");
  assert.deepEqual(await leaseRow(w), [{ holder: null, expires_at: null }], "nothing was taken");
});

const rowsOf = (w, who) => as(w.db, who, (tx) => tx.query(`select * from private.posting_run_lease`));

/* ---------- 7. the daily cap's default ---------- */

test("a new account starts at 3 posts a day; accounts saved before the draft keep their number", async () => {
  const db = await freshDb();
  await db.query(`insert into public.social_accounts (platform_key, username, daily_cap) values ('instagram', 'paused', 0), ('instagram', 'five', 5)`);
  await db.query(`insert into public.social_accounts (platform_key, username) values ('facebook', 'old default')`);
  await db.exec(readFileSync(DRAFT, "utf8"));
  const caps = Object.fromEntries((await db.query(`select username, daily_cap from public.social_accounts order by username`)).rows.map((r) => [r.username, r.daily_cap]));
  assert.deepEqual(caps, { paused: 0, five: 5, "old default": 0 }, "existing rows unchanged");
  await db.query(`insert into public.social_accounts (platform_key, username) values ('instagram', 'brand new')`);
  assert.equal(await one(db, `select daily_cap from public.social_accounts where username = 'brand new'`), 3);
});

test("one live post per video per account: a second one is refused; after a stop or a failure it may be scheduled again", async () => {
  const w = await world();
  const first = await scheduled(w, w.strat);
  /* a double click, or a second person at the same time */
  await assert.rejects(scheduled(w, w.admin), (e) => e.code === "23505");
  /* another account takes the same video */
  await scheduled(w, w.admin, { account: w.fb });
  /* stopped: free again */
  await setPost(w, w.strat, first, `status = 'cancelled'`);
  const second = await scheduled(w, w.strat);
  /* failed: free again, and the failed one cannot come back while the new one is live */
  await startTry(w, second);
  await setPost(w, "service", second, `status = 'failed'`);
  const third = await scheduled(w, w.strat);
  await assert.rejects(setPost(w, w.strat, second, `status = 'scheduled', scheduled_for = now() + interval '2 hours'`), (e) => e.code === "23505");
  assert.equal(await status(w, third), "scheduled");
});
