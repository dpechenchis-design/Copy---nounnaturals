-- Frame.io links added in Notion after the import (owner, Nov 16 2026: "there are no edited Frame.io links in the
-- Founder content week 1. You are supposed to upload it there too").
--
-- Read from every row page of the content team's Notion on Nov 16: Founder Week 1 now has 7 edited video links the
-- import never saw, and one Noun Naturals row got a newer link ("Freestyle sea salt spray delivery pt1" in Week 2;
-- checked row by row, every other Noun Naturals link is unchanged). Matched by space, week number and title, like
-- 20261120000000_notion_scripts.sql; a title that two cards of one week share is skipped, so a link never lands on
-- the wrong card. A new link fills an empty Edited video; a newer link replaces only the exact old link, so nothing
-- anyone set by hand is overwritten. Then, as 20261120100000_frameio_shot.sql did for the other Frame.io cards, an
-- unticked card with an edited video link is marked Shot before Noun ART (only cards the card rules accept, so the
-- file never stops).
--
-- Only data, no schema change. Running it again changes nothing. A database without these weeks is left as it is.

create temporary table frameio_links_src (space_slug text, week_no int, title text, url text, old_url text);
insert into frameio_links_src values
  ('noun', 2, 'freestyle sea salt spray delivery pt1', 'https://f.io/2sg8rXYD', 'https://f.io/kIZRsxPV'),
  ('founder', 1, 'why i started noun', 'https://f.io/iLw0Wsiv', null),
  ('founder', 1, 'the 0.5% label trick', 'https://f.io/-xRjuvTd', null),
  ('founder', 1, 'why we went quiet for a year', 'https://f.io/FrynjNkf', null),
  ('founder', 1, 'my first order came from a stranger in maryland', 'https://f.io/jisZw7Ar', null),
  ('founder', 1, 'value your product and customers', 'https://f.io/_ui9z_aq', null),
  ('founder', 1, 'i hate our industry', 'https://f.io/nqZzBPuZ', null),
  ('founder', 1, 'sea salt', 'https://f.io/uXY8xFul', null);

with weeks_in as (
  select w.id, s.slug as space_slug, n.week_no, count(*) over (partition by s.id, n.week_no) as same_no
    from public.weeks w
    join public.spaces s on s.id = w.space_id and s.deleted_at is null
    cross join lateral (
      select coalesce(w.number, nullif(substring(w.name from '(?i)^\s*week\s*(\d{1,6})'), '')::int) as week_no
    ) n
   where w.deleted_at is null
),
cards_in as (
  select c.id, wi.space_slug, wi.week_no, lower(regexp_replace(btrim(c.title), '\s+', ' ', 'g')) as title,
         btrim(coalesce(c.extra ->> 'Edited video', '')) as current_url,
         count(*) over (partition by c.week_id, lower(regexp_replace(btrim(c.title), '\s+', ' ', 'g'))) as same_title
    from public.cards c
    join weeks_in wi on wi.id = c.week_id and wi.same_no = 1
    join public.weeks w on w.id = c.week_id
   where c.deleted_at is null
     and c.space_id = w.space_id
     and (c.planned_on is null or c.planned_on between w.starts_on and w.starts_on + 6)
)
update public.cards c
   set extra = coalesce(c.extra, '{}'::jsonb) || jsonb_build_object('Edited video', src.url)
  from frameio_links_src src
  join cards_in ci on ci.space_slug = src.space_slug and ci.week_no = src.week_no and ci.title = src.title and ci.same_title = 1
 where c.id = ci.id
   and ((src.old_url is null and ci.current_url = '') or (src.old_url is not null and ci.current_url = src.old_url));

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
   and coalesce(c.created_by, (select id from owner_profile)) is not null
   and exists (
     select 1 from public.weeks w
      where w.id = c.week_id
        and w.deleted_at is null
        and w.space_id = c.space_id
        and (c.planned_on is null or c.planned_on between w.starts_on and w.starts_on + 6)
   );

drop table frameio_links_src;
