# Letterhead Quick Add (Chrome extension)

A tiny Manifest V3 extension: on any web page, click **Grab this page** and it
opens Letterhead with a new *pending* company row, pre-filled with the company,
role, and contact it could read from that page. Nothing is sent — you review and
create the draft in Letterhead as normal.

## Install (Load unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Chrome shows the extension with an **ID** (a long string of letters).
   **Copy it.**
5. In `index.html`, set `QUICKADD_EXTENSION_ID` (near the top of the `<script>`
   block) to that ID and redeploy the site. Until you do, the extension still
   works but the Letterhead tab falls back to asking you to paste the page text.

The extension ID stays the same as long as this folder isn't moved or renamed.

## Before it works end to end

- Confirm `LETTERHEAD_URL` in **`popup.js`** and **`background.js`**, and the
  `externally_connectable` match in **`manifest.json`**, all point at the real
  deployed app: `https://letterhead-repo.koolkasig19.workers.dev` (a
  `*.workers.dev` Worker serving static assets — not a Cloudflare Pages URL).
- The Letterhead tab must be signed in; the extraction call runs as that
  signed-in user.
- The backend needs the `extract-contact` Edge Function deployed and
  `ANTHROPIC_API_KEY` set (same secret `generate-draft` uses). Optional:
  `ANTHROPIC_EXTRACT_MODEL` to override the model (defaults to
  `claude-haiku-4-5`).

## Trust model

The extension reads the text of a page **only** when you click *Grab this page*
on it (`activeTab` + `scripting`, no host permissions, no content scripts). It
stashes that text in `chrome.storage.session` (in-memory, this browser only,
never synced) and hands it once to the already-signed-in Letterhead tab, which
then calls Supabase itself. The extension holds no credentials and never talks
to Supabase, Google, or Anthropic directly.
