-- 0009_row_intent.sql
-- Per-contact "brief" — a short free-text steer for the draft, e.g.
-- "email about a summer internship" or "message about a coffee chat".
-- Captured in the Quick Add extension / paste panel, editable in-app, and
-- passed to generate-draft as the `instruction` when no explicit one is given.
-- Additive; NULL for existing rows. RLS unchanged.

alter table public.companies
  add column if not exists intent text;
