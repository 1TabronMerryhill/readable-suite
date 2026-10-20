-- Migration: complete the Station directory with the full stack
-- Run in Supabase dashboard SQL editor (project: readable), AFTER v11.
--
-- Source of truth for the stack: tabronmerryhill.com (Oct 20, 2026):
-- eight operating businesses. Milly's directory order: Ellianna's first,
-- then VictoryLap, then OpenLine, then every other system that is ready
-- for the market. Everything below OpenLine is seeded HIDDEN: the rows
-- exist so the registry is complete, and a listing goes live only on
-- Milly's per-listing word. Hidden listings never surface to callers.
-- All of them are owner-facing systems work, so all carry the
-- business_systems intent and can only ever be offered to a caller whose
-- intent is business_systems. Never to consumers.

-- Refresh Readable's row (already seeded hidden in v10) with the site's
-- own description of the business.
insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'readable-business-systems',
  'Readable',
  'system',
  array['business_systems'],
  'Turn AI into useful, accountable work. Readiness assessments, Business Systems for owner-led businesses, the Readable Academy, and independent Evals.',
  null,
  '{"signup_url": "https://readable.tabronmerryhill.com"}'::jsonb,
  array['info'],
  'hidden',
  4
)
on conflict (slug) do update set
  display_name = excluded.display_name,
  intents = excluded.intents,
  description = excluded.description,
  facts = excluded.facts,
  gates = excluded.gates,
  status = excluded.status,
  priority = excluded.priority,
  updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'vision-studio',
  'V.I.S.I.O.N. Studio',
  'system',
  array['business_systems'],
  'Finished videos, manufactured. AI commercials that move through nine approval gates. Single spots or monthly production on retainer.',
  null,
  '{"signup_url": "https://studio.tabronmerryhill.com"}'::jsonb,
  array['info'],
  'hidden',
  5
)
on conflict (slug) do update set
  display_name = excluded.display_name, intents = excluded.intents,
  description = excluded.description, facts = excluded.facts,
  gates = excluded.gates, status = excluded.status,
  priority = excluded.priority, updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'sitepulse',
  'SitePulse',
  'system',
  array['business_systems'],
  'Field-ops reporting for builders. Ninety-second sub check-ins compiled into one morning report, with problems flagged the same day.',
  null,
  '{"signup_url": "https://sitepulse.tabronmerryhill.com"}'::jsonb,
  array['info'],
  'hidden',
  6
)
on conflict (slug) do update set
  display_name = excluded.display_name, intents = excluded.intents,
  description = excluded.description, facts = excluded.facts,
  gates = excluded.gates, status = excluded.status,
  priority = excluded.priority, updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'ai-search-discovery',
  'AI Search Discovery',
  'system',
  array['business_systems'],
  'Get found when customers ask AI. Your video content made machine-readable, so AI search can quote your business as the answer.',
  null,
  '{"signup_url": "https://discovery.tabronmerryhill.com"}'::jsonb,
  array['info'],
  'hidden',
  7
)
on conflict (slug) do update set
  display_name = excluded.display_name, intents = excluded.intents,
  description = excluded.description, facts = excluded.facts,
  gates = excluded.gates, status = excluded.status,
  priority = excluded.priority, updated_at = now();

insert into dm_directory_listings (slug, display_name, kind, intents, description, business_id, facts, gates, status, priority)
values (
  'the-workflow',
  'The Workflow',
  'system',
  array['business_systems'],
  'The daily publication for owner-led businesses. One idea, one example, one next step.',
  null,
  '{"signup_url": "https://workflow.tabronmerryhill.com"}'::jsonb,
  array['info'],
  'hidden',
  8
)
on conflict (slug) do update set
  display_name = excluded.display_name, intents = excluded.intents,
  description = excluded.description, facts = excluded.facts,
  gates = excluded.gates, status = excluded.status,
  priority = excluded.priority, updated_at = now();

-- Verification:
-- select slug, display_name, kind, status, priority from dm_directory_listings order by priority;
-- Expected 8 rows: elliannas-donut-shop (live, 1), victorylap (live, 2),
-- openline (live, 3), readable-business-systems (hidden, 4),
-- vision-studio (hidden, 5), sitepulse (hidden, 6),
-- ai-search-discovery (hidden, 7), the-workflow (hidden, 8).
