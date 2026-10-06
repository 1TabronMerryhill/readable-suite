-- DayMarket migration v3: business cash-out (balance model).
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr) after migration-orders-v2.sql.
--
-- The business holds a DayMarket balance: delivery credits the net automatically
-- (trigger dm_order_fee), and the business cashes out on demand. DayMarket remains
-- the merchant of record throughout: the org pays DayMarket, the business draws
-- its net from its balance.
--
-- Payout flow per order: pending -> payable (on delivery) -> requested (cash-out)
-- -> paid (money sent). Operator marks payouts paid via the dashboard:
--   update public.dm_payouts set status='paid', paid_at=now() where id='<payout_id>';
--   update public.dm_orders set payout_status='paid', paid_out_at=now()
--     where business_id='<business_id>' and payout_status='requested';

-- allow the 'requested' state on orders included in a cash-out
alter table public.dm_orders drop constraint if exists dm_orders_payout_status_check;
alter table public.dm_orders
  add constraint dm_orders_payout_status_check
  check (payout_status in ('pending','payable','requested','paid','void'));

-- the ledger: every cash-out request and its settlement
create table if not exists public.dm_payouts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.dm_businesses(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'requested'
    check (status in ('requested','paid','canceled')),
  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.dm_payouts enable row level security;

-- businesses: read their own payout history
drop policy if exists dm_payouts_business_select on public.dm_payouts;
create policy dm_payouts_business_select on public.dm_payouts
  for select using (public.dm_is_owner(business_id));

-- businesses: request a cash-out (requested only; settlement is operator-side)
drop policy if exists dm_payouts_business_insert on public.dm_payouts;
create policy dm_payouts_business_insert on public.dm_payouts
  for insert with check (
    public.dm_is_owner(business_id) and status = 'requested'
  );

create index if not exists dm_payouts_business_idx on public.dm_payouts(business_id);
