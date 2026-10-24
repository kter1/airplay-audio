const BASE = "http://127.0.0.1:8090";
const el = (id) => document.getElementById(id);
let running = null;
let starting = false;

function status(message) { el("status").textContent = message; }
function buttons() { el("start").disabled = starting || Boolean(running); el("stop").disabled = !running; }
async function request(path, options) {
  const response = await fetch(BASE + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || result.error || "Backend request failed");
  return result;
}
async function stop() {
  const session = running;
  running = null;
  buttons();
  if (!session) return;
  session.shuttingDown = true;
  try { if (session.recorder.state !== "inactive") session.recorder.stop(); } catch {}
  for (const track of session.stream.getTracks()) track.stop();
  try { session.socket.close(); } catch {}
  try {
    await request("/mirror/stop", { method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({sessionId:session.sessionId,sessionToken:session.sessionToken}) });
  } catch {}
  status("Stopped.");
}
function chooseScreen() {
  return new Promise((resolve,reject) => {
    chrome.desktopCapture.chooseDesktopMedia(["screen","window","tab","audio"], (streamId, options) => {
      if (!streamId) return reject(new Error(chrome.runtime.lastError?.message || "Screen sharing canceled"));
      resolve({streamId, audioAllowed: Boolean(options?.canRequestAudioTrack)});
    });
  });
}
function streamConstraints(streamId, audioAllowed, profile = "standard") {
  const settings = profile === "fast"
    ? { maxWidth: 960, maxHeight: 540, maxFrameRate: 20 }
    : { maxWidth: 1280, maxHeight: 720, maxFrameRate: 24 };
  return {
    audio: audioAllowed ? { mandatory: { chromeMediaSource:"desktop", chromeMediaSourceId:streamId } } : false,
    video: {mandatory:{chromeMediaSource:"desktop",chromeMediaSourceId:streamId,
      ...settings}}
  };
}
function makeRecorder(stream, profile = "standard") {
  const withAudio = stream.getAudioTracks().length > 0;
  const candidates = withAudio
    ? ["video/webm;codecs=vp8,opus","video/webm"]
    : ["video/webm;codecs=vp8","video/webm"];
  const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error("Chrome does not support WebM MediaRecorder");
  return new MediaRecorder(stream, {mimeType,videoBitsPerSecond:profile === "fast" ? 1250000 : 2300000,audioBitsPerSecond:96000});
}
async function connectWebSocket(session) {
  const url = new URL("/mirror/stream",BASE);
  url.protocol = "ws:";
  const socket = new WebSocket(url.toString());
  socket.binaryType = "arraybuffer";
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error("Backend WebSocket timed out")),5000);
    const success = () => {clearTimeout(timer);resolve();};
    const failure = () => {clearTimeout(timer);reject(new Error("Backend WebSocket unavailable"));};
    socket.onopen = () => socket.send(JSON.stringify({sessionId:session.sessionId,sessionToken:session.sessionToken}));
    socket.onmessage = (event) => {
      try { if (JSON.parse(event.data).type === "ready") success(); } catch {}
    };
    socket.onerror = failure;
    socket.onclose = failure;
  }).catch((error) => {socket.close();throw error;});
  return socket;
}
async function start() {
  if (starting || running) return;
  starting = true;
  buttons();
  let stream = null, socket = null, session = null;
  try {
    const profile = el("profile").value;
    const receiverIp = el("receiver").value.trim();
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(receiverIp)) throw new Error("Enter a valid local Apple TV IPv4 address");
    const pairingCode = el("pin").value.trim();
    await chrome.storage.local.set({receiverIp});
    status("Choose the screen or tab to share. Enable audio if offered.");
    const {streamId,audioAllowed} = await chooseScreen();
    // Crucial: use the desktop capture stream ID in the SAME real extension tab
    // that requested it. MV3 offscreen documents cannot reliably consume it.
    stream = await navigator.mediaDevices.getUserMedia(streamConstraints(streamId,audioAllowed,profile));
    if (!stream.getVideoTracks().length) throw new Error("Chrome did not provide desktop video");
    status("Starting Linux bridge and pairing...");
    session = await request("/mirror/start", {method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({receiverIp,pairingCode})});
    socket = await connectWebSocket(session);
    const recorder = makeRecorder(stream,profile);
    running = {...session,stream,socket,recorder,shuttingDown:false};
    buttons();
    for (const track of stream.getTracks()) {
      track.addEventListener("ended",() => { if (running?.stream === stream) void stop(); },{once:true});
    }
    socket.onclose = () => {if (running?.socket === socket) void stop();};
    recorder.onerror = () => {if (running?.recorder === recorder) void stop();};
    // Blob serialization must preserve MediaRecorder chunk ordering.
    let queue = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      queue = queue.then(async () => {
        if (!running || running.recorder !== recorder || socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 4 * 1024 * 1024) throw new Error("Network buffer exceeded 4MB");
        socket.send(await event.data.arrayBuffer());
      }).catch((error) => {
        status("Streaming interrupted: " + error.message);
        void stop();
      });
    };
    recorder.start(200);
    status("Capture started [" + profile + "] (" + (stream.getAudioTracks().length ? "video + audio" : "video only") +
      "). AirPlay output not yet verified.\nLeave this tab open and look at your Apple TV.");
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    try {socket?.close();} catch {}
    if (session) {
      await request("/mirror/stop",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({sessionId:session.sessionId,sessionToken:session.sessionToken})}).catch(()=>{});
    }
    status("Could not cast: " + error.message + "\nIf audio capture failed, try a Chrome tab or choose a screen without audio.");
  } finally {starting = false;buttons();}
}
el("start").addEventListener("click",()=>void start());
el("stop").addEventListener("click",()=>void stop());
chrome.storage.local.get(["receiverIp"]).then((saved) => {el("receiver").value = saved.receiverIp || "";});
request("/health").then((result) => {
  if (!result.requirements?.ready) status("Linux backend reachable, but missing: " + (result.requirements?.missing || []).join(", "));
  else status("Linux backend ready. Enter the Apple TV IP and choose a screen.");
}).catch((error)=>status("Linux bridge is not running: " + error.message));
buttons();
window.addEventListener("beforeunload",()=> {
  if (running) {
    const session = running;
    running = null;
    session.stream.getTracks().forEach((track)=>track.stop());
    session.socket.close();
    navigator.sendBeacon; // No keepalive JSON beacon; backend closes on socket disconnect.
  }
});
