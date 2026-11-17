-- DRAFT. NOT LIVE. Do not move into supabase/migrations until the owner approves it.
-- When approved it becomes supabase/migrations/20261115010000_pill_paint.sql (or a later
-- timestamp, after any migration pushed before it, for example the team and access one).
--
-- Pill colors for the whole team (owner, Nov 15 2026: "you have to save for the whole team").
-- Every status, content type and content format can carry one paint choice from the Noun ERP's
-- picker. One choice per status, type or format: every pill with it changes for everyone.
--
-- What this file changes:
--   1. A new value type, public.pill_paint: the ERP's shape, one of
--        {"hex": "#2F7FD8"}
--        {"gradient": "<preset id from src/components/paint/gradient-presets.ts>"}
--        {"stops": ["#AAAAAA", "#BBBBBB"], "angle": 135, "type": "linear"}
--   2. A new nullable column `paint` on card_statuses, content_types and content_formats.
--      Empty means "the default": for a status the design token in its `color` column, for a
--      type or format the app's preset (src/components/paint/presets.ts).
--   3. The preset colors for the 8 content types and 4 formats, so they are told apart from day one.
--   4. Live updates for content_types and content_formats (card_statuses already has them).
--
-- What it does not need to change, because the first migration already does it:
--   - Who may change a color: owner and admins. The existing policies card_statuses_update,
--     content_types_update and content_formats_update use private.is_manager(). Every active
--     person reads (the *_select policies). Custom statuses are rows of card_statuses, same rule.
--     If the team and access migration adds a "manage statuses" permission, it swaps
--     private.is_manager() in those three update policies; nothing here has to change.
--   - The history of every color change (who, when, old, new): the zz_audit trigger is already on
--     all three tables and writes one audit_log row per change, with before_data and after_data
--     holding the old and the new paint. No second history table.
--   - Grants: a new column takes the table's grants. No delete, as always.
--   - A system status still cannot be removed or change its key or stage (private.guard_card_status).

-- 1. The value type. A domain, so the rule is written once and holds for all three tables.
create domain public.pill_paint as jsonb
  check (
    value is null
    or (
      jsonb_typeof(value) = 'object'
      and (
        -- a solid color
        (value ? 'hex' and not value ? 'gradient' and not value ? 'stops'
          and jsonb_typeof(value -> 'hex') = 'string'
          and value ->> 'hex' ~ '^#[0-9A-Fa-f]{6}$')
        -- a gradient preset, by its id
        or (value ? 'gradient' and not value ? 'hex' and not value ? 'stops'
          and jsonb_typeof(value -> 'gradient') = 'string'
          and char_length(value ->> 'gradient') between 1 and 80)
        -- custom gradient stops: 2 to 8 hex colors, an optional angle and type
        or (value ? 'stops' and not value ? 'hex' and not value ? 'gradient'
          and jsonb_typeof(value -> 'stops') = 'array'
          and jsonb_array_length(value -> 'stops') between 2 and 8
          and (value -> 'stops')::text ~ '^\[("#[0-9A-Fa-f]{6}"(, )?)+\]$'
          and (not value ? 'angle' or jsonb_typeof(value -> 'angle') = 'number')
          and (not value ? 'type' or value ->> 'type' in ('linear', 'radial')))
      )
    )
  );
comment on domain public.pill_paint is 'A pill color from the picker: {hex}, {gradient: preset id} or {stops, angle, type}. Same shape as the Noun ERP.';

-- 2. The column, on the three lists.
alter table public.card_statuses add column paint public.pill_paint;
alter table public.content_types add column paint public.pill_paint;
alter table public.content_formats add column paint public.pill_paint;
comment on column public.card_statuses.paint is 'The team''s color for this status from the picker. Empty: the design token in color.';
comment on column public.content_types.paint is 'The team''s color for this type from the picker. Empty: the app''s preset.';
comment on column public.content_formats.paint is 'The team''s color for this format from the picker. Empty: the app''s preset.';

-- 3. Preset colors (the same values as src/components/paint/presets.ts; a test keeps them equal).
--    Reference data, not demo data. Statuses keep their design tokens (paint stays empty).
update public.content_types t set paint = jsonb_build_object('hex', v.hex)
  from (values
    ('talking_head', '#5A4FD8'),
    ('tiktok_comment', '#2BA3B8'),
    ('expert_video', '#1F3F66'),
    ('bts', '#8A5A3C'),
    ('drop', '#E8603C'),
    ('founder_story', '#A33B63'),
    ('industry_callout', '#C9B23A'),
    ('product_breakdown', '#8DB83A')
  ) as v (key, hex)
  where t.key = v.key and t.paint is null;

update public.content_formats f set paint = jsonb_build_object('hex', v.hex)
  from (values
    ('education', '#2F7FD8'),
    ('connection', '#E0568C'),
    ('objection_handling', '#E8833A'),
    ('proof', '#1FA38A')
  ) as v (key, hex)
  where f.key = v.key and f.paint is null;

-- 4. Live updates, so an open screen can pick up a new color (card_statuses is already published).
do $$
declare
  t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['content_types', 'content_formats']
    loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end;
$$;
