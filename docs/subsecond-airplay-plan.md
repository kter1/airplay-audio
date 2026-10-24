# AirPlay Subsecond Project — Optimized Execution Plan (v2)

> **Status: engineering plan, not a shipping implementation.** Current Chromebook → Apple TV A1469 full-screen+audio path works. Observed latency: ~6 s original, ~3 s after FFplay low-buffering, and still ~3 s with 540p/20-fps Fast mode. These are user's estimates, not controlled p95 measurements. Direct Doubletake baseline result has **not** been reported. Keep the working branch and settings available throughout.
>
> **Key decision:** Do not build both a browser H.264 encoder **and** a custom AirPlay adapter before demonstrating that the A1469 can play externally encoded H.264 at low latency. **Receiver baseline → synthetic direct encoded sender → Chrome codec capability → integration → audio**.

## 1. Product outcome and priorities

**Primary acceptance condition:** 720p at 24 fps, full Chromebook desktop, audio enabled, **input/action-to-TV-photon latency <1,000 ms p95** across a 10-minute representative session, no accumulating lag, stable A/V sync, and no persistent memory growth on the actual 4 GB Chromebook + Apple TV A1469.

- **P0:** subsecond interactive video, correctness, recovery, A/V sync.
- **P1:** sustained 720p legibility/24 fps, stable CPU and RAM, security.
- **P2:** 1080p/30 fps after 720p meets P0+P1 (A1469's advertised 1080p output does not guarantee every AirPlay mirroring mode negotiates that resolution).
- Optional stretch: 500 ms p95; **no guarantee** for the 2013 receiver.
- Rollback: existing MediaRecorder/FFplay/Xvfb/Doubletake path must remain usable. New feature only enabled by explicit Experimental Direct mode.

### Why the previous plan was reordered

The existing stream incurs `MediaRecorder VP8/Opus WebM → WebSocket → FFplay decode/render → Xvfb/PulseAudio → Doubletake X11 capture → software H.264 re-encode → AirPlay`. A 540p capture optimization did not reduce end-to-end delay; reducing FFplay buffering did. This suggests a structural/video clock bottleneck, **but does not prove whether the remaining 3 seconds are at the receiver**. A major rewrite before benchmarking that baseline is premature.

### Planned architecture (not yet implemented)

`ChromeOS desktopCapture → VideoFrame → one WebCodecs H.264 encoder (low latency) → authenticated bounded AU transport over localhost → adapted Doubletake Go sender (reuse clock mapping, encryption, RTP/AirPlay setup) → A1469`.

Keep audio as separate timestamped stream; **do not** add FFplay back into the video path. Existing Node control API can remain in front of the Go sender unless benchmarks show material overhead.

## 2. Latency measurement protocol and budget

**Tools:**
1. Existing `scripts/latency-baseline.sh TV_IP` creates an Xvfb xclock and sends it directly to Doubletake. This excludes ChromeOS screen capture, MediaRecorder, WebSocket, Node and FFplay. Run with audio disabled. Compare to live `date +%T` on Chromebook/Linux. **The one-second clock only distinguishes ~1 s vs ~3 s; it cannot certify <1 s.**
2. For quantitative subsecond verification: put source screen/controlled visual marker and TV in one camera recording (ideally 120/240 fps); use a rapid, timestamped visible state change or random frame ID, and calculate frame-count delay. Use repeated trials, **not just a single screenshot**.
3. Record **p50, p95, max** (≥100 independent actions) at start and after 10 minutes. Record dropped/duplicated frames, FPS, A/V delay and any drift. Repeat on a stable local Wi-Fi environment; note receiver connection and Chromebook CPU/swap.

**Engineering budget to test, not asserted measurements**:
- Chrome capture + H.264 encode: target ≤150 ms at p95.
- ChromeOS → Linux transport + native bridge: target ≤75 ms at p95.
- Doubletake frame scheduling/packetization: target ≤75 ms at p95.
- A1469 network/decoding/display: remaining ~600 ms plus 100 ms safety margin. **Reallocate only after measuring it**.
- Stage-specific p95 figures cannot simply be summed to prove overall p95; validate end-to-end with camera measurements.

**Clock validity:** WebCodecs VideoFrame/EncodedVideoChunk timestamps are microseconds in a media timeline, **not necessarily Unix wall time or Crostini monotonic time**. Capture per-session timebase metadata; align relative timestamps at sender ingress using monotonic mapping. Allow for ChromeOS/Crostini clock domain differences and detect discontinuities. Do not assume arbitrary microsecond timestamps are already safe AirPlay presentation times.

## 3. Gate A — Receiver path first (no production app modification)

Run the existing direct X11 clock test, then assess video-only and video+audio where practical.

| Direct path | Decision |
| --- | --- |
| **<1 s** measured accurately | Focus on elimination of the FFplay/video recapture chain. |
| **1–2 s** | Investigate Doubletake transport/timestamps + A1469 receiver buffer before building entire Chrome pipeline. |
| **~3 s** | Halt major media rewrite. Profile Doubletake timing and the receiver, and benchmark an available newer Apple TV before assuming the app is the bottleneck. |

Check `-target-latency-ms` only with controlled A/B tests; upstream defaults are small scheduling leads, **not direct control of a receiver's multi-second queue**. A single coarse xclock comparison is indicative, not proof of any threshold.

**Deliverable:** short baseline log with screenshots/video evidence, estimated median/p95, CPU/RAM and identified current bottleneck. **Go/no-go required.**

## 4. Gate B — Prove Direct Doubletake can play externally encoded H.264

**Move this stage ahead of full browser WebCodecs implementation.** Fork/adapt the Doubletake Go sender in an isolated experimental module. Preserve attribution and LGPL-3.0 obligations when distributing modified builds. Pin the upstream revision (not an unpinned `main`).

Source interfaces verified in Doubletake:
- `internal/airplay.VideoAccessUnit{AnnexB, PTS}`.
- `MirrorSession.StreamFrames(ctx, capture, ...)`, which handles SPS/PPS, IDR, encryption and AirPlay framing, mapping PTS to negotiated clock.
- `ScreenCapture` has a private access-unit reader; `BroadcastSink.AsCapture()` illustrates wrapping a non-GStreamer reader into the existing streamer.

**Minimal native prototype:** add a narrow exported constructor/adapter inside `internal/airplay` for an externally supplied, bounded **H.264 Annex-B access-unit reader** with explicit PTS. Wire it into the existing session setup/streaming without invoking any X11 capture, FFplay or second encoder.

**First feed:** independently generate a known H.264 test pattern with GStreamer/x264 as **the only encoder** and stream it through the adapter to A1469. This is intentionally independent of Chrome, WebCodecs and our Node bridge. Check SPS/PPS (codec configuration), IDR startup, frame size, monotonic time, exact display dimensions and reconnect.

**Failure handling:** a single UDP/TCP stall cannot add unbounded encoded-frame delay. Do not randomly discard interdependent H.264 P-frames; drop stale **raw frames before encoding**, and if encoded continuity breaks, re-prime with IDR/SPS/PPS after bounded recovery. Abort/resume if the sender cannot catch up.

**Go/no-go:** externally encoded **video-only** pattern renders reliably and its latency approaches the direct X11 Doubletake baseline, with correct timestamps and no seconds-long buffering.

## 5. Gate C — ChromeOS H.264 capability spike (parallel to or after B)

Before building new UI, probe the **actual Chromebook Chrome version and hardware**, not theoretical Chrome support:

1. Preserve `chrome.desktopCapture.chooseDesktopMedia` user selection and persistent extension tab.
2. Check `VideoEncoder` and `VideoEncoder.isConfigSupported`; probe appropriate `avc1` H.264 profiles at 720p/24 fps, `latencyMode: "realtime"`, `avc: { format: "annexb" }`, and hardware preference. `hardwareAcceleration: "prefer-hardware"` is **a hint**, not proof of hardware encoding or speed. Fall back to `no-preference` and narrower profile, then consider native GStreamer if needed.
3. Test `MediaStreamTrackProcessor` worker availability; feature-detect because exposure differs between browser contexts. Use a fallback capture bridge only when justified by performance.
4. Encode and locally validate complete video access units with IDR/SPS/PPS and no problematic frame reordering. Force a keyframe on start/reconnect and after discontinuities; inspect actual output instead of assuming the requested profile is honored.
5. Bound `encodeQueueSize` and close input `VideoFrame` objects. A slow encoder should reduce/dismiss **pre-encode raw frames**, not accumulate seconds of frames. Benchmark encoding under desktop motion for at least two minutes.
6. Report encoder p50/p95, frame drops, sustained FPS, browser memory, CPU and swap. Avoid reliance on a bare `MediaRecorder.start(200)` timeslice as a meaningful low-latency guarantee.

**Go/no-go:** stable 720p/24 fps Annex-B H.264, bounded queues, quality acceptable, and no significant memory growth on the actual 4 GB Chromebook. Fallback to a separately benchmarked native encoder **only if WebCodecs fails the gate**.

## 6. Gate D — Integrate direct media transport without recoding

**Local boundary:** use the existing authenticated localhost startup/session. Version frame packets and strictly validate size, sequence, codec/profile, dimensions, keyframe flags and PTS. Node can forward bytes unmodified to Go initially; remove Node from the data path **only if measured as a material latency contributor**.

**Backpressure:** use time/frames (e.g. 2–3 video frames or approximately 100–150 ms under nominal cadence), not just an arbitrary several-megabyte WebSocket threshold. When congested, stop feeding new raw frames, request a new IDR if coded continuity is compromised, and fail/recover rather than retaining stale media.

**Instrumentation:** browser capture time, encode complete time, enqueue/dequeue time, Node receive, Go ingress and AirPlay write time (compare only times after mapping clock domains); receiver measured externally. Include `queueDelayMs`, `senderAgeMs`, `droppedRawFrames`, `codecRestarts`, `lastKeyframeAgeMs`, CPU/swap, socket buffered bytes and baseline comparison.

**Profiles:** `Legacy` (unchanged), `Direct 720p / 24 fps` (experimental, target), optional `Direct 1080p / 30 fps` (future, capability-gated). Legacy fallback should take one click after stopping current session; no automatic hidden toggles.

**Go/no-go:** p95 end-to-end **<1,000 ms** for video-only, sustained ten minutes, no growing delay, no unbounded buffers. If latency remains high, use stage timing to distinguish browser encoder, Go sender and A1469. **Do not move to 1080p until this passes.**

## 7. Gate E — Audio without reintroducing video latency

- Use the audio track ChromeOS actually grants. Not all desktop/window captures include system audio; show `audio unavailable` honestly.
- Start by transporting timed raw PCM chunks from AudioWorklet when supported. Map them to the same session timeline as video; avoid large audio aggregation windows.
- Reuse Doubletake's existing sender audio implementation. If needed, retain isolated PulseAudio as an **audio-only** interop stage, not FFplay for video.
- Diagnose crackling independently: synthetic receiver test versus browser audio; measure audio underrun, clipping, sample-rate/channel mismatch and clock drift.
- Re-measure video p95 with audio enabled. Optimize synchronization without imposing a multi-second video buffer.

**Go/no-go:** synchronized, intelligible audio and stable video p95 <1,000 ms, with no worsening lag or audio drift over ten minutes.

## 8. Security, QA and licensing (parallel blockers)

- Existing GitHub Actions audit currently reports high-severity vulnerabilities for `fastify`, `fast-uri`, `find-my-way`, and `ws`. **Fix dependencies and committed lockfile before widening any access or treating experimental code as release-ready**; test upgrades instead of running blind `npm audit fix --force`.
- Keep backend bound to `127.0.0.1`, reject unauthorized origins when appropriate, authenticate each media session, enforce packet bounds and timeouts; do not expose a listening port on the Wi-Fi interface.
- Unit/fuzz/property test Annex-B parser boundaries, frame length, timestamps/overflow, session expiry, IDR and SPS/PPS resets, source shutdown, unexpected WebSocket disconnect, pairing and cleanup.
- A1469 hardware soak (ten-minute minimum), record performance metrics before/after each architecture change. Leave baseline version recoverable.
- If modifying/redistributing Doubletake, document license notices, copyright, modification scope and corresponding-source obligations; upstream is LGPL-3.0.

## 9. Scope control and stop conditions

**Do not build now:** new AirPlay encryption from scratch, a WebRTC signaling server, multi-receiver casting, a native ChromeOS app, 1080p quality-first mode, an elaborate telemetry backend, DRM bypass, or speculative hardware purchasing.

Stop direct-H.264 work if: the direct sender itself has a receiver-imposed >1-second floor that cannot be improved in controlled tests; WebCodecs/native fallback cannot sustainably encode at useful speed on the 4 GB machine; or a prototype repeatedly breaks pairing or receiver playback with no measurable gain.

If hardware limits are confirmed, preserve the 3-second implementation for passive viewing, or evaluate a receiver better suited to low-latency input before committing to larger engineering costs.

## 10. Practical next action on the Chromebook

1. Stop the cast and Node server; install `x11-apps` if necessary.
2. `cd ~/apps/airplay-audio && git pull --ff-only && export PATH="$HOME/.local/bin:$PATH"`.
3. `read -rp "Apple TV IP: " TV_IP; bash scripts/latency-baseline.sh "$TV_IP"`.
4. Open another Linux terminal: `watch -n 0.2 'date +%T'`.
5. Report direct sender delay; if under 1 s, proceed to Gate B synthetic encoded-video adapter. For subsecond proof, use shared-camera frame analysis instead of 1 Hz xclock.

## References

- Current project branch: https://github.com/kter1/airplay-audio/tree/codex/chromeos-full-airplay-cast
- Doubletake: https://github.com/omarroth/doubletake
- Doubletake encoded unit: https://github.com/omarroth/doubletake/blob/main/internal/airplay/capture_frame.go
- Doubletake AirPlay StreamFrames: https://github.com/omarroth/doubletake/blob/main/internal/airplay/mirror.go
- WebCodecs AVC Annex-B registration: https://www.w3.org/TR/webcodecs-avc-codec-registration/
- WebCodecs VideoEncoder configuration and latency mode: https://www.w3.org/TR/webcodecs/
- MediaStreamTrackProcessor availability: https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackProcessor
