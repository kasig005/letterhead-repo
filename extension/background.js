// Keep in sync with popup.js. The web app is only allowed to pull the stashed
// payload if its origin matches this exactly (and manifest.json's
// externally_connectable match).
const LETTERHEAD_URL = "https://letterhead-repo.koolkasig19.workers.dev";
const SLOT = "quickAddPayload";

// From the popup: stash the captured page payload { kind, url, title, text }.
// Single slot, in-memory only — chrome.storage.session clears on browser
// restart and is never synced.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "stashQuickAdd") {
    const payload = msg.payload || { kind: "page", text: String(msg.text || "") };
    chrome.storage.session.set({ [SLOT]: payload }).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});

// From the Letterhead tab: hand over the stashed payload once, then clear it.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "pullQuickAdd") return;
  if (!sender || !sender.url || sender.url.indexOf(LETTERHEAD_URL) !== 0) {
    sendResponse({ payload: null });
    return;
  }
  chrome.storage.session.get(SLOT).then((data) => {
    const payload = (data && data[SLOT]) || null;
    chrome.storage.session.remove(SLOT).finally(() => sendResponse({ payload }));
  });
  return true; // async response
});
