-- Seven Noun Naturals Week 2 rows the content team added in Notion after the import (owner, Nov 16 2026: "In week
-- 2, there are still some Frame.io videos you didn't upload yet. Make sure all the Frame.io videos from the Notion
-- are uploaded into the app").
--
-- Read from the Notion Week 2 table on Nov 16 2026: 99 rows now, 7 of them new since the import (created Nov 15), all
-- Freestyle talking heads with an edited video on Frame.io, status "Sent to QA for review" (our Script in QA), TikTok
-- only, no page text. Every other Frame.io link in the content team's Notion is already in the app (Week 1 70, Week 2
-- 14, Founder Week 1 7).
--
-- Each row becomes a card in the Noun Naturals week numbered 2 (or named "Week 2"), on its weekday, after the week's
-- other cards, with its type, formats, TikTok, the Notion page id and the Frame.io link in Edited video, and marked
-- Shot before Noun ART like 20261120100000_frameio_shot.sql. A row whose title a card of that week already has, or
-- whose Notion page is already a card, is skipped, so running it again adds nothing and nothing set by hand changes.
-- A database without that week (or with two weeks numbered 2) is left as it is.
--
-- Only data, no schema change.

create temporary table notion_week2_src (ord int, notion_id text, title text, day_offset int, formats text[], url text);
insert into notion_week2_src values
  (1, '41909f44-7f80-8002-8a38-ebd884e44031', 'Freestyle Showing off Sea salt spray bottle in warehouse V2', 5, array['connection'], 'https://f.io/J-8o0yyH'),
  (2, '41909f44-7f80-809e-b284-df6f63060cfe', 'Freestyle Damp vs Dry SSS', 6, array['education', 'connection'], 'https://f.io/j3iwYjDm'),
  (3, '41909f44-7f80-8073-a4c7-d0e8cc140881', 'Freestyle Why People with Straight Hair Should use SSS', 0, array['education', 'connection'], 'https://f.io/60ajyVlA'),
  (4, '41909f44-7f80-80cd-9bf1-cdd37b417c2c', 'Freestyle 3 Ways to Use Sea Salt Spray', 1, array['education'], 'https://f.io/CBOjIsvK'),
  (5, '41909f44-7f80-80fc-949b-d3bb78cda14d', 'Freestyle Tag SSS Promo', 2, array['connection'], 'https://f.io/HD5kog7k'),
  (6, '41909f44-7f80-8038-acf9-cec354be643b', 'Freestyle TP vs SSS', 3, array['education', 'connection'], 'https://f.io/vUcjltWC'),
  (7, '41909f44-7f80-8091-97e5-e231fa307f5b', 'Freestyle Why our Sea Salt Spray', 4, array['connection'], 'https://f.io/0TPCgDzJ');

create temporary table notion_week2_new (card_id uuid, ord int, formats text[]);

with week2 as (
  select w.id, w.space_id, w.starts_on
    from public.weeks w
    join public.spaces s on s.id = w.space_id and s.slug = 'noun' and s.deleted_at is null
   where w.deleted_at is null
     and coalesce(w.number, nullif(substring(w.name from '(?i)^\s*week\s*(\d{1,6})'), '')::int) = 2
),
the_week as (
  select * from week2 where (select count(*) from week2) = 1
),
owner_profile as (
  select p.id
    from public.profiles p
    join public.roles r on r.id = p.role_id
   where r.key = 'owner'
   order by p.created_at, p.id
   limit 1
),
todo as (
  select src.*
    from notion_week2_src src
   cross join the_week tw
   where not exists (
           select 1 from public.cards c
            where c.deleted_at is null
              and c.week_id = tw.id
              and lower(regexp_replace(btrim(c.title), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(src.title), '\s+', ' ', 'g'))
         )
     and not exists (select 1 from public.cards c where c.notion_page_id = src.notion_id)
),
added as (
  insert into public.cards (space_id, week_id, title, status_id, planned_on, type_key, extra, sort_order, source,
                            notion_page_id, shot_at, shot_by)
  select tw.space_id, tw.id, t.title,
         (select s.id from public.card_statuses s where s.key = 'qa'),
         tw.starts_on + t.day_offset,
         'talking_head',
         jsonb_build_object('Edited video', t.url)
           || case when (select id from owner_profile) is not null
                   then jsonb_build_object('Shot before Noun ART', ((tw.starts_on + t.day_offset) + time '12:00') at time zone 'America/New_York')
                   else '{}'::jsonb end,
         coalesce((select max(c.sort_order) from public.cards c where c.week_id = tw.id), 0) + t.ord,
         'notion_import',
         t.notion_id,
         case when (select id from owner_profile) is not null
              then ((tw.starts_on + t.day_offset) + time '12:00') at time zone 'America/New_York' end,
         (select id from owner_profile)
    from todo t
   cross join the_week tw
  returning id, notion_page_id
)
insert into notion_week2_new (card_id, ord, formats)
select a.id, src.ord, src.formats
  from added a
  join notion_week2_src src on src.notion_id = a.notion_page_id;

insert into public.card_formats (card_id, format_key, sort_order)
select n.card_id, f.key, f.pos - 1
  from notion_week2_new n
 cross join lateral unnest(n.formats) with ordinality as f(key, pos);

insert into public.card_platforms (card_id, platform_key)
select n.card_id, 'tiktok' from notion_week2_new n;

drop table notion_week2_new;
drop table notion_week2_src;
