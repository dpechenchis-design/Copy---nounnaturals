-- =====================================================================
-- Noun ART: Team and access (custom roles, page access).
-- Written Nov 15 2026 by Fable 5.2; page keys added the same day.
-- Approved by the owner on Nov 15 2026. Behavior tests: supabase/tests/team-access.test.mjs.
--
-- What it does, in plain words:
--   * Roles become rows the owner can build, like the Noun ERP. The five
--     roles of the first migration (Owner, Admin, Strategist, Editor,
--     Viewer) are the prebuilt ones. A custom role is a name plus a set of
--     permissions ticked from one fixed list.
--   * Every rule in the database that asked "is this an owner or admin"
--     (or strategist, editor, viewer) now asks "does this person's role
--     have this permission". For the five prebuilt roles nothing changes:
--     each keeps exactly what it could do before.
--   * Posting stays per person (channels ticked under the person, and the
--     "Needs admin approval before posting" box). Spaces stay per person.
--     A role can carry "Opens every space" and "Posts on every channel
--     without an approval", which is what Owner and Admin always had.
--   * Nobody changes their own role. Nobody gives a permission they do not
--     have. A person who manages the team only manages people whose role
--     does less than their own. The Owner role is locked. There is always
--     one active owner.
--   * Every change is history: roles and their permissions are never
--     deleted (a removed tick is a row with deleted_at), the audit trail
--     records each change, and profile_role_changes keeps who had which
--     role when.
--
-- Legacy columns kept so old rows and old code stay true:
--   profiles.role, invites.role and approvals.decided_by_role (the enum)
--   are filled by the database for a prebuilt role and are empty for a
--   custom role. The source of truth is role_id.
--
-- Rules followed (supabase/README.md): explicit grants, never DELETE,
-- row level security, no_hard_delete, no_truncate, zz_audit, updated_at,
-- realtime, narrow functions, no demo data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
create table public.permissions (
  key text primary key check (key ~ '^[a-z_]+\.[a-z_]+$'),
  group_key text not null,
  group_label text not null,
  label text not null,
  hint text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
comment on table public.permissions is 'The fixed list of things a role may be allowed to do, in groups, with the words shown on screen. Changed only by a migration.';

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  -- Only the prebuilt roles have a key (owner, admin, strategist, editor, viewer). A custom role has none.
  key text check (key ~ '^[a-z0-9_]+$'),
  name text not null check (btrim(name) <> '' and length(name) <= 40),
  description text,
  -- A design token name or a choice from the pill color picker, like card_statuses.color.
  color text not null default 'st-idea',
  is_system boolean not null default false,
  -- Locked: its permissions never change (the Owner role).
  is_locked boolean not null default false,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) default auth.uid(),
  deleted_at timestamptz,
  check (is_system = (key is not null))
);
create unique index roles_key on public.roles (key) where key is not null;
create unique index roles_name_key on public.roles (lower(btrim(name))) where deleted_at is null;
comment on table public.roles is 'Roles: the five prebuilt ones and any custom role the owner builds. A role is a name plus its ticked permissions.';

create table public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_id uuid not null references public.roles (id),
  permission_key text not null references public.permissions (key),
  granted_by uuid references public.profiles (id) default auth.uid(),
  granted_at timestamptz not null default now(),
  removed_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index role_permissions_key on public.role_permissions (role_id, permission_key) where deleted_at is null;
create index role_permissions_permission_idx on public.role_permissions (permission_key);
comment on table public.role_permissions is 'Which permissions a role has. A tick is a live row; unticking sets deleted_at, so the history stays.';

create table public.profile_role_changes (
  id bigint generated always as identity primary key,
  profile_id uuid not null references public.profiles (id),
  from_role_id uuid references public.roles (id),
  to_role_id uuid not null references public.roles (id),
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default now()
);
create index profile_role_changes_profile_idx on public.profile_role_changes (profile_id, changed_at desc);
comment on table public.profile_role_changes is 'Who had which role when. One row each time a person gets a role. Written by the database only. Append only.';

-- ---------------------------------------------------------------------
-- 2. Reference data: the permission list, the prebuilt roles and what
--    each may do. No people.
--    The group "Pages" (owner, Nov 15 2026): one key per screen except
--    Home (always open), in sidebar order, labelled as the screen
--    (src/lib/nav.ts). A page key only shows or hides a page; no row level
--    security policy reads one, on purpose, so data stays behind the
--    action keys. The guards below work on any key, page keys included.
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('calendar.plan', 'calendar', 'Calendar', 'Plan weeks and cards', 'Add and change weeks, cards and to do lists, match raw clips to cards, import tables.', 10),
  ('calendar.all_cards', 'calendar', 'Calendar', 'See every card', 'Off: this role sees only the cards assigned to the person.', 20),
  ('calendar.setup', 'calendar', 'Calendar', 'Set up statuses and undo imports', 'Add, rename and recolor statuses. Take an import back.', 30),
  ('footage.upload', 'footage', 'Footage and edits', 'Upload raw clips and new versions', 'Editors upload versions onto the cards they can see.', 40),
  ('footage.direct', 'footage', 'Footage and edits', 'Write directions on raw clips', 'Mark moments and draw on a raw clip for the editor.', 50),
  ('footage.reply', 'footage', 'Footage and edits', 'Reply to directions and notes', 'Answer a direction or a review note with a question, and tick notes fixed.', 60),
  ('review.notes', 'review', 'Review', 'Write review notes and send them to the editor', 'Timestamped notes on a video, and the Send to editor button.', 70),
  ('review.approve', 'review', 'Review', 'Approve or reject videos', 'An approval lets a video be scheduled and posted.', 80),
  ('posting.all_channels', 'posting', 'Posting', 'Post on every channel without an approval', 'Off: the person posts only on the channels ticked for them, and the approval box applies.', 90),
  ('posting.bank', 'posting', 'Posting', 'Manage the bank', 'Put approved videos in the bank and take them out.', 100),
  ('posting.accounts', 'posting', 'Posting', 'Manage accounts and posting times', 'Add accounts, daily caps and time slots. Connecting an account stays the owner''s click.', 110),
  ('posting.numbers', 'posting', 'Posting', 'See post numbers', 'Views, likes and the rest, for every post in their spaces.', 120),
  ('studio.make', 'ai', 'Make with AI', 'Make with AI in the Studio', 'Start AI jobs and chat with the agents.', 130),
  ('rules.propose', 'ai', 'Make with AI', 'Propose checker rules', 'Suggest a house rule for the AI check.', 140),
  ('rules.approve', 'ai', 'Make with AI', 'Approve and switch checker rules', 'Turn a proposed rule on or off, and add reference videos.', 150),
  ('ai.setup', 'ai', 'Make with AI', 'Set up AI tools, models and agents', 'The list of AI vendors, models and agents.', 160),
  ('brand.manage', 'brand', 'Brand', 'Change the brand kit, templates, sounds and lists', 'Faces, claims, brand assets, templates, sounds, and the fixed lists such as content types, formats and products.', 170),
  ('team.manage', 'team', 'Team', 'Invite people and change their access', 'Invite, let in, remove, give a role, tick spaces and channels. Only for people whose role does less than their own. Also removes anyone''s direction or reply.', 180),
  ('team.roles', 'team', 'Team', 'Build and change roles', 'Create a custom role and tick its permissions. Never their own role, and only permissions they have.', 190),
  ('spaces.all', 'team', 'Team', 'Open every space', 'Off: the person opens only the spaces ticked for them.', 200),
  ('spaces.manage', 'team', 'Team', 'Add and rename spaces', null, 210),
  ('team.activity', 'team', 'Team', 'See the audit trail and everyone''s activity', 'Who did what, every AI job, agent chat and notice.', 220),
  ('settings.view', 'team', 'Team', 'See budgets and app settings', 'Read only. Only the owner changes budgets, settings and agent prompts.', 230),
  ('integrations.manage', 'team', 'Team', 'Refresh and resync integrations', 'Re-check health and pull data again. Connecting an account stays the owner''s click.', 240),
  ('page.analytics', 'pages', 'Pages', 'Analytics', null, 300),
  ('page.calendar', 'pages', 'Pages', 'Calendar', null, 310),
  ('page.upload', 'pages', 'Pages', 'Upload', null, 320),
  ('page.review', 'pages', 'Pages', 'Review', null, 330),
  ('page.studio', 'pages', 'Pages', 'Studio', null, 340),
  ('page.carousels', 'pages', 'Pages', 'Carousels and photos', null, 350),
  ('page.ugc', 'pages', 'Pages', 'UGC, mentions and comments', null, 360),
  ('page.bank', 'pages', 'Pages', 'Bank and schedule', null, 370),
  ('page.posting', 'pages', 'Pages', 'Posting', null, 380),
  ('page.accounts', 'pages', 'Pages', 'Accounts', null, 390),
  ('page.brand', 'pages', 'Pages', 'Brand kit', null, 400),
  ('page.templates', 'pages', 'Pages', 'Templates', null, 410),
  ('page.library', 'pages', 'Pages', 'Library', null, 420),
  ('page.sounds', 'pages', 'Pages', 'Sounds', null, 430),
  ('page.discovery', 'pages', 'Pages', 'Discovery', null, 440),
  ('page.community', 'pages', 'Pages', 'Community', null, 450),
  ('page.competitors', 'pages', 'Pages', 'Competitors', null, 460),
  ('page.ads', 'pages', 'Pages', 'Ads', null, 470),
  ('page.activity', 'pages', 'Pages', 'Activity', null, 480),
  ('page.audit', 'pages', 'Pages', 'Audit trail', null, 490),
  ('page.rules', 'pages', 'Pages', 'Checker rules', null, 500),
  ('page.settings', 'pages', 'Pages', 'Settings', null, 510);

insert into public.roles (key, name, description, color, is_system, is_locked, sort_order, created_by) values
  ('owner', 'Owner', 'Everything, always. The Owner role cannot be changed.', 'accent', true, true, 10, null),
  ('admin', 'Admin', 'Runs the content system day to day and builds roles with the owner.', 'st-scheduled', true, false, 20, null),
  ('strategist', 'Strategist', 'Plans the weeks and cards, matches raw clips, writes directions and review notes.', 'st-editing', true, false, 30, null),
  ('editor', 'Editor', 'Sees the cards assigned to them and every raw clip of their spaces. Uploads versions and replies to notes.', 'st-bank', true, false, 40, null),
  ('viewer', 'Viewer', 'Reads the calendar and the numbers. Changes nothing.', 'st-idea', true, false, 50, null);

insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, p.key, null
from public.roles r
join public.permissions p on
  r.key = 'owner'
  or r.key = 'admin'  -- owner, Nov 15: the owner and admins build the roles
  -- Pages: Strategist and Editor open the eight screens editors open today, Home (no key) and seven pages;
  -- Viewer opens Home, Analytics and Calendar. So nothing changes on screen for the five prebuilt roles.
  or (r.key = 'strategist' and p.key in ('calendar.plan', 'calendar.all_cards', 'footage.upload', 'footage.direct',
                                         'footage.reply', 'review.notes', 'posting.numbers', 'studio.make', 'rules.propose',
                                         'page.calendar', 'page.upload', 'page.review', 'page.ugc', 'page.library',
                                         'page.sounds', 'page.brand'))
  or (r.key = 'editor' and p.key in ('footage.upload', 'footage.reply',
                                     'page.calendar', 'page.upload', 'page.review', 'page.ugc', 'page.library',
                                     'page.sounds', 'page.brand'))
  or (r.key = 'viewer' and p.key in ('calendar.all_cards', 'posting.numbers', 'page.analytics', 'page.calendar'));

-- ---------------------------------------------------------------------
-- 3. People, invites and approvals point at a role row. The old enum
--    columns stay, filled by the database (empty for a custom role).
-- ---------------------------------------------------------------------
alter table public.profiles add column role_id uuid references public.roles (id);
update public.profiles p set role_id = (select r.id from public.roles r where r.key = p.role::text);
alter table public.profiles alter column role_id set not null;
alter table public.profiles alter column role drop not null;
create index profiles_role_idx on public.profiles (role_id);
comment on column public.profiles.role_id is 'The person''s role. The source of truth.';
comment on column public.profiles.role is 'Legacy: the prebuilt role''s key, kept in step by the database. Empty for a custom role. Read role_id.';

alter table public.invites add column role_id uuid references public.roles (id);
update public.invites i set role_id = (select r.id from public.roles r where r.key = i.role::text);
alter table public.invites alter column role_id set not null;
alter table public.invites alter column role drop not null;
comment on column public.invites.role is 'Legacy: the prebuilt role''s key, kept in step by the database. Empty for a custom role. Read role_id.';

-- Invites and spaces (owner, Nov 15 2026): every space is ticked by default
-- in the invite sheet and the inviter unticks what the person should not
-- open. This file does not yet give invites a spaces column, so for the real
-- team spaces are still ticked on the person's card after they sign in.
-- When invites get spaces (its own later change, not part of this file):
--   * invites.space_ids uuid[], null by default. Null (no choice made)
--     means every space; a list means exactly those spaces.
--   * handle_new_user and invites_after_insert (5g), after the profile is
--     let in, add one person_spaces row (granted_by = the inviter) for each
--     live space in coalesce(space_ids, every space where deleted_at is null),
--     so a person let in from an invite gets every space unless unticked.
--   * insert and update of space_ids follow the invites policies (team.manage,
--     a role below yours), and each id must be a live space.
--   * tests: an invite with no choice lets the person into every space; an
--     invite with one space unticked leaves that one out.

-- Approvals made before this file keep only the old column (an approval can never be changed).
alter table public.approvals add column decided_by_role_id uuid references public.roles (id);
alter table public.approvals add column decided_by_role_name text;
alter table public.approvals alter column decided_by_role drop not null;
alter table public.approvals alter column decided_by_role drop default;
comment on column public.approvals.decided_by_role_id is 'The role of the person who decided, at that moment. The name is kept beside it in case the role is renamed.';

-- ---------------------------------------------------------------------
-- 4. Helpers (security definer, fixed search_path, private schema)
-- ---------------------------------------------------------------------
-- The caller's role, or null when they are not signed in, not active, or removed.
create or replace function private.current_role_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select p.role_id
  from public.profiles p
  where p.id = auth.uid()
    and p.access_status = 'active'
    and p.deleted_at is null;
$$;

-- Does this role have this permission? The Owner role has every one.
create or replace function private.role_has(p_role uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.roles r
    where r.id = p_role
      and (r.key = 'owner'
           or exists (select 1 from public.role_permissions rp
                      join public.permissions pm on pm.key = rp.permission_key
                      where rp.role_id = r.id and rp.permission_key = p_key
                        and rp.deleted_at is null and pm.deleted_at is null)));
$$;

-- The one question every policy asks: may the caller do this?
create or replace function private.has_permission(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.role_has(private.current_role_id(), p_key);
$$;

-- "Does less than": the target role is not Owner, has nothing the actor's role
-- lacks, and has fewer permissions. Two equal roles are not below each other,
-- so an admin never manages another admin.
create or replace function private.role_below(p_target uuid, p_actor uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.roles t where t.id = p_target and t.key is distinct from 'owner')
    and exists (select 1 from public.roles a where a.id = p_actor)
    and not exists (select 1 from public.role_permissions rp
                    where rp.role_id = p_target and rp.deleted_at is null
                      and not private.role_has(p_actor, rp.permission_key))
    and (select count(*) from public.role_permissions rp where rp.role_id = p_target and rp.deleted_at is null)
        < (select count(*) from public.role_permissions rp where rp.role_id = p_actor and rp.deleted_at is null);
$$;

-- May the caller give this role to someone (invite or change)? The owner: any
-- role. Anyone else who manages the team: only a role that does less than theirs.
create or replace function private.can_grant_role(p_role uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('team.manage')
    and (private.is_owner() or private.role_below(p_role, private.current_role_id()));
$$;

-- May the caller change this person's access (spaces, channels)? Never their
-- own, and only people whose role does less than theirs (the owner: anyone).
create or replace function private.can_manage_person(p_profile uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('team.manage')
    and p_profile is distinct from auth.uid()
    and (private.is_owner()
         or exists (select 1 from public.profiles p
                    where p.id = p_profile and private.role_below(p.role_id, private.current_role_id())));
$$;

-- The helpers of the first migration, now answered from the role's
-- permissions. Policies that still call them keep working unchanged.
create or replace function private.is_active_user()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.current_role_id() is not null;
$$;

create or replace function private.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select r.key = 'owner' from public.roles r where r.id = private.current_role_id()), false);
$$;

-- Manages the team (was: owner or admin).
create or replace function private.is_manager()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('team.manage');
$$;

-- Plans weeks and cards (was: owner, admin, strategist).
create or replace function private.is_planner()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('calendar.plan');
$$;

-- Sees every card of their spaces (was: everyone except editors).
create or replace function private.sees_all_cards()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('calendar.all_cards');
$$;

create or replace function private.can_see_space(p_space uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when p_space is null then false
    when not private.is_active_user() then false
    when private.has_permission('spaces.all') then true
    else exists (
      select 1
      from public.person_spaces ps
      join public.spaces s on s.id = ps.space_id
      where ps.space_id = p_space and ps.profile_id = auth.uid()
        and ps.deleted_at is null and s.deleted_at is null)
  end;
$$;

-- Without "See every card", a person sees only the cards assigned to them.
create or replace function private.card_visible(p_space uuid, p_editor uuid, p_deleted timestamptz)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_see_space(p_space)
    and (private.sees_all_cards()
         or (private.is_active_user() and p_editor = auth.uid() and p_deleted is null));
$$;

create or replace function private.can_post_to(p_account uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('posting.all_channels')
    or (private.is_active_user() and exists (
      select 1 from public.person_posting_accounts pa
      where pa.profile_id = auth.uid() and pa.account_id = p_account and pa.deleted_at is null));
$$;

create or replace function private.can_see_run(p_run uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_permission('team.activity')
    or exists (select 1 from public.agent_runs r where r.id = p_run and r.started_by = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- 5. Trigger functions
-- ---------------------------------------------------------------------
-- 5a. role_id is the truth; the old enum column follows it. Old code that
-- still writes only the enum column is understood too. On profiles and invites.
create or replace function private.sync_role_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
  v_live boolean;
begin
  if tg_op = 'INSERT' then
    if new.role_id is null and new.role is not null then
      select r.id into new.role_id from public.roles r where r.key = new.role::text;
    end if;
  elsif new.role_id is not distinct from old.role_id and new.role is distinct from old.role and new.role is not null then
    select r.id into new.role_id from public.roles r where r.key = new.role::text;
  end if;
  if new.role_id is null then
    raise exception 'Pick a role';
  end if;
  select r.key, r.deleted_at is null into v_key, v_live from public.roles r where r.id = new.role_id;
  if not coalesce(v_live, false) then
    if tg_op = 'INSERT' or new.role_id is distinct from old.role_id then
      raise exception 'That role was removed. Pick another role.';
    end if;
    if tg_table_name = 'profiles' then
      if new.access_status = 'active' and old.access_status is distinct from 'active' then
        raise exception 'Their role was removed. Give them another role first.';
      end if;
    end if;
  end if;
  new.role := case when v_key is null then null else v_key::public.app_role end;
  return new;
end;
$$;

-- 5b. Who had which role when.
create or replace function private.log_role_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.profile_role_changes (profile_id, from_role_id, to_role_id, changed_by)
    values (new.id, null, new.role_id, auth.uid());
  elsif new.role_id is distinct from old.role_id then
    insert into public.profile_role_changes (profile_id, from_role_id, to_role_id, changed_by)
    values (new.id, old.role_id, new.role_id, auth.uid());
  end if;
  return new;
end;
$$;

-- 5c. Roles. A person builds only custom roles; the prebuilt ones keep their
-- key and flags; the Owner role never changes; nobody changes the role they
-- hold; a role in use is never removed.
create or replace function private.guard_role()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_mine uuid := private.current_role_id();
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.key := null;
    new.is_system := false;
    new.is_locked := false;
    new.deleted_at := null;
    new.created_by := auth.uid();
    return new;
  end if;
  if new.id <> old.id or new.key is distinct from old.key or new.is_system is distinct from old.is_system
     or new.is_locked is distinct from old.is_locked or new.created_by is distinct from old.created_by then
    raise exception 'That part of a role cannot be changed';
  end if;
  if old.is_locked then
    raise exception 'The Owner role cannot be changed';
  end if;
  if not private.is_owner() then
    if old.id = v_mine then
      raise exception 'You cannot change your own role';
    end if;
    if exists (select 1 from public.role_permissions rp
               where rp.role_id = old.id and rp.deleted_at is null
                 and not private.role_has(v_mine, rp.permission_key)) then
      raise exception 'You can only change a role that has nothing your own role lacks';
    end if;
  end if;
  if new.deleted_at is not null and old.deleted_at is null then
    if old.is_system then
      raise exception 'A prebuilt role cannot be removed';
    end if;
    if exists (select 1 from public.profiles p
               where p.role_id = old.id and p.deleted_at is null and p.access_status <> 'removed')
       or exists (select 1 from public.invites i
                  where i.role_id = old.id and i.accepted_at is null and i.revoked_at is null and i.deleted_at is null) then
      raise exception 'Move its people and open invites to another role first';
    end if;
  end if;
  return new;
end;
$$;

-- 5d. A role's ticks. Tick: a new row. Untick: deleted_at on the live row,
-- and nothing else about a row ever changes. Never on the Owner role, never
-- on the role you hold, and only a permission you have yourself.
create or replace function private.guard_role_permission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_mine uuid := private.current_role_id();
  v_role public.roles%rowtype;
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  select * into v_role from public.roles r where r.id = new.role_id;
  if v_role.id is null or v_role.deleted_at is not null then
    raise exception 'That role was removed';
  end if;
  if v_role.is_locked then
    raise exception 'The Owner role cannot be changed';
  end if;
  if not private.is_owner() then
    if v_role.id = v_mine then
      raise exception 'You cannot change your own role';
    end if;
    if not private.role_has(v_mine, new.permission_key) then
      raise exception 'You can only give or take a permission you have yourself';
    end if;
    if exists (select 1 from public.role_permissions rp
               where rp.role_id = v_role.id and rp.deleted_at is null
                 and not private.role_has(v_mine, rp.permission_key)) then
      raise exception 'You can only change a role that has nothing your own role lacks';
    end if;
  end if;
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.permissions pm where pm.key = new.permission_key and pm.deleted_at is null) then
      raise exception 'That permission does not exist';
    end if;
    new.granted_by := auth.uid();
    new.granted_at := now();
    new.removed_by := null;
    new.deleted_at := null;
    return new;
  end if;
  if (to_jsonb(new) - array['deleted_at', 'removed_by', 'updated_at'])
     is distinct from (to_jsonb(old) - array['deleted_at', 'removed_by', 'updated_at'])
     or old.deleted_at is not null or new.deleted_at is null then
    raise exception 'A tick is only added or removed. To put it back, add it again.';
  end if;
  new.removed_by := auth.uid();
  return new;
end;
$$;

-- 5e. Profile guard, by permission instead of by role name.
--   * Your own profile: your personal details only, as before.
--   * Someone else's: only role, access, the removal fields and the approval
--     box, only with "Invite people and change their access", and only when
--     both the role they have and the role they get do less than yours.
--     Only an owner touches an owner or makes one.
--   * The last active owner cannot be removed or given another role.
create or replace function private.guard_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_mine uuid := private.current_role_id();
  v_i_am_owner boolean := private.is_owner();
  v_was_owner boolean;
  v_is_owner boolean;
  v_admin_fields constant text[] := array['role', 'role_id', 'access_status', 'needs_post_approval', 'removed_at',
                                          'removed_by', 'deleted_at', 'updated_at'];
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if new.id <> old.id then
    raise exception 'A profile id never changes';
  end if;
  if new.id = auth.uid() then
    if new.email is distinct from old.email then
      raise exception 'Your email comes from Google sign in and cannot be changed here';
    end if;
    if new.invited_by is distinct from old.invited_by
       or new.removed_at is distinct from old.removed_at
       or new.removed_by is distinct from old.removed_by then
      raise exception 'You cannot change who invited or removed you';
    end if;
  elsif (to_jsonb(new) - v_admin_fields) is distinct from (to_jsonb(old) - v_admin_fields) then
    raise exception 'Only the person themself can change their own details';
  end if;
  if new.role_id is distinct from old.role_id
     or new.access_status is distinct from old.access_status
     or new.needs_post_approval is distinct from old.needs_post_approval
     or new.removed_at is distinct from old.removed_at
     or new.removed_by is distinct from old.removed_by
     or new.deleted_at is distinct from old.deleted_at then
    if new.id = auth.uid() then
      raise exception 'You cannot change your own role, access or posting approval';
    end if;
    if v_mine is null or not private.role_has(v_mine, 'team.manage') then
      raise exception 'Only the owner or an admin can change roles and access';
    end if;
    select r.key = 'owner' into v_was_owner from public.roles r where r.id = old.role_id;
    select r.key = 'owner' into v_is_owner from public.roles r where r.id = new.role_id;
    if not v_i_am_owner
       and (not private.role_below(old.role_id, v_mine) or not private.role_below(new.role_id, v_mine)) then
      raise exception 'You can only manage people whose role does less than yours';
    end if;
    if coalesce(v_was_owner, false)
       and (not coalesce(v_is_owner, false) or new.access_status <> 'active' or new.deleted_at is not null)
       and (select count(*) from public.profiles p
            join public.roles r on r.id = p.role_id
            where r.key = 'owner' and p.access_status = 'active' and p.deleted_at is null and p.id <> old.id) = 0 then
      raise exception 'There must always be at least one active owner';
    end if;
    if new.access_status = 'removed' and old.access_status <> 'removed' then
      new.removed_at := now();
      new.removed_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

-- 5f. Approvals: the person deciding must hold "Approve or reject videos".
-- Their role at that moment is saved (id and name; the old column too).
create or replace function private.approvals_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_role_id uuid;
  v_role public.app_role;
  v_name text;
begin
  if auth.uid() is not null then
    new.decided_by := auth.uid();
  end if;
  select p.role_id, p.role, r.name into v_role_id, v_role, v_name
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where p.id = new.decided_by and p.access_status = 'active' and p.deleted_at is null;
  if v_role_id is null or not private.role_has(v_role_id, 'review.approve') then
    raise exception 'Only the owner or an admin can approve or reject (the role needs "Approve or reject videos")';
  end if;
  new.decided_by_role := v_role;
  new.decided_by_role_id := v_role_id;
  new.decided_by_role_name := v_name;
  new.decided_at := now();
  return new;
end;
$$;

-- 5g. First sign in and invites: the same rules, carrying role_id.
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_inv public.invites%rowtype;
begin
  if coalesce(new.raw_app_meta_data ->> 'provider', '') <> 'google'
     or coalesce(btrim(new.email), '') = '' then
    return new;
  end if;
  select * into v_inv
  from public.invites i
  where lower(btrim(i.email)) = lower(btrim(new.email))
    and i.accepted_at is null and i.revoked_at is null and i.deleted_at is null
  order by i.created_at desc
  limit 1;

  insert into public.profiles (id, email, full_name, avatar_url, role_id, access_status, invited_by)
  values (
    new.id,
    btrim(new.email),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    coalesce(v_inv.role_id, (select r.id from public.roles r where r.key = 'viewer')),
    case when v_inv.id is null then 'pending'::public.access_status else 'active'::public.access_status end,
    v_inv.invited_by
  )
  on conflict (id) do nothing;

  if v_inv.id is not null then
    update public.invites set accepted_at = now(), accepted_by = new.id where id = v_inv.id;
  end if;
  return new;
end;
$$;

create or replace function private.invites_after_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_profile uuid;
begin
  if new.accepted_at is not null or new.revoked_at is not null or new.deleted_at is not null then
    return new;
  end if;
  update public.profiles p
     set role_id = new.role_id, access_status = 'active', invited_by = new.invited_by
   where lower(btrim(p.email)) = lower(btrim(new.email)) and p.access_status = 'pending' and p.deleted_at is null
  returning p.id into v_profile;
  if v_profile is not null then
    update public.invites set accepted_at = now(), accepted_by = v_profile where id = new.id;
  end if;
  return new;
end;
$$;

-- 5h. The posting rule: the same function as the first migration with three
-- changes. "Owner or admin" became the permission "Post on every channel
-- without an approval"; an approval counts when the person who gave it held
-- "Approve or reject videos" (checked when it was given); a video with
-- someone's likeness still needs an owner approval.
create or replace function private.posts_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v public.approvals%rowtype;
  v_actor uuid := auth.uid();
  v_judge uuid;
  v_role uuid;
  v_free boolean;
  v_needs_flag boolean;
  v_needs_approval boolean;
  v_likeness boolean;
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
    else
      if new.status is distinct from old.status
         and not (new.status in ('draft', 'scheduled', 'cancelled')
                  or (new.status = 'posted' and old.status = 'finish_in_tiktok')) then
        raise exception 'Only the system moves a post to %', new.status;
      end if;
      new.attempt_count := old.attempt_count;
      new.failed_reason := old.failed_reason;
      new.posted_at := old.posted_at;
    end if;
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
    if v_judge is not null then
      select p.role_id, p.needs_post_approval into v_role, v_needs_flag from public.profiles p
       where p.id = v_judge and p.access_status = 'active' and p.deleted_at is null;
      if v_role is null then
        raise exception 'Only active people can schedule or post';
      end if;
      v_free := private.role_has(v_role, 'posting.all_channels');
      if not v_free
         and not exists (select 1 from public.person_posting_accounts pa
                         where pa.profile_id = v_judge and pa.account_id = new.account_id and pa.deleted_at is null) then
        raise exception 'You do not have posting permission on this account';
      end if;
      v_needs_approval := not v_free and v_needs_flag;
    else
      v_needs_approval := true;
    end if;

    v_likeness := exists (select 1 from public.variant_faces vf
                          where vf.variant_id = new.variant_id and vf.deleted_at is null);
    if new.approval_id is not null then
      -- Whoever approved held "Approve or reject videos" at that moment (approvals_before_insert).
      v := private.approval_matches(new.approval_id, new.version_id, new.variant_id, new.asset_id);
    elsif v_needs_approval or v_likeness then
      raise exception 'This post needs an approval of this video first';
    end if;
    if v_likeness and v.decided_by_role is distinct from 'owner' then
      raise exception 'This video uses someone''s likeness: only an owner approval lets it post';
    end if;
    new.approved_by := v.decided_by;
    new.posted_without_approval := new.approval_id is null;
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

-- 5i. Checker rules: approving and switching needs "Approve and switch checker rules".
create or replace function private.guard_checker_rule()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.proposed_by := auth.uid();
    new.proposed_by_run_id := null;
    if not private.has_permission('rules.approve') then
      new.state := 'proposed';
      new.is_on := false;
    end if;
    if new.state = 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    else
      new.approved_by := null;
      new.approved_at := null;
    end if;
    return new;
  end if;
  if new.proposed_by is distinct from old.proposed_by or new.proposed_by_run_id is distinct from old.proposed_by_run_id
     or new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at then
    if not (new.state = 'approved' and old.state is distinct from 'approved') then
      raise exception 'Who proposed or approved a rule is recorded by the system';
    end if;
  end if;
  if (new.state is distinct from old.state or new.is_on is distinct from old.is_on) and not private.has_permission('rules.approve') then
    raise exception 'Only the owner or an admin can approve or switch a checker rule';
  end if;
  if new.state = 'approved' and old.state is distinct from 'approved' then
    new.approved_by := auth.uid();
    new.approved_at := now();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------
-- Before triggers fire in name order: a_ (fill), c_ (guards), z_ (updated_at).
create trigger a_role_sync before insert or update on public.profiles
  for each row execute function private.sync_role_columns();
create trigger a_role_sync before insert or update on public.invites
  for each row execute function private.sync_role_columns();
create trigger d_log_role_change after insert or update of role_id on public.profiles
  for each row execute function private.log_role_change();
create trigger c_guard_role before insert or update on public.roles
  for each row execute function private.guard_role();
create trigger c_guard_role_permission before insert or update on public.role_permissions
  for each row execute function private.guard_role_permission();

-- People who already have a profile get their first history row.
insert into public.profile_role_changes (profile_id, from_role_id, to_role_id, changed_by)
select p.id, null, p.role_id, null from public.profiles p;

-- The house steps for every new table (the loops of the first migration ran once).
do $$
declare
  t text;
begin
  foreach t in array array['permissions', 'roles', 'role_permissions', 'profile_role_changes']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function private.block_delete()', t);
    execute format('create trigger no_truncate before truncate on public.%I for each statement execute function private.block_delete()', t);
  end loop;
  foreach t in array array['permissions', 'roles', 'role_permissions']
  loop
    execute format('create trigger z_set_updated_at before update on public.%I for each row execute function private.set_updated_at()', t);
    execute format('create trigger zz_audit after insert or update on public.%I for each row execute function private.audit_row()', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Grants. Nothing is open by default. Never DELETE.
-- ---------------------------------------------------------------------
revoke all on public.permissions, public.roles, public.role_permissions, public.profile_role_changes
  from public, anon, authenticated, service_role;
grant select on public.permissions, public.profile_role_changes to authenticated;
grant select, insert, update on public.roles, public.role_permissions to authenticated;
grant select, insert, update on public.permissions, public.roles, public.role_permissions to service_role;
grant select on public.profile_role_changes to service_role;
grant usage, select on sequence public.profile_role_changes_id_seq to service_role;

revoke all on function
  private.current_role_id(), private.role_has(uuid, text), private.has_permission(text),
  private.role_below(uuid, uuid), private.can_grant_role(uuid), private.can_manage_person(uuid),
  private.sync_role_columns(), private.log_role_change(), private.guard_role(), private.guard_role_permission()
  from public, anon, authenticated, service_role;
grant execute on function
  private.current_role_id(), private.role_has(uuid, text), private.has_permission(text),
  private.role_below(uuid, uuid), private.can_grant_role(uuid), private.can_manage_person(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Row level security
-- ---------------------------------------------------------------------
-- The permission list and the roles: every active person reads them (the
-- app shows role names and hides what a person may not do).
create policy permissions_select on public.permissions for select to authenticated
  using ((select private.is_active_user()));
create policy roles_select on public.roles for select to authenticated
  using ((select private.is_active_user()));
create policy roles_insert on public.roles for insert to authenticated
  with check ((select private.has_permission('team.roles')));
create policy roles_update on public.roles for update to authenticated
  using ((select private.has_permission('team.roles'))) with check ((select private.has_permission('team.roles')));
create policy role_permissions_select on public.role_permissions for select to authenticated
  using ((select private.is_active_user()));
create policy role_permissions_insert on public.role_permissions for insert to authenticated
  with check ((select private.has_permission('team.roles')));
create policy role_permissions_update on public.role_permissions for update to authenticated
  using ((select private.has_permission('team.roles'))) with check ((select private.has_permission('team.roles')));
create policy profile_role_changes_select on public.profile_role_changes for select to authenticated
  using ((select private.has_permission('team.manage')) or profile_id = (select auth.uid()));

-- Invites: with "Invite people and change their access", and only for a role
-- that does less than your own (the owner: any role).
drop policy invites_select on public.invites;
drop policy invites_insert on public.invites;
drop policy invites_update on public.invites;
create policy invites_select on public.invites for select to authenticated
  using ((select private.has_permission('team.manage')));
create policy invites_insert on public.invites for insert to authenticated
  with check ((select private.can_grant_role(role_id)));
create policy invites_update on public.invites for update to authenticated
  using ((select private.can_grant_role(role_id))) with check ((select private.can_grant_role(role_id)));

-- Spaces and channels per person: changed only for people below you, never your own.
drop policy person_spaces_insert on public.person_spaces;
drop policy person_spaces_update on public.person_spaces;
create policy person_spaces_insert on public.person_spaces for insert to authenticated
  with check ((select private.can_manage_person(profile_id)));
create policy person_spaces_update on public.person_spaces for update to authenticated
  using ((select private.can_manage_person(profile_id))) with check ((select private.can_manage_person(profile_id)));
drop policy person_posting_accounts_insert on public.person_posting_accounts;
drop policy person_posting_accounts_update on public.person_posting_accounts;
create policy person_posting_accounts_insert on public.person_posting_accounts for insert to authenticated
  with check ((select private.can_manage_person(profile_id)));
create policy person_posting_accounts_update on public.person_posting_accounts for update to authenticated
  using ((select private.can_manage_person(profile_id))) with check ((select private.can_manage_person(profile_id)));

-- The lists: every active person still reads them; who adds and changes is now a permission per list.
do $$
declare
  pair text[];
begin
  foreach pair slice 1 in array array[
    ['platforms', 'brand.manage'], ['content_types', 'brand.manage'], ['content_formats', 'brand.manage'],
    ['products', 'brand.manage'], ['series', 'brand.manage'], ['hook_styles', 'brand.manage'],
    ['note_tags', 'brand.manage'], ['direction_tags', 'brand.manage'], ['variant_kinds', 'brand.manage'],
    ['asset_kinds', 'brand.manage'], ['post_kinds', 'brand.manage'], ['sound_sources', 'brand.manage'],
    ['template_kinds', 'brand.manage'], ['brand_asset_kinds', 'brand.manage'], ['metric_checkpoints', 'brand.manage'],
    ['faces', 'brand.manage'], ['claims', 'brand.manage'], ['brand_assets', 'brand.manage'],
    ['brand_rules', 'brand.manage'], ['templates', 'brand.manage'], ['sounds', 'brand.manage'],
    ['sound_platforms', 'brand.manage'],
    ['card_statuses', 'calendar.setup'],
    ['ai_providers', 'ai.setup'], ['ai_models', 'ai.setup'], ['agents', 'ai.setup'],
    ['social_accounts', 'posting.accounts'], ['posting_slots', 'posting.accounts']
  ]
  loop
    execute format('drop policy %I on public.%I', pair[1] || '_insert', pair[1]);
    execute format('drop policy %I on public.%I', pair[1] || '_update', pair[1]);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select private.has_permission(%L)))',
                   pair[1] || '_insert', pair[1], pair[2]);
    execute format('create policy %I on public.%I for update to authenticated using ((select private.has_permission(%L))) with check ((select private.has_permission(%L)))',
                   pair[1] || '_update', pair[1], pair[2], pair[2]);
  end loop;
end;
$$;

-- Every other policy that named a role. Each is the policy of the first
-- migration with the role check swapped for a permission; nothing else changed.
-- Spaces: add and rename
drop policy spaces_insert on public.spaces;
create policy spaces_insert on public.spaces for insert to authenticated
  with check ((select private.has_permission('spaces.manage')));
drop policy spaces_update on public.spaces;
create policy spaces_update on public.spaces for update to authenticated
  using ((select private.has_permission('spaces.manage'))) with check ((select private.has_permission('spaces.manage')));

-- Settings an owner changes and others may read
drop policy agent_prompt_versions_select on public.agent_prompt_versions;
create policy agent_prompt_versions_select on public.agent_prompt_versions for select to authenticated
  using ((select private.has_permission('settings.view')));
drop policy budgets_select on public.budgets;
create policy budgets_select on public.budgets for select to authenticated using ((select private.has_permission('settings.view')));
drop policy app_settings_select on public.app_settings;
create policy app_settings_select on public.app_settings for select to authenticated using ((select private.has_permission('settings.view')));

-- Everyone's AI jobs, agent chats, notices and the audit trail
drop policy agent_threads_select on public.agent_threads;
create policy agent_threads_select on public.agent_threads for select to authenticated
  using ((select private.has_permission('team.activity')) or (owner_id = (select auth.uid()) and (select private.is_active_user())));
drop policy agent_threads_insert on public.agent_threads;
create policy agent_threads_insert on public.agent_threads for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select private.has_permission('studio.make')));
drop policy agent_threads_update on public.agent_threads;
create policy agent_threads_update on public.agent_threads for update to authenticated
  using (owner_id = (select auth.uid()) or (select private.has_permission('team.activity')))
  with check (owner_id = (select auth.uid()) or (select private.has_permission('team.activity')));
drop policy agent_messages_select on public.agent_messages;
create policy agent_messages_select on public.agent_messages for select to authenticated
  using (exists (select 1 from public.agent_threads t where t.id = thread_id
                 and ((select private.has_permission('team.activity')) or t.owner_id = (select auth.uid()))));
drop policy agent_runs_select on public.agent_runs;
create policy agent_runs_select on public.agent_runs for select to authenticated
  using ((select private.has_permission('team.activity')) or (started_by = (select auth.uid()) and (select private.is_active_user())));
drop policy ai_generations_select on public.ai_generations;
create policy ai_generations_select on public.ai_generations for select to authenticated
  using ((select private.has_permission('team.activity')) or (requested_by = (select auth.uid()) and (select private.is_active_user())));
drop policy ai_generations_insert on public.ai_generations;
create policy ai_generations_insert on public.ai_generations for insert to authenticated
  with check (requested_by = (select auth.uid()) and (select private.has_permission('studio.make')));
drop policy ai_generation_outputs_select on public.ai_generation_outputs;
create policy ai_generation_outputs_select on public.ai_generation_outputs for select to authenticated
  using (exists (select 1 from public.ai_generations g where g.id = generation_id
                 and ((select private.has_permission('team.activity')) or g.requested_by = (select auth.uid()))));
drop policy notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()) or (select private.has_permission('team.activity')));
drop policy audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using ((select private.has_permission('team.activity')));

-- Imports: undo one
drop policy import_batches_update on public.import_batches;
create policy import_batches_update on public.import_batches for update to authenticated
  using ((select private.has_permission('calendar.setup'))) with check ((select private.has_permission('calendar.setup')));

-- Uploading raw clips and versions
drop policy upload_batches_insert on public.upload_batches;
create policy upload_batches_insert on public.upload_batches for insert to authenticated
  with check ((select private.has_permission('footage.upload'))
              and uploaded_by = (select auth.uid()) and (select private.can_see_space(space_id)));
drop policy raw_clips_insert on public.raw_clips;
create policy raw_clips_insert on public.raw_clips for insert to authenticated
  with check ((select private.has_permission('footage.upload'))
              and uploaded_by = (select auth.uid()) and (select private.can_see_space(space_id)));
drop policy versions_insert on public.versions;
create policy versions_insert on public.versions for insert to authenticated
  with check ((select private.can_plan_card(card_id))
              or ((select private.has_permission('footage.upload')) and (select private.can_see_card(card_id))));

-- Directions on raw clips and their replies
drop policy clip_directions_insert on public.clip_directions;
create policy clip_directions_insert on public.clip_directions for insert to authenticated
  with check ((select private.has_permission('footage.direct')) and author_id = (select auth.uid())
              and (select private.can_see_space(space_id)));
drop policy clip_directions_update on public.clip_directions;
create policy clip_directions_update on public.clip_directions for update to authenticated
  using ((select private.can_see_space(space_id))
         and ((author_id = (select auth.uid()) and (select private.has_permission('footage.direct'))) or (select private.has_permission('team.manage'))))
  with check ((select private.can_see_space(space_id)));
drop policy clip_direction_replies_insert on public.clip_direction_replies;
create policy clip_direction_replies_insert on public.clip_direction_replies for insert to authenticated
  with check (author_id = (select auth.uid())
              and (select private.has_permission('footage.reply'))
              and (select private.can_see_direction(direction_id)));
drop policy clip_direction_replies_update on public.clip_direction_replies;
create policy clip_direction_replies_update on public.clip_direction_replies for update to authenticated
  using ((select private.can_see_direction(direction_id))
         and ((author_id = (select auth.uid()) and (select private.is_active_user())) or (select private.has_permission('team.manage'))))
  with check ((select private.can_see_direction(direction_id)));

-- Likeness on a variant
drop policy variant_faces_update on public.variant_faces;
create policy variant_faces_update on public.variant_faces for update to authenticated
  using ((select private.has_permission('brand.manage'))) with check ((select private.has_permission('brand.manage')));

-- Review notes, send to editor, approve
drop policy review_comments_select on public.review_comments;
create policy review_comments_select on public.review_comments for select to authenticated
  using ((select private.can_see_card(card_id))
         and (sent_at is not null or author_id = (select auth.uid()) or (select private.has_permission('review.notes'))));
drop policy review_comments_insert on public.review_comments;
create policy review_comments_insert on public.review_comments for insert to authenticated
  with check (author_id = (select auth.uid())
              and (select private.can_see_card(card_id))
              and ((select private.has_permission('review.notes')) or ((select private.has_permission('footage.reply')) and parent_comment_id is not null)));
drop policy review_comments_update on public.review_comments;
create policy review_comments_update on public.review_comments for update to authenticated
  using ((select private.can_see_card(card_id))
         and (author_id = (select auth.uid()) or (select private.has_permission('review.notes'))
              or ((select private.has_permission('footage.reply')) and sent_at is not null)))
  with check ((select private.can_see_card(card_id)));
drop policy edit_requests_insert on public.edit_requests;
create policy edit_requests_insert on public.edit_requests for insert to authenticated
  with check ((select private.has_permission('review.notes')) and (select private.can_see_card(card_id)) and sent_by = (select auth.uid()));
drop policy approvals_insert on public.approvals;
create policy approvals_insert on public.approvals for insert to authenticated
  with check ((select private.has_permission('review.approve')) and decided_by = (select auth.uid()));

-- Checker rules
drop policy checker_rules_insert on public.checker_rules;
create policy checker_rules_insert on public.checker_rules for insert to authenticated
  with check ((select private.has_permission('rules.propose')));
drop policy checker_rules_update on public.checker_rules;
create policy checker_rules_update on public.checker_rules for update to authenticated
  using ((select private.has_permission('rules.propose'))) with check ((select private.has_permission('rules.propose')));
drop policy checker_references_insert on public.checker_references;
create policy checker_references_insert on public.checker_references for insert to authenticated
  with check ((select private.has_permission('rules.approve')));
drop policy checker_references_update on public.checker_references;
create policy checker_references_update on public.checker_references for update to authenticated
  using ((select private.has_permission('rules.approve'))) with check ((select private.has_permission('rules.approve')));

-- The bank
drop policy bank_items_insert on public.bank_items;
create policy bank_items_insert on public.bank_items for insert to authenticated
  with check ((select private.has_permission('posting.bank')));
drop policy bank_items_update on public.bank_items;
create policy bank_items_update on public.bank_items for update to authenticated
  using ((select private.has_permission('posting.bank'))) with check ((select private.has_permission('posting.bank')));

-- Post numbers
drop policy post_attempts_select on public.post_attempts;
create policy post_attempts_select on public.post_attempts for select to authenticated
  using ((select private.has_permission('posting.numbers'))
         and exists (select 1 from public.posts p where p.id = post_id and (select private.can_see_card(p.card_id))));
drop policy post_metrics_select on public.post_metrics;
create policy post_metrics_select on public.post_metrics for select to authenticated
  using ((select private.has_permission('posting.numbers'))
         and exists (select 1 from public.posts p where p.id = post_id and (select private.can_see_card(p.card_id))));

-- ---------------------------------------------------------------------
-- 9. Realtime: a role or a tick changed by the owner reaches open screens.
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.roles;
    alter publication supabase_realtime add table public.role_permissions;
  end if;
end;
$$;
