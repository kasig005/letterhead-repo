# Letterhead — project context for Claude

Read this first in any new session working on this repo. It's a multi-user
cold-email tool: each person signs in with Google, manages their own CV,
message template, and target-company list, and creates personalized,
CV-attached **drafts** in their own Gmail. Nothing sends automatically —
review always happens in Gmail itself.

## Architecture

- **Frontend**: `index.html` — one self-contained static page, no build
  step. Uses the Supabase JS client (loaded from a CDN) for auth, database
  reads/writes, storage, and calling the Edge Function. Deployable to any
  static host (currently: Cloudflare Pages, connected to this repo's GitHub
  remote for auto-deploy on push).
- **Backend**: Supabase project `letterhead`.
  - Project ref: `bsyhpyvowajbfpiyeinp`
  - Org: `ItDaaG's Org` (org id `zvphugtqmzwqvspzzeut`)
  - Region: `eu-west-2`
  - Project URL: `https://bsyhpyvowajbfpiyeinp.supabase.co`
  - The publishable API key is hardcoded near the top of `index.html`'s
    `<script>` block — that's expected, it's a public, RLS-protected key,
    safe to commit. There is no service-role key or secret anywhere in this
    repo; the Edge Function reads the service role key from its own runtime
    env (`SUPABASE_SERVICE_ROLE_KEY`, auto-injected by Supabase).
- **`supabase/functions/create-draft/index.ts`** — the only code that talks
  to Gmail. Runs server-side: verifies the caller's JWT, looks up their
  stored Google refresh token (service-role only, RLS blocks the client from
  reading it back), exchanges it for an access token, builds the MIME
  message with the CV attached, and calls the Gmail API to create a draft in
  *that user's* account.
- **`supabase/migrations/`** — full schema, in order:
  - `0001_init_schema.sql` — `profiles`, `companies`, `templates`,
    `cv_files`, `google_tokens` tables; RLS policies scoped to
    `auth.uid()`; a trigger that auto-creates a `profiles` row + a starter
    `templates` row on signup.
  - `0002_cv_storage_bucket.sql` — the private `cv-files` storage bucket
    and its per-user object policies (folder-per-user convention: objects
    live at `<user_id>/<filename>`).

## Data model

| Table | Purpose |
|---|---|
| `profiles` | One row per user, auto-created on signup. |
| `templates` | One editable subject/body/sign-off per user. |
| `companies` | Each user's outreach list and per-row draft status (`pending` / `creating` / `drafted` / `error`). |
| `cv_files` | Metadata for the CV in the `cv-files` bucket. |
| `google_tokens` | Refresh tokens — insert/update only for the owning user, no select policy at all for client roles. Only the service role (inside the Edge Function) can read it. |

## Status

**Live and verified end-to-end as of 2026-08-29** — a real CV-attached
draft was created in Gmail Drafts (`companies.status` → `drafted`).

- Repo pushed to GitHub (`kasig005/letterhead-repo`).
- Frontend deployed on Cloudflare at
  `https://letterhead-repo.koolkasig19.workers.dev` (served as a Worker
  with static assets — the URL is `*.workers.dev`, not `*.pages.dev`).
- Google Cloud OAuth client created. Scope
  `https://www.googleapis.com/auth/gmail.compose` registered under the
  **Google Auth Platform → Data access** screen; Gmail API enabled.
  Consent screen in **Testing** mode (only listed test users can sign in;
  their Google refresh tokens expire after 7 days).
- Supabase: Google Auth provider enabled; `GOOGLE_CLIENT_ID` /
  `GOOGLE_CLIENT_SECRET` set as Edge Function secrets; **Site URL** set to
  the Cloudflare URL and added to Redirect URLs.
- Schema: migrations `0001`–`0003` applied (`0003` added
  `store_google_token()` — see below).

### Bugs fixed during setup (2026-08-29)

- `0003_store_google_token_rpc.sql` — the browser cannot `upsert` into
  `google_tokens` (no SELECT policy, and the client-set `user_id` trips
  the INSERT check). A `SECURITY DEFINER` function `store_google_token()`
  writes the caller's row using `auth.uid()`; `index.html` calls it via
  `sb.rpc()` in `onAuthStateChange`.
- `index.html` — `onAuthStateChange` re-fires on token refresh / tab
  focus; it used to reload data and rebuild the companies table each
  time, wiping in-progress row edits (→ blank rows → "Missing or invalid
  contact email"). Now data loads once per sign-in, `renderTable()` skips
  rebuilding while a cell is focused, and a row is force-saved before
  `create-draft` runs.
- Gotcha: Google silently drops OAuth scopes not registered on the
  consent screen — `gmail.compose` must be under **Data access** *and*
  the Gmail API enabled, then re-authorize (existing tokens don't gain
  scopes). Check `edge_logs` for `/auth/v1/callback?...scope=` to see
  what was actually granted.

## Working conventions

- Keep `supabase/migrations/` as the source of truth for schema changes —
  add new numbered migration files rather than editing old ones, and apply
  them to project `bsyhpyvowajbfpiyeinp`.
- The Edge Function is deployed by name (`create-draft`) to that same
  project; redeploying with the same name creates a new version.
- No billing, no formal legal pages, no Google app verification yet — this
  is intentionally still prototype stage (a few named test users only).
- Never commit a service-role key, a Google client secret, or anyone's
  refresh token to this repo.
