const URL_BASE = "http://127.0.0.1:8090";
let state = null;
let transitioning = false;

async function stop() {
  const previous = state;
  state = null;
  if (!previous) return { stopped: true };
  previous.shuttingDown = true;
  try { if (previous.recorder.state !== "inactive") previous.recorder.stop(); } catch {}
  for (const track of previous.stream.getTracks()) track.stop();
  try { previous.socket.close(1000, "Stopped"); } catch {}
  try {
    await fetch(URL_BASE + "/mirror/stop", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({sessionId:previous.sessionId,sessionToken:previous.sessionToken})
    });
  } catch {}
  return { stopped: true };
}

async function start({ streamId, receiverIp, pairingCode }) {
  if (state || transitioning) throw new Error("A casting session is already active");
  transitioning = true;
  let stream = null, session = null, socket = null;
  try {
    const constraints = (withAudio) => ({
      audio: withAudio ? { mandatory: { chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId } } : false,
      video: { mandatory: { chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 24 } }
    });
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(true));
    } catch (error) {
      // Some screen/window selections lack audio. Retrying video-only avoids
      // making basic mirroring depend on ChromeOS system audio support.
      stream = await navigator.mediaDevices.getUserMedia(constraints(false));
    }
    const types = ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp8", "video/webm"];
    const mimeType = types.find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("This Chromium build cannot record WebM desktop video");
    const reply = await fetch(URL_BASE + "/mirror/start", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({ receiverIp, pairingCode })
    });
    session = await reply.json();
    if (!reply.ok) throw new Error(session.message || session.error || "sender initialization failed");
    const ws = new URL("/mirror/stream",URL_BASE);
    ws.protocol = "ws:";
    socket = new WebSocket(ws.toString());
    socket.binaryType = "arraybuffer";
    await new Promise((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket ready timeout")), 5000);
      socket.onopen = () => socket.send(JSON.stringify({
        sessionId:session.sessionId,sessionToken:session.sessionToken
      }));
      socket.onmessage = (event) => {
        try {
          if (JSON.parse(event.data).type === "ready") {
            clearTimeout(timeout);resolve();
          }
        } catch {}
      };
      socket.onerror = () => {clearTimeout(timeout);reject(new Error("WebSocket failed"));};
      socket.onclose = () => {clearTimeout(timeout);reject(new Error("WebSocket closed"));};
    });
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 2300000,
      audioBitsPerSecond: 96000
    });
    state = { stream, socket, recorder, ...session, shuttingDown: false };
    stream.getTracks().forEach((track) => track.addEventListener("ended", () => void stop(), { once:true }));
    recorder.ondataavailable = async (event) => {
      if (!state || state.recorder !== recorder || socket.readyState !== WebSocket.OPEN) return;
      // Bound memory even during temporary encoder/network stalls.
      if (socket.bufferedAmount > 4 * 1024 * 1024) {
        await stop();
        return;
      }
      if (event.data.size) {
        try { socket.send(await event.data.arrayBuffer()); }
        catch { await stop(); }
      }
    };
    socket.onclose = () => { if (state?.socket === socket) void stop(); };
    recorder.onerror = () => void stop();
    recorder.start(200);
    return { started:true, audioCaptured:stream.getAudioTracks().length > 0 };
  } catch (error) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    socket?.close();
    if (session?.sessionId) {
      await fetch(URL_BASE + "/mirror/stop", {
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({sessionId:session.sessionId,sessionToken:session.sessionToken})
      }).catch(() => {});
    }
    throw error;
  } finally { transitioning = false; }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (message?.target !== "offscreen") return false;
  (async () => {
    if (message.action === "start") return await start(message);
    if (message.action === "stop") return await stop();
    throw new Error("Unknown action");
  })().then(respond).catch((error) => respond({ error:error.message }));
  return true;
});
