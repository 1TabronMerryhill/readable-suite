-- DayMarket account-area migration v1 — APPLIED 2026-10-04 via the Supabase SQL editor
-- (project readable / evmynxxvyafvnreaudpr). Kept here as the canonical record.
-- The account dashboard needs these three pieces, which schema.sql does not include:
--   1. a trigger that bumps dm_offers.quantity_claimed on each redemption insert
--      (SECURITY DEFINER: members have no UPDATE policy on dm_offers, so the
--      trigger must run with elevated privilege to do the increment)
--   2. an RLS policy letting business owners UPDATE redemptions on their offers (mark redeemed)
--   3. an RLS policy letting business owners SELECT member rows that claimed their offers
-- All statements are idempotent; safe to re-run.

-- ---------- 1. quantity_claimed auto-increment ----------

create or replace function public.dm_claim_increment()
returns trigger language plpgsql security definer as $$
begin
  update public.dm_offers
  set quantity_claimed = quantity_claimed + 1
  where id = new.offer_id;
  return new;
end $$;

drop trigger if exists dm_redemptions_claim on public.dm_redemptions;
create trigger dm_redemptions_claim
  after insert on public.dm_redemptions
  for each row execute function public.dm_claim_increment();

-- ---------- 2. owners can UPDATE redemptions on their own offers ----------

drop policy if exists dm_redemptions_owner_update on public.dm_redemptions;
create policy dm_redemptions_owner_update on public.dm_redemptions
  for update using (
    exists (
      select 1 from public.dm_offers o
      join public.dm_holidays h on h.id = o.holiday_id
      where o.id = dm_redemptions.offer_id and public.dm_is_owner(h.business_id)
    )
  )
  with check (
    exists (
      select 1 from public.dm_offers o
      join public.dm_holidays h on h.id = o.holiday_id
      where o.id = dm_redemptions.offer_id and public.dm_is_owner(h.business_id)
    )
  );

-- ---------- 3. owners can read member rows that claimed their offers ----------

drop policy if exists dm_members_owner_read on public.dm_members;
create policy dm_members_owner_read on public.dm_members
  for select using (
    exists (
      select 1 from public.dm_redemptions r
      join public.dm_offers o on o.id = r.offer_id
      join public.dm_holidays h on h.id = o.holiday_id
      where r.member_id = dm_members.id and public.dm_is_owner(h.business_id)
    )
  );
