-- =====================================================================
-- Noun ART: Gmail invites.
-- Written Nov 15 2026 (plan by Fable 5.2, docs/drafts/plan-view-as-and-gmail-invites.md, Brief B).
-- Approved by the owner on Nov 15 2026. Behavior tests: supabase/tests/gmail-invites.test.mjs.
--
-- What it does, in plain words:
--   * google_links: one row per person, their own Google connection for
--     sending invites from their Gmail. It keeps Google's refresh token
--     sealed by our server (AES-256-GCM with TOKEN_ENCRYPTION_KEY, which is
--     only in Replit Secrets), never in the clear. Each person reads and
--     writes only their own row, with their own session. No service role.
--     Disconnect empties the token and sets deleted_at: never a delete.
--   * invite_emails: the send log. Every attempt to email an invite is a
--     row: sent, failed or not_connected, with Gmail's message and thread
--     ids. Written by the inviter, read by people who manage the team.
--     Never changed, never deleted.
--
-- Rules followed (supabase/README.md): explicit grants, never DELETE,
-- row level security, no_hard_delete, no_truncate, updated_at, zz_audit on
-- invite_emails. google_links is left out of zz_audit on purpose: the audit
-- trail would keep a copy of every sealed token, also after Disconnect.
-- Who connected and when stays on the row itself (linked_at, deleted_at).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table public.google_links (
  profile_id uuid primary key references public.profiles (id) default auth.uid(),
  -- "v1.<iv>.<tag>.<data>", sealed by the server and bound to profile_id; empty after Disconnect
  refresh_enc text check (refresh_enc is null or refresh_enc ~ '^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$'),
  -- what Google allowed, for example https://www.googleapis.com/auth/gmail.send
  scopes text[] not null default '{}',
  linked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (deleted_at is not null or refresh_enc is not null)
);
comment on table public.google_links is 'Each person''s own Google connection (send invites from their Gmail). The refresh token is sealed by the server; only its owner reads or writes the row.';

create table public.invite_emails (
  id uuid primary key default gen_random_uuid(),
  invite_id uuid not null references public.invites (id),
  to_email text not null check (length(to_email) <= 254),
  from_email text check (from_email is null or length(from_email) <= 254),
  sent_by uuid not null references public.profiles (id) default auth.uid(),
  subject text not null check (length(subject) <= 300),
  status text not null check (status in ('sent', 'failed', 'not_connected')),
  gmail_message_id text,
  gmail_thread_id text,
  error text check (error is null or length(error) <= 500),
  created_at timestamptz not null default now()
);
create index invite_emails_invite on public.invite_emails (invite_id, created_at desc);
comment on table public.invite_emails is 'Every attempt to email an invite from the inviter''s Gmail: sent, failed or not_connected. Never changed or deleted.';

-- ---------------------------------------------------------------------
-- 2. The same steps the first migration ran in its loops (they only ran once)
-- ---------------------------------------------------------------------
alter table public.google_links enable row level security;
alter table public.invite_emails enable row level security;

create trigger z_set_updated_at before update on public.google_links
  for each row execute function private.set_updated_at();
create trigger no_hard_delete before delete on public.google_links
  for each row execute function private.block_delete();
create trigger no_truncate before truncate on public.google_links
  for each statement execute function private.block_delete();

create trigger no_hard_delete before delete on public.invite_emails
  for each row execute function private.block_delete();
create trigger no_truncate before truncate on public.invite_emails
  for each statement execute function private.block_delete();
create trigger zz_audit after insert or update on public.invite_emails
  for each row execute function private.audit_row();

-- invite_emails rows never change once written (no update policy or grant
-- either; this also stops our own server role).
create or replace function private.block_invite_email_edit()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'invite_emails rows are never changed' using errcode = '42501';
end;
$$;
revoke execute on function private.block_invite_email_edit() from public;
create trigger no_edit before update on public.invite_emails
  for each row execute function private.block_invite_email_edit();

-- ---------------------------------------------------------------------
-- 3. Grants: exactly what the policies allow. Nobody gets DELETE or TRUNCATE.
-- Supabase may grant everything on a new table to anon, authenticated and
-- service_role by default, so all four are revoked. Our server never uses the
-- service role here (each person's own session does the work), so it gets nothing.
-- ---------------------------------------------------------------------
revoke all on public.google_links from anon, authenticated, service_role, public;
revoke all on public.invite_emails from anon, authenticated, service_role, public;
grant select, insert, update on public.google_links to authenticated;
grant select, insert on public.invite_emails to authenticated;

-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
-- google_links: your own row only, and only while you are let in.
create policy google_links_select on public.google_links for select to authenticated
  using (profile_id = (select auth.uid()));
create policy google_links_insert on public.google_links for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select private.is_active_user()));
create policy google_links_update on public.google_links for update to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()) and (select private.is_active_user()));

-- invite_emails: written by the person who sends, as themself, for an invite
-- they can see (invites_select: owner and admins); read by the same people.
create policy invite_emails_insert on public.invite_emails for insert to authenticated
  with check (
    sent_by = (select auth.uid())
    and (select private.is_manager())
    and exists (select 1 from public.invites i where i.id = invite_id)
  );
create policy invite_emails_select on public.invite_emails for select to authenticated
  using ((select private.is_manager()));

-- When the team access migration (docs/drafts/team-access-migration-draft.sql)
-- lands first, replace private.is_manager() above with its permission check
-- for team.manage, so a custom role that manages the team can log and read.
