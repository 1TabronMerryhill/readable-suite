-- DayMarket migration v5: agent verification records (Readable Station).
-- Run in the Supabase SQL editor (project evmynxxvyafvnreaudpr) after migration-orders-v4.sql.
--
-- Every order placed through the agent gate (POST /api/agent/order) writes one
-- verification record: timestamp, SHA-256 of the canonical request inputs,
-- the order id, and the status at write time. This is the audit trail for the
-- station and the seed volume for Readable Evals. When agents act invisibly,
-- audit is the moat.
--
-- The gate's Netlify function writes via the service-role key (bypasses RLS).
-- No public access: verification records are operator-visible only.

create table if not exists public.dm_agent_verifications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  order_id uuid not null references public.dm_orders(id) on delete cascade,
  endpoint text not null,
  inputs_hash text not null,
  status text not null,
  agent_ref text,
  error text
);

create index if not exists dm_agent_verifications_order_idx
  on public.dm_agent_verifications(order_id);
create index if not exists dm_agent_verifications_ref_idx
  on public.dm_agent_verifications(agent_ref);

alter table public.dm_agent_verifications enable row level security;

-- operator: full read access (uses the existing dm_is_operator() helper)
drop policy if exists dm_agent_verifications_operator on public.dm_agent_verifications;
create policy dm_agent_verifications_operator on public.dm_agent_verifications
  for select using (public.dm_is_operator());
