-- DayMarket AI sales agent v2: conversation threads, messages, audit.
-- Ported from the VictoryLap coach chat (threads + proposal buttons + audit):
-- the agent is a conversation, not a one-shot form. Threads survive reloads,
-- proposals apply only when the manager taps, and every invocation is audited.
-- Depends on dm_is_owner() (schema) and dm_is_operator() (orders-v4, widened
-- Oct 23 to both Milly identities). Apply via the Supabase dashboard SQL
-- editor (project: readable) before the v2 deploy goes live.

create table if not exists public.dm_agent_threads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.dm_businesses(id) on delete cascade,
  title text not null default 'Conversation',
  -- origin: 'member' (manager started), 'proactive' (DayMarket signal started)
  origin text not null default 'member'
    check (origin in ('member', 'proactive')),
  context jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dm_agent_threads_business_idx
  on public.dm_agent_threads(business_id, updated_at desc);

create table if not exists public.dm_agent_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.dm_agent_threads(id) on delete cascade,
  role text not null check (role in ('member', 'agent', 'system')),
  content text not null default '',
  -- intent: 'proposal' (proposal jsonb holds the offer), 'applied:<proposalId>',
  -- or a deterministic intent name ('best_sellers', 'repeat_last', ...). Null
  -- for plain replies. Buttons render from proposal jsonb, never from text.
  intent text,
  proposal jsonb,
  created_at timestamptz not null default now()
);
create index if not exists dm_agent_messages_thread_idx
  on public.dm_agent_messages(thread_id, created_at);

create table if not exists public.dm_agent_audit (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.dm_businesses(id) on delete cascade,
  actor text not null check (actor in ('manager', 'agent', 'operator', 'system')),
  action text not null,
  details jsonb not null default '{}',
  result text not null default 'success'
    check (result in ('success', 'failure', 'denied')),
  created_at timestamptz not null default now()
);
create index if not exists dm_agent_audit_business_idx
  on public.dm_agent_audit(business_id, created_at desc);

alter table public.dm_agent_threads enable row level security;
alter table public.dm_agent_messages enable row level security;
alter table public.dm_agent_audit enable row level security;

-- Threads: owners manage their own; operator reads/manages all.
drop policy if exists dm_agent_threads_owner on public.dm_agent_threads;
create policy dm_agent_threads_owner on public.dm_agent_threads
  for all using (public.dm_is_owner(business_id))
  with check (public.dm_is_owner(business_id));
drop policy if exists dm_agent_threads_operator on public.dm_agent_threads;
create policy dm_agent_threads_operator on public.dm_agent_threads
  for all using (public.dm_is_operator())
  with check (public.dm_is_operator());

-- Messages: owners manage messages on their own threads; operator all.
drop policy if exists dm_agent_messages_owner on public.dm_agent_messages;
create policy dm_agent_messages_owner on public.dm_agent_messages
  for all using (exists (
    select 1 from public.dm_agent_threads t
    where t.id = thread_id and public.dm_is_owner(t.business_id)))
  with check (exists (
    select 1 from public.dm_agent_threads t
    where t.id = thread_id and public.dm_is_owner(t.business_id)));
drop policy if exists dm_agent_messages_operator on public.dm_agent_messages;
create policy dm_agent_messages_operator on public.dm_agent_messages
  for all using (public.dm_is_operator())
  with check (public.dm_is_operator());

-- Audit: owners and operator may read; writes come from the service role
-- (which bypasses RLS), so no insert policy is needed or wanted.
drop policy if exists dm_agent_audit_owner on public.dm_agent_audit;
create policy dm_agent_audit_owner on public.dm_agent_audit
  for select using (public.dm_is_owner(business_id));
drop policy if exists dm_agent_audit_operator on public.dm_agent_audit;
create policy dm_agent_audit_operator on public.dm_agent_audit
  for select using (public.dm_is_operator());
