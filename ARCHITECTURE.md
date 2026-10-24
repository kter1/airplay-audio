# AirPlay mirroring architecture

ChromeOS desktopCapture + offscreen getUserMedia -> WebM MediaRecorder -> localhost WebSocket -> ffplay -> private Xvfb display and PulseAudio null sink -> Doubletake sender -> Apple TV.

## Trust boundaries and behavior
- Receiver IPv4 restricted to RFC1918 ranges; backend listens only on 127.0.0.1.
- Session ID and token used to authenticate the audio/video WebSocket before binary frames are accepted.
- One session at a time. Timeout: 90 seconds before media, 20 seconds idle after media.
- WebSocket buffering bounded. Decoder backpressure pauses inbound socket.
- Sender, decoder, Xvfb and PulseAudio sink are cleaned up on session stop.
- Pairing may need separate interactive Doubletake setup.
- No claim that sender-started state proves successful Apple TV playback.

## Hardware validation gates
1. Doubletake synthetic -test works on actual target (especially Apple TV 2 / A1378).
2. ChromeOS screen capture and audio tracks work in offscreen document.
3. ffplay decodes WebM and Doubletake captures private virtual screen/audio.
4. A/V sync and stability sustained for 30 minutes on the 4 GB Chromebook.
5. Optimize re-encode overhead with direct sender input only after working prototype.
