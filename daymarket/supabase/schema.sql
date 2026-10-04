-- DayMarket schema — lives inside the existing `readable` Supabase project.
-- All tables prefixed dm_ to avoid collisions with readable's own tables.
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr).

-- ---------- tables ----------

create table if not exists public.dm_members (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  pass_type text not null default 'none'
    check (pass_type in ('none','holiday','organization')),
  pass_status text not null default 'inactive'
    check (pass_status in ('inactive','active','past_due','canceled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text unique,
  tagline text,
  description text,
  logo_url text,
  website text,
  status text not null default 'pending'
    check (status in ('pending','active','suspended')),
  profile_tier text not null default 'none'
    check (profile_tier in ('none','paid')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_holidays (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.dm_businesses(id) on delete cascade,
  title text not null,
  description text,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft','published','ended','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_offers (
  id uuid primary key default gen_random_uuid(),
  holiday_id uuid not null references public.dm_holidays(id) on delete cascade,
  title text not null,
  details text,
  regular_price_cents integer,
  member_price_cents integer,
  quantity_total integer,
  quantity_claimed integer not null default 0,
  status text not null default 'draft'
    check (status in ('draft','active','sold_out','ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.dm_packages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.dm_businesses(id) on delete set null,
  name text not null,
  description text,
  serves_min integer,
  serves_max integer,
  base_price_cents integer,
  image_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.dm_redemptions (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references public.dm_offers(id) on delete cascade,
  member_id uuid not null references public.dm_members(id) on delete cascade,
  code text not null unique,
  status text not null default 'claimed'
    check (status in ('claimed','redeemed','expired','canceled')),
  claimed_at timestamptz not null default now(),
  redeemed_at timestamptz,
  unique (offer_id, member_id)
);

-- ---------- updated_at trigger ----------

create or replace function public.dm_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists dm_members_touch on public.dm_members;
create trigger dm_members_touch before update on public.dm_members
  for each row execute function public.dm_touch_updated_at();
drop trigger if exists dm_businesses_touch on public.dm_businesses;
create trigger dm_businesses_touch before update on public.dm_businesses
  for each row execute function public.dm_touch_updated_at();
drop trigger if exists dm_holidays_touch on public.dm_holidays;
create trigger dm_holidays_touch before update on public.dm_holidays
  for each row execute function public.dm_touch_updated_at();
drop trigger if exists dm_offers_touch on public.dm_offers;
create trigger dm_offers_touch before update on public.dm_offers
  for each row execute function public.dm_touch_updated_at();

-- ---------- indexes ----------

create index if not exists dm_holidays_business_idx on public.dm_holidays(business_id);
create index if not exists dm_offers_holiday_idx on public.dm_offers(holiday_id);
create index if not exists dm_packages_business_idx on public.dm_packages(business_id);
create index if not exists dm_redemptions_offer_idx on public.dm_redemptions(offer_id);
create index if not exists dm_redemptions_member_idx on public.dm_redemptions(member_id);
create index if not exists dm_redemptions_code_idx on public.dm_redemptions(code);
create index if not exists dm_businesses_owner_idx on public.dm_businesses(owner_id);

-- ---------- RLS ----------

alter table public.dm_members enable row level security;
alter table public.dm_businesses enable row level security;
alter table public.dm_holidays enable row level security;
alter table public.dm_offers enable row level security;
alter table public.dm_packages enable row level security;
alter table public.dm_redemptions enable row level security;

-- helper: is the caller the owner of this business?
create or replace function public.dm_is_owner(bid uuid)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.dm_businesses b
    where b.id = bid and b.owner_id = auth.uid()
  );
$$;

-- dm_members: members see and edit only their own row
drop policy if exists dm_members_self on public.dm_members;
create policy dm_members_self on public.dm_members
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- dm_businesses: anyone can read active businesses; owners manage their own
drop policy if exists dm_businesses_public on public.dm_businesses;
create policy dm_businesses_public on public.dm_businesses
  for select using (status = 'active');
drop policy if exists dm_businesses_owner on public.dm_businesses;
create policy dm_businesses_owner on public.dm_businesses
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- dm_holidays: anyone can read published holidays; owners manage their own
drop policy if exists dm_holidays_public on public.dm_holidays;
create policy dm_holidays_public on public.dm_holidays
  for select using (status = 'published');
drop policy if exists dm_holidays_owner on public.dm_holidays;
create policy dm_holidays_owner on public.dm_holidays
  for all using (public.dm_is_owner(business_id))
  with check (public.dm_is_owner(business_id));

-- dm_offers: anyone can read active offers on published holidays; owners manage
drop policy if exists dm_offers_public on public.dm_offers;
create policy dm_offers_public on public.dm_offers
  for select using (
    status = 'active' and exists (
      select 1 from public.dm_holidays h
      where h.id = dm_offers.holiday_id and h.status = 'published'
    )
  );
drop policy if exists dm_offers_owner on public.dm_offers;
create policy dm_offers_owner on public.dm_offers
  for all using (
    exists (
      select 1 from public.dm_holidays h
      where h.id = dm_offers.holiday_id and public.dm_is_owner(h.business_id)
    )
  ) with check (
    exists (
      select 1 from public.dm_holidays h
      where h.id = dm_offers.holiday_id and public.dm_is_owner(h.business_id)
    )
  );

-- dm_packages: anyone can read active packages; owners manage their own
drop policy if exists dm_packages_public on public.dm_packages;
create policy dm_packages_public on public.dm_packages
  for select using (active = true);
drop policy if exists dm_packages_owner on public.dm_packages;
create policy dm_packages_owner on public.dm_packages
  for all using (business_id is null or public.dm_is_owner(business_id))
  with check (business_id is null or public.dm_is_owner(business_id));

-- dm_redemptions: members see and create their own claims; owners see claims on their offers
drop policy if exists dm_redemptions_member on public.dm_redemptions;
create policy dm_redemptions_member on public.dm_redemptions
  for all using (auth.uid() = member_id) with check (auth.uid() = member_id);
drop policy if exists dm_redemptions_owner on public.dm_redemptions;
create policy dm_redemptions_owner on public.dm_redemptions
  for select using (
    exists (
      select 1 from public.dm_offers o
      join public.dm_holidays h on h.id = o.holiday_id
      where o.id = dm_redemptions.offer_id and public.dm_is_owner(h.business_id)
    )
  );
