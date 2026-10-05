-- Ellianna's Donut Shop — claim-day seed.
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr) AFTER the owner
-- creates their DayMarket account. Replace <OWNER_UUID> with their auth.users id
-- (Supabase dashboard > Authentication > Users).
-- This migrates the furnished static profile into live, claimable holidays.

-- 1. Business row
insert into public.dm_businesses (owner_id, name, slug, tagline, description, logo_url, website, status, profile_tier)
values (
  '<OWNER_UUID>',
  'Ellianna''s Donut Shop',
  'elliannas-donut-shop',
  'Fresh donuts made daily on Grindstone Parkway.',
  'Columbia''s morning ritual: fresh donuts made daily — glazed rings, apple fritters, maple bacon bars, bismarks — plus cappuccino and iced coffee, with a drive-thru on Grindstone Parkway. 4.9 stars from 400+ reviews. DayMarket launch partner — the first business with a holiday calendar.',
  'https://daymarket.tabronmerryhill.com/assets/img/elliannas-logo.jpg',
  null,
  'active',
  'paid'
)
on conflict (slug) do update set
  status = 'active',
  tagline = excluded.tagline,
  description = excluded.description,
  logo_url = excluded.logo_url;

-- 2. Holidays + offers (dates: launch week of Oct 5, 2026; America/Chicago)
-- Holiday 1: The Daybreak Drop — Tue Oct 6, 5:00–9:00 AM CT
with h as (
  insert into public.dm_holidays (business_id, title, description, starts_at, ends_at, status)
  select id, 'The Daybreak Drop',
    'The first holiday ever on DayMarket. A dozen glazed at member pricing, Tuesday morning only.',
    '2026-10-06T10:00:00Z', '2026-10-06T14:00:00Z', 'published'
  from public.dm_businesses where slug = 'elliannas-donut-shop'
  returning id
)
insert into public.dm_offers (holiday_id, title, details, regular_price_cents, member_price_cents, quantity_total, status)
select id, 'Dozen glazed — member price', 'One dozen glazed donuts at the counter. Show your claim code.',
  1499, 1099, 25, 'active' from h;

-- Holiday 2: Fritter Friday — Fri Oct 9, all day CT
with h as (
  insert into public.dm_holidays (business_id, title, description, starts_at, ends_at, status)
  select id, 'Fritter Friday',
    'Free apple fritter with any dozen, all day Friday. Members only.',
    '2026-10-09T10:00:00Z', '2026-10-09T19:00:00Z', 'published'
  from public.dm_businesses where slug = 'elliannas-donut-shop'
  returning id
)
insert into public.dm_offers (holiday_id, title, details, quantity_total, status)
select id, 'Free apple fritter with any dozen', 'Buy any dozen at the counter, get a free apple fritter. Show your claim code.',
  30, 'active' from h;

-- Holiday 3: The First Hunt — Sat Oct 10, 10:00 AM CT (played in WhatsApp; claim = entry)
with h as (
  insert into public.dm_holidays (business_id, title, description, starts_at, ends_at, status)
  select id, 'The First Hunt',
    'A scavenger hunt in the Columbia Crew WhatsApp group. Clues drop in the thread — first to crack them wins a 1 Dozen Large box ($22.99 value) plus coffee at the counter.',
    '2026-10-10T15:00:00Z', '2026-10-10T18:00:00Z', 'published'
  from public.dm_businesses where slug = 'elliannas-donut-shop'
  returning id
)
insert into public.dm_offers (holiday_id, title, details, quantity_total, status)
select id, 'Hunt entry', 'Claim to enter the hunt. Winner is decided in the WhatsApp group.',
  50, 'active' from h;

-- 3. Verify
select b.name, b.slug, b.status, count(h.id) as holidays
from public.dm_businesses b left join public.dm_holidays h on h.business_id = b.id
where b.slug = 'elliannas-donut-shop' group by b.name, b.slug, b.status;
