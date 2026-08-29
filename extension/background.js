// Keep in sync with popup.js. The web app is only allowed to pull the stashed
// text if its origin matches this exactly (and manifest.json's
// externally_connectable match).
const LETTERHEAD_URL = "https://letterhead-repo.koolkasig19.workers.dev";
const SLOT = "quickAddText";

// From the popup: stash the page text (single slot, in-memory only —
// chrome.storage.session clears when the browser restarts and is never synced).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "stashQuickAdd") {
    chrome.storage.session
      .set({ [SLOT]: String(msg.text || "") })
      .then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});

// From the Letterhead tab: hand over the stashed text once, then clear it.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "pullQuickAdd") return;
  if (!sender || !sender.url || sender.url.indexOf(LETTERHEAD_URL) !== 0) {
    sendResponse({ text: "" });
    return;
  }
  chrome.storage.session.get(SLOT).then((data) => {
    const text = (data && data[SLOT]) || "";
    chrome.storage.session.remove(SLOT).finally(() => sendResponse({ text }));
  });
  return true; // async response
});
