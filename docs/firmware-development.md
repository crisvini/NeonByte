# Firmware Development

**Status:** Phase 4 has a native C++17 core and locally compilable ESP8266 runtime adapters. The maintainer confirmed an ESP-12F / ESP8266 module; remaining hardware and Wi-Fi-only installation/recovery gates are unresolved. No device operation has been performed. See the [integration report](esp8266-integration.md) for measured artifact sizes and limitations.

## Local Validation

PlatformIO remains defaulted to `native`. Use `uv tool run --from platformio pio` in place of `pio` when PlatformIO is not on PATH.

~~~sh
pio test -d firmware -e native
pio run -d firmware -e esp8266-provisional
pio run -d firmware -e esp8266-integration-check
npm run check
python3 firmware/scripts/inspect_image.py firmware/.pio/build/esp8266-integration-check/firmware.bin
~~~

Run PlatformIO jobs sequentially: native test preparation may clean other environment build directories. No upload, filesystem-image, erase, monitor, UART, or device-discovery command is part of this workflow. The pre-build guard rejects deployment-related targets in the ESP8266 profiles. It is a local safeguard, not protection against manually invoking other tools.

## Core and Runtime Structure

- `SceneManager` retains the existing two-scene behavior, 45-second independent heartbeat/metadata expiry, manual modes, timestamp correction, and monotonic progress.
- `ProtocolHandler` preserves the JSON schemas and uses a retained transactional `NowPlaying` scratch value. Bounded key/mode text buffers remove the previous full-field stack allocations. Calls are serialized; the handler is not reentrant.
- `HttpHeaders`, `Transfer`, `HashJob`, `AtomicFileBackend`, image validators, and Wi-Fi form parsing are portable and native-tested. They cover strict framing, exact counts, failed writes/readback, SHA comparison, bounded hashing, and image checks.
- `esp8266/main.cpp` binds the core to an extended monotonic clock, optional SNTP Unix time, nonblocking station retries, protected AP provisioning/reconfiguration, and a cooperative loop.
- `esp8266/http_server.cpp` serves a single HTTP/1.1 connection on port 80 with bounded headers/body buffers, authentication before storage/body allocation, incremental binary writes, and incremental staged-file SHA-256.
- `esp8266/storage.cpp` disables LittleFS autoformat, persists only `/neonbyte/` files, reads candidates after close before promoting settings, and atomically renames verified media. No stock settings migration is attempted.
- `esp8266/display.cpp` uses the provisional ST7789 profile. Animation and cover pixels stream in 480-byte rows. Covers are decimated from 240 × 240 to 144 × 144; text and progress use the remaining area. The built-in font substitutes `?` for unsupported Unicode glyphs and truncates long lines.

## Configuration and Network Behavior

First startup requires a compatible, already provisioned LittleFS volume. There is deliberately no automatic format or filesystem installer. A missing/unmountable volume fails closed. A corrupt existing configuration also fails closed rather than replacing its token or credentials.

When configuration is absent, SDK random values generate a 64-hex-character pairing token and independent 16-hex-character WPA2 AP password. They are persisted with a version and SHA-256 corruption check. The enabled display shows them locally during initial setup. They never appear in logs, HTTP responses, URLs, build settings, or source-controlled credential files.

The setup AP is named `NeonByte-<chip-id>`; its address uses the ESP8266 AP default, `192.168.4.1`. Authenticated `PUT /api/v1/config` accepts a small URL-encoded Wi-Fi form. All mutations, including configuration and OTA, require the bearer token. The station retries every 30 seconds without a blocking connection wait. Initial setup keeps the protected AP available until the station connects. After 60 seconds disconnected, a configured device offers the same protected AP while continuing offline rendering. A paired user must retain its random password and token to repair Wi-Fi; no unauthenticated reset endpoint is provided.

The default review build disables display GPIO activation, so initial setup secrets are unavailable in that artifact. This is an intentional installation blocker. The enabled validation build is for compilation only; physically validating display/pairing is still pending.

SNTP uses `pool.ntp.org` and `time.nist.gov`; rendering does not require either. Until time is known, Unix time is zero and metadata freshness relies on monotonic receipt age. Old-sample replay cannot reliably be detected without a synchronized clock. Monotonic milliseconds extend the 32-bit `millis()` rollover while the loop continues running.

## Storage and Playback

The linked LittleFS range matches the old artifact's addresses, without demonstrating compatible installed contents. Assets and settings are namespaced. Temporary media files are discarded at boot; installed assets are left intact. Settings are written to a candidate, flushed/closed, reopened, checked byte-for-byte, and renamed only on success. Runtime filesystem faults beyond the modeled failures still require physical validation.

Cover files store a fixed private track-ID prefix together with the NBIC body, so the image and track association change in one rename. Only a matching current track is displayed. Animation files remain the existing NBIF v1 format. Uploads validate exact layout, dimensions, timing, complete staged-file SHA-256, and free-space reserve before replacement. Replacement never removes the installed file first. Same-loop serialization and an asset revision restart playback from frame zero after a successful replacement.

Animation timing is measured from the start of frame drawing. If drawing exceeds a frame delay, the loop proceeds as quickly as possible rather than waiting an additional full delay; no measured FPS is claimed. Missing/invalid animation data leaves a black fullscreen GIF scene. Each loop handles up to 512 network/hash bytes and one display row. Firmware validation/copy and filesystem operations can still pause application rendering; OTA is a maintenance operation, not seamless animation playback.

## Security and Resource Limits

Local bearer HTTP is restricted by design to a trusted LAN; it is unencrypted and provides no publisher signature or anti-downgrade policy. Wi-Fi secrets and the pairing token are plaintext in device flash, outside the repository. ESP8266 storage is not claimed to protect them against physical access. No Spotify credentials are stored on the device.

Headers are capped at 4,096 bytes, JSON at 12,288 bytes, and configuration at 512 bytes. These are explicit implementation bounds, not physical measurements. Binary transfers use at most 512 bytes per loop. The single connection has a 5-second inactivity timeout and 60-second total deadline; local hashing suspends network inactivity checks but retains the total deadline. Unsupported transfer encoding, `Expect`, duplicate sensitive headers, ambiguous framing, and incomplete transfers fail without asset promotion. Connections close after one response.

The image inspector is offline only. A small image, valid checksums, successful linking, native tests, or a matching stock filesystem address does not establish boot compatibility, display compatibility, storage durability, or recovery. Keep Phase 4 physical acceptance and all deployment blockers open.
