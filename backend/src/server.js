import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";

import Fastify from "fastify";
import websocket from "@fastify/websocket";

import { config } from "./config.js";
import { createSessionDirectory, removeSessionDirectory, startFfmpegPipeline } from "./ffmpeg.js";
import { initiatePlayback } from "./playback-adapter.js";
import {
  ensureJsonRequest,
  isLoopbackAddress,
  validateReceiverIp,
  validateSessionId,
  validateSessionToken
} from "./validation.js";

const fastify = Fastify({
  logger: true,
  bodyLimit: config.bodyLimitBytes,
  requestTimeout: config.requestTimeoutMs,
  connectionTimeout: config.connectionTimeoutMs
});

await fastify.register(websocket, {
  options: {
    maxPayload: config.maxWsMessageBytes
  }
});

let activeSession = null;

function hlsContentType(fileName) {
  if (fileName.endsWith(".m3u8")) {
    return "application/vnd.apple.mpegurl";
  }
  return "video/mp2t";
}

function parseWsQuery(rawUrl) {
  const parsed = new URL(rawUrl ?? "/", `http://${config.backendHost}:${config.backendPort}`);
  return {
    sessionId: parsed.searchParams.get("sessionId"),
    sessionToken: parsed.searchParams.get("sessionToken")
  };
}

function loopbackOnly(request, reply) {
  if (isLoopbackAddress(request.ip)) {
    return true;
  }
  reply.code(403).send({
    error: "forbidden",
    message: "Control plane is loopback-only"
  });
  return false;
}

function clearSessionTimers(session) {
  clearTimeout(session.maxDurationTimer);
  clearInterval(session.idleTimer);
}

async function teardownSession(reason) {
  if (!activeSession) {
    return;
  }

  const session = activeSession;
  activeSession = null;
  clearSessionTimers(session);
  await session.pipeline.stop(reason);
  await removeSessionDirectory(config.runtimeRoot, session.id);
  fastify.log.info({ event: "session-ended", sessionId: session.id, reason }, "session ended");
}

async function readHlsFile(session, fileName) {
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    return null;
  }
  if (!fileName.endsWith(".m3u8") && !fileName.endsWith(".ts")) {
    return null;
  }

  const absolutePath = path.resolve(session.sessionDir, fileName);
  const resolvedSessionDir = path.resolve(session.sessionDir);
  if (
    absolutePath !== resolvedSessionDir &&
    !absolutePath.startsWith(`${resolvedSessionDir}${path.sep}`)
  ) {
    return null;
  }

  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      return null;
    }
    return absolutePath;
  } catch {
    return null;
  }
}

fastify.get("/health", async () => ({
  status: "ok",
  localOnly: true,
  ffmpegAvailable: Boolean(config.ffmpegPath),
  activeSession: activeSession
    ? {
        sessionId: activeSession.id,
        receiverIp: activeSession.receiverIp,
        startedAt: activeSession.createdAt
      }
    : null
}));

fastify.post("/session/start", async (request, reply) => {
  if (!loopbackOnly(request, reply)) {
    return;
  }

  if (!ensureJsonRequest(request.headers["content-type"])) {
    reply.code(415).send({
      error: "unsupported_media_type",
      message: "application/json content-type is required"
    });
    return;
  }

  if (!config.ffmpegPath) {
    reply.code(503).send({
      error: "ffmpeg_missing",
      message: "ffmpeg not found at approved local paths; install ffmpeg to start streaming"
    });
    return;
  }

  const validation = validateReceiverIp(request.body?.receiverIp);
  if (!validation.valid) {
    reply.code(400).send({ error: "invalid_receiver_ip", message: validation.reason });
    return;
  }

  if (activeSession) {
    await teardownSession("replaced-by-new-session");
  }

  const sessionId = crypto.randomBytes(12).toString("hex");
  const sessionToken = crypto.randomBytes(24).toString("hex");
  const sessionDir = await createSessionDirectory(config.runtimeRoot, sessionId);
  const pipeline = startFfmpegPipeline({
    ffmpegPath: config.ffmpegPath,
    sessionDir,
    logger: fastify.log
  });
  const createdAt = new Date().toISOString();
  const hlsPath = `/hls/${sessionId}/live.m3u8`;
  const hlsUrl = `http://${config.backendHost}:${config.backendPort}${hlsPath}`;

  const session = {
    id: sessionId,
    token: sessionToken,
    receiverIp: validation.normalized,
    sessionDir,
    createdAt,
    lastChunkAt: Date.now(),
    pipeline,
    maxDurationTimer: null,
    idleTimer: null
  };

  session.maxDurationTimer = setTimeout(() => {
    void teardownSession("max-duration-reached");
  }, config.sessionMaxDurationMs);
  session.maxDurationTimer.unref?.();

  session.idleTimer = setInterval(() => {
    if (!activeSession || activeSession.id !== sessionId) {
      return;
    }
    if (Date.now() - activeSession.lastChunkAt > config.sessionIdleTimeoutMs) {
      void teardownSession("idle-timeout");
    }
  }, 2_000);
  session.idleTimer.unref?.();

  pipeline.child.on("exit", () => {
    if (activeSession?.id === sessionId) {
      void teardownSession("ffmpeg-exited");
    }
  });

  activeSession = session;
  const playback = await initiatePlayback({
    receiverIp: session.receiverIp,
    hlsUrl,
    logger: fastify.log
  });

  reply.send({
    message: "streaming session started",
    sessionId,
    sessionToken,
    hlsPath,
    hlsUrl,
    playback
  });
});

fastify.post("/session/stop", async (request, reply) => {
  if (!loopbackOnly(request, reply)) {
    return;
  }

  if (!ensureJsonRequest(request.headers["content-type"])) {
    reply.code(415).send({
      error: "unsupported_media_type",
      message: "application/json content-type is required"
    });
    return;
  }

  if (!activeSession) {
    reply.code(404).send({ error: "not_found", message: "no active session" });
    return;
  }

  const { sessionId, sessionToken } = request.body ?? {};
  if (!validateSessionId(sessionId) || !validateSessionToken(sessionToken)) {
    reply.code(400).send({ error: "invalid_payload", message: "sessionId and sessionToken are malformed" });
    return;
  }

  if (sessionId !== activeSession.id || sessionToken !== activeSession.token) {
    reply.code(403).send({ error: "forbidden", message: "session credentials are invalid" });
    return;
  }

  await teardownSession("client-stop");
  reply.send({ message: "streaming session stopped" });
});

fastify.get("/hls/live.m3u8", async (_request, reply) => {
  if (!activeSession) {
    reply.code(404).send({ error: "not_found", message: "no active session" });
    return;
  }
  const filePath = await readHlsFile(activeSession, "live.m3u8");
  if (!filePath) {
    reply.code(404).send({ error: "not_found", message: "playlist is not ready yet" });
    return;
  }
  reply.header("cache-control", "no-store");
  reply.type(hlsContentType("live.m3u8")).send(createReadStream(filePath));
});

fastify.get("/hls/:sessionId/:fileName", async (request, reply) => {
  const { sessionId, fileName } = request.params;
  if (!activeSession || sessionId !== activeSession.id) {
    reply.code(404).send({ error: "not_found", message: "session artifacts unavailable" });
    return;
  }
  const filePath = await readHlsFile(activeSession, fileName);
  if (!filePath) {
    reply.code(404).send({ error: "not_found", message: "artifact not found" });
    return;
  }
  reply.header("cache-control", "no-store");
  reply.type(hlsContentType(fileName)).send(createReadStream(filePath));
});

fastify.get("/stream/audio", { websocket: true }, (connection, request) => {
  const ws = connection.socket;
  const { sessionId, sessionToken } = parseWsQuery(request.raw.url);

  if (!isLoopbackAddress(request.ip)) {
    ws.close(1008, "Loopback-only endpoint");
    return;
  }
  if (!activeSession || !validateSessionId(sessionId) || !validateSessionToken(sessionToken)) {
    ws.close(1008, "Invalid session");
    return;
  }
  if (sessionId !== activeSession.id || sessionToken !== activeSession.token) {
    ws.close(1008, "Unauthorized session credentials");
    return;
  }

  ws.on("message", (payload, isBinary) => {
    if (!activeSession || activeSession.id !== sessionId) {
      ws.close(1008, "Session expired");
      return;
    }
    if (!isBinary) {
      ws.close(1003, "Binary audio frames required");
      return;
    }
    const frame = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    if (frame.length > config.maxWsMessageBytes) {
      ws.close(1009, "Frame too large");
      return;
    }

    activeSession.lastChunkAt = Date.now();
    const accepted = activeSession.pipeline.inputWritable.write(frame);
    if (!accepted) {
      fastify.log.warn({ event: "backpressure", sessionId }, "ffmpeg stdin backpressure");
    }
  });
});

fastify.addHook("onClose", async () => {
  await teardownSession("server-shutdown");
});

try {
  await fastify.listen({
    host: config.backendHost,
    port: config.backendPort
  });
} catch (error) {
  fastify.log.error({ error }, "backend startup failed");
  process.exitCode = 1;
}
