-- 0006_contact_research.sql
-- Stage 1 of the LinkedIn capture + staged-research feature.
--
-- Adds per-row columns for: the raw captured profile (source_profile), the
-- outreach channel (email | linkedin), the short LinkedIn DM variant, and the
-- staged research prompts + synthesised notes that later stages fill in.
-- All additive; existing rows get NULL / the 'email' default. RLS is unchanged
-- (the columns inherit the table's auth.uid() policies).

alter table public.companies
  add column if not exists source_profile   jsonb,
  add column if not exists channel          text not null default 'email',
  add column if not exists generated_linkedin text,
  add column if not exists research_prompts jsonb,
  add column if not exists research_notes   text;

alter table public.companies
  drop constraint if exists companies_channel_check;
alter table public.companies
  add constraint companies_channel_check check (channel in ('email', 'linkedin'));
