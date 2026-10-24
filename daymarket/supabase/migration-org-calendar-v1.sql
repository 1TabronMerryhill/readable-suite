-- DayMarket organization calendars: a standing link between an organization
-- and a business. The business invites the org (org-invite function); the
-- org signs up, pays the $49/mo membership, and then orders from that
-- business through its calendar. Either side can leave at any time: leaving
-- ends the link and cancels future unconfirmed orders, while confirmed
-- orders stand. Only one active link per (org, business); leaving keeps
-- history, and a later re-invite opens a fresh active row.
-- Also adds dm_members.org_name, which org-signup already writes but no
-- migration ever created. Apply via the Supabase dashboard SQL editor
-- (project: readable).

alter table public.dm_members add column if not exists org_name text;

create table if not exists public.dm_org_calendars (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.dm_members(id) on delete cascade,
  business_id uuid not null references public.dm_businesses(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'left')),
  source text not null default 'business_invite'
    check (source in ('business_invite', 'self')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists dm_org_calendars_org_idx
  on public.dm_org_calendars(org_id, status);
create index if not exists dm_org_calendars_business_idx
  on public.dm_org_calendars(business_id, status);
create unique index if not exists dm_org_calendars_one_active
  on public.dm_org_calendars(org_id, business_id) where status = 'active';

alter table public.dm_org_calendars enable row level security;

-- Orgs manage their own calendar links.
drop policy if exists dm_org_calendars_org on public.dm_org_calendars;
create policy dm_org_calendars_org on public.dm_org_calendars
  for all using (auth.uid() = org_id) with check (auth.uid() = org_id);

-- Fulfilling businesses manage links to their own business.
drop policy if exists dm_org_calendars_business on public.dm_org_calendars;
create policy dm_org_calendars_business on public.dm_org_calendars
  for all using (public.dm_is_owner(business_id))
  with check (public.dm_is_owner(business_id));

-- Operator manages all.
drop policy if exists dm_org_calendars_operator on public.dm_org_calendars;
create policy dm_org_calendars_operator on public.dm_org_calendars
  for all using (public.dm_is_operator())
  with check (public.dm_is_operator());
