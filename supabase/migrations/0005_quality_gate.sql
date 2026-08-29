-- 0005_quality_gate.sql
--
-- Feature: writer -> judge quality loop in generate-draft. The writer drafts,
-- a judge scores it 0-100 against prompts/rubric.md, and anything under
-- PASS_THRESHOLD (80) is rewritten with the feedback, up to 3 attempts. Only a
-- passing draft may become a Gmail draft; otherwise the row is needs_review.
--
-- Reuses the generated_subject / generated_body columns from 0004. Adds the
-- score/attempts/feedback and an audit table of every writer/judge pass.

alter table public.companies
  add column if not exists quality_score    int,
  add column if not exists quality_attempts int,
  add column if not exists quality_feedback text;

-- Widen the status check to cover the new in-flight + gate states.
-- 0001 created this inline, auto-named companies_status_check.
alter table public.companies drop constraint if exists companies_status_check;
alter table public.companies add constraint companies_status_check
  check (status in (
    'pending','generating','scoring','needs_review','creating','drafted','error'
  ));

-- One row per writer/judge pass — for inspecting why a draft scored low.
-- Not required for the loop; the loop tolerates insert failures here.
create table if not exists public.email_revisions (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  attempt    int  not null,
  subject    text,
  body       text,
  score      int,
  breakdown  jsonb,
  feedback   text,
  created_at timestamptz not null default now()
);
create index if not exists email_revisions_company_id_idx
  on public.email_revisions(company_id);

alter table public.email_revisions enable row level security;
create policy "email_revisions_all_own" on public.email_revisions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
