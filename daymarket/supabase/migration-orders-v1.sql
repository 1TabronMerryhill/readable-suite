-- DayMarket migration: org orders (the demand engine).
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr) after schema.sql.
-- Orgs (dm_members with pass_type='organization') schedule package orders;
-- orders route to a profiled business or to DayMarket itself (business_id null = operator-fulfilled).

create table if not exists public.dm_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.dm_members(id) on delete cascade,
  business_id uuid references public.dm_businesses(id) on delete set null,
  package_id uuid references public.dm_packages(id) on delete set null,
  title text not null,
  scheduled_for timestamptz not null,
  headcount integer,
  recurrence text not null default 'once'
    check (recurrence in ('once','weekly','biweekly','monthly')),
  status text not null default 'scheduled'
    check (status in ('scheduled','confirmed','delivered','canceled')),
  notes text,
  total_cents integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists dm_orders_touch on public.dm_orders;
create trigger dm_orders_touch before update on public.dm_orders
  for each row execute function public.dm_touch_updated_at();

create index if not exists dm_orders_org_idx on public.dm_orders(org_id);
create index if not exists dm_orders_business_idx on public.dm_orders(business_id);
create index if not exists dm_orders_scheduled_idx on public.dm_orders(scheduled_for);

alter table public.dm_orders enable row level security;

-- orgs: full control over their own orders
drop policy if exists dm_orders_org on public.dm_orders;
create policy dm_orders_org on public.dm_orders
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

-- fulfilling businesses: read orders routed to them
drop policy if exists dm_orders_business on public.dm_orders;
create policy dm_orders_business on public.dm_orders
  for select using (
    business_id is not null and public.dm_is_owner(business_id)
  );
