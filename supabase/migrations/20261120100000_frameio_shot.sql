-- Shot for the agency's edited weeks (owner, Nov 16 2026: "check box all the ones that have a Frame.io link as
-- already shot"; pushed on his yes, Nov 16 2026). Its own push, after the code
-- that reads the "Shot before Noun ART" mark went live.
--
-- Every live card that has an edited video link (cards.extra "Edited video", the agency's Frame.io links on the
-- imported weeks) and is not ticked yet becomes Shot. Shot always names a person (cards check: shot_at and shot_by
-- together), so it names whoever imported the card, or the owner; the mark extra "Shot before Noun ART" tells
-- the app nobody ticked it here, and the table reads "Shot before Noun ART". shot_at is the card's planned day at noon
-- New York time (it was filmed before that), or now when the card has no day. The mark holds that same time, so a
-- later hand tick (a new time) reads as that person's tick.
--
-- Only data, no schema change. A card ticked by hand is left as it is, and running it again changes nothing. A
-- database without such cards (a fresh test database) is left as it is.

with owner_profile as (
  select p.id
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where r.key = 'owner'
   order by p.created_at, p.id
   limit 1
)
update public.cards c
   set shot_at = coalesce((c.planned_on + time '12:00') at time zone 'America/New_York', now()),
       shot_by = coalesce(c.created_by, (select id from owner_profile)),
       extra = coalesce(c.extra, '{}'::jsonb)
               || jsonb_build_object('Shot before Noun ART', coalesce((c.planned_on + time '12:00') at time zone 'America/New_York', now()))
 where c.deleted_at is null
   and c.shot_at is null
   and btrim(coalesce(c.extra ->> 'Edited video', '')) <> ''
   and coalesce(c.created_by, (select id from owner_profile)) is not null;
