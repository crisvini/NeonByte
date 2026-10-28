# NeonByte

NeonByte is an open-source project planned for a JUZIPi SD PRO Wi-Fi display and a desktop agent that reads Spotify playback. The device is intended to have two screens: Spotify Now Playing and fullscreen GIF. The maintainer visually confirmed an ESP-12F / ESP8266 module; display, flash, and boot compatibility remain unverified.

## Current Status

The [daily-startup and synchronization report](docs/daily-startup-and-sync.md)
records offline Spotify/artwork fixes and a private automatic-power-on candidate.
Post-OTA startup remains explicitly verified and hardware acceptance is pending.

**Release readiness: NOT RELEASE READY.** Part 6 concluded **NO-GO**, and Part 7 physical acceptance is blocked. A complete unit-specific backup/restore procedure and independent Wi-Fi-only failed-boot recovery have not been established. No firmware has been validated on the project clock. See the [release-readiness report](docs/release-readiness.md) and [installation decision](docs/installation-go-no-go.md).

The [final OTA safety audit](docs/final-ota-safety-audit.md) records offline startup/recovery corrections, test evidence, and the remaining first-installation and return-to-stock blockers. Installation remains **NO-GO**.

The subsequent [final offline preparation](docs/final-offline-preparation.md) implements a separate authenticated return to the pinned vendor V1.0.6 while NeonByte is running. It includes failure tests, remaining risks and a [conditional physical checklist](docs/pre-installation-checklist.md). It does not provide independent boot recovery or change NO-GO.

**Phases 1, 2, and 3 are complete.** The Node.js/TypeScript Spotify agent uses OAuth PKCE, polling, and state compatible with the v1 contract. The local interface includes a responsive 240 × 240 simulator, Spotify and looping GIF previews, display modes, uploads, and demo data. Real-account OAuth validation still requires configured Spotify credentials. Phase 4 includes the native C++ core and previously compiled ESP8266 runtime adapters under provisional assumptions. The [PC-only validation](docs/offline-validation.md) connects an explicitly constructed agent client to that core through loopback HTTP v1; production LAN synchronization remains Phase 5 work. No device has been contacted, flashed, or updated. These software checks do not establish hardware compatibility.

The 240 × 240 resolution is a planning expectation, not a measurement of this unit. See [hardware investigation](docs/hardware.md) before any work that depends on the board.

On Windows 11, the maintainer reported successful automatic startup at login, hidden execution without a persistent terminal window, and Spotify reconnection after a PC restart. A separate agent-only restart, safe stop, failure-log inspection, and startup removal/restoration have not been manually verified. See the [pending Windows acceptance checklist](docs/installation.md#pending-manual-windows-acceptance).

## Planned Display Modes

| Mode | With active playback and a connected agent | Without playback or when the agent is unavailable |
|---|---|---|
| **auto** | Spotify Now Playing | Fullscreen GIF |
| **spotify** | Spotify Now Playing | Spotify waiting screen |
| **gif** | Fullscreen GIF | Fullscreen GIF |

The simulator applies the modes to its local preview; the selected mode is stored in the browser. The agent reads and normalizes playback. Firmware persistence and runtime adapters are implemented and compile-validated; physical behavior and production LAN integration remain pending.

## Repository Structure

~~~text
.
├── agent/                 # Spotify agent, dashboard, and Node.js/TypeScript simulator
├── assets/samples/        # Reserved for future samples; no assets included
├── contracts/v1/          # Contract schemas and examples
├── docs/                  # Hardware, protocol, development, and pending items
├── firmware/              # Native core and provisional ESP8266 integration
├── simulator/             # Reserved location; simulator is served by agent/src/web
├── tests/                 # v1 contract tests
├── AGENTS.md
├── PLANNING.md
└── README.md
~~~

## Validation

Use Node.js 22 or 24, the major versions exercised by CI. Package metadata declares Node.js 22 or later, but CI does not validate every supported major. On Linux, the keyring library can fall back to a nonpersistent kernel keyring when Secret Service is unavailable, so refresh-token persistence across restarts is not guaranteed. On Windows, the agent uses Credential Manager. See [development requirements and dependency notes](docs/development.md).

~~~sh
npm ci
npm ci --prefix agent
npm run lint
npm test
# or
npm run check
~~~

`npm run check` also checks language consistency, verifies types, and runs the agent tests. To authorize and start the agent, copy `.env.example` to `.env`, set `SPOTIFY_CLIENT_ID`, register the exact redirect URI in the Spotify Developer Dashboard, and run:

~~~sh
npm --prefix agent run build
npm --prefix agent run start
~~~

Open [http://localhost:8787](http://localhost:8787), connect Spotify with the button, and choose a mode. Without a valid Client ID, the agent starts with mock data; the controls can simulate play, pause, next track, and unavailability. The `auth` command remains available if you prefer to authorize without opening the interface. The refresh token is stored in the system credential manager; tokens are not written to `.env` or logs. `SPOTIFY_POLL_INTERVAL_MS` configures the polling interval (15 seconds by default). See [development](docs/development.md) and [installation](docs/installation.md) for details.

Run `npm run test:offline` for PC-only agent-to-native-core validation. It builds a host test executable and requires a C++17 compiler and OpenSSL development headers. It uses loopback networking and mock Spotify data; it does not build firmware or contact a device. See the [results and remaining gaps](docs/offline-validation.md).

## Documentation

- [Planning and phase boundaries](PLANNING.md)
- [Instructions for coding agents](AGENTS.md)
- [Hardware and unknowns](docs/hardware.md)
- [HTTP v1 contract](docs/protocol.md)
- [Development](docs/development.md)
- [Installation](docs/installation.md)
- [Recovery](docs/recovery.md)
- [Release readiness](docs/release-readiness.md)
- [License](LICENSE)
