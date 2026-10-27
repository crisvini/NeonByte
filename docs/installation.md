# Installation

**Status:** the Spotify agent and local interface with simulator are available; startup at login and firmware installation remain PENDING.

## Spotify Agent (Ubuntu WSL2 and Windows 11)

1. Install Node.js 22 or later.
2. On Ubuntu, confirm an unlocked Secret Service is accessible on the session D-Bus. On Windows, the agent uses Credential Manager.
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

Without a valid `SPOTIFY_CLIENT_ID`, the agent starts in demo mode so you can test play, pause, track changes, GIFs, and display modes without external calls. With a Client ID configured, the interface offers demo data controls. GIFs must be animated and limited to 8 MiB, 20 frames, 30 seconds total duration, 1,048,576 pixels per logical dimension or frame descriptor, and 4,194,304 pixels total across descriptors. The preview is temporary and remains in memory until the agent exits.

These instructions do not install or configure the device. Any firmware depends on hardware identification, a tested backup and restore procedure, and explicit authorization to flash.

## Firmware Preparation Boundary

[Safe first-boot preparation](safe-first-boot.md) documents the implemented maintenance/provisioning logic, validation, unresolved risks, and exact future OTA package requirements. No installation package has been generated. Public compile-check binaries have no usable recovery identity and must not be installed. Hardware, complete backup, independent Wi-Fi-only boot recovery, and filesystem-independent verified maintenance updates remain deployment blockers. Installation-related work requires separate maintainer approval.

## Optional Startup at Windows Login

The primary setup runs the agent inside Ubuntu WSL2. Windows Task Scheduler
starts a foreground `wsl.exe` command at login; no terminal needs to remain
open. Building and testing do not register a task. The Windows account and
Linux user must be the same ones used to configure the agent. Use Linux Node
and Linux dependencies in the WSL checkout. Choose this setup or Windows-native
startup, not both: the instance guard is scoped to a network namespace, so it
cannot guarantee exclusion between Windows and WSL or between distributions.

### Ubuntu WSL2

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

### Windows-Native Alternative

Use a Windows checkout, Windows Node and Credential Manager. In Windows
PowerShell, build as above and explicitly register the existing task:

~~~powershell
.\agent\startup\windows-register.ps1 -NodePath (Get-Command node.exe).Source
~~~

Use `Start-ScheduledTask -TaskName 'NeonByte Agent'` to start it. To deactivate,
stop it with `Stop-ScheduledTask -TaskName 'NeonByte Agent'` and remove it with
`Unregister-ScheduledTask -TaskName 'NeonByte Agent' -Confirm:$false`. Logs are
in `%LOCALAPPDATA%\NeonByte\agent.log`, with one previous log rotated on
launch. Do not enable both startup paths.

### Troubleshooting Startup

- Check task history, the executable and checkout paths, the built agent, and
  Linux logs. A failure before Linux starts may only appear in task history.
- Confirm Windows can reach the WSL dashboard at `http://localhost:8787` and
  that `NEONBYTE_PORT` matches the OAuth redirect URI. Localhost forwarding
  depends on the WSL networking configuration.
- Check for another agent or a process occupying port `47877` in the same
  namespace. Stop it before retrying. The dashboard port can also conflict.
- If Spotify cannot reconnect, inspect the scheduled process's user session,
  D-Bus, and keyring availability without printing credential values. Reconnect
  from the dashboard when the keyring is available.
- Changes to `.env` require restarting the agent. Never share `.env`, token
  values, or credential-store contents when reporting a problem.

The Fedora service example remains available for reference; Fedora is not a
validation target for this environment. Physical device installation remains
blocked by the requirements above.
