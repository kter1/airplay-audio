#!/usr/bin/env bash
# Direct X11 clock -> Doubletake -> Apple TV latency baseline, video-only.
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "Usage: bash scripts/latency-baseline.sh APPLE_TV_IP"
  exit 2
fi
for binary in Xvfb xclock doubletake; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "Missing $binary (xclock: sudo apt install x11-apps)."
    exit 1
  fi
done
num=""
for n in $(seq 160 180); do
  if [[ ! -e "/tmp/.X11-unix/X$n" && ! -e "/tmp/.X$n-lock" ]]; then
    num="$n"
    break
  fi
done
if [[ -z "$num" ]]; then echo "No free X display"; exit 1; fi
display=":$num"
xvfb_pid=""
clock_pid=""
cleanup() {
  if [[ -n "$clock_pid" ]]; then kill "$clock_pid" 2>/dev/null || true; wait "$clock_pid" 2>/dev/null || true; fi
  if [[ -n "$xvfb_pid" ]]; then kill "$xvfb_pid" 2>/dev/null || true; wait "$xvfb_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
Xvfb "$display" -screen 0 1280x720x24 -nolisten tcp >/dev/null 2>&1 &
xvfb_pid="$!"
ready=0
for _ in $(seq 1 50); do
  if [[ -e "/tmp/.X11-unix/X$num" ]]; then ready=1; break; fi
  if ! kill -0 "$xvfb_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if [[ "$ready" != 1 ]]; then echo "Xvfb failed to start"; exit 1; fi
DISPLAY="$display" xclock -digital -update 1 -geometry "860x160+40+40" \
  -fg white -bg black >/dev/null 2>&1 &
clock_pid="$!"
sleep 0.5
if ! kill -0 "$clock_pid" 2>/dev/null; then echo "xclock failed"; exit 1; fi

echo "DIRECT BASELINE: compare the clock on Apple TV with:"
echo "  watch -n 0.2 'date +%T'"
echo "Run that command in a SECOND Linux terminal. Stop here with Ctrl+C."
echo "Audio deliberately disabled to isolate video."

DISPLAY="$display" doubletake -target "$1" \
  -fps 24 -bitrate 2300 -video-codec h264 -hwaccel none -no-audio
