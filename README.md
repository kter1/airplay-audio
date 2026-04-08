# AirPlay Audio Prototype

Local-first, security-hardened prototype for exploring browser-to-device audio streaming on a LAN.

## Status

- Experimental and portfolio-focused
- Not production-ready
- Designed to make architecture decisions and failure modes explicit

## Implemented Flow

1. Chrome extension popup validates a private LAN receiver IP.
2. Extension requests a local session from `POST /session/start`.
3. Backend returns a per-session token and starts ffmpeg HLS output under a temp runtime directory.
4. Extension captures current tab audio (`tabCapture`) and streams binary chunks over `WS /stream/audio`.
5. Backend transcodes input to HLS (`live.m3u8` + `.ts` segments) and attempts playback initiation on the selected receiver.

## Security Posture

- Backend binds only to `127.0.0.1` (no LAN-exposed control plane).
- Session-scoped nonce/token required for both stream ingress and stop operations.
- Receiver input is validated to RFC1918 private IPv4 ranges only.
- ffmpeg is executed via argument arrays (`spawn` with `shell: false`).
- Runtime artifacts are confined to an isolated temp directory and deleted on teardown.
- `.env` and env-like files are blocked from version control.

## Quick Start

```bash
git clone https://github.com/kter1/airplay_audio.git
cd airplay_audio
npm ci --prefix backend
npm run backend:start
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked extension from this repository directory.
4. In any tab, click the extension popup and start a stream.

## Local Verification Commands

```bash
curl -s http://127.0.0.1:8090/health
npm run check:tracked-env
npm run scan:secrets
npm run scan:policy
npm run backend:test
npm run security:audit
```


## Known Constraints

- AirPlay device behavior varies by firmware and protocol support.
- Popup lifetime can interrupt streaming if Chrome closes the extension UI.
- ffmpeg must be installed at an approved local path (`/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg`, or `/usr/bin/ffmpeg`, or explicit `FFMPEG_PATH`).
