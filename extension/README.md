# Letterhead Quick Add (Chrome extension)

A tiny Manifest V3 extension: on any web page, click **Grab this page** and it
opens Letterhead with a new *pending* company row, pre-filled from what it could
read on that page. On a LinkedIn profile (`linkedin.com/in/…`) it captures the
full profile (headline, about, current + past roles, location) so the drafting
step has real context. Nothing is sent — you review and create the draft in
Letterhead as normal.

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
Reloading after an update (the ↻ on the card) keeps the same ID.

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

## What it sends

The popup runs `document.body.innerText` (preferring `<main>`) on the tab you
clicked, trims it to 20k characters, and stashes
`{ kind, url, title, text, intent, email }` in `chrome.storage.session` — `kind`
is `"linkedin"` for `linkedin.com/in/…` URLs, otherwise `"page"`; `intent` is
the optional brief; `email` is an address you typed in (overrides anything the
extractor finds on the page). The Letterhead tab pulls that once via an
origin-checked `onMessageExternal` message and clears it. The extension holds no
credentials and never talks to Supabase, Google, or Anthropic directly.

## Trust / LinkedIn note

The extension only reads a page when you explicitly click *Grab this page* on it
(`activeTab` + `scripting`, no host permissions, no content scripts). Reading a
LinkedIn profile this way is DOM text from a page you already have open in your
own session, not an automated crawl — but LinkedIn's User Agreement discourages
bulk/automated collection, so keep it to profiles you're genuinely reaching out
to.
