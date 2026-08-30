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
- **`supabase/functions/generate-draft/index.ts`** — agentic layer, Feature 1
  + quality gate + channel-aware drafting. Verifies the caller's JWT, reads
  their `companies` row + `templates` row + `cv_files.cv_text` (RLS-scoped),
  runs the writer→judge
  loop against the Claude Messages API (`ANTHROPIC_API_KEY` secret; writer
  `claude-opus-5` / `ANTHROPIC_MODEL`, judge `claude-haiku-4-5` /
  `ANTHROPIC_JUDGE_MODEL`), and stores the best draft + `quality_*` on the
  row. Never touches Gmail. Takes `{ companyId, channel?, instruction? }`:
  `channel:"email"` (default, or `company.channel`) → `LINKEDIN_GUIDE`-free
  email into `generated_subject`/`generated_body`; `channel:"linkedin"` →
  a short no-subject DM (`LINKEDIN_GUIDE` + `LINKEDIN_RUBRIC`) into
  `generated_linkedin`. Both channels fold the candidate's `cv_text` (≤5k
  chars) plus `source_profile` + `research_notes` into the writer's context
  when present; the guides + rubrics forbid citing any candidate experience
  not in the CV text, template, or `instruction`. Returns
  `{error:"not_configured"}` (HTTP 400) when the key is unset; the client
  treats that as "skip generation".
- **`supabase/functions/extract-contact/index.ts`** — Quick Add helper.
  Verifies the caller's JWT, takes `{ text, kind?, url? }` (`kind` is
  `"page"` or `"linkedin"`; raw text capped at 20k chars), makes ONE Claude
  Messages API call (`ANTHROPIC_API_KEY` secret; model `claude-haiku-4-5`,
  override via `ANTHROPIC_EXTRACT_MODEL`) and returns `{ ok:true, company,
  role, contact_name, contact_email }` pulled verbatim from the text. When
  `kind === "linkedin"` it also returns a `source_profile` object (name,
  headline, location, about, current_title, current_company, past_roles[],
  skills[], profile_url). No retry loop, no scoring, and it never touches the
  database — the client inserts the `companies` row. Sends the
  `anthropic-workspace-id` header when `ANTHROPIC_WORKSPACE_ID` is set (same
  identity-linked-key gotcha as `generate-draft`). Prompt text is inlined as
  the `EXTRACT_GUIDE` const in `index.ts`; `prompts/extract-guide.md` is the
  editable source (re-inline by hand — the deploy path ships only `.ts`/`.js`).
- **`supabase/functions/suggest-research/index.ts`** — Stage 2 of the
  LinkedIn feature. Verifies the caller's JWT, reads their `companies` row
  (RLS-scoped), and makes ONE Claude call (`ANTHROPIC_RESEARCH_MODEL` ||
  `ANTHROPIC_EXTRACT_MODEL` || `claude-haiku-4-5`) to propose 3–6 research
  questions (`topic` = `company` | `person`, plus a suggested search
  `query`) about the contact and their employer. Writes them to
  `companies.research_prompts` (each `{id, topic, question, query,
  status:"suggested", selected:true}`) and returns them. It **does not run**
  any of them — that's `run-research`. Prompt inlined as `RESEARCH_GUIDE`;
  `prompts/research-guide.md` is the editable source.
- **`supabase/functions/run-research/index.ts`** — runs the drafted research
  prompts. Verifies the caller's JWT, reads the `companies` row, and makes
  ONE Claude call with the server-side **web_search** tool
  (`ANTHROPIC_RESEARCH_RUN_MODEL` || `claude-sonnet-5`; `web_search_20260209`
  for Sonnet 4.6+/Opus 4.6+ models, basic `web_search_20250305` otherwise;
  `max_uses` 5; `pause_turn` continuation loop). Marks the targeted prompts
  `status:"running"`, then writes each back with `status:"done"`, `answer`,
  `sources[]`, `ran_at`, and a synthesis onto `companies.research_notes`. On
  failure it rolls the prompts back off `running`. Costs real API credits +
  web-search usage — the client only calls it on an explicit click (with a
  `confirm()`). Prompt inlined as `RUN_GUIDE`; `prompts/run-guide.md` is the
  editable source.
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
  - `0005_quality_gate.sql` — `quality_score` / `quality_attempts` /
    `quality_feedback` on `companies`, plus the `email_revisions` audit
    table, for the writer→judge loop.
  - `0006_contact_research.sql` — `source_profile` (jsonb), `channel`
    (`email`|`linkedin`, default `email`), `generated_linkedin`,
    `research_prompts` (jsonb), `research_notes` on `companies` for the
    LinkedIn-capture + staged-research feature (Stage 1).
  - `0007_cv_text.sql` — `cv_text` (text) on `cv_files`; the CV's plain text,
    extracted once client-side (pdf.js / mammoth) at upload, fed to
    `generate-draft`.

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

- **Voice-tuned prompts (2026-08-29, `generate-draft` v11).**
  `prompts/writing-guide.md` + `prompts/rubric.md` were rewritten to match
  the primary user's real sent-email voice (reverse-engineered via ChatGPT
  + Gmail; source kept in `reference/voice-analysis.md`,
  `reference/sample-emails.md`). Rubric now grades *voice match* (30 pts)
  rather than a generic "impressive email". `reference/writing-skills/` holds
  vendored guidance from `Varnan-Tech/opendirectory` used to tighten them.
  Both `.md` files are still inlined into `index.ts` (see gotcha below).

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
  - **Gotcha (fixed 2026-08-29):** the quality-gate version originally read
    its prompts with `Deno.readTextFile("./prompts/*.md")` at module load.
    The Supabase **deploy path used here (MCP `deploy_edge_function` /
    Management API) does not bundle non-code asset files** — only `.ts`/`.js`
    ship — so every `generate-draft` boot threw
    `NotFound: .../prompts/writing-guide.md` and the worker died before
    responding. The client's `sb.functions.invoke` swallowed it silently and
    the row just stayed `pending` ("clicking Create draft does nothing").
    Fix: the prompt text is now **inlined as string constants in
    `index.ts`** (v10); `prompts/writing-guide.md` + `prompts/rubric.md`
    stay in the repo as the editable source — re-inline by hand (or with a
    script) if you edit them. If a real `supabase` CLI is ever used to
    deploy, the `readTextFile` approach would work and could be restored.

- **Quick Add / browser extension.** Adds companies from a captured web page
  instead of hand-typing, and (Stage 1) captures full LinkedIn profiles for
  richer drafting. Built in stages:
  1. **Basic quick add — done (2026-08-30).** `extract-contact` +
     `?quickadd=1` handshake + "Quick add from text" paste panel.
  2. **LinkedIn capture — done (2026-08-30).** `kind:"linkedin"` path +
     `source_profile` blob + migration `0006`. Below.
  3. **Research prompts (drafted, not run) — done (2026-08-30).**
     `suggest-research` proposes 3–6 questions about the person's company +
     recent work, stored in `research_prompts` (`status:"suggested"`).
     Auto-called after a LinkedIn quick-add; the `#researchPanel` in the
     Companies card lists them with checkboxes (persisted per row) and a
     "Suggest research" / "Regenerate" button. The "Run selected" button is
     present but disabled until Stage 4. Nothing runs.
  4. **Run research on demand — done (2026-08-30).** `run-research` executes
     the selected prompts with Claude's web-search tool and stores per-prompt
     `answer`/`sources` + a `research_notes` synthesis. The `#researchPanel`
     "Run selected (N)" button (with a `confirm()`) triggers it; per-prompt
     status shows suggested → running → done with answers + source links, and
     the notes render below. Gated, costs money, user-triggered only.
  5. **Channel-aware drafting — done (2026-08-30).** `generate-draft` takes
     a `channel` (`email` | `linkedin`, also read from `company.channel`),
     folds `source_profile` + `research_notes` into the writer prompt, and in
     `linkedin` mode writes a short no-subject DM to `generated_linkedin`
     scored against `LINKEDIN_RUBRIC`. Frontend: a per-row `✉` / `in` channel
     toggle; a LinkedIn row shows **Write message** then **Copy message**
     (clipboard) instead of Create draft, the preview drops the subject line,
     and bulk "Create drafts" / `create-draft` skip LinkedIn rows. Email path
     unchanged (still a Gmail draft), now research-enriched.

- **Anti-invention guard — done (2026-08-30, `generate-draft` v13).** The
  writer is never shown the CV (only `create-draft` attaches it, as a file).
  The guides used to say "name concrete tools/projects/employers", so with a
  thin template the model fabricated candidate experience. Both
  `WRITING_GUIDE` / `LINKEDIN_GUIDE` now state the CV contents are not
  visible and that every claim about the candidate must trace to the
  `templates` row or the `instruction` param; both rubrics score an invented
  specific as 0 for its category and require it be named in feedback. `.md`
  sources under `prompts/` updated to match (LinkedIn guide/rubric live only
  in `index.ts`).

- **CV-text drafting — done (2026-08-30, `generate-draft` v14).** `index.html`
  `saveCv()` now extracts the CV's plain text at upload — PDF via pdf.js 4.5
  ESM (`import()` from cdnjs, worker set), `.docx` via mammoth (lazy
  `loadScript`); unsupported / scanned files just store `null` (non-fatal,
  button shows "Reading CV…"). Stored as `cv_files.cv_text` (≤20k), migration
  `0007`. `generate-draft` reads it (≤5k) into the writer's target block, and
  the "only from the template or instruction" rule now includes "…or the CV
  text". Re-extraction only happens on a new upload — not per draft.

  Components:
  - `extract-contact` Edge Function (see Architecture) — `{ text, kind, url }`
    in, base 4 fields out, plus `source_profile` for `kind:"linkedin"`. One
    Claude call, `ANTHROPIC_EXTRACT_MODEL` override (default
    `claude-haiku-4-5`), prompt inlined as `EXTRACT_GUIDE` with
    `prompts/extract-guide.md` as the editable source. No DB writes.
  - `index.html` — `quickAddFromText(input)` (string = manual paste, or
    `{text,kind,url}` = extension capture) calls `extract-contact`, then
    inserts one `pending` row via `addCompany()` (a LinkedIn capture also
    sets `source_profile` + `channel:"linkedin"` on the row). Two entry
    points: the **"Quick add from text"** toolbar button (paste panel, with
    a "This is a LinkedIn profile" checkbox), and, on `?quickadd=1`, a
    `chrome.runtime.sendMessage(QUICKADD_EXTENSION_ID, …)` handshake that
    pulls the stashed capture from the extension. Falls back to the paste
    panel when the extension isn't installed / ID not set.
    `QUICKADD_EXTENSION_ID` near the top of the `<script>` block must be set
    to the ID `chrome://extensions` shows after Load unpacked, then the site
    redeployed.
  - `extension/` — Manifest V3, `activeTab` + `scripting` + `storage`, no
    host permissions. Popup reads `document.body.innerText` (preferring
    `<main>`), tags it `kind:"linkedin"` for `linkedin.com/in/…` URLs,
    stashes `{kind,url,title,text}` in `chrome.storage.session`, opens
    `LETTERHEAD_URL/?quickadd=1`. Background worker hands that payload to the
    Letterhead tab via origin-checked `onMessageExternal` once, then clears
    it. `externally_connectable` matches the deployed Worker URL. Holds no
    credentials; never calls Supabase or Google. See `extension/README.md`.

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
