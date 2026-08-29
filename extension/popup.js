// The one value to confirm: your deployed Letterhead URL. This is a
// *.workers.dev Worker serving static assets, NOT a Cloudflare Pages site.
// Keep it in sync with background.js and with manifest.json's
// externally_connectable match.
const LETTERHEAD_URL = "https://letterhead-repo.koolkasig19.workers.dev";

const btn = document.getElementById("grab");
const statusEl = document.getElementById("status");

btn.addEventListener("click", async () => {
  btn.disabled = true;
  statusEl.textContent = "Reading page…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab to read.");

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText,
    });
    const text = String(result || "").slice(0, 20000);
    if (!text.trim()) throw new Error("This page has no readable text.");

    await chrome.runtime.sendMessage({ type: "stashQuickAdd", text });
    await chrome.tabs.create({ url: LETTERHEAD_URL + "/?quickadd=1" });
    window.close();
  } catch (err) {
    statusEl.textContent = err && err.message ? err.message : "Couldn't read this page.";
    btn.disabled = false;
  }
});
