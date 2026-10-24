# Chromebook to Apple TV — experimental full-screen mirroring

**Tested receiver path:** Doubletake v0.5.0 was successfully used from Chromebook Linux to show its synthetic video pattern with audible audio on an Apple TV A1469 (AppleTV3,2) on October 23, 2026. **The ChromeOS extension-to-receiver path is still unverified.**

## Design

A persistent visible Chrome extension tab (capture.html) runs the desktop capture chooser and getUserMedia **in the same extension context**, then streams MediaRecorder WebM to the local Node bridge over an authenticated WebSocket. The backend decodes with ffplay to an isolated Xvfb display and PulseAudio null sink; Doubletake captures the virtual Linux display and sink and attempts AirPlay H.264/audio mirroring.

Use a visible extension tab instead of an MV3 offscreen document: Chrome's desktopCapture chooser stream IDs are not reliably consumable from offscreen pages. Keep the casting tab open; you can switch to other windows and tabs while streaming.

## Prerequisites (Chromebook Linux/Crostini)

- Node.js >=22
- Doubletake (binary named `doubletake` must be in PATH)
- ffplay/ffmpeg, Xvfb, pulseaudio-utils, GStreamer x11 and encoders
- Apple TV on the same trusted home LAN

Example Debian dependencies:

```bash
sudo apt update
sudo apt install -y ffmpeg xvfb pulseaudio-utils gstreamer1.0-tools gstreamer1.0-x \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

Install Doubletake from https://github.com/omarroth/doubletake and confirm with `doubletake -h`. If using a home directory install, export `PATH="$HOME/.local/bin:$PATH"` before starting the Node backend.

## Run from ChromeOS Linux terminal

```bash
git clone --branch codex/chromeos-full-airplay-cast https://github.com/kter1/airplay-audio.git ~/apps/airplay-audio
cd ~/apps/airplay-audio
export PATH="$HOME/.local/bin:$PATH"
node --version       # must be v22+
npm ci --prefix backend
npm run backend:start
```

Do not close the backend terminal. In another terminal run `curl http://127.0.0.1:8090/health` to inspect missing requirements.

In ChromeOS Chrome, open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select the project folder from ChromeOS Files (e.g. copy it to Downloads or enable Linux files access). Click the extension icon, **Open casting controls**. In the new tab supply the Apple TV private IPv4 address, click **Choose screen & cast**, select **Entire screen**, tick **Share audio** if offered, and confirm.

**Keep the casting controls tab open**, but switch to another tab or application to mirror it. Click Stop or end Chrome screen sharing to end the stream.

## Hardware diagnostics

Synthetic direct-to-receiver test:

```bash
doubletake -target YOUR_APPLE_TV_IP -test -fps 24 -video-codec h264 -hwaccel none
```

A successful synthetic test proves AirPlay video/audio from Linux but not native ChromeOS capture. The UI status only proves capture or bytes received, **not** verified Apple TV display.

```bash
curl -s http://127.0.0.1:8090/health
curl -s http://127.0.0.1:8090/mirror/status
npm run backend:test
npm run ci:verify
```

## Limitations

This **does not yet establish** full Chromebook screen mirroring. ChromeOS may not expose system audio for all surfaces. The double decode/re-encode bridge is CPU-intensive for a 4 GB Chromebook, and pairing, sync, and FPS still require live testing. Keep the extension control tab open. The Node backend stays bound to loopback and accepts only a single stream. Protected content might not be capturable. Use on a trusted machine/network only.

Older audio-only HLS code remains in `backend/src/server.js` for reference. The historical dependency lockfile may fail `npm audit`; remediate vulnerabilities before treating the prototype as production-ready.

## Low-latency experiment (after confirming live A/V)

As of the low-buffering patch, the bridge starts ffplay with reduced demux/probe buffering, external-clock sync, and frame dropping. This attempts to reduce the multi-second default playback lag. It **cannot eliminate** the intrinsic extra encode/decode stage or older Apple TV AirPlay buffering.

A/B test the same screen motion with both profiles:

```bash
# Default: low latency
npm run backend:start

# If audio glitches, frames fail, or latency gets worse, stop the server and run:
AIRPLAY_LOW_LATENCY=0 npm run backend:start
```

Stop casting before restarting the backend. Restart an active cast after changing profile. Report measured seconds of delay, picture smoothness, and audio clarity for each profile. Benchmark the display by opening a clock with seconds on the Chromebook and photographing both screens; test 30+ seconds into the session to distinguish startup delay from accumulating buffering.
