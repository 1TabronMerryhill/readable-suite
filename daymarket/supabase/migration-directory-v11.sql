-- Migration: concierge contexts + callback/message store
-- Run in Supabase dashboard SQL editor (project: readable), AFTER v10.
--
-- dm_voice_contexts: one row per get_business_context call. The context_id
-- is the enforcement token for the concierge path: business-scoped tools
-- presented with a context_id are rejected unless the context's business
-- matches the call's business_ref. Rows also persist call_id -> listing,
-- which the call-sync webhook uses to tag dm_voice_calls with the listing
-- served (pass-through billing split; unattributed = DayMarket overhead).
--
-- dm_callback_requests: the message store behind take_message. The
-- concierge's "take a message" and the pilot agent's "the shop will call
-- you back" both land here. Before this table existed, that promise was
-- a dead end: nothing was ever written anywhere.

-- 0. Intent enum correction (v10 seed fix, idempotent): OpenLine serves
--    business_phone only. The intent enum stays small and exact:
--    food_ordering | health | business_phone | business_systems.
update dm_directory_listings
set intents = array['business_phone'], updated_at = now()
where slug = 'openline' and intents <> array['business_phone'];

-- 1. Voice contexts.
create table if not exists dm_voice_contexts (
  id uuid primary key,
  retell_call_id text,
  listing_slug text not null,
  business_id uuid references dm_businesses(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists dm_voice_contexts_call_idx on dm_voice_contexts (retell_call_id);

alter table dm_voice_contexts enable row level security;

drop policy if exists dm_voice_contexts_operator on dm_voice_contexts;
create policy dm_voice_contexts_operator on dm_voice_contexts
  for all using (dm_is_operator());

-- 2. Callback / message requests.
create table if not exists dm_callback_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text,
  message text not null,
  listing_slug text,
  business_id uuid references dm_businesses(id) on delete set null,
  retell_call_id text,
  source text not null default 'concierge',
  status text not null default 'new' check (status in ('new', 'contacted', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists dm_callback_requests_status_idx on dm_callback_requests (status, created_at);

alter table dm_callback_requests enable row level security;

-- Public intake: anyone (the voice backend's callers) may leave a message.
drop policy if exists dm_callback_requests_insert on dm_callback_requests;
create policy dm_callback_requests_insert on dm_callback_requests
  for insert with check (true);

-- Reads: operator full; a business owner sees requests for their business.
drop policy if exists dm_callback_requests_operator on dm_callback_requests;
create policy dm_callback_requests_operator on dm_callback_requests
  for all using (dm_is_operator());

drop policy if exists dm_callback_requests_owner_read on dm_callback_requests;
create policy dm_callback_requests_owner_read on dm_callback_requests
  for select using (
    business_id in (select id from dm_businesses where owner_id = auth.uid())
  );

-- Verification:
-- select table_name from information_schema.tables
-- where table_name in ('dm_voice_contexts', 'dm_callback_requests');
-- Expected: 2 rows.
-- select slug, intents from dm_directory_listings where slug = 'openline';
-- Expected: intents = {business_phone}.
