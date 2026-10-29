# Development

## Repository Status

**Release readiness: NOT RELEASE READY.** Part 6 is **NO-GO** and Part 7 physical acceptance is blocked by missing unit-specific evidence, complete backup/restore, and independent Wi-Fi-only failed-boot recovery. Phases 1 through 3 are complete: documentation, the v1 contract, the Spotify agent, and the local interface with a 240 × 240 simulator. The interface uses the agent's state and works with either a Spotify account or demo data, without a connected device. `firmware/` contains a native core and provisional ESP8266 build profiles. The module is visually confirmed as ESP-12F / ESP8266; actual display settings, performance, flash capacity, and recovery remain PENDING. See [firmware development](firmware-development.md) and the [release-readiness report](release-readiness.md).

## Current Requirements and Commands

- Node.js 22 or later according to package engine metadata. CI exercises major versions 22 and 24; it does not validate every major version allowed by the engine range.
- npm compatible with the installed Node.js version.
- `npm ci` installs the root lint and contract tools.
- `npm ci --prefix agent` installs the agent, native credential-store, GIF decoder, and image decoder dependencies.
- `npm run lint` checks Markdown files.
- `npm run language:check` checks for high-confidence Portuguese content in project text and source files.
- `npm test` runs contract tests with the native Node.js test runner.
- `npm --prefix agent run build` compiles the TypeScript agent and copies static dashboard files.
- `npm --prefix agent test` runs unit and integration tests with mocked fetch and providers.
- `npm run check` runs lint, language checks, contract tests, the TypeScript build, type checks, and agent tests; `make check` is an equivalent shortcut.
- `npm run test:offline` compiles a host executable and exercises the agent against the native firmware core over loopback HTTP v1. A C++17 compiler and OpenSSL development headers/libcrypto are required; no device or Spotify credentials are used. See [offline validation](offline-validation.md) for results and limits.
- `uv tool run --from platformio pio test -d firmware -e native` runs the C++ host test suites without selecting an ESP8266 board. This requires `uv` and PlatformIO; it does not validate physical hardware.
- `npm run check` does not run the offline integration harness or PlatformIO tests. CI runs those separately and also compiles two provisional ESP8266 profiles as compile-only checks. CI does not upload a firmware artifact or publish a release; successful compilation does not establish installation readiness.

Agent tests cover PKCE, the loopback callback, refresh, normalization, 204/401/429 responses, reconnects, caching, the simulator, display modes, uploads, media conversion, limits, and checksums. They do not call the Spotify Web API or validate a real account or hardware.

## Local Interface and Simulator

With `.env` configured (or without a valid Spotify Client ID to start the demo), run `npm --prefix agent run build` and `npm --prefix agent run start`. Open [http://localhost:8787](http://localhost:8787). The server binds only to `127.0.0.1`; `NEONBYTE_PORT` must match the port in `SPOTIFY_REDIRECT_URI` so the OAuth callback returns to the same server. The dashboard can connect Spotify, select `auto`, `spotify`, or `gif`, simulate play/pause/track changes/offline state, and upload a GIF.

The simulator keeps its logical composition at 240 × 240 and scales the canvas responsively with CSS. `auto` selects Spotify only when the agent's recent state confirms playback. Manual Spotify mode shows a waiting state without a track; GIF mode and the `auto` fallback fill the entire frame with the animation. The clock status always reads “simulation without a device”; Phase 3 does not connect to the physical unit.

### Simulator Media Intermediate Format

The agent uses `gifuct-js` 2.1.2 (MIT) to read GIF frames. The preview format is now accepted by the provisional firmware v1 binary routes, with hardware performance still unverified:

- `NBIF` (animation): bytes `NBIF`, version `1` (u8), width and height `240` (u16 little-endian), frame count (u16 little-endian); then each frame contains a delay in milliseconds (u16 little-endian) followed by 240 × 240 RGB565 pixels in little-endian order.
- `NBIC` (cover): bytes `NBIC`, version `1` (u8), width and height `240` (u16 little-endian), followed by 240 × 240 RGB565 pixels in little-endian order.
- The lowercase hexadecimal SHA-256 covers the complete intermediate file, including its header and frame timings.
- GIF limits: 8 MiB for the original GIF, 60 frames for NBIF v2 (20 for v1), 1,048,576 pixels per logical screen or frame descriptor, 16,777,216 total descriptor pixels for v2 conversion (4,194,304 for v1), and 30 seconds total duration. The Windows agent validates descriptors before decoding and performs conversion in a worker with a 10-second deadline and bounded memory. Frames are composed and encoded one at a time. A frame delay below 20 ms is set to 20 ms; a zero delay is set to 100 ms. The scaling policy is `cover` with a centered crop. GIF disposal method 2 restores the global background color while preserving transparency when the background index matches the transparent index. Device firmware advertises its own v2 frame capacity, and the agent rejects incompatible files before upload.

The converted NBIF size is 11 + frameCount × 115,202 bytes, at most 2,304,051 bytes. Device replacement also needs the installed asset and 32 KiB staging reserve; insufficient space is reported separately from the original upload limit. The [display report](spotify-gif-display.md) describes layout, capacity feedback and offline color fixtures.

Converted GIFs and covers remain in memory for the local session and are discarded when the agent exits. The limits and format exist for the preview and must be reviewed against measured flash, RAM, and speed before any firmware integration. The decoder package is documented at [gifuct-js](https://github.com/matt-way/gifuct-js).

### Preserving a Prepared Animation During Agent Repair

Before restarting an agent with a prepared GIF, export the exact converted bytes
from loopback `GET /api/animation` and retain its `X-Content-SHA256` header.
After restart, `POST /api/animation/prepared` accepts those unchanged bytes with
`Content-Type: application/vnd.neonbyte.animation`, a required lowercase
`X-Content-SHA256`, and the trusted loopback `Origin`. Optional
`X-Original-Size-Bytes` preserves the original GIF size statistics (0 through
8 MiB); omission records an unknown original size. The route checks the existing
NBIF v2 size limit, hash and complete format, and retains the current preview if
validation fails. Existing host/origin checks and firmware-update locks apply.
Restoration only prepares the local preview; device replacement still requires
its separate explicit action. This API does not provide automatic disk storage.

## Conventions

- Use UTF-8, LF, and kebab-case filenames for documentation.
- Keep schemas and examples in `contracts/v1/` aligned with `docs/protocol.md`.
- The agent stores refresh tokens in the operating system's native credential manager and has no fallback to local files. On Linux, the installed keyring library can fall back silently to a nonpersistent kernel keyring when Secret Service is unavailable. The backend-selection argument is not supported by the installed version, so persistence is not guaranteed.
- The `@napi-rs/keyring` 1.3.0 runtime dependency is MIT-licensed; upstream publishes notices for bundled libraries, including `libdbus` (AFL-2.1 or GPL-2.0-or-later in the Linux binary). Review upstream notices before redistributing binaries.
- The agent calls only `GET /me/player/currently-playing` with the `user-read-currently-playing` scope.
- `PlaybackPoller.currentSnapshot` and `subscribe()` form the in-process local interface for future consumers; it does not open a network port or transport tokens.
- The Spotify cover URL remains internal agent metadata. The dashboard fetches the image only from the permitted media host and converts it for the preview; sending it to the device is for a later phase.
- `gifuct-js` 2.1.2 is MIT-licensed; the original demo vector asset is covered by this repository's MIT license. The package's license files remain in `agent/node_modules` after installation.
- Firmware language and build configuration depend on hardware identification.

## Direct Dependency and License Notes

The npm lockfiles pin the installed dependency tree. Direct package metadata and known redistribution considerations are summarized here; this is not a completed third-party notice bundle.

| Package | Pinned version | License / notice status |
|---|---:|---|
| `@napi-rs/keyring` | 1.3.0 | MIT; Linux binaries may include `libdbus` notices under AFL-2.1 or GPL-2.0-or-later. |
| `gifuct-js` | 2.1.2 | MIT. |
| `sharp` | 0.35.5 | Apache-2.0; bundled libvips and image libraries have their own notices. |
| `@types/node` | 22.15.30 | MIT; development types only. |
| `tsx` | 4.19.4 | MIT; development/test runner only. |
| `typescript` | 5.8.3 | Apache-2.0; development compiler only. |
| `markdownlint-cli2` | 0.24.0 | MIT; development tool only. |

PlatformIO declares pinned Adafruit ST7735/ST7789, GFX, and BusIO libraries in `firmware/platformio.ini`. Their redistribution notices, all transitive npm notices, and bundled native-library notices must be collected and reviewed before distributing desktop or firmware binaries. No distributable bundle was prepared in this review. The project license is [MIT](../LICENSE).

## Next Phases

The agent uses Node.js and TypeScript; firmware is planned for C++ and PlatformIO, with the MCU family confirmed as ESP8266. Clock integration depends on approval for the next phase and hardware validation described in [hardware.md](hardware.md). Installation, authorization, and startup commands are in [installation.md](installation.md).

- `sharp` 0.35.5 is required to decode compressed Spotify artwork without an
  open browser; the existing converter produces the firmware asset. Sharp is
  Apache-2.0 licensed and its bundled libvips and image libraries carry their own
  licenses and notices, which must be reviewed before distribution.
