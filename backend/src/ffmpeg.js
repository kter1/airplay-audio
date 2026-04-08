import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";

function ensurePathWithinRoot(rootDir, candidatePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (
    resolvedCandidate !== resolvedRoot &&
    !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("Resolved path escapes runtime root");
  }
  return resolvedCandidate;
}

export async function createSessionDirectory(runtimeRoot, sessionId) {
  const sessionDir = ensurePathWithinRoot(runtimeRoot, path.join(runtimeRoot, sessionId));
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  return sessionDir;
}

export async function removeSessionDirectory(runtimeRoot, sessionId) {
  const sessionDir = ensurePathWithinRoot(runtimeRoot, path.join(runtimeRoot, sessionId));
  await fs.rm(sessionDir, { recursive: true, force: true });
}

export function startFfmpegPipeline({ ffmpegPath, sessionDir, logger }) {
  const playlistPath = path.resolve(sessionDir, "live.m3u8");
  const segmentPattern = path.resolve(sessionDir, "segment_%03d.ts");
  const inputWritable = new PassThrough();

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    "-f",
    "webm",
    "-i",
    "pipe:0",
    "-vn",
    "-acodec",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "6",
    "-hls_flags",
    "delete_segments+append_list+omit_endlist",
    "-hls_segment_filename",
    segmentPattern,
    playlistPath
  ];

  const child = spawn(ffmpegPath, args, {
    stdio: ["pipe", "ignore", "pipe"],
    shell: false
  });

  inputWritable.pipe(child.stdin);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    logger.warn({ event: "ffmpeg-stderr", chunk }, "ffmpeg emitted stderr output");
  });

  async function stop(reason) {
    inputWritable.end();
    if (child.exitCode !== null || child.killed) {
      return;
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (child.exitCode === null) {
      logger.warn({ event: "ffmpeg-force-kill", reason }, "forcing ffmpeg shutdown");
      child.kill("SIGKILL");
    }
  }

  return {
    child,
    inputWritable,
    playlistPath,
    stop
  };
}
