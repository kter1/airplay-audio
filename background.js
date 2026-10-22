const OFFSCREEN_URL = "offscreen.html";
let creatingOffscreen = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA", "BLOBS"],
      justification: "Keep desktop audio and video capture alive after the popup closes."
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "worker") return false;
  (async () => {
    if (message.action === "start") {
      await ensureOffscreen();
      return await chrome.runtime.sendMessage({ target: "offscreen", ...message });
    }
    if (message.action === "stop") {
      await ensureOffscreen();
      return await chrome.runtime.sendMessage({ target: "offscreen", action: "stop" });
    }
    return { error: "Unknown action" };
  })().then(sendResponse).catch((error) => sendResponse({ error: error.message }));
  return true;
});
