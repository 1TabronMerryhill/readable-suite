-- Migration: concierge call tagging on dm_voice_calls
-- Run in Supabase dashboard SQL editor (project: readable), AFTER v12.
--
-- Until now dm_voice_calls.business_id was NOT NULL: every logged call had
-- to belong to a shop. Concierge calls break that assumption. A call that
-- served a system listing (VictoryLap, OpenLine) or never picked a listing
-- is DayMarket overhead, not a shop's billable call, and it still has to be
-- logged. business_id becomes nullable (NULL = unattributed / overhead),
-- and listing_slug records which directory listing the call served,
-- resolved through dm_voice_contexts (call_id -> listing) by the webhook.
-- Owner RLS (dm_is_owner(business_id)) simply never matches NULL, so
-- overhead rows stay operator-visible only. Billing cycles only roll up
-- for calls with a business.

alter table public.dm_voice_calls alter column business_id drop not null;
alter table public.dm_voice_calls add column if not exists listing_slug text;
create index if not exists dm_voice_calls_listing_idx on public.dm_voice_calls (listing_slug);

-- Verification:
-- select column_name, is_nullable from information_schema.columns
-- where table_name = 'dm_voice_calls' and column_name in ('business_id', 'listing_slug');
-- Expected: business_id is_nullable = YES; listing_slug present, is_nullable = YES.
