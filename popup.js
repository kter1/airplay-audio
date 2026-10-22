const BACKEND_URL = "http://127.0.0.1:8090";
const $ = (name) => document.getElementById(name);
function status(message) { $("status").textContent = message; }
async function api(path, options) {
  const response = await fetch(BACKEND_URL + path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || data.error || String(response.status));
  return data;
}
async function refresh() {
  try {
    const [health, state] = await Promise.all([api("/health"), api("/mirror/status")]);
    status((state.active ? state.status + "\nBytes: " + state.inputBytes : "Ready to configure") +
      (health.requirements.ready ? "" : "\nMissing Linux dependencies:\n" + health.requirements.missing.join(", ")));
  } catch (error) { status("Start the Linux service:\n" + error.message); }
}
$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  try {
    const receiverIp = $("receiver").value.trim();
    const pairingCode = $("pin").value.trim();
    await chrome.storage.local.set({ receiverIp });
    // This chooser is invoked directly from the popup button's user gesture.
    const streamId = await new Promise((resolve, reject) => {
      chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab", "audio"], (id) => {
        if (!id) return reject(new Error(chrome.runtime.lastError?.message || "Screen selection canceled"));
        resolve(id);
      });
    });
    const result = await chrome.runtime.sendMessage({
      target:"worker",action:"start",streamId,receiverIp,pairingCode
    });
    if (result?.error) throw new Error(result.error);
    status("Capture running; receiver negotiation NOT verified.\n" +
      "You may close this popup.\n" + (result?.audioCaptured ? "Audio captured" : "No audio track available"));
  } catch (error) { status("Could not start: " + error.message); }
  finally { $("start").disabled = false; }
});
$("stop").addEventListener("click", async () => {
  try {
    const result = await chrome.runtime.sendMessage({ target:"worker",action:"stop" });
    if (result?.error) throw new Error(result.error);
    status("Stopped");
  } catch (error) { status("Stop failed: " + error.message); }
});
chrome.storage.local.get(["receiverIp"]).then((r) => { $("receiver").value = r.receiverIp || ""; });
void refresh();
