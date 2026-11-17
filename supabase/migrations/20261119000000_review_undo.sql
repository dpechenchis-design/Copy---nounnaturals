-- =====================================================================
-- Noun ART: Undo on Review for owners and admins (approved by the owner, Nov 16 2026).
-- Written Nov 16 2026 after the owner's decision: Undo on Review is for
-- owners AND admins, as a permission key, never a role name. Behavior
-- tests: supabase/tests/review-actions.test.mjs.
--
-- Approved by the owner on Nov 16 2026 and moved here from supabase/drafts.
--
-- What it does, in plain words:
--   * A new permission, "Undo an approval or a rejection" (review.undo,
--     Review group), ticked for Owner and Admin. Any custom role can be
--     given it like every other permission.
--   * Who may take a decision back: before this, only the Owner role could
--     change an approval (approvals_update asked private.is_owner()). Now
--     anyone holding review.undo who can see the decision's card.
--   * What a change may be: still the revoke alone. Nothing else on an
--     approval ever changes, and once revoked it stays revoked: nobody
--     clears revoked_at or rewrites who revoked it (revoked_by is the
--     database's, from the signed in person). Before this, the Owner could
--     clear a revoke; now that more people may revoke, that door closes.
--
-- The app's code works on the old database too: until this is live the
-- database has no review.undo key, so only the Owner (who has every key)
-- passes the app's check, and the old policy still lets the Owner revoke.
--
-- No new table and no new public function, so no new grants. The
-- trigger function stays in private, closed to everyone like the others.
-- Never DELETE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The permission, after "Approve or reject videos" (80) and before the
--    Posting group. Owner and Admin get it.
-- ---------------------------------------------------------------------
insert into public.permissions (key, group_key, group_label, label, hint, sort_order) values
  ('review.undo', 'review', 'Review', 'Undo an approval or a rejection', 'Take a decision back so the video waits for review again.', 85);

insert into public.role_permissions (role_id, permission_key, granted_by)
select r.id, 'review.undo', null
from public.roles r
where r.key in ('owner', 'admin')
  and not exists (select 1 from public.role_permissions x
                  where x.role_id = r.id and x.permission_key = 'review.undo' and x.deleted_at is null);

-- ---------------------------------------------------------------------
-- 2. Who may change an approval: someone holding review.undo who can see
--    its card. The trigger below keeps that change to the revoke alone.
-- ---------------------------------------------------------------------
drop policy approvals_update on public.approvals;
create policy approvals_update on public.approvals for update to authenticated
  using ((select private.has_permission('review.undo')) and (select private.can_see_card(card_id)))
  with check ((select private.has_permission('review.undo')) and (select private.can_see_card(card_id)));

-- ---------------------------------------------------------------------
-- 3. Approvals never change, except that one may be revoked, once.
--    Before update on approvals (the trigger c_guard_approval of the first
--    migration calls this function, so it needs no new trigger).
-- ---------------------------------------------------------------------
create or replace function private.guard_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (to_jsonb(new) - array['revoked_at', 'revoked_by', 'updated_at'])
     is distinct from (to_jsonb(old) - array['revoked_at', 'revoked_by', 'updated_at']) then
    raise exception 'An approval cannot be changed; it may only be revoked';
  end if;
  if old.revoked_at is not null then
    -- revoked already: it stays revoked, by the same person
    if new.revoked_at is distinct from old.revoked_at or new.revoked_by is distinct from old.revoked_by then
      raise exception 'An approval cannot be changed; it may only be revoked, once';
    end if;
  elsif new.revoked_at is null then
    -- not a revoke: who revoked it cannot be written on its own
    if new.revoked_by is distinct from old.revoked_by then
      raise exception 'An approval cannot be changed; it may only be revoked';
    end if;
  else
    new.revoked_by := coalesce(auth.uid(), new.revoked_by);
  end if;
  return new;
end;
$$;
