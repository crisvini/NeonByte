# NeonByte

NeonByte is an open-source project planned for a JUZIPi SD PRO Wi-Fi display and a desktop agent that reads Spotify playback. The device is intended to have two screens: Spotify Now Playing and fullscreen GIF. The specific hardware unit has not yet been identified.

## Current Status

**Phases 1, 2, and 3 are complete.** The Node.js/TypeScript Spotify agent uses OAuth PKCE, polling, and state compatible with the v1 contract. The local interface includes a responsive 240 × 240 simulator, Spotify and looping GIF previews, display modes, uploads, and demo data. Real-account OAuth validation still requires configured Spotify credentials. The physical clock, firmware, and device synchronization have not been implemented; no firmware has been compiled or flashed.

The 240 × 240 resolution is a planning expectation, not a measurement of this unit. See [hardware investigation](docs/hardware.md) before any work that depends on the board.

## Planned Display Modes

| Mode | With active playback and a connected agent | Without playback or when the agent is unavailable |
|---|---|---|
| **auto** | Spotify Now Playing | Fullscreen GIF |
| **spotify** | Spotify Now Playing | Spotify waiting screen |
| **gif** | Fullscreen GIF | Fullscreen GIF |

The simulator applies the modes to its local preview; the selected mode is stored in the browser. The agent reads and normalizes playback. Persistence on the device and clock integration have not been implemented.

## Repository Structure

~~~text
.
├── agent/                 # Spotify agent, dashboard, and Node.js/TypeScript simulator
├── assets/samples/        # Reserved for future samples; no assets included
├── contracts/v1/          # Contract schemas and examples
├── docs/                  # Hardware, protocol, development, and pending items
├── firmware/              # Reserved structure; hardware not yet confirmed
├── simulator/             # Reserved location; simulator is served by agent/src/web
├── tests/                 # v1 contract tests
├── AGENTS.md
├── PLANNING.md
└── README.md
~~~

## Validation

Node.js 22 or later is required. On Fedora, a Secret Service session (for example, GNOME Keyring or KWallet) must be available to persist the refresh token. On Windows, the agent uses Credential Manager.

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

## Documentation

- [Planning and phase boundaries](PLANNING.md)
- [Instructions for coding agents](AGENTS.md)
- [Hardware and unknowns](docs/hardware.md)
- [HTTP v1 contract](docs/protocol.md)
- [Development](docs/development.md)
- [Installation](docs/installation.md)
- [Recovery](docs/recovery.md)
