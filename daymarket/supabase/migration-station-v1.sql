-- Readable Station Gate 2 (Phone Gate) — migration v1.
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr).
--
-- 1) dm_station_reviews: the human review queue. Uncertain phone/SMS orders
--    land here as structured data. A human approves or denies; approval can
--    trigger fulfillment (Phase 2). v1 review is SQL-level:
--
--      -- pending reviews for a business:
--      select id, created_at, caller_phone, channel, confidence,
--             structured_order, validation_notes
--      from public.dm_station_reviews
--      where business_id = '<uuid>' and status = 'pending'
--      order by created_at desc;
--
--      -- approve:
--      update public.dm_station_reviews
--      set status = 'approved', decided_at = now(), decided_by = 'operator'
--      where id = '<review-uuid>';
--
--      -- deny:
--      update public.dm_station_reviews
--      set status = 'denied', decided_at = now(), decided_by = 'operator'
--      where id = '<review-uuid>';
--
--    A future review UI needs: list pending by business, show the structured
--    order + validation notes + confidence + caller phone, one-tap
--    approve/deny, and on approve an automatic handoff into dm_orders.
--
-- 2) dm_agent_verifications extension: call/SMS events are verification
--    events too. order_id becomes nullable (questions and answered calls
--    have no order), plus channel and event_type columns. Existing rows
--    are untouched.

create table if not exists public.dm_station_reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  business_id uuid not null references public.dm_businesses(id) on delete cascade,
  caller_phone text not null,
  channel text not null check (channel in ('voice', 'sms')),
  structured_order jsonb,
  validation_notes text,
  confidence numeric,
  review_reason text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied')),
  decided_at timestamptz,
  decided_by text,
  order_id uuid references public.dm_orders(id) on delete set null
);

create index if not exists dm_station_reviews_business_idx
  on public.dm_station_reviews(business_id, status, created_at desc);

alter table public.dm_station_reviews enable row level security;

drop policy if exists dm_station_reviews_operator on public.dm_station_reviews;
create policy dm_station_reviews_operator on public.dm_station_reviews
  for select using (public.dm_is_operator());

-- Verification table extension for call/SMS events.
alter table public.dm_agent_verifications alter column order_id drop not null;

alter table public.dm_agent_verifications
  add column if not exists channel text;

alter table public.dm_agent_verifications
  add column if not exists event_type text;

-- Measurement: the monthly report writes itself from these tables.
--   calls handled:      select count(*) from dm_agent_verifications where channel in ('voice','sms') and created_at >= date_trunc('month', now());
--   orders completed:   select count(*) from dm_agent_verifications where event_type = 'order_auto_approved' and created_at >= date_trunc('month', now());
--   queued for review:  select count(*) from dm_station_reviews where status = 'pending';
--   review outcomes:    select status, count(*) from dm_station_reviews where created_at >= date_trunc('month', now()) group by status;
