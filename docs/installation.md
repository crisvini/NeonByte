# Installation

**Status:** the Spotify agent and local interface with simulator are available; startup at login and firmware installation remain PENDING.

## Spotify Agent (Windows 11 and Fedora)

1. Install Node.js 22 or later.
2. On Fedora, confirm that a Secret Service session is active (GNOME Keyring or KWallet). On Windows, the agent uses the built-in Credential Manager.
3. From the repository root, install dependencies with `npm ci` and `npm ci --prefix agent`.
4. Copy `.env.example` to `.env`, set `SPOTIFY_CLIENT_ID`, and keep `SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback`. If you change the port, set `NEONBYTE_PORT` to the same value.
5. In the Spotify Developer Dashboard, register the redirect URI exactly as configured. The application uses PKCE and does not need a `client_secret`.
6. Build the agent and start the local interface:

   ~~~sh
   npm --prefix agent run build
   npm --prefix agent run start
   ~~~

   Open [http://localhost:8787](http://localhost:8787) and select **Connect Spotify**. The same server receives the OAuth return and listens only on `127.0.0.1`. The `npm --prefix agent run auth` command remains available for authorization without opening the dashboard.

The agent starts polling with the interface. The default interval is 15 seconds; adjust `SPOTIFY_POLL_INTERVAL_MS` in `.env` if needed.

The refresh token is stored in the operating system's native credential manager. If the credential manager is unavailable, authentication fails without writing the token to a file. The agent is not registered to start at login in this phase.

Without a valid `SPOTIFY_CLIENT_ID`, the agent starts in demo mode so you can test play, pause, track changes, GIFs, and display modes without external calls. With a Client ID configured, the interface offers demo data controls. GIFs must be animated and limited to 8 MiB, 20 frames, 30 seconds total duration, 1,048,576 pixels per logical dimension or frame descriptor, and 4,194,304 pixels total across descriptors. The preview is temporary and remains in memory until the agent exits.

These instructions do not install or configure the device. Any firmware depends on hardware identification, a tested backup and restore procedure, and explicit authorization to flash.
