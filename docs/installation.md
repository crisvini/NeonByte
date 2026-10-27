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

The refresh token is stored in the operating system's native credential manager. If the credential manager is unavailable, authentication fails without writing the token to a file. Login startup is optional; see the instructions below.

Without a valid `SPOTIFY_CLIENT_ID`, the agent starts in demo mode so you can test play, pause, track changes, GIFs, and display modes without external calls. With a Client ID configured, the interface offers demo data controls. GIFs must be animated and limited to 8 MiB, 20 frames, 30 seconds total duration, 1,048,576 pixels per logical dimension or frame descriptor, and 4,194,304 pixels total across descriptors. The preview is temporary and remains in memory until the agent exits.

These instructions do not install or configure the device. Any firmware depends on hardware identification, a tested backup and restore procedure, and explicit authorization to flash.

## Firmware Preparation Boundary

[Safe first-boot preparation](safe-first-boot.md) documents the implemented maintenance/provisioning logic, validation, unresolved risks, and exact future OTA package requirements. No installation package has been generated. Public compile-check binaries have no usable recovery identity and must not be installed. Hardware, complete backup, independent Wi-Fi-only boot recovery, and filesystem-independent verified maintenance updates remain deployment blockers. Installation-related work requires separate maintainer approval.

## Optional Startup at Login

Startup is opt-in. Install dependencies and build as above on the operating
system that will run the agent. Windows and WSL are separate environments:
choose one, and use its own Node installation, dependencies, paths, credential
manager, and `.env`. A Windows login task does not imply that WSL is running;
the Windows procedure below runs the Windows agent. Fedora instructions apply
only to a Linux user session with systemd and Secret Service available. No
startup settings are changed by building or testing.

### Windows 11 Task Scheduler

In Windows PowerShell, from a Windows checkout, build the agent and pass the
absolute path to Windows `node.exe` to the registration script:

~~~powershell
npm ci
npm ci --prefix agent
npm --prefix agent run build
.\agent\startup\windows-register.ps1 -NodePath (Get-Command node.exe).Source
~~~

This creates `NeonByte Agent` for the current user's login, with no persistent
terminal window. It ignores overlapping task launches and retries failures up to
three times. Keep the checkout and Node path stable. To start it now, use
`Start-ScheduledTask -TaskName 'NeonByte Agent'`; to deactivate and remove it,
run `Unregister-ScheduledTask -TaskName 'NeonByte Agent' -Confirm:$false`.
Stop a running task first with `Stop-ScheduledTask -TaskName 'NeonByte Agent'`.
Task Scheduler may forcibly terminate processes; the OS releases the instance
port on termination and the next launch can start normally.

Logs are in `%LOCALAPPDATA%\NeonByte\agent.log`, with one previous log rotated
on launch once the current log exceeds 1 MiB. Restrict access to your Windows
account. The agent logs status and generic errors, not credentials. Do not put
secrets in diagnostic messages or share `.env` or credential-store contents.

### Fedora systemd user service

Copy `agent/startup/neonbyte.service.example` to
`~/.config/systemd/user/neonbyte.service`, replacing each placeholder with an
absolute path for the Linux checkout and Node executable. Use paths without
spaces or apply systemd unit escaping. Then run:

~~~sh
systemctl --user daemon-reload
systemctl --user enable --now neonbyte.service
~~~

Use `systemctl --user disable --now neonbyte.service` to deactivate it and
`journalctl --user -u neonbyte.service` to inspect logs. The service restarts
on failure. It runs in the user session and needs an accessible Secret Service
session for Spotify credentials; no credentials belong in the unit file.

### Troubleshooting Startup

- Check Task Scheduler history or `systemctl --user status neonbyte.service`,
  then inspect the local logs. Confirm the Node executable, built files, and
  `.env` paths still exist and that the OAuth redirect port matches the dashboard.
- Only one agent can bind the local instance port `127.0.0.1:47877` in a
  given network namespace. Stop the other agent or resolve a port conflict.
  Windows and WSL can have different network namespaces; do not enable both.
- If Spotify needs authorization, open the dashboard in the same environment
  and reconnect. A locked or unavailable credential manager prevents token access.
- Changes to `.env` require a restart. Stop the existing agent before starting
  another; on Linux SIGTERM and SIGINT request a clean shutdown.
- Login startup, credential availability, and restart behavior still require
  testing on the actual target desktop and user session.
