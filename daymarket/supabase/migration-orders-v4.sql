-- DayMarket migration v4: adjustable per-business fee rate, order fee inheritance,
-- holiday review queue (submit-for-review), operator RLS access.
-- Run in the Supabase SQL editor for project "readable".

-- 1. Per-business fee rate, operator-adjustable. Default 15%.
alter table public.dm_businesses
  add column if not exists fee_bps integer not null default 1500;

-- 2. Orders inherit the business's current rate when fee_bps is not set on insert.
-- Existing orders keep their historical rate; new orders pick up the business rate.
alter table public.dm_orders alter column fee_bps drop default;

create or replace function public.dm_order_fee()
returns trigger as $$
begin
  if new.fee_bps is null then
    select b.fee_bps into new.fee_bps
    from public.dm_businesses b where b.id = new.business_id;
    if new.fee_bps is null then new.fee_bps := 1500; end if;
  end if;
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

-- 3. Holiday review queue: owners submit drafts for review; operator approves.
alter table public.dm_holidays drop constraint if exists dm_holidays_status_check;
alter table public.dm_holidays
  add constraint dm_holidays_status_check
  check (status in ('draft','in_review','published','ended','archived'));

-- 4. Operator access via RLS: the operator can review and manage all holidays/offers.
create or replace function public.dm_is_operator()
returns boolean as $$
begin
  return (auth.jwt() ->> 'email') = 'TabronMerryhill@gmail.com';
end; $$ language plpgsql stable security definer;

drop policy if exists dm_holidays_operator on public.dm_holidays;
create policy dm_holidays_operator on public.dm_holidays
  for all using (public.dm_is_operator()) with check (public.dm_is_operator());

drop policy if exists dm_offers_operator on public.dm_offers;
create policy dm_offers_operator on public.dm_offers
  for all using (public.dm_is_operator()) with check (public.dm_is_operator());

drop policy if exists dm_businesses_operator on public.dm_businesses;
create policy dm_businesses_operator on public.dm_businesses
  for all using (public.dm_is_operator()) with check (public.dm_is_operator());

-- Operator fee adjustment (run manually per business):
-- update public.dm_businesses set fee_bps = 1200 where id = '<business-id>';
