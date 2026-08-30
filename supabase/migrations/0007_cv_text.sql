-- 0007_cv_text.sql
-- Store the extracted plain text of the candidate's CV so generate-draft can
-- ground its "evidence" paragraph in real experience instead of inventing it.
--
-- The text is extracted once, client-side (pdf.js / mammoth), when the CV is
-- uploaded or replaced — never on every draft. Existing rows stay NULL until
-- the user uploads a new CV. Additive; RLS is unchanged (inherits cv_files's
-- auth.uid() policies).

alter table public.cv_files
  add column if not exists cv_text text;
