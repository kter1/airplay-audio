import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REQUIRED = ["Xvfb", "ffplay", "pactl", "gst-inspect-1.0", "doubletake"];
const WIDTH = 1280;
const HEIGHT = 720;

export function resolveBinary(name) {
  const result = spawnSync("which", [name], { encoding: "utf8", timeout: 2000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function requirements() {
  const found = Object.fromEntries(REQUIRED.map((name) => [name, resolveBinary(name)]));
  return { ready: Object.values(found).every(Boolean), missing: REQUIRED.filter((name) => !found[name]), found };
}

export function buildSenderArgs(receiverIp, { pairing = false, fps = 24, bitrate = 2300 } = {}) {
  const args = ["-target", receiverIp, "-fps", String(fps), "-bitrate", String(bitrate),
    "-video-codec", "h264", "-hwaccel", "none", "-no-cursor"];
  if (pairing) args.push("-pair");
  return args;
}

export function validPin(value) {
  return value === "" || (typeof value === "string" && /^[0-9A-Za-z]{4,12}$/.test(value));
}

async function waitForSocket(socketPath, child) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Virtual display process exited before startup");
    }
    try {
      await fs.stat(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Virtual display did not become ready");
}

async function allocateDisplay() {
  const offset = crypto.randomInt(0, 30);
  for (let i = 0; i < 30; i++) {
    const number = 110 + ((offset + i) % 30);
    try {
      await fs.stat("/tmp/.X11-unix/X" + number);
    } catch (error) {
      if (error.code === "ENOENT") return { name: ":" + number, socket: "/tmp/.X11-unix/X" + number };
      throw error;
    }
  }
  throw new Error("No available X11 display number in 110–139");
}

function exitProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1200);
    timer.unref?.();
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

export class MirrorEngine {
  constructor({ receiverIp, pairingCode = "", onFailure = () => {} }) {
    this.receiverIp = receiverIp;
    this.pairingCode = pairingCode;
    this.onFailure = onFailure;
    this.status = "starting";
    this.logs = [];
    this.processes = [];
    this.pulseModule = null;
    this.pactl = null;
    this.runtimeDir = null;
    this.closed = false;
    this.videoBytes = 0;
    this.startedAt = Date.now();
  }

  note(source, chunk) {
    const line = String(chunk).slice(-1800);
    this.logs.push(source + ": " + line);
    this.logs = this.logs.slice(-25);
  }

  launch(name, args, env, { input = "ignore" } = {}) {
    const child = spawn(name, args, {
      env,
      shell: false,
      stdio: [input, "pipe", "pipe"]
    });
    this.processes.push(child);
    child.stdout?.on("data", (data) => this.note(path.basename(name), data));
    child.stderr?.on("data", (data) => this.note(path.basename(name), data));
    child.on("error", (error) => {
      this.note("spawn", error.message);
      if (!this.closed) this.onFailure("Could not start " + path.basename(name) + ": " + error.message);
    });
    child.on("exit", (code, signal) => {
      if (!this.closed) {
        this.onFailure(path.basename(name) + " stopped (" + (signal || code) + ")");
      }
    });
    return child;
  }

  async start() {
    const check = requirements();
    if (!check.ready) throw new Error("Missing Linux packages: " + check.missing.join(", "));
    this.pactl = check.found.pactl;
    try {
      this.runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "airplay-mirror-"));
      await fs.chmod(this.runtimeDir, 0o700);
      const display = await allocateDisplay();
      const xenv = { ...process.env, DISPLAY: display.name };
      delete xenv.WAYLAND_DISPLAY;
      delete xenv.XDG_SESSION_TYPE;
      const xvfb = this.launch(check.found.Xvfb,
        [display.name, "-screen", "0", WIDTH + "x" + HEIGHT + "x24", "-nolisten", "tcp"], xenv);
      await waitForSocket(display.socket, xvfb);

      // An isolated PulseAudio null sink avoids stealing the Chromebook's default output.
      // Doubletake discovers audio with "pactl get-default-sink", so intercept only that
      // query in its process environment. All other pactl calls invoke the real binary.
      const sink = "airplaymirror" + crypto.randomBytes(5).toString("hex");
      const { stdout } = await execFileAsync(this.pactl,
        ["load-module", "module-null-sink", "sink_name=" + sink,
          "sink_properties=device.description=AirPlayMirror"]);
      this.pulseModule = Number(stdout.trim());
      if (!Number.isInteger(this.pulseModule)) throw new Error("Could not create isolated audio sink");
      const wrapperDir = path.join(this.runtimeDir, "bin");
      await fs.mkdir(wrapperDir, { mode: 0o700 });
      const wrapper = "#!/bin/sh\nif [ \"$1\" = \"get-default-sink\" ]; then\n  printf '%s\\n' '" +
        sink + "'\nelse\n  exec '" + this.pactl + "' \"$@\"\nfi\n";
      await fs.writeFile(path.join(wrapperDir, "pactl"), wrapper, { mode: 0o700 });
      const senderEnv = { ...xenv, PATH: wrapperDir + ":" + process.env.PATH };
      if (this.pairingCode) senderEnv.DOUBLETAKE_CODE = this.pairingCode;
      const playerEnv = { ...xenv, PULSE_SINK: sink, SDL_AUDIODRIVER: "pulseaudio" };

      // One continuous WebM byte stream; the MediaRecorder initialization data occurs
      // in its first blob. ffplay renders into the private Xvfb display and audio sink.
      this.player = this.launch(check.found.ffplay, ["-loglevel", "error", "-nostats",
        "-noborder", "-fs", "-f", "matroska", "-i", "pipe:0"], playerEnv, { input: "pipe" });
      this.sender = this.launch(check.found.doubletake,
        buildSenderArgs(this.receiverIp, { pairing: Boolean(this.pairingCode) }),
        senderEnv);
      this.status = "sender-started-unverified";
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  write(data) {
    if (this.closed || !this.player || this.player.stdin.destroyed) return false;
    this.videoBytes += data.length;
    this.status = "receiving-media-airplay-unverified";
    return this.player.stdin.write(data);
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.status = "stopped";
    try { this.player?.stdin.end(); } catch {}
    await Promise.allSettled([...this.processes].reverse().map(exitProcess));
    if (this.pulseModule !== null && Number.isInteger(this.pulseModule) && this.pactl) {
      try { await execFileAsync(this.pactl, ["unload-module", String(this.pulseModule)], { timeout: 2500 }); } catch {}
    }
    if (this.runtimeDir) {
      await fs.rm(this.runtimeDir, { recursive: true, force: true });
    }
  }

  snapshot() {
    return {
      status: this.status,
      receiverIp: this.receiverIp,
      inputBytes: this.videoBytes,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      diagnostics: this.logs.slice(-8).map((line) => line.replace(/[^\x20-\x7e\n]/g, " ").slice(0, 500))
    };
  }
}
