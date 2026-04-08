import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";

const parsedPort = Number(process.env.BACKEND_PORT ?? 8090);
if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
  throw new Error("BACKEND_PORT must be an integer between 1 and 65535");
}

const configuredHost = process.env.BACKEND_HOST ?? LOOPBACK_HOST;
if (configuredHost !== LOOPBACK_HOST) {
  throw new Error("BACKEND_HOST must remain 127.0.0.1 for local-only security posture");
}

const parsedBodyLimit = Number(process.env.BODY_LIMIT_BYTES ?? 8 * 1024);
if (!Number.isInteger(parsedBodyLimit) || parsedBodyLimit < 1024 || parsedBodyLimit > 1024 * 1024) {
  throw new Error("BODY_LIMIT_BYTES must be between 1024 and 1048576");
}

const parsedWsLimit = Number(process.env.MAX_WS_MESSAGE_BYTES ?? 512 * 1024);
if (!Number.isInteger(parsedWsLimit) || parsedWsLimit < 1024 || parsedWsLimit > 2 * 1024 * 1024) {
  throw new Error("MAX_WS_MESSAGE_BYTES must be between 1024 and 2097152");
}

const parsedIdleMs = Number(process.env.SESSION_IDLE_TIMEOUT_MS ?? 20_000);
if (!Number.isInteger(parsedIdleMs) || parsedIdleMs < 5_000 || parsedIdleMs > 10 * 60_000) {
  throw new Error("SESSION_IDLE_TIMEOUT_MS must be between 5000 and 600000");
}

const parsedMaxDurationMs = Number(process.env.SESSION_MAX_DURATION_MS ?? 5 * 60_000);
if (!Number.isInteger(parsedMaxDurationMs) || parsedMaxDurationMs < 30_000 || parsedMaxDurationMs > 60 * 60_000) {
  throw new Error("SESSION_MAX_DURATION_MS must be between 30000 and 3600000");
}

const runtimeRoot = path.resolve(os.tmpdir(), "airplay_audio_runtime");

const ffmpegCandidates = [
  process.env.FFMPEG_PATH,
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg"
].filter(Boolean);

export function resolveFfmpegPath() {
  for (const candidate of ffmpegCandidates) {
    const absolutePath = path.resolve(candidate);
    try {
      fs.accessSync(absolutePath, fs.constants.X_OK);
      return absolutePath;
    } catch {
      // Continue searching known-safe absolute paths.
    }
  }
  return null;
}

export const config = {
  backendHost: configuredHost,
  backendPort: parsedPort,
  bodyLimitBytes: parsedBodyLimit,
  maxWsMessageBytes: parsedWsLimit,
  sessionIdleTimeoutMs: parsedIdleMs,
  sessionMaxDurationMs: parsedMaxDurationMs,
  runtimeRoot,
  requestTimeoutMs: 10_000,
  connectionTimeoutMs: 5_000,
  ffmpegPath: resolveFfmpegPath()
};
