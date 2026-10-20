-- Migration: Station directory registry for the DayMarket concierge
-- Run in Supabase dashboard SQL editor (project: readable)
--
-- One registry of everything the concierge can route to: businesses
-- (orderable shops) and systems (VictoryLap, OpenLine, ...). The concierge
-- reads this directory and offers ONLY listings whose intents match the
-- caller's intent. Menus and prices are never copied here: a business
-- listing points at its dm_businesses row and tools read live station_data.
-- A system listing carries its own facts (programs, pricing, signup).

-- 1. Directory listings.
create table if not exists dm_directory_listings (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  display_name text not null,
  kind text not null check (kind in ('business', 'system')),
  intents text[] not null default '{}',
  description text,
  business_id uuid references dm_businesses(id) on delete set null,
  facts jsonb not null default '{}'::jsonb,
  gates text[] not null default '{}',
  status text not null default 'live' check (status in ('live', 'pilot', 'hidden')),
  priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dm_directory_listings_status_idx on dm_directory_listings (status, priority);

-- 2. RLS: the directory is public-read for live/pilot listings (it is a
--    public directory); writes are operator-only. The voice backend uses
--    the service key and bypasses RLS.
alter table dm_directory_listings enable row level security;

drop policy if exists dm_directory_listings_public_read on dm_directory_listings;
create policy dm_directory_listings_public_read on dm_directory_listings
  for select using (status in ('live', 'pilot'));

drop policy if exists dm_directory_listings_operator on dm_directory_listings;
create policy dm_directory_listings_operator on dm_directory_listings
  for all using (dm_is_operator());

-- 3. Seed, in Milly's order (Oct 20, 2026):
--    1. Ellianna's Donut Shop (first business on the directory)
--    2. VictoryLap
--    3. OpenLine
--    4. Readable Business Systems: row exists but HIDDEN until Milly
--       calls it market-ready. Hidden listings never surface.
insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'elliannas-donut-shop',
  'Ellianna''s Donut Shop',
  'business',
  array['food_ordering'],
  'Donut shop in Columbia, Missouri. Fresh donuts, coffee, and catering packages.',
  (select id from dm_businesses where slug = 'elliannas-donut-shop'),
  '{}'::jsonb,
  array['order', 'info'],
  'live',
  1
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  intents = excluded.intents,
  description = excluded.description,
  business_id = excluded.business_id,
  gates = excluded.gates,
  status = excluded.status,
  priority = excluded.priority,
  updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'victorylap',
  'VictoryLap',
  'system',
  array['health'],
  'Health clinic. Labs, health programs, and coaching.',
  null,
  '{"programs": [{"name": "Essential", "price": "$199"}, {"name": "Concierge", "price": "$999"}, {"name": "Private Client", "price": "$5,000"}], "signup_url": "https://victorylap.tabronmerryhill.com"}'::jsonb,
  array['info', 'signup'],
  'live',
  2
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  intents = excluded.intents,
  description = excluded.description,
  facts = excluded.facts,
  gates = excluded.gates,
  status = excluded.status,
  priority = excluded.priority,
  updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'openline',
  'OpenLine',
  'system',
  array['business_phone'],
  'Phone agent service for businesses. Answers your calls, takes orders, and sends payment links so you never miss a customer.',
  null,
  '{"plans": [{"name": "Shared", "price": "$149/mo", "detail": "300 minutes included, $0.25/min after, $0.02 per text"}, {"name": "Dedicated", "price": "$1,500 setup + $1,500/mo", "detail": "Your own agent and number, $0.15/min, $0.02 per text"}, {"name": "Reviews add-on", "price": "$49/mo"}], "signup_url": "https://openline.tabronmerryhill.com/pricing.html"}'::jsonb,
  array['info', 'signup'],
  'live',
  3
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  intents = excluded.intents,
  description = excluded.description,
  facts = excluded.facts,
  gates = excluded.gates,
  status = excluded.status,
  priority = excluded.priority,
  updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'readable-business-systems',
  'Readable Business Systems',
  'system',
  array['business_systems'],
  'Business systems work: visibility sprints, fractional systems architecture, and observability for owner-led businesses.',
  null,
  '{"signup_url": "https://readable.tabronmerryhill.com/business-systems"}'::jsonb,
  array['info'],
  'hidden',
  4
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  kind = excluded.kind,
  intents = excluded.intents,
  description = excluded.description,
  facts = excluded.facts,
  gates = excluded.gates,
  status = excluded.status,
  priority = excluded.priority,
  updated_at = now();

-- Verification:
-- select slug, display_name, kind, intents, status, priority
-- from dm_directory_listings order by priority;
-- Expected: 4 rows. elliannas-donut-shop (business, food_ordering, live, 1,
-- business_id NOT NULL), victorylap (system, health, live, 2),
-- openline (system, business_phone+owner_services, live, 3),
-- readable-business-systems (system, business_systems, hidden, 4).
