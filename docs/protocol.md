# Local HTTP v1 Contract

**Status:** the native core and provisional ESP8266 runtime implement v1. The runtime has compiled locally; no device endpoint has been contacted or deployed. An explicitly constructed agent client is validated against the native core in the [PC-only runner](offline-validation.md); the desktop agent can opt in to scheduled metadata, heartbeat, artwork, mode, and animation synchronization. The agent's simulator routes under `/api/*` are private to the local interface. Hardware compatibility and installation are PENDING.

## Transport and Compatibility

- ESP8266 runtime: local HTTP on port 80; station address comes from DHCP. Setup/reconfiguration AP uses `192.168.4.1`. Discovery is not implemented.
- Route prefix: `/api/v1`.
- JSON uses UTF-8 and `Content-Type: application/json`.
- The version returned by `GET /api/v1/status` must be `v1`. The client must stop sending updates if the version is incompatible.
- Schemas are closed (`additionalProperties: false`). Breaking changes require a new path version.
- Local HTTP with a token does not encrypt traffic. Use it only on a trusted LAN; do not expose the device to the Internet.

## Authentication

All mutating routes require `Authorization: Bearer {token}`: mode, Spotify, cover, animation, and heartbeat. `GET /api/v1/status` is read-only and does not require a token. Tokens must not appear in logs, URLs, or responses.

A future private per-device recovery identity supplies first-boot access independently of storage and display. New namespaced configuration uses that token for initial pairing; existing valid pairing tokens remain unchanged. Recovery AP and bearer credentials are independent, privately supplied random secrets with no defaults. Public compilation profiles have no usable identity and are not installations. See [safe first-boot preparation](safe-first-boot.md) for secret delivery, staged provisioning, authenticated maintenance, and limitations. Tokens remain plaintext in device flash; physical validation remains PENDING.

## Display Modes and Scene Selection

The persisted mode is exactly one of these values:

- **auto**: show Spotify only when the agent has sent a recent update and `isPlaying` is true; otherwise, show GIF.
- **spotify**: stay on the Spotify screen; show a subtle waiting state when there is no active track or the data/heartbeat is stale.
- **gif**: show only the fullscreen GIF.

Initial timeout interpretation: a missing heartbeat for 45 seconds makes the agent unavailable. In `auto` mode this returns to GIF; manual `spotify` mode stays on its waiting screen, as specified by the planning mode matrix. The default mode is `auto`; a manual selection persists across restarts.

The native firmware also expires Spotify metadata independently using the same timeout, even when heartbeats continue. Its age includes the nonnegative Unix sample age at receipt plus monotonic elapsed time since receipt; exactly 45 seconds remains fresh. Expired metadata selects GIF in `auto` and the waiting state in `spotify`. Fresh playback samples must therefore arrive within the timeout. Heartbeats record presence only. The ESP8266 adapter attempts SNTP; until Unix time is known, receipt freshness uses monotonic time and cannot reliably distinguish replayed old samples. The [core review](firmware-core-review.md) explains the underlying clock limitations.

The suggested Spotify polling interval is 15 seconds and will be configurable in the agent. Keeping `spotify` on its waiting screen after heartbeat expiration reconciles the mode matrix with the planning timeout behavior; revisit this if the maintainer wants the timeout to override manual mode as well.

| Mode | Recent agent update and track playing | No track, paused, or agent stale |
|---|---|---|
| auto | Spotify Now Playing | Fullscreen GIF |
| spotify | Spotify Now Playing | Spotify waiting screen |
| gif | Fullscreen GIF | Fullscreen GIF |

`activeScene` represents one of the two screens, `spotify` or `gif`; the waiting state belongs to the Spotify screen and does not create a third screen.

## Spotify Model

`PUT /api/v1/spotify` accepts the object defined by [now-playing.schema.json](../contracts/v1/now-playing.schema.json):

~~~json
{
  "trackId": "example-track-id",
  "title": "Example Track",
  "artist": "Example Artist",
  "isPlaying": true,
  "durationMs": 180000,
  "progressMs": 42000,
  "sampledAtUnixMs": 1790000000000
}
~~~

The Spotify display shows a centered 176 × 176 cover and two bounded title/artist fields with unchanged font sizes. It has no progress bar or playback times, and progress-only updates do not redraw metadata. The existing timing fields remain in v1 for compatibility.

The agent must clamp `progressMs` to `durationMs`. The firmware advances progress locally between updates and corrects it when it receives another timestamp. Initial text limits are 256 characters for `trackId`, `title`, and `artist`; keep them aligned across schemas, agent, and firmware.

There is no clear-playback operation in v1, and `trackId` must be nonempty. The offline client sends the last known track with `isPlaying: false` when playback becomes idle or unavailable. A newly started agent with no track history cannot immediately clear unknown playback already on the device; independent metadata expiry still selects GIF after the timeout even if heartbeats continue. No invented track ID or schema change is introduced by offline validation.

## Routes

| Method | Route | Body/headers | Success |
|---|---|---|---|
| GET | /api/v1/status | No body | 200 and an object matching [status.schema.json](../contracts/v1/status.schema.json). |
| PUT | /api/v1/mode | JSON matching [mode.schema.json](../contracts/v1/mode.schema.json) | 204; mode persisted. |
| PUT | /api/v1/spotify | JSON matching [now-playing.schema.json](../contracts/v1/now-playing.schema.json) | 204; state updated. |
| PUT | /api/v1/cover | Binary bytes, X-Track-Id, and X-Content-SHA256 | 204 after validation and storage. NBIC v1, exactly 115,209 bytes. |
| PUT | /api/v1/animation | Binary bytes and X-Content-SHA256 | 204 after validation and storage. NBIF v1, at most 2,304,051 bytes and available atomic staging space. |
| POST | /api/v1/heartbeat | No body | 204; records presence when received. |

The ESP8266 profile accepts `application/octet-stream`, an exact nonzero `Content-Length`, and `X-Content-SHA256`: lowercase hexadecimal SHA-256 of the complete body. These limits describe the local implementation, not measured hardware performance. It rejects chunked transfers, `Expect`, duplicate sensitive headers, and incomplete input. Uploads use candidate files; checksum/format validation occurs after close and before atomic rename. Failed uploads preserve the installed asset.

- Cover body: `NBIC`, version `1` (u8), width `240` and height `240` (u16 little-endian), followed by 115,200 little-endian RGB565 bytes. Example header bytes: `4e 42 49 43 01 f0 00 f0 00`.
- `X-Track-Id` encodes the UTF-8 track ID with percent escapes, as produced by `encodeURIComponent`. For example, `track%2Fexample` identifies `track/example`; `+` is literal. Decoding must produce 1–256 Unicode code points. A 4,096-byte header budget accommodates the maximally percent-encoded 1,024-byte field and ordinary required headers.
- Animation body: `NBIF`, version `1` (u8), width/height `240` (u16 little-endian), frame count `1–20` (u16 little-endian), then each frame's u16 little-endian delay and 115,200 RGB565 bytes. Example one-frame header: `4e 42 49 46 01 f0 00 f0 00 01 00`. Delays must be at least 20 ms and total duration at most 30,000 ms. File length must exactly match the frame count.
- Free space must hold the candidate alongside the installed asset, its private metadata, and a 32 KiB reserve. The effective upload limit is therefore often below the format maximum. No format or limit claims a validated FPS or physical flash capacity.

A cover received before metadata may be stored under the `X-Track-Id` key, but it may only be shown with a track whose `trackId` matches. Do not show a previous track's cover as if it belonged to the current track.

## HTTP Errors

JSON errors follow [error.schema.json](../contracts/v1/error.schema.json). The `message` field must be actionable and must not contain tokens or other secrets.

| HTTP | Stable code | Use |
|---|---|---|
| 400 | invalid_request | Invalid, missing, or malformed JSON, parameter, or header. |
| 401 | unauthorized | Missing or invalid token on a mutating route. |
| 404 | not_found | Unknown route or resource. |
| 409 | conflict | Conflict with current state or concurrent upload. |
| 413 | payload_too_large | Body exceeds the configured limit; 12,288 bytes for JSON, 512 bytes for configuration, and the binary limits above; headers have a separate 4,096-byte cap. |
| 415 | unsupported_media_type | Unsupported media type or format. |
| 422 | invalid_content | Invalid content, checksum, or semantics. |
| 500 | internal_error | Internal failure without sensitive details. |

## ESP8266 Configuration and Future OTA Extensions

These device-hosted extensions do not change the existing JSON schemas or agent behavior. They are not stock SD PRO endpoints. Both require `Authorization: Bearer {token}`; tokens, passwords, and request bodies must never be echoed.

| Method | Route | Body/headers | Success |
|---|---|---|---|
| PUT | /api/v1/config | `application/x-www-form-urlencoded`, at most 512 bytes; exactly `ssid=<encoded>&password=<encoded>` in that order | 204 after verified persistent replacement; station connection is attempted asynchronously. |
| PUT | /api/v1/firmware | `application/octet-stream`, exact length, X-Content-SHA256 | 204 after validation and successful firmware staging; a restart is scheduled. |

SSID length is 1–32 decoded bytes. Wi-Fi passwords are empty for open networks, 8–63 printable bytes, or 64 hexadecimal characters. Form `+` means space; percent escapes must be well formed and cannot decode to NUL/control bytes. Stored credentials are not returned. There is no shared or default Wi-Fi password or pairing token. Recovery identity is supplied privately per device.

Firmware OTA is **disabled** in the provisional artifact (`409 conflict`). An enabled future build accepts only an uncompressed combined DIO/40 MHz/4 MB ESP8266 eboot/application image, at most 524,288 bytes and within runtime staging space. It validates segment bounds/checksums, modern Arduino length/CRC, and the complete staged-file SHA-256 before `Update.begin(exactSize, U_FLASH)`. Modern checksum validation accounts for elf2bin's post-checksum metadata patch. `Update.end(false)` rejects incomplete firmware. Filesystem updates and formatting are absent. Compressed, signed/trailing, old-stock-CRC, and other-profile images are unsupported by this route.

The recovery-authenticated `GET /maintenance/v1/info` is available before storage/application startup. It returns bounded `deviceId`, per-startup `bootId`, `buildId`, `firmwareVersion`, station/AP IPs, `otaEnabled`, `maxFirmwareBytes`, `profile`, and the non-secret `recoveryIdentityFingerprint`; it returns no credentials or SSID. The stable device ID is the chip identifier. Only an identity-bearing private build reports a nonempty build/profile/fingerprint and nonzero OTA capacity. Runtime capacity is conservative and the existing updater remains authoritative. The fingerprint is SHA-256 of ASCII `NeonByte recovery identity v1`, NUL, recovery token, NUL, and recovery AP password. The route is additive and leaves every API v1 contract unchanged.

Firmware maintenance can pause rendering during complete image validation and flash staging. Animation SHA-256 runs in 512-byte steps across loop iterations. The connection has a 5-second inactivity timeout and 60-second total deadline; local finalization retains the total deadline. One connection is handled at a time, responses close the connection, and a pending successful OTA prevents further mutations before restart.

## Authenticated Maintenance Extensions

The additive `/maintenance/v1/*` extensions are separate from the API v1 JSON contracts. Every maintenance request, including `info` and status, requires the private recovery bearer token. They provide authenticated build/device identity, status, diagnostics, staged/confirmed Wi-Fi, explicit temporary Wi-Fi, guarded storage initialization, application pause/resume, and access to the existing gated updater while the application is paused. The exact routes and response fields are specified in [safe first-boot preparation](safe-first-boot.md#maintenance-routes). No existing v1 schema or success payload changes. Ordinary v1 application requests return `409 conflict` while the application is paused.

On a clean maintenance boot, after the fresh ten-second recovery window, firmware makes one RTC-guarded, configuration-only mount/load attempt. It may use valid saved NeonByte credentials for nonblocking STA retries while retaining the recovery AP; it does not create the settings namespace, clean temporary files, prepare media, or start the application. Crash/risky/invalid warm-reset evidence suppresses this automatic load. An unknown guard on a warm reset remains AP/HTTP-only and may require one authenticated `POST /maintenance/v1/storage` during a separately authorized legacy transition. The 12-byte guard is at RTC word offset 32 (byte offset 128), beyond eboot's first 128 reserved user bytes; its magic encodes layout version 1. These are host-tested source behaviors; LittleFS mount effects, RTC retention, and AP+STA radio behavior remain pending physical validation.

The recovery AP stays available after station connection. Maintenance confirmation saves credentials only after association to the candidate SSID; failed persistence retains the previous installed configuration. Temporary settings require explicit selection and disappear at reset. Firmware maintenance still requires mountable storage and free space; it is not filesystem repair or independent boot recovery. The configuration-only mount does not change any API v1 schema or response.

## Security and Validation Limits

- HTTP bearer authentication does not encrypt traffic or authenticate a publisher. Restrict use to a trusted LAN; no public Internet exposure, signature enforcement, or anti-downgrade policy is provided.
- The C++ JSON schemas/examples are unchanged. Portable tests cover validation, authentication, media layout, strict framing, transactional writes, bounded hashing, image corruption, and failure preservation.
- Target adapters have compiled but have not been exercised on hardware. Pairing, transfer behavior over Wi-Fi, filesystem durability, runtime memory, sustained responsiveness, and boot compatibility remain PENDING.
- OTA is an application service, not rollback or recovery after a failed boot. [Wi-Fi-only installation and recovery are blocked](recovery.md). No device operation is authorized by this specification.
