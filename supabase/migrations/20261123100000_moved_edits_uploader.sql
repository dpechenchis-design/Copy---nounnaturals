-- The Frame.io edits moved into Noun Naturals Weeks 1 and 2 on Nov 17 2026 are Daryna's, not the owner's (owner, Nov 17
-- 2026: "It can't be me. ... You have to change all the uploaders to Darnya ... Then she gets the warnings and the
-- messages along with the editors").
--
-- The move was done by an agent signed in as the owner, so each moved v1 was saved with the owner as its uploader, and
-- Review read "Edited by Khaled Atallah" and Send to editor sent the notes back to him. This sets the uploader of those
-- versions to Daryna Pechenchis (Strategist/Editor), and any notes already sent on them to the owner now go to her.
--
-- Which versions: uploaded by the owner from a row (intake_via 'row', or none on an older save) on a card in the Noun Naturals content space,
-- saved on Nov 17 2026 (New York time, with a margin). Nothing else changes; running it again changes nothing.
-- A database without both people is left as it is.
--
-- Only data, no schema change.

do $$
declare
  v_owner uuid;
  v_daryna uuid;
  v_versions int;
  v_requests int;
  v_ids uuid[];
begin
  select p.id into v_owner from public.profiles p where lower(p.email) = 'khaled@nounnaturals.com';
  select p.id into v_daryna from public.profiles p where lower(p.email) = 'pechenchis.daryna@gmail.com';
  if v_owner is null or v_daryna is null then
    raise notice 'moved_edits_uploader: owner or Daryna not found, nothing changed';
    return;
  end if;

  select coalesce(array_agg(v.id), '{}') into v_ids
      from public.versions v
      join public.cards c on c.id = v.card_id
      join public.weeks w on w.id = c.week_id
      join public.spaces s on s.id = w.space_id and s.slug = 'noun'
     where v.uploaded_by = v_owner
       and coalesce(v.intake_via, 'row') = 'row'
       and v.deleted_at is null
       and v.created_at >= timestamptz '2026-11-16 18:00:00+00'
       and v.created_at <  timestamptz '2026-11-18 12:00:00+00';

  update public.versions v set uploaded_by = v_daryna
   where v.id = any (v_ids);
  get diagnostics v_versions = row_count;

  update public.edit_requests r set sent_to = v_daryna
   where r.sent_to = v_owner
     and r.version_id = any (v_ids);
  get diagnostics v_requests = row_count;

  raise notice 'moved_edits_uploader: % versions and % sent notes now Daryna''s', v_versions, v_requests;
end;
$$;
