-- DayMarket operator widening (Oct 23, 2026).
-- The operator check previously recognized ONLY the old Gmail identity.
-- Milly's business identity tabron@tabronmerryhill.com must also green-light
-- holidays. Case-insensitive so JWT email casing can never lock him out.
-- Existing dm_holidays_operator / dm_offers_operator / dm_businesses_operator
-- policies call dm_is_operator(), so replacing the function is enough.
-- Apply via the Supabase dashboard SQL editor (project: readable).
create or replace function public.dm_is_operator()
returns boolean as $$
begin
  return lower(auth.jwt() ->> 'email') in
    ('tabronmerryhill@gmail.com', 'tabron@tabronmerryhill.com');
end; $$ language plpgsql stable security definer;
