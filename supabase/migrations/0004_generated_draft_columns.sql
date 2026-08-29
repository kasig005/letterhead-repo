-- 0004_generated_draft_columns.sql
--
-- Feature 1 (LLM draft writing): the `generate-draft` Edge Function writes a
-- tailored subject/body per company with Claude and stores it here. `create-draft`
-- uses these when present and falls back to naive {{token}} template merge when
-- they are null (e.g. no ANTHROPIC_API_KEY set, or the row was never generated).

alter table public.companies
  add column if not exists generated_subject text,
  add column if not exists generated_body   text,
  add column if not exists generated_at     timestamptz;

-- No RLS changes needed: the existing `companies_all_own` policy already covers
-- these columns for the owning user.
