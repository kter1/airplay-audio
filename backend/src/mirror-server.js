import crypto from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { ensureJsonRequest, isLoopbackAddress, validateReceiverIp } from "./validation.js";
import { MirrorEngine, requirements, validPin } from "./mirror-engine.js";

const app = Fastify({ logger: true, bodyLimit: 4096 });
await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
let current = null;
let stopping = false;

async function stop(reason) {
  const previous = current;
  if (!previous || stopping) return;
  stopping = true;
  current = null;
  clearInterval(previous.timer);
  previous.socket?.close(1000, reason.slice(0, 100));
  await previous.engine.stop();
  stopping = false;
}

function localOnly(request, reply) {
  if (isLoopbackAddress(request.ip)) return true;
  reply.code(403).send({ error: "local_only" });
  return false;
}

app.get("/health", async () => ({ status: "ok", requirements: requirements() }));
app.get("/mirror/status", async () => ({
  active: Boolean(current),
  ...(current ? current.engine.snapshot() : { status: "idle" })
}));

app.post("/mirror/start", async (request, reply) => {
  if (!localOnly(request, reply)) return;
  if (!ensureJsonRequest(request.headers["content-type"])) {
    return reply.code(415).send({ error: "json_required" });
  }
  if (current || stopping) return reply.code(409).send({ error: "session_already_active" });
  const validation = validateReceiverIp(request.body?.receiverIp);
  if (!validation.valid) return reply.code(400).send({ error: "invalid_receiver", message: validation.reason });
  const pairingCode = request.body?.pairingCode ?? "";
  if (!validPin(pairingCode)) return reply.code(400).send({ error: "invalid_pairing_code" });
  const check = requirements();
  if (!check.ready) {
    return reply.code(503).send({ error: "dependencies_missing", message: check.missing.join(", ") });
  }
  const sessionId = crypto.randomBytes(12).toString("hex");
  const sessionToken = crypto.randomBytes(24).toString("hex");
  const engine = new MirrorEngine({
    receiverIp: validation.normalized,
    pairingCode,
    onFailure: (reason) => {
      app.log.warn({ reason }, "mirror process failed");
      if (current?.id === sessionId) void stop(reason);
    }
  });
  try {
    await engine.start();
  } catch (error) {
    return reply.code(502).send({ error: "sender_start_failed", message: error.message });
  }
  const session = {
    id: sessionId, token: sessionToken, engine, socket: null,
    lastMediaAt: Date.now(), mediaStarted: false, timer: null
  };
  current = session;
  session.timer = setInterval(() => {
    if (current?.id !== sessionId) return;
    const limit = session.mediaStarted ? 20000 : 90000;
    if (Date.now() - session.lastMediaAt > limit) void stop("media-timeout");
  }, 2000);
  session.timer.unref?.();
  return reply.send({ sessionId, sessionToken, status: engine.status });
});

app.post("/mirror/stop", async (request, reply) => {
  if (!localOnly(request, reply)) return;
  if (!current || request.body?.sessionId !== current.id ||
      request.body?.sessionToken !== current.token) {
    return reply.code(403).send({ error: "invalid_session" });
  }
  await stop("user-requested");
  return { stopped: true };
});

app.get("/mirror/stream", { websocket: true }, (socket, request) => {
  if (!isLoopbackAddress(request.ip) || !current || current.socket) {
    socket.close(1008, "Session unavailable");
    return;
  }
  const session = current;
  let authenticated = false;
  let frameCount = 0;
  const authorizationTimer = setTimeout(() => {
    if (!authenticated) socket.close(1008, "Authentication timeout");
  }, 5000);
  authorizationTimer.unref?.();
  socket.on("message", (message, isBinary) => {
    if (current?.id !== session.id) return socket.close(1008, "Session expired");
    if (!authenticated) {
      if (isBinary || message.length > 1024) return socket.close(1008, "Expected authentication");
      let payload;
      try { payload = JSON.parse(message.toString()); } catch { return socket.close(1008, "Bad authentication"); }
      if (payload.sessionId !== session.id || payload.sessionToken !== session.token) {
        return socket.close(1008, "Bad credentials");
      }
      authenticated = true;
      clearTimeout(authorizationTimer);
      session.socket = socket;
      socket.send(JSON.stringify({ type: "ready" }));
      return;
    }
    if (!isBinary) return socket.close(1003, "Binary media only");
    session.lastMediaAt = Date.now();
    session.mediaStarted = true;
    frameCount++;
    const accepted = session.engine.write(message);
    if (!accepted) {
      // Pausing the TCP stream prevents unbounded queues during decoder stalls.
      socket.pause();
      session.engine.player?.stdin.once("drain", () => socket.resume());
      if (session.engine.player?.stdin.destroyed) socket.close(1011, "Decoder unavailable");
    }
  });
  socket.on("close", () => {
    clearTimeout(authorizationTimer);
    if (current?.id === session.id && session.socket === socket) void stop("stream-disconnected");
  });
  socket.on("error", (error) => app.log.warn({ message: error.message }, "stream socket error"));
});

app.addHook("onClose", async () => { await stop("server-shutdown"); });
await app.listen({ host: config.backendHost, port: config.backendPort });
