const receiverIpInput = document.getElementById("receiverIp");
const statusDiv = document.getElementById("status");

const BACKEND_URL = "http://127.0.0.1:8090";
let activeSession = null;
let activeSocket = null;
let activeMediaRecorder = null;
let activeAudioStream = null;

function setStatus(message) {
  statusDiv.textContent = `Status: ${message}`;
}

function parseIpv4(ip) {
  const segments = ip.split(".");
  if (segments.length !== 4) {
    return null;
  }
  const octets = [];
  for (const segment of segments) {
    if (!/^\d{1,3}$/.test(segment)) {
      return null;
    }
    if (segment.length > 1 && segment.startsWith("0")) {
      return null;
    }
    const value = Number(segment);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      return null;
    }
    octets.push(value);
  }
  return octets;
}

function isPrivateIp(octets) {
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function validateReceiverIp(rawIp) {
  const candidate = rawIp.trim();
  const octets = parseIpv4(candidate);
  if (!octets) {
    return { valid: false, message: "enter a valid IPv4 address" };
  }
  if (!isPrivateIp(octets)) {
    return { valid: false, message: "receiver IP must be in RFC1918 private LAN range" };
  }
  return { valid: true, normalized: octets.join(".") };
}

function captureTabAudio() {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!stream) {
        reject(new Error("tab capture returned no stream"));
        return;
      }
      resolve(stream);
    });
  });
}

async function requestSessionStart(receiverIp) {
  const response = await fetch(`${BACKEND_URL}/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ receiverIp })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.message ?? "failed to start backend session");
  }
  return payload;
}

async function requestSessionStop(session) {
  if (!session) {
    return;
  }

  const response = await fetch(`${BACKEND_URL}/session/stop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: session.sessionId,
      sessionToken: session.sessionToken
    }),
    keepalive: true
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message ?? "stop request failed");
  }
}

function stopLocalCapture() {
  if (activeMediaRecorder && activeMediaRecorder.state !== "inactive") {
    activeMediaRecorder.stop();
  }
  if (activeSocket && activeSocket.readyState <= WebSocket.OPEN) {
    activeSocket.close();
  }
  if (activeAudioStream) {
    for (const track of activeAudioStream.getTracks()) {
      track.stop();
    }
  }
  activeMediaRecorder = null;
  activeSocket = null;
  activeAudioStream = null;
}

function createMediaRecorder(stream) {
  const preferredType = "audio/webm;codecs=opus";
  if (MediaRecorder.isTypeSupported(preferredType)) {
    return new MediaRecorder(stream, { mimeType: preferredType });
  }
  return new MediaRecorder(stream);
}

async function beginAudioStreaming(sessionInfo) {
  const audioStream = await captureTabAudio();
  const wsUrl = new URL("/stream/audio", BACKEND_URL);
  wsUrl.protocol = "ws:";
  wsUrl.searchParams.set("sessionId", sessionInfo.sessionId);
  wsUrl.searchParams.set("sessionToken", sessionInfo.sessionToken);

  const socket = new WebSocket(wsUrl.toString());
  socket.binaryType = "arraybuffer";

  await new Promise((resolve, reject) => {
    const openHandler = () => {
      socket.removeEventListener("error", errorHandler);
      resolve();
    };
    const errorHandler = () => {
      socket.removeEventListener("open", openHandler);
      reject(new Error("websocket connection to local backend failed"));
    };
    socket.addEventListener("open", openHandler, { once: true });
    socket.addEventListener("error", errorHandler, { once: true });
  });

  const recorder = createMediaRecorder(audioStream);
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0 || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    event.data.arrayBuffer().then((buffer) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(buffer);
      }
    });
  });
  recorder.addEventListener("error", () => {
    setStatus("media recorder error");
  });
  recorder.start(750);

  activeAudioStream = audioStream;
  activeSocket = socket;
  activeMediaRecorder = recorder;
}

async function startFlow() {
  if (activeSession) {
    setStatus("session already active");
    return;
  }

  const validation = validateReceiverIp(receiverIpInput.value);
  if (!validation.valid) {
    setStatus(`error: ${validation.message}`);
    return;
  }

  let startedSession = null;
  setStatus("starting backend session");
  try {
    const sessionInfo = await requestSessionStart(validation.normalized);
    startedSession = sessionInfo;
    await beginAudioStreaming(sessionInfo);
    activeSession = sessionInfo;
    setStatus(`streaming to ${validation.normalized} (${sessionInfo.playback.selectedStrategy ?? "fallback"})`);
  } catch (error) {
    stopLocalCapture();
    setStatus(`error: ${String(error.message ?? error)}`);
    if (startedSession) {
      await requestSessionStop(startedSession).catch(() => {});
    }
    activeSession = null;
  }
}

async function stopFlow() {
  if (!activeSession) {
    setStatus("no active session");
    return;
  }
  setStatus("stopping session");
  const currentSession = activeSession;
  activeSession = null;
  stopLocalCapture();
  try {
    await requestSessionStop(currentSession);
    setStatus("session stopped");
  } catch (error) {
    setStatus(`warning: backend stop request failed (${String(error.message ?? error)})`);
  }
}

document.getElementById("startStream").addEventListener("click", () => {
  void startFlow();
});

document.getElementById("stopStream").addEventListener("click", () => {
  void stopFlow();
});

document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["receiverIp"], (result) => {
    if (result.receiverIp) {
      receiverIpInput.value = result.receiverIp;
    }
  });
});

receiverIpInput.addEventListener("change", () => {
  chrome.storage.local.set({ receiverIp: receiverIpInput.value.trim() });
});

window.addEventListener("beforeunload", () => {
  if (activeSession) {
    const session = activeSession;
    activeSession = null;
    stopLocalCapture();
    void requestSessionStop(session).catch(() => {});
  }
});
