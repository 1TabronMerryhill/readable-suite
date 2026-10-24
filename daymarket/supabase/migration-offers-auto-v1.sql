-- DayMarket auto draft offers: mark offers generated from the menu so the
-- business view shows the right net. Auto offers price by the package
-- engine (menu + 10% premium = member/shop price; + 15% markup = regular
-- price) and members skip the markup, so the shop nets the full member
-- price. Manual offers keep the existing fee display. Existing rows
-- default to 'manual'. Apply via the Supabase dashboard SQL editor
-- (project: readable) BEFORE the code that writes pricing_source goes live.

alter table public.dm_offers
  add column if not exists pricing_source text not null default 'manual'
    check (pricing_source in ('manual', 'auto'));
