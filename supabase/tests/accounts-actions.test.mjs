// Behavior tests for the Accounts screen on the live schema (no migration of its own): each test runs the exact read or
// write src/lib/content/accounts-actions.ts and accounts-db.ts make, with the same person's session, on a throwaway
// database. The lock is posting.accounts on social_accounts and posting_slots (20261115200000_team_access.sql):
// owners and admins have it, Strategist/Editor does not, a custom role may.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, signUp, as, rowsAs, oneAs, one } from "./helpers.mjs";

async function world() {
  const db = await freshDb();
  const owner = await signUp(db, "khaled@nounnaturals.com", "Khaled");
  const inv = (email, role) => as(db, owner, (tx) => tx.query(`insert into public.invites (email, role) values ($1, $2)`, [email, role]));
  await inv("steven@nounnaturals.com", "admin");
  await inv("strat@agency.test", "strategist");
  await inv("poster@agency.test", "strategist");
  const admin = await signUp(db, "steven@nounnaturals.com", "Steven");
  const strategist = await signUp(db, "strat@agency.test", "Daryna");
  const scheduler = await signUp(db, "poster@agency.test", "Olena");
  /* a custom role an admin builds: accounts and posting times, and the Accounts page, nothing else */
  await as(db, admin, async (tx) => {
    const id = (await tx.query(`insert into public.roles (name) values ('Scheduler') returning id`)).rows[0].id;
    for (const k of ["posting.accounts", "page.accounts"]) await tx.query(`insert into public.role_permissions (role_id, permission_key) values ($1, $2)`, [id, k]);
    await tx.query(`update public.profiles set role_id = $1 where id = $2`, [id, scheduler]);
  });
  /* an account as src/lib/social/store.ts saveAccount leaves it (our server, the service role) */
  const tiktok = await oneAs(
    db,
    "service",
    `insert into public.social_accounts (platform_key, username, external_id, health, posts_private_until_review, connected_by, connected_at, created_by)
     values ('tiktok', '@nounnaturals', 'open-1', 'ok', true, $1, now(), $1) returning id`,
    [owner],
  );
  const youtube = await oneAs(db, "service", `insert into public.social_accounts (platform_key, username, created_by) values ('youtube', '@nounnaturals', $1) returning id`, [owner]);
  return { db, owner, admin, strategist, scheduler, tiktok, youtube };
}

/* the writes, exactly as the actions send them through supabase-js */
const setCap = (db, who, id, cap) => rowsAs(db, who, `update public.social_accounts set daily_cap = $2 where id = $1 and deleted_at is null returning id`, [id, cap]);
const addSlots = (db, who, account, rows) =>
  rowsAs(
    db,
    who,
    `insert into public.posting_slots (account_id, weekday, local_time) select $1, (r->>'weekday')::smallint, (r->>'local_time')::time from jsonb_array_elements($2::jsonb) r returning id`,
    [account, JSON.stringify(rows)],
  );
const removeSlots = (db, who, account, ids) =>
  rowsAs(db, who, `update public.posting_slots set deleted_at = now() where id = any($2::uuid[]) and account_id = $1 and deleted_at is null returning id`, [account, ids]);
const liveSlots = (db, account) => db.query(`select weekday, local_time::text as t from public.posting_slots where account_id = $1 and deleted_at is null order by t, weekday`, [account]).then((r) => r.rows);

test("seed: posting.accounts is held by Owner and Admin, not by Strategist/Editor; a custom role can hold it", async () => {
  const w = await world();
  for (const [who, has] of [[w.owner, true], [w.admin, true], [w.strategist, false], [w.scheduler, true]]) {
    assert.equal(await oneAs(w.db, who, `select private.has_permission('posting.accounts')`), has);
  }
});

test("everyone let in reads the accounts and time slots the screen shows; never account_tokens", async () => {
  const w = await world();
  await addSlots(w.db, w.owner, w.tiktok, [{ weekday: 1, local_time: "18:30" }]);
  for (const who of [w.owner, w.admin, w.strategist, w.scheduler]) {
    const acc = await rowsAs(
      w.db,
      who,
      `select id, platform_key, username, display_name, external_id, avatar_url, followers_count, health, health_note, posts_private_until_review, connected_at, daily_cap, auto_post, timezone
         from public.social_accounts where deleted_at is null order by created_at`,
    );
    assert.equal(acc.length, 2);
    assert.equal(acc[0].timezone, "America/New_York");
    const slots = await rowsAs(w.db, who, `select id, account_id, weekday, local_time, is_active from public.posting_slots where account_id = $1 and deleted_at is null`, [w.tiktok]);
    assert.equal(slots.length, 1);
    await assert.rejects(rowsAs(w.db, who, `select * from public.account_tokens`), /permission denied/);
  }
});

test("daily cap: owner, admin and a custom role with posting.accounts save it; Strategist/Editor changes nothing", async () => {
  const w = await world();
  assert.equal((await setCap(w.db, w.owner, w.tiktok, 12)).length, 1);
  assert.equal(await one(w.db, `select daily_cap from public.social_accounts where id = $1`, [w.tiktok]), 12);
  assert.equal((await setCap(w.db, w.admin, w.tiktok, 8)).length, 1);
  assert.equal((await setCap(w.db, w.scheduler, w.tiktok, 6)).length, 1);
  assert.equal(await one(w.db, `select daily_cap from public.social_accounts where id = $1`, [w.tiktok]), 6);
  /* row level security hides the row from the update: no row back, nothing changed (the action says "You need the permission") */
  assert.deepEqual(await setCap(w.db, w.strategist, w.tiktok, 40), []);
  assert.equal(await one(w.db, `select daily_cap from public.social_accounts where id = $1`, [w.tiktok]), 6);
});

test("daily cap: below 0 is refused by the database", async () => {
  const w = await world();
  await assert.rejects(setCap(w.db, w.owner, w.tiktok, -1), /check constraint/);
});

test("time slots: owner and admin add them; Strategist/Editor is refused", async () => {
  const w = await world();
  const every = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, local_time: "18:30:00" }));
  assert.equal((await addSlots(w.db, w.owner, w.tiktok, every)).length, 7);
  assert.equal((await addSlots(w.db, w.admin, w.tiktok, [{ weekday: 1, local_time: "09:00:00" }])).length, 1);
  assert.equal((await addSlots(w.db, w.scheduler, w.tiktok, [{ weekday: 2, local_time: "09:00:00" }])).length, 1);
  await assert.rejects(addSlots(w.db, w.strategist, w.tiktok, [{ weekday: 3, local_time: "09:00:00" }]), /row-level security/);
  assert.equal((await liveSlots(w.db, w.tiktok)).length, 9);
  /* who added it: created_by is filled by the database with the person signed in */
  assert.equal(await one(w.db, `select created_by from public.posting_slots where account_id = $1 and weekday = 1 and local_time = '09:00'`, [w.tiktok]), w.admin);
});

test("time slots: one live row per account, day and time; after a remove the same time can be added again", async () => {
  const w = await world();
  const [id] = (await addSlots(w.db, w.owner, w.tiktok, [{ weekday: 1, local_time: "18:30:00" }])).map((r) => r.id);
  await assert.rejects(addSlots(w.db, w.admin, w.tiktok, [{ weekday: 1, local_time: "18:30:00" }]), /duplicate key/);
  assert.equal((await removeSlots(w.db, w.admin, w.tiktok, [id])).length, 1);
  assert.equal((await addSlots(w.db, w.admin, w.tiktok, [{ weekday: 1, local_time: "18:30:00" }])).length, 1);
  /* the removed row is still there: never a hard delete */
  assert.equal(await one(w.db, `select count(*)::int from public.posting_slots where account_id = $1`, [w.tiktok]), 2);
  await assert.rejects(rowsAs(w.db, w.owner, `delete from public.posting_slots where id = $1`, [id]));
});

test("changing a time (the action's plan): new rows first, then the old ones get deleted_at", async () => {
  const w = await world();
  const ids = (await addSlots(w.db, w.owner, w.tiktok, [1, 2, 3].map((weekday) => ({ weekday, local_time: "09:00:00" })))).map((r) => r.id);
  /* 9:00 Mon Tue Wed becomes 9:00 Tue Wed Thu: keep Tue and Wed, add Thu, remove Mon */
  const monday = (await rowsAs(w.db, w.admin, `select id from public.posting_slots where id = any($1::uuid[]) and weekday = 1`, [ids]))[0].id;
  assert.equal((await addSlots(w.db, w.admin, w.tiktok, [{ weekday: 4, local_time: "09:00:00" }])).length, 1);
  assert.equal((await removeSlots(w.db, w.admin, w.tiktok, [monday])).length, 1);
  assert.deepEqual(await liveSlots(w.db, w.tiktok), [2, 3, 4].map((weekday) => ({ weekday, t: "09:00:00" })));
});

test("changing a time while someone else removed one of its days: the count tells, and the new time stays once", async () => {
  const w = await world();
  const ids = (await addSlots(w.db, w.owner, w.tiktok, [1, 2].map((weekday) => ({ weekday, local_time: "09:00:00" })))).map((r) => r.id);
  /* 9:00 Mon Tue becomes 18:30 Mon Tue: the new rows first */
  const added = (await addSlots(w.db, w.admin, w.tiktok, [1, 2].map((weekday) => ({ weekday, local_time: "18:30:00" })))).map((r) => r.id);
  /* the owner removes Monday's 9:00 at the same moment */
  assert.equal((await removeSlots(w.db, w.owner, w.tiktok, [ids[0]])).length, 1);
  /* the action's remove changes one row where it planned two: it stops there and retires nothing it just added */
  assert.equal((await removeSlots(w.db, w.admin, w.tiktok, ids)).length, 1);
  assert.equal(added.length, 2);
  assert.deepEqual(await liveSlots(w.db, w.tiktok), [1, 2].map((weekday) => ({ weekday, t: "18:30:00" })));
  /* a take back scoped to another account touches nothing */
  assert.deepEqual(await removeSlots(w.db, w.admin, w.youtube, added), []);
  assert.equal((await liveSlots(w.db, w.tiktok)).length, 2);
});

test("removing a time: Strategist/Editor changes nothing; an id from another account is not touched", async () => {
  const w = await world();
  const [id] = (await addSlots(w.db, w.owner, w.tiktok, [{ weekday: 5, local_time: "12:00:00" }])).map((r) => r.id);
  assert.deepEqual(await removeSlots(w.db, w.strategist, w.tiktok, [id]), []);
  assert.deepEqual(await removeSlots(w.db, w.owner, w.youtube, [id]), [], "the account filter keeps a stray id out");
  assert.equal((await liveSlots(w.db, w.tiktok)).length, 1);
});

test("the screen's other reads: ticked channels (own rows only) and today's posts", async () => {
  const w = await world();
  await as(w.db, w.owner, (tx) => tx.query(`insert into public.person_posting_accounts (profile_id, account_id) values ($1, $2)`, [w.strategist, w.tiktok]));
  const mine = (who) => rowsAs(w.db, who, `select account_id from public.person_posting_accounts where profile_id = $1 and deleted_at is null`, [who]);
  assert.deepEqual((await mine(w.strategist)).map((r) => r.account_id), [w.tiktok]);
  assert.deepEqual(await mine(w.scheduler), []);
  /* a person cannot read someone else's ticked channels unless they manage the team */
  assert.deepEqual(await rowsAs(w.db, w.scheduler, `select account_id from public.person_posting_accounts where profile_id = $1`, [w.strategist]), []);
  /* the posts read runs for everyone let in (no posts yet: zero, never an error) */
  for (const who of [w.owner, w.strategist]) {
    const rows = await rowsAs(
      w.db,
      who,
      `select id, account_id, status, scheduled_for, posted_at from public.posts where account_id = any($1::uuid[]) and deleted_at is null and scheduled_for >= now() - interval '36 hours' and scheduled_for < now() + interval '36 hours'`,
      [[w.tiktok, w.youtube]],
    );
    assert.deepEqual(rows, []);
  }
});
