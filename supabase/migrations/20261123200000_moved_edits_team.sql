-- Notes on the edits moved into Noun Naturals on Nov 17 2026 go to the whole editing team, not to Daryna alone (owner,
-- Nov 17 2026: "It should go to all of them ... Once we start uploading in the app, the updates will only go to the
-- person who edited it").
--
-- 20261123100000_moved_edits_uploader made Daryna Pechenchis the uploader of those versions, so Send to editor sent
-- their notes to her only. Nobody uploaded them in Noun ART, so this takes the uploader off (null) and every note
-- already sent on them to her goes to the team instead. "The team" is a Send to editor with nobody in sent_to: every
-- person with the editor Home reads it (src/lib/content/review-db.ts readSentRequests).
--
-- Which versions: uploaded by Daryna from a row (intake_via 'row', or none on an older save) on a card in a week of
-- the Noun Naturals content space, saved from Nov 16 2026 18:00 UTC until 09:38 UTC on Nov 17 2026 (when the uploader
-- migration was pushed), not removed, and handed to her by that migration (its audit_log row). A version she uploads
-- herself stays hers.
--
-- A card that has an editor set still sends to that editor: Send to editor falls back to the card's editor when a
-- version has no uploader (private.edit_requests_before_insert), and that stays as it is. Notes already sent to Daryna
-- on these videos go where a new Send would: the card's editor when one is set, else the team.
--
-- Nothing else changes; running it again changes nothing. A database without Daryna is left as it is.
-- Only data, no schema change.

do $$
declare
  v_daryna uuid;
  v_ids uuid[];
  v_versions int;
  v_requests int;
  v_with_editor int;
begin
  select p.id into v_daryna from public.profiles p where lower(p.email) = 'pechenchis.daryna@gmail.com';
  if v_daryna is null then
    raise notice 'moved_edits_team: Daryna not found, nothing changed';
    return;
  end if;

  select coalesce(array_agg(v.id), '{}') into v_ids
      from public.versions v
      join public.cards c on c.id = v.card_id
      join public.weeks w on w.id = c.week_id
      join public.spaces s on s.id = w.space_id and s.slug = 'noun'
     where v.uploaded_by = v_daryna
       and coalesce(v.intake_via, 'row') = 'row'
       and v.deleted_at is null
       and v.created_at >= timestamptz '2026-11-16 18:00:00+00'
       and v.created_at <  timestamptz '2026-11-17 09:38:00+00'
       /* only the ones the uploader migration handed to her (its audit row: the system set uploaded_by to Daryna),
          never a video she uploaded herself in that window */
       and exists (
         select 1 from public.audit_log a
          where a.entity_table = 'versions'
            and a.entity_id = v.id::text
            and a.actor_type = 'system'
            and 'uploaded_by' = any (a.changed_fields)
            and a.after_data ->> 'uploaded_by' = v_daryna::text
       );

  select count(distinct c.id) into v_with_editor
      from public.versions v
      join public.cards c on c.id = v.card_id
     where v.id = any (v_ids)
       and c.assigned_editor_id is not null;

  update public.versions v set uploaded_by = null
   where v.id = any (v_ids);
  get diagnostics v_versions = row_count;

  /* notes already sent to her go where a new Send would: the title's editor when one is set, else the team (null) */
  update public.edit_requests r set sent_to = c.assigned_editor_id
    from public.cards c
   where c.id = r.card_id
     and r.sent_to = v_daryna
     and r.version_id = any (v_ids);
  get diagnostics v_requests = row_count;

  raise notice 'moved_edits_team: % versions and % sent notes now go to the editing team; % of their titles have an editor set, who still gets their notes',
    v_versions, v_requests, v_with_editor;
end;
$$;
