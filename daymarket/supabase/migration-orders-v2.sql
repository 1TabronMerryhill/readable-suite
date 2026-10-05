-- DayMarket migration v2: automatic fulfillment fee (the routing economics).
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr) after migration-orders-v1.sql.
--
-- The fee is a standard platform term, not a negotiation: orders routed to a
-- profiled business carry a 15% fulfillment fee (1500 basis points), deducted
-- automatically before payout. DayMarket is the merchant of record: the org
-- pays DayMarket, the business is paid the net. No invoicing, no chasing.
--
-- fee_bps is per-order so the standard can evolve (or be adjusted for a
-- specific business) without rewriting history. Existing rows keep 1500.

alter table public.dm_orders
  add column if not exists fee_bps integer not null default 1500,
  add column if not exists fee_cents integer,
  add column if not exists net_cents integer,
  add column if not exists payout_status text not null default 'pending'
    check (payout_status in ('pending','payable','paid','void')),
  add column if not exists paid_out_at timestamptz,
  add column if not exists payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','paid','refunded'));

-- auto-compute the fee and the business net whenever the total or rate changes.
-- delivery releases the payout (pending -> payable); cancellation voids it.
-- operator-fulfilled orders (business_id null) are internal: no external payout.
create or replace function public.dm_order_fee()
returns trigger as $$
begin
  if new.total_cents is not null then
    new.fee_cents := round(new.total_cents * new.fee_bps / 10000.0);
    new.net_cents := new.total_cents - new.fee_cents;
  else
    new.fee_cents := null;
    new.net_cents := null;
  end if;
  if new.business_id is null then
    new.payout_status := 'paid';
    if new.paid_out_at is null then new.paid_out_at := now(); end if;
  else
    if new.status = 'delivered'
       and old.status is distinct from 'delivered'
       and new.payout_status = 'pending' then
      new.payout_status := 'payable';
    end if;
    if new.status = 'canceled' and new.payout_status in ('pending','payable') then
      new.payout_status := 'void';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists dm_order_fee on public.dm_orders;
create trigger dm_order_fee before insert or update on public.dm_orders
  for each row execute function public.dm_order_fee();

-- backfill existing rows through the same math
update public.dm_orders
set fee_cents = round(total_cents * fee_bps / 10000.0),
    net_cents = total_cents - round(total_cents * fee_bps / 10000.0)
where total_cents is not null and fee_cents is null;

create index if not exists dm_orders_payout_idx on public.dm_orders(business_id, payout_status);
