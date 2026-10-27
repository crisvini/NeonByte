# Development

## Repository Status

Phases 1 through 3 are complete: documentation, the v1 contract, the Spotify agent, and the local interface with a 240 × 240 simulator. The interface uses the agent's state and works with either a Spotify account or demo data, without a connected device. `firmware/` contains a native core and provisional ESP8266 build profiles. The module is visually confirmed as ESP-12F / ESP8266; actual display settings, performance, flash capacity, and recovery remain PENDING. See [firmware development](firmware-development.md).

## Current Requirements and Commands

- Node.js 22 or later for linting and testing tools.
- npm compatible with the installed Node.js version.
- `npm ci` installs the root lint and contract tools.
- `npm ci --prefix agent` installs the agent, native credential-store, and GIF decoder dependencies.
- `npm run lint` checks Markdown files.
- `npm run language:check` checks for high-confidence Portuguese content in project text and source files.
- `npm test` runs contract tests with the native Node.js test runner.
- `npm --prefix agent run build` compiles the TypeScript agent and copies static dashboard files.
- `npm --prefix agent test` runs unit and integration tests with mocked fetch and providers.
- `npm run check` runs lint, language checks, contract tests, the TypeScript build, type checks, and agent tests; `make check` is an equivalent shortcut.
- `npm run test:offline` compiles a host executable and exercises the agent against the native firmware core over loopback HTTP v1. A C++17 compiler and OpenSSL development headers/libcrypto are required; no device or Spotify credentials are used. See [offline validation](offline-validation.md) for results and limits.

Agent tests cover PKCE, the loopback callback, refresh, normalization, 204/401/429 responses, reconnects, caching, the simulator, display modes, uploads, media conversion, limits, and checksums. They do not call the Spotify Web API or validate a real account or hardware.

## Local Interface and Simulator

With `.env` configured (or without a valid Spotify Client ID to start the demo), run `npm --prefix agent run build` and `npm --prefix agent run start`. Open [http://localhost:8787](http://localhost:8787). The server binds only to `127.0.0.1`; `NEONBYTE_PORT` must match the port in `SPOTIFY_REDIRECT_URI` so the OAuth callback returns to the same server. The dashboard can connect Spotify, select `auto`, `spotify`, or `gif`, simulate play/pause/track changes/offline state, and upload a GIF.

The simulator keeps its logical composition at 240 × 240 and scales the canvas responsively with CSS. `auto` selects Spotify only when the agent's recent state confirms playback. Manual Spotify mode shows a waiting state without a track; GIF mode and the `auto` fallback fill the entire frame with the animation. The clock status always reads “simulation without a device”; Phase 3 does not connect to the physical unit.

### Simulator Media Intermediate Format

The agent uses `gifuct-js` 2.1.2 (MIT) to read GIF frames. The preview format is now accepted by the provisional firmware v1 binary routes, with hardware performance still unverified:

- `NBIF` (animation): bytes `NBIF`, version `1` (u8), width and height `240` (u16 little-endian), frame count (u16 little-endian); then each frame contains a delay in milliseconds (u16 little-endian) followed by 240 × 240 RGB565 pixels in little-endian order.
- `NBIC` (cover): bytes `NBIC`, version `1` (u8), width and height `240` (u16 little-endian), followed by 240 × 240 RGB565 pixels in little-endian order.
- The lowercase hexadecimal SHA-256 covers the complete intermediate file, including its header and frame timings.
- GIF limits: 8 MiB, 20 frames, 1,048,576 pixels per logical dimension or frame descriptor, 4,194,304 pixels total across descriptors, and 30 seconds of total duration. Descriptors are limited before decompression. A frame delay below 20 ms is set to 20 ms; a zero delay is set to 100 ms. The scaling policy is `cover` with a centered crop. GIF disposal method 2 restores the global background color while preserving transparency when the background index matches the transparent index.

Converted GIFs and covers remain in memory for the local session and are discarded when the agent exits. The limits and format exist for the preview and must be reviewed against measured flash, RAM, and speed before any firmware integration. The decoder package is documented at [gifuct-js](https://github.com/matt-way/gifuct-js).

## Conventions

- Use UTF-8, LF, and kebab-case filenames for documentation.
- Keep schemas and examples in `contracts/v1/` aligned with `docs/protocol.md`.
- The agent stores refresh tokens in the operating system's native credential manager and has no fallback to local files. On Linux, the adapter requires Secret Service for persistence across restarts.
- The `@napi-rs/keyring` 1.3.0 runtime dependency is MIT-licensed; upstream publishes notices for bundled libraries, including `libdbus` (AFL-2.1 or GPL-2.0-or-later in the Linux binary). Review upstream notices before redistributing binaries.
- The agent calls only `GET /me/player/currently-playing` with the `user-read-currently-playing` scope.
- `PlaybackPoller.currentSnapshot` and `subscribe()` form the in-process local interface for future consumers; it does not open a network port or transport tokens.
- The Spotify cover URL remains internal agent metadata. The dashboard fetches the image only from the permitted media host and converts it for the preview; sending it to the device is for a later phase.
- `gifuct-js` 2.1.2 is MIT-licensed; the original demo vector asset is covered by this repository's MIT license. The package's license files remain in `agent/node_modules` after installation.
- Firmware language and build configuration depend on hardware identification.

## Next Phases

The agent uses Node.js and TypeScript; firmware is planned for C++ and PlatformIO, with the MCU family confirmed as ESP8266. Clock integration depends on approval for the next phase and hardware validation described in [hardware.md](hardware.md). Installation, authorization, and startup commands are in [installation.md](installation.md).
