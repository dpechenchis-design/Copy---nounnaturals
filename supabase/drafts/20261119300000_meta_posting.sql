-- =====================================================================
-- Noun ART: Meta posting, the database part (DRAFT, not live).
-- Written Nov 16 2026 for the Meta posting plan (docs/META.md, section 5,
-- "The database change"), reviewed by Fable 5.2. Behavior tests:
-- supabase/tests/meta-posting.test.mjs.
--
-- THIS IS A DRAFT WAITING FOR THE OWNER'S APPROVAL. It is kept out of
-- supabase/migrations on purpose: every file in that folder runs on the
-- live database when main is pushed. Approving it means MOVING this file
-- into supabase/migrations under a name whose timestamp is later than the
-- newest file there (rename it if a newer file landed meanwhile; a copy
-- would make test:db apply it twice), and updating docs/DATA.md in the
-- same commit. It runs after the seven drafts before it, in name order,
-- but needs none of them.
--
-- What it does, in plain words:
--   1. Closes a hole in the posting rule. Before this, a signed in person
--      could move a post that was already posting or posted back to
--      scheduled, and the run would post it a second time. Now a post that
--      is posting or posted is read only for people; only our own server
--      moves it on (to posted, failed or finish in TikTok). The other moves a
--      person may make are listed in section 3.
--   2. A one time switch on each try (post_attempts.publish_claimed_at),
--      flipped by the server only function public.claim_post_publish right
--      before the last step at Meta (Instagram's publish, Facebook's
--      finish). It judges the post again at that moment, exactly as the
--      posting rule judges a server step (the same helper), so an approval
--      undone while Instagram was preparing stops it here. Once flipped, the
--      run never publishes that try again.
--   3. Who settled a post that needed a check (posts.resolved_by,
--      posts.resolved_at). Only our own server writes them, and only with a
--      person who holds the new permission.
--   4. The permission "Settle posts that need a check" (posting.resolve),
--      ticked for Owner and Admin.
--   5. The posting timer: every minute Supabase calls the published app's
--      /api/posting/run with a shared secret from Vault. Without the secret
--      it does nothing.
--
--   6. The run's lease (section 5b): one posting run at a time, one row
--      in the private table private.posting_run_lease (no app role reaches
--      it, no audit), taken and given back with a token by our server only.
--   7. A new social account starts at 3 posts a day (daily_cap default 3).
--      Accounts already saved keep their number.
--   8. One live post per video per account (posts_one_live_per_account):
--      a double click, or two people scheduling at once, can never put
--      the same video on the same account twice.
--
-- New public functions: claim_post_publish, take_posting_lease and
-- release_posting_lease, for our server alone (granted to service_role
-- only). The helpers stay in private, closed to everyone.
-- Never DELETE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The permission, after "See post numbers" (120) and before the Make
--    with AI group (130). Owner and Admin get it. Strategist/Editor and
--    Viewer do not; any custom role can be given it like every other key.
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('posting.resolve', 'posting', 'Posting', 'Settle posts that need a check', 'Mark a post Meta did not answer clearly about as posted or not posted.', 125);

insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, 'posting.resolve', null
from public.roles r
where r.key in ('owner', 'admin')
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = 'posting.resolve' and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 2. New columns.
-- ---------------------------------------------------------------------
alter table public.post_attempts add column publish_claimed_at timestamptz;
comment on column public.post_attempts.publish_claimed_at is
  'When our server passed the point of no return on this try (right before the last step at the platform). Set once, by public.claim_post_publish only. Set means the post may be out: never publish this try again.';

alter table public.posts add column resolved_by uuid references public.profiles (id);
alter table public.posts add column resolved_at timestamptz;

-- A new account starts at 3 posts a day (owner, Nov 16 2026; raised per
-- account in Accounts). Accounts already saved keep their number: a 0 there
-- may be a deliberate pause.
alter table public.social_accounts alter column daily_cap set default 3;
-- One live post per video per account (owner rule: never post the same
-- video twice on one account). The app checks it too; this is the lock.
-- Cancelled, failed and deleted posts do not count, so a failed post can
-- be scheduled again. The live list matches LIVE_POST_STATUSES in
-- src/lib/content/posting.ts. Nothing posts before this draft, so the
-- table has no two live posts of one video on one account; if it ever
-- did, this line would stop the whole draft (count them before the push).
create unique index posts_one_live_per_account on public.posts (account_id, (coalesce(version_id, variant_id, asset_id)))
  where deleted_at is null and coalesce(version_id, variant_id, asset_id) is not null
    and status in ('draft', 'scheduled', 'posting', 'posted', 'finish_in_tiktok');

comment on column public.posts.resolved_by is
  'Who settled this post when the platform did not answer clearly ("It is posted" or "It is not posted"). Written by our server only, for a person holding posting.resolve.';
comment on column public.posts.resolved_at is 'When that person settled it.';

-- ---------------------------------------------------------------------
-- 3. The judgement, in one place. The posting rule (posts_before_write)
--    and the one time switch (claim_post_publish) both call it, so they can
--    never drift apart. Same rules and same sentences as before:
--      * p_judge is the person judged (null: nobody, so an approval is
--        always needed).
--      * That person must be active, and hold that exact account unless
--        their role has "Post on every channel without an approval".
--      * A live approval of this exact video is needed, unless the person
--        has that permission or their "needs admin approval before posting"
--        box is unticked. Whoever approved held "Approve or reject videos"
--        when they did (approvals_before_insert).
--      * A variant with someone's likeness always needs an owner approval.
--    Answers the approval row (all empty when there is none).
-- ---------------------------------------------------------------------
create or replace function private.judge_post(p_judge uuid, p_account uuid, p_version uuid, p_variant uuid, p_asset uuid, p_approval uuid)
returns public.approvals language plpgsql stable security definer set search_path = '' as $$
declare
  v public.approvals%rowtype;
  v_role uuid;
  v_free boolean;
  v_needs_flag boolean;
  v_needs_approval boolean;
  v_likeness boolean;
begin
  if p_judge is not null then
    select p.role_id, p.needs_post_approval into v_role, v_needs_flag from public.profiles p
     where p.id = p_judge and p.access_status = 'active' and p.deleted_at is null;
    if v_role is null then
      raise exception 'Only active people can schedule or post';
    end if;
    v_free := private.role_has(v_role, 'posting.all_channels');
    if not v_free
       and not exists (select 1 from public.person_posting_accounts pa
                       where pa.profile_id = p_judge and pa.account_id = p_account and pa.deleted_at is null) then
      raise exception 'You do not have posting permission on this account';
    end if;
    v_needs_approval := not v_free and v_needs_flag;
  else
    v_needs_approval := true;
  end if;

  v_likeness := exists (select 1 from public.variant_faces vf
                        where vf.variant_id = p_variant and vf.deleted_at is null);
  if p_approval is not null then
    v := private.approval_matches(p_approval, p_version, p_variant, p_asset);
  elsif v_needs_approval or v_likeness then
    raise exception 'This post needs an approval of this video first';
  end if;
  if v_likeness and v.decided_by_role is distinct from 'owner' then
    raise exception 'This video uses someone''s likeness: only an owner approval lets it post';
  end if;
  return v;
end;
$$;
revoke all on function private.judge_post(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;
comment on function private.judge_post(uuid, uuid, uuid, uuid, uuid, uuid) is
  'The posting judgement, shared by the posting rule and claim_post_publish: the person (active, posting permission on the account), the approval and the likeness rule. Raises a plain sentence when the post may not go out.';

-- ---------------------------------------------------------------------
-- 4. The posting rule: the same function as the team access migration
--    (5h), with the judgement moved into private.judge_post and these
--    changes:
--      * A post that is posting or posted is read only for people: they may
--        not move it ("A post that is posting or posted cannot be moved")
--        nor change anything on it ("... cannot be changed"). Only our own
--        server moves it on.
--      * The moves a person may make by hand:
--          to scheduled: from draft, failed or cancelled (and edits while
--            scheduled);
--          to draft: from scheduled, failed or cancelled;
--          to cancelled: from draft, scheduled, failed or finish in TikTok;
--          to posted: from finish in TikTok only (they finished it there).
--        A post waiting in TikTok goes nowhere else by hand.
--      * resolved_by and resolved_at are our server's: a person's write
--        keeps the old values. When our server writes a person there, that
--        person must be active and hold posting.resolve.
--    Everything else is as before: who is judged, what is cleared on a move
--    back to draft or cancelled, the fields only this trigger writes.
-- ---------------------------------------------------------------------
create or replace function private.posts_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v public.approvals%rowtype;
  v_actor uuid := auth.uid();
  v_judge uuid;
  v_role uuid;
  v_changed boolean := false;
  v_live constant text[] := array['scheduled', 'posting', 'posted', 'finish_in_tiktok'];
begin
  select a.platform_key into new.platform_key from public.social_accounts a where a.id = new.account_id;

  -- Fields only this trigger writes.
  if tg_op = 'INSERT' then
    new.scheduled_by := null;
    new.scheduled_at := null;
    new.approved_by := null;
    new.posted_without_approval := false;
  else
    new.scheduled_by := old.scheduled_by;
    new.scheduled_at := old.scheduled_at;
    new.approved_by := old.approved_by;
    new.posted_without_approval := old.posted_without_approval;
    v_changed := new.account_id is distinct from old.account_id
                 or new.version_id is distinct from old.version_id
                 or new.variant_id is distinct from old.variant_id
                 or new.asset_id is distinct from old.asset_id;
    -- Back to draft or cancelled: nobody is scheduling it any more.
    if new.status in ('draft', 'cancelled') then
      new.scheduled_by := null;
      new.scheduled_at := null;
      new.approved_by := null;
      new.posted_without_approval := false;
    end if;
    -- A different video or account is never covered by who scheduled the old
    -- one, unless a signed in person schedules it in this same write (then they
    -- are judged as themself and become scheduled_by below).
    if v_changed and not (v_actor is not null and new.status = 'scheduled') then
      new.scheduled_by := null;
    end if;
  end if;

  -- What a signed in person may do by hand.
  if v_actor is not null then
    if tg_op = 'INSERT' then
      if new.status not in ('draft', 'scheduled') then
        raise exception 'A new post starts as a draft or scheduled';
      end if;
      new.attempt_count := 0;
      new.failed_reason := null;
      new.posted_at := null;
      new.resolved_by := null;
      new.resolved_at := null;
    else
      -- A post that is posting or posted is our server's alone.
      if old.status in ('posting', 'posted') and new.status is distinct from old.status then
        raise exception 'A post that is posting or posted cannot be moved';
      end if;
      if new.status is distinct from old.status
         and not (new.status in ('draft', 'scheduled', 'cancelled')
                  or (new.status = 'posted' and old.status = 'finish_in_tiktok')) then
        raise exception 'Only the system moves a post to %', new.status;
      end if;
      if new.status is distinct from old.status and old.status = 'finish_in_tiktok'
         and new.status not in ('posted', 'cancelled') then
        raise exception 'A post waiting to be finished in TikTok can only be marked posted or cancelled';
      end if;
      new.attempt_count := old.attempt_count;
      new.failed_reason := old.failed_reason;
      new.posted_at := old.posted_at;
      new.resolved_by := old.resolved_by;
      new.resolved_at := old.resolved_at;
      if old.status in ('posting', 'posted')
         and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
        raise exception 'A post that is posting or posted cannot be changed';
      end if;
    end if;
  elsif new.resolved_by is not null
        and (tg_op = 'INSERT' or new.resolved_by is distinct from old.resolved_by) then
    -- Our server records who settled it: someone who may settle posts.
    select p.role_id into v_role from public.profiles p
     where p.id = new.resolved_by and p.access_status = 'active' and p.deleted_at is null;
    if v_role is null or not private.role_has(v_role, 'posting.resolve') then
      raise exception 'Only someone who may settle posts can be recorded as settling one';
    end if;
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;

  if new.status::text = any (v_live)
     and (tg_op = 'INSERT'
          or new.status is distinct from old.status
          or new.account_id is distinct from old.account_id
          or new.version_id is distinct from old.version_id
          or new.variant_id is distinct from old.variant_id
          or new.asset_id is distinct from old.asset_id
          or new.approval_id is distinct from old.approval_id) then

    if v_actor is not null and new.status = 'scheduled'
       and (tg_op = 'INSERT' or old.status is distinct from 'scheduled' or v_changed) then
      new.scheduled_by := v_actor;
      new.scheduled_at := now();
    elsif v_actor is null and new.status = 'scheduled'
          and (tg_op = 'INSERT' or old.status is distinct from 'scheduled') then
      new.scheduled_at := now();
    end if;

    -- Who is judged. A signed in person: themself. Our own server: the person
    -- who scheduled it, but only to carry on or retry exactly what that person
    -- scheduled (from scheduled, posting, failed or finish in TikTok, same
    -- video, same account). Anything else the server does needs an approval.
    if v_actor is not null then
      v_judge := v_actor;
    elsif tg_op = 'UPDATE' and not v_changed and new.scheduled_by is not null
          and old.status in ('scheduled', 'posting', 'failed', 'finish_in_tiktok') then
      v_judge := new.scheduled_by;
    else
      v_judge := null;
    end if;

    -- Our server recording what already went out (posting to posted or to
    -- finish in TikTok, same video, same account) is not judged again: the
    -- post was judged when it was claimed and again by the one time switch
    -- right before the last step. Judging it here would leave a post that
    -- is live on the platform stuck in "posting" when an approval is undone
    -- in that last minute. approved_by and posted_without_approval keep the
    -- values copied from the old row above.
    if not (v_actor is null and tg_op = 'UPDATE' and not v_changed
            and old.status = 'posting' and new.status in ('posted', 'finish_in_tiktok')
            and new.approval_id is not distinct from old.approval_id) then
      v := private.judge_post(v_judge, new.account_id, new.version_id, new.variant_id, new.asset_id, new.approval_id);
      new.approved_by := v.decided_by;
      new.posted_without_approval := new.approval_id is null;
    end if;
  end if;

  if new.status = 'posted' and new.posted_at is null then
    new.posted_at := now();
  end if;
  if new.status = 'posted' and tg_op = 'UPDATE' and old.status = 'finish_in_tiktok' and v_actor is not null then
    new.finished_by := v_actor;
    new.finished_at := now();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. The one time switch. Our server calls it right before the last step
--    at the platform. It locks the post, then the try, and answers:
--      true:  the switch was flipped now; go ahead and publish, once.
--      false: nothing changed: already flipped, the try is finished or
--             removed, it is not the post's latest try, or the post is not
--             posting (or removed). Do not publish.
--    Before flipping, it judges the post exactly as the posting rule judges
--    a server step from posting (the person who scheduled it, or nobody so
--    an approval is needed) and raises the same plain sentence when the post
--    may no longer go out (an approval undone, a channel taken away).
-- ---------------------------------------------------------------------
create or replace function public.claim_post_publish(p_attempt_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_post_id uuid;
  p public.posts%rowtype;
  a public.post_attempts%rowtype;
begin
  select pa.post_id into v_post_id from public.post_attempts pa where pa.id = p_attempt_id;
  if v_post_id is null then
    return false;
  end if;
  -- Lock the post first, then the try (the order the run writes them in).
  select * into p from public.posts where id = v_post_id for update;
  select * into a from public.post_attempts where id = p_attempt_id for update;
  if a.publish_claimed_at is not null or a.finished_at is not null or a.deleted_at is not null
     or p.id is null or p.deleted_at is not null or p.status <> 'posting'
     or a.attempt_no is distinct from p.attempt_count then
    return false;
  end if;
  perform private.judge_post(p.scheduled_by, p.account_id, p.version_id, p.variant_id, p.asset_id, p.approval_id);
  update public.post_attempts set publish_claimed_at = now() where id = a.id;
  return true;
end;
$$;
revoke all on function public.claim_post_publish(uuid) from public, anon, authenticated;
grant execute on function public.claim_post_publish(uuid) to service_role;
comment on function public.claim_post_publish(uuid) is
  'Our server only: flip the one time publish switch on a try, after judging the post again. True once; false when already flipped or not eligible; raises when the post may no longer go out.';

-- ---------------------------------------------------------------------
-- 5b. The run's lease: one posting run at a time. A run can take longer
--     than a minute (Meta is slow, or several posts are due), and two runs
--     at once could meet at Instagram's last step. Each run first takes the
--     lease (90 seconds) and gets a token; it gives the lease back with that
--     token when it ends, so a run that went long can never free the lease
--     of the run after it. A run that finds the lease held does nothing.
--     The lease is one row in a private table: no app role can read or
--     write it, PostgREST never shows it, and it has no audit trigger (a
--     write every minute would flood the audit trail). Only these two server
--     functions touch it.
-- ---------------------------------------------------------------------
create table private.posting_run_lease (
  id boolean primary key default true check (id),
  holder uuid,
  expires_at timestamptz
);
comment on table private.posting_run_lease is
  'One row: which posting run holds the lease (a random token) and until when. Our server only, through take_posting_lease and release_posting_lease.';
alter table private.posting_run_lease enable row level security;
revoke all on table private.posting_run_lease from public, anon, authenticated, service_role;
insert into private.posting_run_lease (id, holder, expires_at) values (true, null, null);
create trigger no_hard_delete before delete on private.posting_run_lease for each row execute function private.block_delete();
create trigger no_truncate before truncate on private.posting_run_lease for each statement execute function private.block_delete();

create or replace function public.take_posting_lease(p_seconds int)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid := gen_random_uuid();
  v_got uuid;
begin
  if p_seconds is null or p_seconds < 1 or p_seconds > 600 then
    raise exception 'The posting lease is 1 to 600 seconds';
  end if;
  -- One statement: the row lock makes a second caller wait, then see the new
  -- time and change nothing.
  update private.posting_run_lease l
     set holder = v_token, expires_at = clock_timestamp() + make_interval(secs => p_seconds)
   where l.id and (l.expires_at is null or l.expires_at <= clock_timestamp())
  returning l.holder into v_got;
  return v_got;
end;
$$;
revoke all on function public.take_posting_lease(int) from public, anon, authenticated;
grant execute on function public.take_posting_lease(int) to service_role;
comment on function public.take_posting_lease(int) is
  'Our server only: take the posting run''s lease for p_seconds. Answers the run''s token when it was free (or ran out); null while another run holds it.';

create or replace function public.release_posting_lease(p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_n int;
begin
  update private.posting_run_lease l set holder = null, expires_at = null
   where l.id and p_token is not null and l.holder = p_token;
  get diagnostics v_n = row_count;
  return v_n = 1;
end;
$$;
revoke all on function public.release_posting_lease(uuid) from public, anon, authenticated;
grant execute on function public.release_posting_lease(uuid) to service_role;
comment on function public.release_posting_lease(uuid) is
  'Our server only: give the posting run''s lease back. Clears it only for the token that took it; true when it did.';

-- ---------------------------------------------------------------------
-- 6. The posting timer (pg_cron + pg_net), the same pattern as the UGC
--    sync. Every minute Supabase calls the published app:
--      POST https://art.incivera.ai/api/posting/run   header x-posting-secret
--    The secret is NOT in this file. The owner saves it once in Supabase
--    Vault under the name posting_run_secret (and the same value in Replit
--    Secrets as POSTING_RUN_SECRET). Until he does, the timer runs and does
--    nothing. Skipped where the two extensions do not exist (the throwaway
--    test database). Running it again replaces the job, never doubles it.
--    No app role gets the function or the extensions' functions: only the
--    timer itself (the database owner) uses them.
--    First real test: the first run on the live project. If the role that
--    runs migrations may not create these extensions there, the owner turns
--    on "pg_cron" and "pg_net" once under Database, Extensions, before this
--    file is pushed, and this section then finds them.
-- ---------------------------------------------------------------------
create or replace function private.call_posting_run()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    return;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v_secret using 'posting_run_secret';
  if v_secret is null or v_secret = '' then
    return;
  end if;
  execute 'select net.http_post(url := $1, headers := $2, body := $3, timeout_milliseconds := 55000)'
    using 'https://art.incivera.ai/api/posting/run',
          jsonb_build_object('content-type', 'application/json', 'x-posting-secret', v_secret),
          '{}'::jsonb;
end;
$$;
revoke all on function private.call_posting_run() from public, anon, authenticated, service_role;
comment on function private.call_posting_run() is
  'The posting timer''s one job: ask the published app to post what is due. Reads the shared secret from Vault; does nothing without it.';

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    execute 'create extension if not exists pg_cron';
    execute 'create extension if not exists pg_net';
    -- one job of this name, never two
    execute 'select cron.unschedule(jobid) from cron.job where jobname = $1' using 'posting-run';
    -- every minute
    execute $cron$select cron.schedule('posting-run', '* * * * *', $job$select private.call_posting_run()$job$)$cron$;
  end if;
end;
$$;
