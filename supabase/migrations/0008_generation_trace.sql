-- 0008_generation_trace.sql
-- Records, per companies row, what generate-draft actually fed the writer for
-- the most recent run: the template body, CV-text excerpt, LinkedIn profile,
-- research notes, extra instruction, models, score/attempts, and the full
-- assembled writer context. Powers the in-app "How it was made" review portal.
-- The per-attempt draft history already lives in email_revisions (0005).
--
-- Additive; NULL for rows generated before this shipped. RLS unchanged.

alter table public.companies
  add column if not exists generation_trace jsonb;
