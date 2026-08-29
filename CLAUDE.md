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
  *that user's* account. Uses the row's `generated_subject`/`generated_body`
  (from `generate-draft`) when present; otherwise falls back to naive
  `{{token}}` merge of the template.
- **`supabase/functions/generate-draft/index.ts`** — agentic layer, Feature 1.
  Verifies the caller's JWT, reads their `companies` row + `templates` row
  (RLS-scoped), calls the Claude Messages API (`ANTHROPIC_API_KEY` secret;
  model `claude-opus-5`, override via `ANTHROPIC_MODEL` secret) to write a
  tailored subject + body, and stores it on the row. Never touches Gmail.
  Returns `{error:"not_configured"}` (HTTP 400) when the key is unset; the
  client treats that as "skip generation" so the app still works key-less.
- **`supabase/migrations/`** — full schema, in order:
  - `0001_init_schema.sql` — `profiles`, `companies`, `templates`,
    `cv_files`, `google_tokens` tables; RLS policies scoped to
    `auth.uid()`; a trigger that auto-creates a `profiles` row + a starter
    `templates` row on signup.
  - `0002_cv_storage_bucket.sql` — the private `cv-files` storage bucket
    and its per-user object policies (folder-per-user convention: objects
    live at `<user_id>/<filename>`).
  - `0003_store_google_token_rpc.sql` — `store_google_token()` SECURITY
    DEFINER function (see Status).
  - `0004_generated_draft_columns.sql` — `generated_subject`,
    `generated_body`, `generated_at` on `companies` for Feature 1.

## Data model

| Table | Purpose |
|---|---|
| `profiles` | One row per user, auto-created on signup. |
| `templates` | One editable subject/body/sign-off per user. |
| `companies` | Each user's outreach list, per-row draft status (`pending` / `creating` / `drafted` / `error`), and the LLM-written `generated_subject` / `generated_body` / `generated_at`. |
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
- Schema: migrations `0001`–`0004` applied (`0003` added
  `store_google_token()` — see below; `0004` added the generated-draft
  columns).

### Agentic layer (in progress)

Being built feature by feature on top of the working draft pipeline. Planned
order: **1. LLM draft writing** → 2. per-contact research/enrichment →
3. in-app draft review & revision loop → 4. prospect finding →
5. chat-driven campaign agent. Nothing sends automatically at any stage; the
agent's terminal action is always a reviewable Gmail draft.

- **Feature 1 — done (2026-08-29).** `generate-draft` Edge Function +
  `0004` columns + `index.html` wiring. Each row gets a per-row **✨ Write**
  button (generate only, updates the preview panel) and **Create draft**
  now runs generate → create. Needs `ANTHROPIC_API_KEY` as an Edge Function
  secret; without it, generation is skipped and the app falls back to
  `{{token}}` template merge (so it's non-breaking). Model defaults to
  `claude-opus-5`; set the `ANTHROPIC_MODEL` secret to change it.
  - **Gotcha:** newer console keys (platform.claude.com) are
    *identity-linked* — the Messages API rejects them with
    "anthropic-workspace-id is required …". Fix: set the
    `ANTHROPIC_WORKSPACE_ID` secret (`wrkspc_…`); `generate-draft` sends it
    as the `anthropic-workspace-id` header when present. The auto-created
    "Default" workspace shows a blank ID in the console — create a named
    workspace to get a visible `wrkspc_…`.

- **Quality gate — done (2026-08-29).** `generate-draft` now runs a
  writer → judge loop (`0005_quality_gate.sql`; prompts in
  `supabase/functions/generate-draft/prompts/`). Writer drafts, judge
  (`claude-haiku-4-5`, override `ANTHROPIC_JUDGE_MODEL`) scores 0–100 vs
  `rubric.md`, anything < 80 is rewritten with the feedback, up to 3
  attempts. Best draft + `quality_score` / `quality_attempts` /
  `quality_feedback` stored on the row; every pass logged to
  `email_revisions`. A draft that never clears 80 → `status = needs_review`;
  `create-draft` returns 409 `below_quality_bar` for such a row unless
  called with `{ force: true }` ("Create anyway" button). New in-flight
  statuses: `generating`, `scoring`. `index.html` shows a score badge and a
  `needs_review` state; `createDraftForRow` skips regeneration when the row
  already scores ≥ 80.

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
