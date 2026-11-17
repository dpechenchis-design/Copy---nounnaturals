-- =====================================================================
-- Noun ART: Strategist/Editor gets its wider list (approved by the owner, Nov 16 2026).
-- Written Nov 16 2026 after the owner's yes: Strategist/Editor is "almost
-- admin", because "they have to add the spaces and rows... this system
-- was built mainly for them". Behavior tests:
-- supabase/tests/strategist-editor-access.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
--
-- It runs after three other drafts and needs them: the UGC draft
-- (20261118200000_ugc.sql, ugc.manage), the review undo draft
-- (20261119000000_review_undo.sql, review.undo) and the space draft
-- (20261119100000_space_create.sql, spaces.create). Those files add the
-- new permissions; this one adds none. A key that is not in the list yet
-- is skipped, never an error, so the file is safe in any order.
--
-- What it does, in plain words:
--   * The prebuilt role Strategist/Editor (key `strategist`) holds exactly
--     these 30 permissions on a fresh database, the same list as
--     src/lib/access/permissions.ts (tested in src/lib/access/access.test.mjs):
--     14 actions: plan weeks and cards, see every card, set up statuses
--       and undo imports, upload raw clips and versions, write directions,
--       reply to directions and notes, write review notes, see post
--       numbers, make with AI, propose checker rules, change the brand kit,
--       save UGC, add spaces, open every space;
--     16 pages: Analytics, Calendar, Upload, Review, Studio, Carousels and
--       photos, UGC, Brand kit, Templates, Library, Sounds, Discovery,
--       Community, Competitors, Ads, Checker rules.
--   * Only ticks are added, each with `not exists`, so a tick the role
--     already has is never doubled. Nothing is unticked: if the owner or
--     an admin gave the role more by hand, it keeps it.
--   * Still not for Strategist/Editor: delete weeks, approve or reject,
--     undo a decision, post, the bank, accounts, checker rule approval,
--     AI setup, inviting people, building roles, renaming and archiving
--     spaces, the activity and audit trail, settings, integrations, and
--     the pages Bank and schedule, Posting, Accounts, Activity, Audit trail
--     and Settings. So it stays below Admin: an admin may still give it.
--   * The role's description says what it does now.
--   * No other role changes, and no custom role.
--
-- It runs with nobody signed in, so the role and tick guards
-- (private.guard_role, private.guard_role_permission) step aside, as in
-- the earlier seed files; granted_by stays empty (the database did it).
-- No new table and no new function, so no new grants. Never DELETE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The ticks: every key of the list the role does not hold yet.
-- ---------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, p.key, null
from public.roles r
join public.permissions p on p.deleted_at is null and p.key in (
  'calendar.plan', 'calendar.all_cards', 'calendar.setup',
  'footage.upload', 'footage.direct', 'footage.reply',
  'review.notes',
  'posting.numbers',
  'studio.make', 'rules.propose',
  'brand.manage',
  'ugc.manage',
  'spaces.create', 'spaces.all',
  'page.analytics', 'page.calendar', 'page.upload', 'page.review', 'page.studio', 'page.carousels', 'page.ugc',
  'page.brand', 'page.templates', 'page.library', 'page.sounds',
  'page.discovery', 'page.community', 'page.competitors', 'page.ads',
  'page.rules')
where r.key = 'strategist'
  and r.deleted_at is null
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = p.key and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 2. The description (name, key, color and flags stay).
-- ---------------------------------------------------------------------
update public.roles
   set description = 'Adds spaces, plans the weeks and cards, uploads raw clips and versions, writes directions and review notes, and makes with AI. Approving, posting and the team stay with the owner and admins.'
 where key = 'strategist';
