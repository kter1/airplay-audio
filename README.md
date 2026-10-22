# AirPlay Chromebook Caster

**Experimental — actual Apple TV playback has not been verified.**

This branch adds whole-screen or tab **video plus optional audio** capture from ChromeOS Chrome to a Linux AirPlay mirroring sender. It targets a likely Apple TV 2nd generation (A1378, 720p), but Doubletake has not been confirmed to support that receiver.

## Architecture

ChromeOS extension desktopCapture -> MV3 offscreen document -> MediaRecorder WebM -> authenticated localhost WebSocket -> ffplay -> virtual X11 display and isolated PulseAudio null sink -> Doubletake H.264 mirroring -> Apple TV.

This deliberately avoids trying to run the Linux sender as a Chrome extension. It is CPU intensive, and not a low-latency native AirPlay implementation.

## Chromebook Linux requirements

Node.js 22+, ffplay (from ffmpeg), Xvfb, PulseAudio utilities, GStreamer capture and encoder plugins, and Doubletake, built separately from https://github.com/omarroth/doubletake.

Example Debian packages:

    sudo apt update
    sudo apt install -y ffmpeg xvfb pulseaudio-utils gstreamer1.0-tools gstreamer1.0-x gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad

Install Doubletake separately using its upstream build instructions and confirm with 'which doubletake'. This repository does not redistribute Doubletake; respect its license.

## Essential compatibility proof first

Before attempting extension casting, verify the original Apple TV accepts the mirroring protocol:

    doubletake -target 192.168.1.25 -test -fps 24 -video-codec h264 -hwaccel none

Replace the example IP with your Apple TV IP. Ctrl+C to stop. If the synthetic test image never displays on the television, DO NOT proceed assuming this bridge will solve it. Pairing/password prompts may have to be completed interactively through Doubletake first.

## Run

    npm ci --prefix backend
    npm run backend:start
    curl http://127.0.0.1:8090/health

On ChromeOS Chrome (not Linux Chrome), visit chrome://extensions, enable developer mode and load this repository directory as unpacked extension. It may need to be moved to an accessible ChromeOS Files location. Open the popup, enter Apple TV LAN IP and optional PIN, then choose screen or tab. If Chrome offers a Share audio checkbox, enable it.

Closing the popup should not stop the offscreen recording. Click Stop or end Chrome screen sharing to stop.

Status 'sender-started-unverified' or 'receiving-media-airplay-unverified' only shows subprocess/transport progress. Neither proves audio or video reached the Apple TV.

## Check

    npm run backend:test
    npm run ci:verify
    curl http://127.0.0.1:8090/mirror/status

## Limitations

- **2010 Apple TV 2nd generation support remains unverified.**
- ChromeOS screen audio support and extension offscreen capture compatibility vary by version and selection.
- Full desktop/system audio may be unavailable; the extension attempts video-only fallback.
- The Linux container must have network reachability to the Apple TV, GStreamer X11 capture support, and a working PulseAudio server.
- Doubletake may require interactive pairing. Pair separately in its own terminal before using the backend if necessary.
- The Xvfb plus ffplay re-encode architecture may overwhelm a 4 GB Chromebook. No performance tests have been run.
- DRM media is not guaranteed capturable.
- One stream at a time, trusted local machine only. This is a prototype and is not security audited.
- Historical broken audio-only HLS code remains in backend/src/server.js for reference; npm --prefix backend run legacy starts it.

A successful end-to-end receiver run, sustained for 30 minutes with synchronized A/V and with popup closed, is still required before calling the project complete.
