# Firmware Development

**Status:** the hardware-independent Phase 4 subset has a PlatformIO native test environment and host-tested C++ components. The project unit, board target, network server, physical display, and recovery path remain unverified.

## Native Project

The `firmware/` directory contains C++17 core code, public interfaces, and a PlatformIO native test environment. The default PlatformIO environment is `native`; it does not select or build a device board.

Run the native tests from the repository root:

~~~sh
pio test -d firmware -e native
~~~

The test suite uses Unity as a development-only test framework. The firmware core has no runtime library dependencies. Native fakes cover the clock, storage, display renderer, request authentication, and network request/response boundary.

## Implemented Components

- `SceneManager` loads and saves `auto`, `spotify`, and `gif` through the storage interface. It selects only the `spotify` and `gif` scenes, shows the Spotify waiting state in manual Spotify mode, and returns `auto` to GIF when the 45-second heartbeat or playback metadata expires, or playback is paused. Continuing heartbeats do not extend metadata freshness; sample age at receipt and subsequent monotonic elapsed time share the same timeout.
- Playback progress is clamped to the track duration. On receipt, the manager uses `sampledAtUnixMs` and the clock's Unix time to correct sampling delay, then advances with monotonic time while playback is active.
- `ProtocolHandler` validates the existing v1 JSON fields, types, closed-object rules, and text limits. It creates the documented status and error responses without depending on an HTTP library. `NetworkOperations` passes a request to the handler and sends its response.
- `BearerTokenAuthenticator` checks the `Bearer` scheme and a token supplied by its caller. The token view must remain valid for the authenticator's lifetime. Pairing, token creation, storage, and recovery remain pending.
- `AnimationReader` reads the existing `NBIF` version 1 RGB565 animation header and timing entries, then reads pixel bytes from storage by caller-requested chunks. It does not allocate or retain a complete frame.
- `DisplayRenderer`, `Storage`, `Clock`, and `NetworkOperations` define the hardware-facing boundaries. No board adapter is included.

## Protocol Compatibility and Limits

The JSON schemas and examples in `contracts/v1/` are unchanged. The handler uses the same `/api/v1` paths, request field names, `auto`/`spotify`/`gif` values, `v1` status value, and error codes. It accepts exact nonnegative JSON integer values up to `UINT64_MAX`, including decimal or exponent notation whose mathematical value is an integer. Values above that implementation bound are rejected even though the schemas do not define a numeric maximum; realistic Spotify timing values fit the bound. Text length is counted in Unicode code points, matching the schema's `maxLength` rules.

The host handler supports `GET /api/v1/status`, `PUT /api/v1/mode`, `PUT /api/v1/spotify`, and `POST /api/v1/heartbeat`. Every mutating route passes through the injected authenticator. There is no network-stack binding or live device endpoint yet.

The current handler returns the existing `415 unsupported_media_type` error for `PUT /api/v1/cover` and `PUT /api/v1/animation`. The route envelopes and `X-Content-SHA256` requirement remain unchanged, but firmware upload validation is deferred until the target's storage limits and safe replacement behavior are known. The animation reader validates the file layout and frame timing; it does not calculate SHA-256 or install an uploaded asset.

`HttpRequest.body` is a non-owning view. The handler does not copy the complete request body, but the network adapter must bound and buffer JSON input before calling it. The numeric request-body limit is still **PENDING**. Pairing, the device IP/port, binary upload limits, asset checksums, atomic writes, and network reconnection are also **PENDING**.

## Memory and Resource Requirements

- A single 240 × 240 RGB565 frame contains 115,200 pixel bytes. `AnimationReader` stores only its small metadata and uses an 11-byte header buffer plus two-byte timing reads. Pixel reads use the destination buffer provided by the caller; the 256-byte chunk in the unit test is only a test choice, not a hardware recommendation.
- The existing agent format allows up to 20 frames and 30 seconds. At the fixed display dimensions, 20 full frames require up to 2,304,051 bytes including the 11-byte header and per-frame delays. The available flash and filesystem space on the project unit remain **PENDING**.
- Three UTF-8 text fields reserve up to 1,024 bytes each to represent the contract's maximum 256 Unicode code points. A `NowPlaying` value therefore uses about 3.1 KiB, before alignment and other fields. The scene manager retains one value; a Spotify request is parsed into a temporary value before it replaces the current state.
- A protocol response reserves 1,024 bytes. The request parser uses a fixed text-key buffer and does not allocate a second copy of the JSON body. The [core review](firmware-core-review.md) records host object sizes and compiler stack reports, including a 4,352-byte handler frame with GCC 11.4.0 on x86-64 at `-Os`. Actual stack use depends on compiler and network adapter and has not been measured on hardware.
- The native mock stores complete animation fixtures in host memory. That test allocation is not used by `AnimationReader` on a device.
- Display buffers, network buffers, filesystem metadata, firmware image size, free RAM, animation frame rate, and maximum safe transfer size have not been measured. No board memory or flash budget is claimed.

## Remaining Hardware Dependencies

Keep the following items **PENDING** until supported by evidence for the project unit:

- MCU/module, PCB revision, power input, boot straps, accessible serial interface, and display controller.
- GPIO mapping, display initialization, orientation, color order, inversion, backlight behavior, and measured rendering speed.
- Flash capacity, partition layout, filesystem geometry, usable storage, upload limit, and interrupted-write recovery.
- Memory and stack measurements with the chosen network and display adapters, plus sustained animation performance.
- Pairing and token provisioning, network server configuration, reconnect behavior, and whether the adapter can service requests without delaying rendering.
- Full-flash backup, restore, and recovery validation on an identical spare or sacrificial unit.

Do not add a device board target, compile for an assumed board, flash, use OTA, erase, change partitions, or communicate with the physical device until the hardware and recovery gates in [the hardware investigation](hardware.md) and [the recovery runbook](recovery.md) are satisfied and board-specific work is approved.
