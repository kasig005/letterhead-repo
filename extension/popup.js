// The one value to confirm: your deployed Letterhead URL. This is a
// *.workers.dev Worker serving static assets, NOT a Cloudflare Pages site.
// Keep it in sync with background.js and with manifest.json's
// externally_connectable match.
const LETTERHEAD_URL = "https://letterhead-repo.koolkasig19.workers.dev";

const btn = document.getElementById("grab");
const statusEl = document.getElementById("status");
const kindEl = document.getElementById("kind");

function detectKind(url) {
  return /^https:\/\/([a-z-]+\.)?linkedin\.com\/in\//i.test(url || "") ? "linkedin" : "page";
}

// Show what kind of page we're on as soon as the popup opens.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    kindEl.textContent =
      detectKind(tab && tab.url) === "linkedin" ? "LinkedIn profile detected" : "Web page";
  } catch {
    /* leave blank */
  }
})();

btn.addEventListener("click", async () => {
  btn.disabled = true;
  statusEl.textContent = "Reading page…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error("No active tab to read.");
    const kind = detectKind(tab.url);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Prefer <main> — on LinkedIn and most job boards it drops the nav,
      // sidebars and footer. Fall back to the whole body.
      func: () => {
        const main = document.querySelector("main");
        return ((main && main.innerText) || document.body.innerText || "");
      },
    });
    const text = String(result || "").replace(/\n{3,}/g, "\n\n").slice(0, 20000);
    if (!text.trim()) throw new Error("This page has no readable text.");

    const payload = {
      kind,
      url: (tab.url || "").split("?")[0],
      title: tab.title || "",
      text,
    };
    await chrome.runtime.sendMessage({ type: "stashQuickAdd", payload });
    await chrome.tabs.create({ url: LETTERHEAD_URL + "/?quickadd=1" });
    window.close();
  } catch (err) {
    statusEl.textContent = err && err.message ? err.message : "Couldn't read this page.";
    btn.disabled = false;
  }
});
