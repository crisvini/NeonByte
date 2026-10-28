# Installation

**Status (2026-10-27): NOT RELEASE READY.** The agent and local interface are available. The maintainer reported successful Windows 11 login startup, hidden execution, and Spotify reconnection after a Windows restart. Separate agent-only restart, safe stop, failure-log inspection, and task removal/restoration remain unverified. Part 6 is **NO-GO** and Part 7 is blocked; these instructions cover the desktop agent only and do not authorize firmware installation. See the [release-readiness report](release-readiness.md).

## Spotify Agent (Windows 11)

1. Install Node.js 22 or 24, the major versions exercised by CI. Package engine metadata requires Node.js 22 or later; CI does not validate every supported major.
2. Use a Windows checkout, Windows Node.js, and Windows Credential Manager. Ubuntu WSL2 is for development; install dependencies separately in each environment.
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

The refresh token is stored through the native keyring library, not in a plaintext token file. On Linux, the installed library may silently fall back to a nonpersistent kernel keyring if Secret Service is unavailable; reconnecting after a restart is therefore not guaranteed. Login startup is optional; see the instructions below.

Without a valid `SPOTIFY_CLIENT_ID`, the agent starts in demo mode so you can test play, pause, track changes, GIFs, and display modes without external calls. With a Client ID configured, the interface offers demo data controls. GIFs must be animated and limited to 8 MiB, 60 frames for NBIF v2 (20 for v1), 30 seconds total duration, 1,048,576 pixels per logical screen or frame descriptor, and 16,777,216 pixels total across v2 descriptors. Conversion runs in a bounded worker. The preview is temporary and remains in memory until the agent exits.

The `.env.example` file contains a placeholder Client ID and enables demo data; the placeholder is treated as unconfigured. Copying it supports a first run without Spotify credentials. Replace the Client ID and select **Connect Spotify** to authorize a real account. Because the sample enables `NEONBYTE_MOCK`, turn off **Demo data** in the interface after authorization to use Spotify playback. The Spotify credential store persists only the refresh token through Windows Credential Manager under the Windows account that runs the agent; access tokens remain in memory. Device synchronization settings are stored separately in the system credential manager. Do not put access tokens, refresh tokens, or a Spotify client secret in `.env`.

These instructions do not install or configure the device. Any firmware depends on hardware identification, a tested backup and restore procedure, and explicit authorization to flash.

## Firmware Preparation Boundary

[Safe first-boot preparation](safe-first-boot.md) documents the implemented maintenance/provisioning logic, validation, unresolved risks, and exact future OTA package requirements. The maintenance-only raw staging path is implemented and host/compile validated, but has not been exercised on a device. A confidential private image exists, but it has no inbox-compatible manifest or installation approval because live device identity/resources and hardware gates remain pending. Public compile-check binaries have no usable recovery identity and must not be installed. Hardware, complete backup, independent Wi-Fi-only boot recovery, and spare-device validation remain deployment blockers. Installation-related work requires separate maintainer approval.

The [Windows dashboard OTA procedure](windows-dashboard-ota.md) describes the protected inbox, foreground credential commands, final confirmation, read-only reboot verification, manual DHCP correction, and explicit application startup. It documents the offline implementation only; it does not provide an installable image or authorize a device update.

## Optional Startup at Windows Login

Run the agent natively on Windows. Startup is opt-in; installation and tests do
not register a scheduled task. Do not enable the optional WSL2 startup path at
the same time: the instance guard cannot guarantee exclusion across separate
network namespaces.

### Windows-Native Startup

In Windows PowerShell, from the Windows checkout, install and build the agent:

~~~powershell
npm ci
npm ci --prefix agent
npm --prefix agent run build
~~~

Copy `.env.example` to `.env`, configure your Spotify client ID and redirect,
then start manually once with `npm --prefix agent run start`. Open
[http://localhost:8787](http://localhost:8787) and connect Spotify. Stop the
manual agent before enabling startup. Demo mode needs no Spotify credentials.

To opt in or update an existing `NeonByte Agent` task, stop any running task
and agent first, then run this command from the same checkout and Windows
account. Registration replaces the existing task with the same name:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent\startup\windows-register.ps1 -NodePath (Get-Command node.exe).Source
~~~

The task `NeonByte Agent` starts at user login under the interactive user, uses
a windowless WScript launcher, ignores overlapping task launches, and retries
failure up to three times. Keep the checkout and Node paths stable. Start it
now with `Start-ScheduledTask -TaskName 'NeonByte Agent'`. To apply an update,
run `Stop-ScheduledTask -TaskName 'NeonByte Agent'` before registration,
confirm the agent has exited, then start the task again. The agent also
rejects another instance on `127.0.0.1:47877` in the same network namespace.

Logs are in `%LOCALAPPDATA%\NeonByte\agent.log`. One previous log is kept
when the current log exceeds 1 MiB at launch. The launcher records standard
output and errors; avoid sharing logs without checking them. Failures before
logging starts may appear only in Task Scheduler history. Changes to `.env`
require a restart. Task Scheduler can forcibly stop the agent; confirm the
process has exited before restarting it. Verify on Windows that starting,
stopping, and restarting the task leaves no terminal window or orphaned agent
process; forced termination can interrupt shutdown.

To uninstall startup, stop and unregister the task:

~~~powershell
Stop-ScheduledTask -TaskName 'NeonByte Agent'
Unregister-ScheduledTask -TaskName 'NeonByte Agent' -Confirm:$false
~~~

This does not remove the checkout, `.env`, logs, or stored credentials. Remove
those separately if desired, using Windows Credential Manager for stored
NeonByte credentials. Windows Credential Manager and the scheduled task must
use the same Windows user profile. The maintainer confirmed Windows 11 automatic
startup, hidden execution, and Spotify reconnection after restart; see the
[manual validation record](../PLANNING.md#phase-6--automatic-startup-distribution-and-quality)
for the remaining shutdown, logging, removal, and agent-only restart checks.

### Pending Manual Windows Acceptance

The checks below require the maintainer to run them on Windows 11 with the same user account that authorized Spotify. They are not covered by the synthetic launcher tests or by the reported PC restart test. Keep each item unchecked until it has been performed and reported.

- [ ] With the PC session left running, stop and restart only the `NeonByte Agent` task; confirm Spotify reconnects without repeating OAuth authorization.
- [ ] Stop the task, confirm the agent process exits and `http://localhost:8787` stops responding, then start it again; check for leftover processes or a terminal window.
- [ ] Inspect `%LOCALAPPDATA%\NeonByte\agent.log` locally after a safe startup failure; confirm the error is useful and no token or credential value appears. Do not share the log without reviewing it.
- [ ] Start the task again while the agent is already running; confirm only one agent process remains active and the running session is not disrupted.
- [ ] If startup was enabled, unregister the task, confirm login no longer starts the agent, then restore it with the documented registration command and confirm the task has the expected account, trigger, and launch paths.

### Optional Ubuntu WSL2 Startup

1. In Ubuntu, run `npm ci`, `npm ci --prefix agent`, and
   `npm --prefix agent run build` from the checkout. Record the absolute paths
   from `pwd` and `command -v node`, and the Linux username from `id -un`.
   The scheduler launcher currently accepts only paths without spaces and
   simple distribution and user names. Keep these paths stable.
2. In Windows PowerShell, run `wsl --list --verbose` and record the exact
   Ubuntu distribution name. Confirm the distribution uses WSL 2.
3. Copy `agent/startup/windows-wsl-launch.ps1` to a stable Windows path, such
   as `C:\Users\YOUR_WINDOWS_USER\NeonByte\windows-wsl-launch.ps1`.
   This avoids depending on a WSL network share to launch the distribution.
4. In Task Scheduler, create a task named `NeonByte Agent WSL` for your Windows
   account. Select **Run only when user is logged on**, add an **At log on**
   trigger for that user, and choose **Do not start a new instance** under
   Settings. Disable the time limit that stops a long-running task. Optionally
   enable restart on failure with a bounded retry count.
5. Set the action program to `powershell.exe`. Set its arguments to the
   following, replacing every placeholder. The first path is the Windows copy
   of the PowerShell launcher; the other two paths are Linux paths. Keep the
   quotes around the Windows path.

   ~~~text
   -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\YOUR_WINDOWS_USER\NeonByte\windows-wsl-launch.ps1" -Distribution Ubuntu -LinuxUser USER -CheckoutPath /home/USER/NeonByte -NodePath /absolute/path/to/node
   ~~~

6. Save the task only when you opt in. Run it from Task Scheduler and inspect
   its history and `~/.local/state/neonbyte/agent.log` in Ubuntu. The log
   directory follows `XDG_STATE_HOME` when set; it uses private permissions.
   A previous log is retained when the current log exceeds 1 MiB at launch.
   Open `http://localhost:8787` in Windows and validate demo operation.
7. To deactivate, disable the task in Task Scheduler. Stop a running task as
   well, and verify the Linux agent has exited; stopping the Windows task or
   shutting down WSL may terminate processes abruptly. Remove the task in Task
   Scheduler when no longer needed. A Linux SIGTERM permits clean shutdown.

The Windows process remains attached to the Linux agent. Task Scheduler can
restart it if it exits with a failure, but forced WSL shutdown, Windows logoff,
sleep, and failures during WSL startup must be checked on the target machine.
The loopback instance guard prevents duplicate agents in the same WSL network
namespace and is released by the OS after termination. A port conflict on
`127.0.0.1:47877` also prevents startup.

**Credentials:** Linux uses a Linux keyring, not Windows Credential Manager. The installed
keyring library prefers Secret Service on a session D-Bus but can silently
fall back to the nonpersistent kernel keyring; the current code does not
reliably enforce its requested Secret Service backend. A scheduled `wsl.exe` invocation does not guarantee a
user session, an accessible bus, or an unlocked keyring. The current session
must have a working Secret Service and the scheduled process must inherit a
usable bus address; an unlock prompt may require interaction. Verify Spotify
reconnection after a real Windows login and after a lock or sleep. The agent does not fall back to a plaintext token file. Use demo mode or
the Windows-native alternative until persistent credential access in the
scheduled session has been verified. Do not put credentials or unlock passwords in the task,
script, service file, or logs.

**Systemd:** this foreground launcher does not require systemd or lingering.
Systemd being PID 1 does not by itself start a user manager, provide an unlocked
keyring, or start WSL at Windows login. A systemd user service requires a
working user manager and session bus, and may need lingering depending on the
session; enabling these changes system settings and is outside this procedure.
Microsoft notes that systemd services alone do not keep WSL running. See
[Microsoft's systemd guidance](https://learn.microsoft.com/en-us/windows/wsl/systemd),
[WSL commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands),
and [localhost networking](https://learn.microsoft.com/en-us/windows/wsl/networking).

### Troubleshooting Startup

- Check task history, the Windows executable and checkout paths, the built
  agent, and `%LOCALAPPDATA%\NeonByte\agent.log`.
- Confirm the dashboard opens at `http://localhost:8787` and that
  `NEONBYTE_PORT` matches the OAuth redirect URI.
- Check for another agent or a process occupying port `47877` in the same
  namespace. Stop it before retrying. The dashboard port can also conflict.
- If Spotify cannot reconnect, confirm the task runs as the same Windows user
  who connected Spotify, then reconnect from the dashboard if needed.
- Changes to `.env` require restarting the agent. Never share `.env`, token
  values, or credential-store contents when reporting a problem.

The Fedora service example remains available for reference; Fedora is not a
validation target for this environment. Physical device installation remains
blocked by the requirements above.
