# Letterhead

A small multi-user tool for cold-emailing companies with your CV attached. Each
person signs in with their own Google account, manages their own CV, message
template, and target-company list, and can create personalized, CV-attached
**drafts** in their own Gmail — nothing is ever sent automatically, so review
always happens in Gmail itself before anything goes out.

## How it's built

- **Frontend** — `index.html`. A single self-contained static page (no build
  step) using the [Supabase JS client](https://supabase.com/docs/reference/javascript)
  loaded from a CDN. Deploy it anywhere that serves static files (Cloudflare
  Pages, Netlify, GitHub Pages, S3, etc.).
- **Backend** — [Supabase](https://supabase.com): Postgres (with row-level
  security so every user only ever sees their own data), Auth (Google
  sign-in), Storage (private per-user CV files), and one Edge Function.
- **`supabase/functions/create-draft`** — the only place that talks to Gmail.
  It runs server-side, looks up the caller's stored Google refresh token,
  exchanges it for an access token, builds the MIME message with the CV
  attached, and calls the Gmail API to create a draft in *that user's* Gmail
  account.
- **`supabase/migrations`** — the full database schema, storage bucket, and
  row-level security policies, in the order they were applied.

## Setting up your own copy

1. **Create a Supabase project** and apply the migrations in
   `supabase/migrations/` (via the Supabase CLI, the dashboard's SQL editor,
   or the Supabase MCP server).
2. **Deploy the Edge Function**: `supabase functions deploy create-draft`
   (or via the dashboard / MCP).
3. **Deploy `index.html`** to any static host, and note the URL it gives you.
4. **Create a Google Cloud OAuth client**:
   - Enable the Gmail API.
   - Configure the OAuth consent screen (External, Testing mode is fine for
     a prototype — add your testers' emails under Test users), with the
     `https://www.googleapis.com/auth/gmail.compose` scope.
   - Create a Web application OAuth client. Authorized JavaScript origin:
     your static host's URL. Authorized redirect URI:
     `https://<your-project-ref>.supabase.co/auth/v1/callback`.
5. **Wire the credentials in Supabase**:
   - Authentication → Providers → Google: paste the Client ID and Secret.
   - Edge Functions → Secrets: add `GOOGLE_CLIENT_ID` and
     `GOOGLE_CLIENT_SECRET` with the same values.
6. Edit `SUPABASE_URL` and `SUPABASE_KEY` near the top of `index.html`'s
   `<script>` to point at your own project (they're public, RLS-protected
   values — safe to commit).

## Data model

| Table | Purpose |
|---|---|
| `profiles` | One row per user, auto-created on signup. |
| `templates` | One editable subject/body/sign-off per user. |
| `companies` | Each user's outreach list and per-row draft status. |
| `cv_files` | Metadata for the CV stored in the `cv-files` storage bucket. |
| `google_tokens` | Refresh tokens. Writable by the owning user, readable only by the service role — the client can never read its own token back. |

## Status

Prototype stage: no billing, no formal legal pages, Google app verification
not yet requested (fine while everyone signing in is an added test user).
