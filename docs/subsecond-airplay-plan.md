# Subsecond ChromeOS → Apple TV AirPlay: Implementation Plan

Status: **design only**, not a performance claim. Baseline observed on Apple TV A1469: approximately **6 s** initially, **3 s** after ffplay low-buffer mode; reducing ChromeOS capture to 540p/20 fps did **not** meaningfully change latency. Entire-screen video and audio work in current prototype. Existing path remains fallback.

## Goal and non-goals

- Primary: **action-to-photon video latency <1.0 s at p95**, sustained for ten minutes on the user's 4 GB Chromebook + A1469, with no visible drift or growing buffered backlog. Measure after warm-up under realistic motion.
- Stretch: <0.5 s p95 if receiver is capable. This is **not guaranteed**, particularly on an older Apple TV.
- Audio: intelligible, stable, not staticky; maintain perceptual lip sync to video. First milestone is video-only so audio does not confound latency.
- Quality after latency: 720p/24 fps first; 1080p/30 fps only after timing and thermal/CPU stability pass.
- Preserve local-only networking, explicit user capture selection, no persisted screenshots/recordings, controlled memory, authenticated connection and clean stop/reconnect.
- Do not turn experimental changes on by default or remove the legacy FFplay/Xvfb/Doubletake profile until the new mode is proven.

## Current architecture and why it is expensive

`chrome.desktopCapture` → MediaStream → browser MediaRecorder (WebM/VP8+Opus) → localhost authenticated WebSocket → Node Fastify → FFplay WebM decode → Xvfb virtual display + isolated PulseAudio sink → Doubletake X11 capture → H.264/x264 re-encode → encrypted AirPlay mirroring → A1469.

This involves codec conversion, a playback clock, resampling and a second screen capture. FFplay's earlier buffer reductions cut observed delay by ~3 seconds; lowering capture rate/resolution did not. It is **not yet proven** which of remaining stages dominates.

## Milestone 0 — Instrument and decide whether direct AirPlay can meet the goal

1. Run `scripts/latency-baseline.sh <receiver-ip>` after `sudo apt install x11-apps`; it displays a digital X11 clock passed directly to Doubletake, without Chrome capture, Node, WebSocket, MediaRecorder or FFplay. Compare to local `date +%T` in a second terminal.
2. This once-per-second clock is enough to distinguish multi-second receiver lag, but **not** to establish precise subsecond latency. Film both local source and TV with one high-frame-rate smartphone camera or perform a shared visible stimulus/photo measurement.
3. Obtain video-only and video+audio baselines. Check whether lag grows with session age. Record sender stderr, local CPU and memory (`top`, `free -m`) and network conditions.
4. Gate: if *direct* Doubletake is already at or above 1 s, debug AirPlay timestamps/receiver playback and test receiver/version alternatives **before** rewriting browser media transport. The `-target-latency-ms` option adjusts scheduling lead, not arbitrary multi-second queue buildup; do not use it blindly.

## Milestone 1 — Browser H.264 feasibility spike (no AirPlay change)

1. Add a **separate experimental capture mode** in the persistent MV3 extension tab (keep the current MediaRecorder choice).
2. Preserve `desktopCapture.chooseDesktopMedia` consent and obtain the media video track. Probe `VideoEncoder.isConfigSupported` at 1280×720, 24/30 fps with `avc: {format: "annexb"}`, `latencyMode: "realtime"`, `hardwareAcceleration: "prefer-hardware"`, H.264-compatible profile strings. Try a conservative profile/size when unsupported; do **not** presume all ChromeOS devices support accelerated H.264.
3. Feed VideoFrame objects from a track processor in a supported worker when available; fall back to a video-element/requestVideoFrameCallback path without excessive canvas copies. Close consumed VideoFrames promptly.
4. Generate complete H.264 access units (SPS/PPS, IDR/non-IDR). Request a keyframe at startup, on connection repair, and periodically (~1–2 s) without B-frames/reordering. Avoid queue growth: cap `VideoEncoder.encodeQueueSize`, drop **raw** frames when late, and reset/request keyframe on unrecoverable *encoded* stream discontinuity.
5. Expose actual encoder capability/encode duration/frame interval stats in UI. Gate: sustained correctly decodable H.264 output, no unbounded encode queue or RAM increase.

## Milestone 2 — Native direct-H.264 AirPlay sender

**Preferred approach: small, pinned, separately licensed Doubletake fork/extension, not a rewrite of pairing/encryption.** Upstream is LGPL-3.0; respect licensing and retain attribution/source availability for redistributed modifications.

Upstream primitives already exist:
- `internal/airplay.VideoAccessUnit` (Annex-B AU with `PTS time.Time`).
- `MirrorSession.StreamFrames(ctx, capture, ...)` parses H.264 SPS/PPS, encrypts VCL access units, maps PTS onto negotiated receiver clock and transmits frames.
- `ScreenCapture` is currently bound to GStreamer/X11 and has a private `videoAccessUnitReader`. `BroadcastSink.AsCapture()` demonstrates that a synthetic in-process source can drive `StreamFrames`.

Implement a documented **external encoded-access-unit adapter** in the Doubletake-based sender that accepts H.264 AUs from stdin/Unix socket and presents them to StreamFrames with valid, monotonic, receiver-clock-mapped PTS. Negotiate receiver size/codec and pairing exactly once; do not introduce arbitrary extra playout lead or reconstruct frame clock from ffplay.

Transport: retain the local loopback Fastify auth/session handshake; use strict versioned, length-bounded frame packets with `sequence`, `captureTimestampUs`, `keyframe`, and AU bytes. Node forwards to the Go sender over a bounded local socket/pipe (or merge transport directly into the Go sender after authorization); **do not** decode/re-encode video. Calculate timestamp offset via clock sync at session start; ChromeOS and Crostini may have different monotonic epochs. Guard timestamp drift/reordering and use arrival-time mapping only as a documented fallback.

Gate: display browser-generated test pattern on Apple TV using direct H.264; log received AU / sent AU timing and receiver behavior, comparing with Milestone 0. No full desktop yet.

## Milestone 3 — Real desktop video and profile selection

Integrate browser screen VideoEncoder output with the native AirPlay adapter. Record:
- capture frame time, encoder output time, browser WS enqueue and drain;
- Node receive time, native sender AU transmit time;
- external action-to-photon measurement at TV.

Profile targets:
- **Low latency**: 720p/24 fps and a controlled bitrate that hardware can sustain;
- **Quality**: 1080p/30 fps only if WebCodecs H.264 and the A1469 AirPlay negotiation actually accept the profile without latency regression;
- **Legacy fallback**: the proven WebM → FFplay → Xvfb → Doubletake path.

Use measured p50, p95 and max over ten minutes. Ensure memory and backpressure are bounded; never let a WebSocket/encoder queue silently accumulate seconds of content.

Gate: <1 s p95 with stable 720p video, no audio.

## Milestone 4 — Audio and A/V sync

Capture tab/system audio only when offered by ChromeOS and explicitly selected. Do not assume global system audio is available for every surface. Build a parallel timestamped audio path (AudioWorklet PCM chunks or supported equivalent) into Doubletake's existing screen-audio sender. Existing PulseAudio null-sink may be kept temporarily as an **audio-only** bridge if supported; do not reinstate the video FFplay stage.

Map audio and video to one session clock with independently bounded queues, and profile source of staticky sound. Check audio underflow, clipping, timing resampling and whether the synthetic audio test itself distorts. Gate: stable intelligible audio, acceptable lip-sync, no renewed multi-second video buffering.

## Milestone 5 — Hardening, security, release

- Unit tests: Annex-B SPS/PPS/IDR parsing, packet length limits, monotonically mapped PTS, capability negotiation, session restart, timeout, keyframe recovery, bounded backpressure; hardware-free simulated receiver test.
- End-to-end A1469 soak test (10 minutes minimum), inspect CPU, memory and ChromeOS capture stability.
- Repair failing GitHub security gate: pinned Fastify dependency plus transitive `fast-uri`, `find-my-way`, `ws`. Run `npm audit`, all tests, no blind `--force` without review.
- Preserve existing branch as rollback; experimental mode default-off until hardware validation passes. Keep binary/source license compliance for any fork.

## Go/no-go decisions

| Observation | Action |
| --- | --- |
| Direct X11 Doubletake <1 s, bridge ~3 s | Proceed with WebCodecs + direct native AUs |
| Direct Doubletake ~3 s | Investigate receiver/Doubletake timing and alternative receiver before pipeline rewrite |
| WebCodecs H.264 unavailable or too slow on 4 GB machine | Benchmark GStreamer or WebRTC H.264 encoder path with one encode; preserve fallback |
| Direct video <1 s but audio restores >1 s | Isolate audio clock and buffering; keep video-only preview usable |
| 720p passes but 1080p does not | Ship 720p low-latency; prioritize responsiveness |

## Immediate next action

**Run and report the direct wall-clock test** that is already committed. This is the highest-value decision gate before investing in a direct media sender. Implement Milestone 1 capability probe as an isolated opt-in next, not as a replacement for the working extension.
