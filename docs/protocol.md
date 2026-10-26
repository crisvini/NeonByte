# Local HTTP v1 Contract

**Status:** initial v1 specification. A hardware-independent C++ handler now implements the JSON status, mode, Spotify, and heartbeat behavior for host tests. There is still no network-stack binding, device server, or agent client. The agent's local interface routes under `/api/*` are private to the simulator and are not part of this contract.

## Transport and Compatibility

- Local HTTP base; device host, port, and discovery method: PENDING.
- Route prefix: `/api/v1`.
- JSON uses UTF-8 and `Content-Type: application/json`.
- The version returned by `GET /api/v1/status` must be `v1`. The client must stop sending updates if the version is incompatible.
- Schemas are closed (`additionalProperties: false`). Breaking changes require a new path version.
- Local HTTP with a token does not encrypt traffic. Use it only on a trusted LAN; do not expose the device to the Internet.

## Authentication

All mutating routes require `Authorization: Bearer {token}`: mode, Spotify, cover, animation, and heartbeat. `GET /api/v1/status` is read-only and does not require a token. Tokens must not appear in logs, URLs, or responses.

Token generation, initial pairing, secure storage, and recovery: PENDING. No pairing exception has been implemented.

## Display Modes and Scene Selection

The persisted mode is exactly one of these values:

- **auto**: show Spotify only when the agent has sent a recent update and `isPlaying` is true; otherwise, show GIF.
- **spotify**: stay on the Spotify screen; show a subtle waiting state when there is no active track or the data/heartbeat is stale.
- **gif**: show only the fullscreen GIF.

Initial timeout interpretation: a missing heartbeat for 45 seconds makes the agent unavailable. In `auto` mode this returns to GIF; manual `spotify` mode stays on its waiting screen, as specified by the planning mode matrix. The default mode is `auto`; a manual selection persists across restarts.

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

The agent must clamp `progressMs` to `durationMs`. The firmware advances progress locally between updates and corrects it when it receives another timestamp. Initial text limits are 256 characters for `trackId`, `title`, and `artist`; keep them aligned across schemas, agent, and firmware.

## Routes

| Method | Route | Body/headers | Success |
|---|---|---|---|
| GET | /api/v1/status | No body | 200 and an object matching [status.schema.json](../contracts/v1/status.schema.json). |
| PUT | /api/v1/mode | JSON matching [mode.schema.json](../contracts/v1/mode.schema.json) | 204; mode persisted. |
| PUT | /api/v1/spotify | JSON matching [now-playing.schema.json](../contracts/v1/now-playing.schema.json) | 204; state updated. |
| PUT | /api/v1/cover | Binary bytes, X-Track-Id, and X-Content-SHA256 | 204 after validation and storage. Image format and byte limit: PENDING. |
| PUT | /api/v1/animation | Binary bytes and X-Content-SHA256 | 204 after validation and storage. Codec, format version, and byte limit: PENDING. |
| POST | /api/v1/heartbeat | No body | 204; records presence when received. |

The cover and animation formats depend on the pixel format, storage, RAM, and performance confirmed for the hardware. Until then, the binary routes are proposed envelopes and are not ready for interoperability. `X-Content-SHA256` is the lowercase hexadecimal SHA-256 of the complete body. Validate uploads before replacing the working asset.

A cover received before metadata may be stored under the `X-Track-Id` key, but it may only be shown with a track whose `trackId` matches. Do not show a previous track's cover as if it belonged to the current track.

## HTTP Errors

JSON errors follow [error.schema.json](../contracts/v1/error.schema.json). The `message` field must be actionable and must not contain tokens or other secrets.

| HTTP | Stable code | Use |
|---|---|---|
| 400 | invalid_request | Invalid, missing, or malformed JSON, parameter, or header. |
| 401 | unauthorized | Missing or invalid token on a mutating route. |
| 404 | not_found | Unknown route or resource. |
| 409 | conflict | Conflict with current state or concurrent upload. |
| 413 | payload_too_large | Body exceeds the configured limit; numeric limit: PENDING. |
| 415 | unsupported_media_type | Unsupported media type or format. |
| 422 | invalid_content | Invalid content, checksum, or semantics. |
| 500 | internal_error | Internal failure without sensitive details. |

## Security and Pending Limits

- The initial design has no TLS; restrict traffic to a trusted local network.
- Define pairing, token generation, and token storage before implementing mutating routes.
- Define the port, body limits, and binary formats with hardware evidence before implementing firmware or integration.
- Reject unknown modes, invalid payloads, bad checksums, and incomplete uploads; preserve the last valid asset.
- The protocol does not include commands to control Spotify playback.

## Hardware-Independent Firmware Status

The C++ handler in [firmware development](firmware-development.md) preserves the existing v1 paths, JSON fields, mode values, status fields, and error codes. The JSON schemas and examples are unchanged. The handler checks the existing bearer-authentication requirement through an injected authenticator; token pairing and provisioning are not implemented.

The handler currently returns `415 unsupported_media_type` for the cover and animation routes because upload size limits, hardware storage behavior, and safe asset replacement remain pending. This response uses an existing v1 error code and does not change the route envelope or checksum header contract. No device endpoint is available until a hardware network adapter is implemented and validated.
