# Install the NeonByte desktop agent

These steps install the agent and local dashboard on Windows 11. They do not install firmware on a display.

## Requirements

- Windows 11 and Windows PowerShell.
- Node.js 22 or 24 with npm. These are the major versions exercised by CI; package metadata requires Node.js 22 or later.
- Git and an Internet connection for downloading dependencies and using Spotify.

Run the agent with Windows-native Node.js under the Windows account that will authorize Spotify. WSL2 is optional and has separate credential requirements described below.

## Install and start

1. Open PowerShell and clone the repository, or open PowerShell in an existing NeonByte checkout:

   ~~~powershell
   git clone https://github.com/crisvini/NeonByte.git
   Set-Location NeonByte
   ~~~

2. Install the locked root and agent dependencies from the repository root:

   ~~~powershell
   npm ci
   npm ci --prefix agent
   ~~~

3. Create the repository-root .env file from the example only if one does not already exist:

   ~~~powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ~~~

4. Follow [Spotify setup](user/spotify.md) to set SPOTIFY_CLIENT_ID and register the exact callback. If needed, adjust the port settings using the [configuration guide](user/configuration.md).
5. Build the dashboard assets and agent:

   ~~~powershell
   npm --prefix agent run build
   ~~~

6. Start the agent:

   ~~~powershell
   npm --prefix agent run start
   ~~~

7. Open [http://localhost:8787](http://localhost:8787) in a browser. Select **Connect Spotify** after setup. The panel can run without Spotify authorization, but playback will be shown as unconfigured or unavailable; it does not invent sample tracks.

Keep the terminal open while using this foreground launch. Press Ctrl+C to stop it.

## Optional startup at Windows login

Startup is opt-in and applies to the interactive Windows account that runs the task. Starting or testing the agent does not register a task.

Stop any foreground agent before registering startup. From PowerShell at the repository root, run:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\agent\startup\windows-register.ps1 -NodePath (Get-Command node.exe).Source
~~~

This creates or replaces a task named **NeonByte Agent**. It starts at user login, runs without a persistent terminal window, ignores overlapping task launches, and retries a failed launch up to three times. Keep the checkout and Node.js paths stable. To start it now:

~~~powershell
Start-ScheduledTask -TaskName 'NeonByte Agent'
~~~

Windows 11 login startup, hidden execution, and reconnection to Spotify after a PC restart were reported by the maintainer. Other task shutdown and log-handling cases have not all been manually verified. The task and Windows Credential Manager use the same user account.

The launcher writes logs to %LOCALAPPDATA%\NeonByte\agent.log. When a log exceeds 1 MiB at launch, one previous log is retained. Failures before logging starts may appear only in Task Scheduler history. Review logs before sharing them.

To update the agent, stop the task and confirm the web panel has stopped responding, install any changed dependencies, rebuild, and start the task again:

~~~powershell
Stop-ScheduledTask -TaskName 'NeonByte Agent'
npm ci
npm ci --prefix agent
npm --prefix agent run build
Start-ScheduledTask -TaskName 'NeonByte Agent'
~~~

Changes to .env require restarting the agent. Task Scheduler can terminate a process abruptly; check that the previous process has exited before starting it again.

To remove automatic startup:

~~~powershell
Stop-ScheduledTask -TaskName 'NeonByte Agent'
Unregister-ScheduledTask -TaskName 'NeonByte Agent' -Confirm:$false
~~~

This removes the scheduled task only. The checkout, .env file, logs, local display-mode settings, and saved credentials remain on the computer. Remove these separately if desired. See [Spotify disconnection](user/spotify.md#playback-and-reconnection) for revoking Spotify access and removing its saved refresh token.

## Optional Ubuntu WSL2 startup

WSL2 startup is an optional reference. The agent must be installed separately in the Linux checkout; Windows Node.js dependencies and credentials are not shared. The instance guard cannot reliably prevent simultaneous agents across separate Windows and WSL network namespaces. Do not enable both startup tasks at once.

1. In the Ubuntu checkout, install dependencies and build. Record the absolute checkout path, Node.js path, Linux username, and WSL distribution name. The launcher currently accepts only paths without spaces and simple distribution and user names.

   ~~~sh
   npm ci
   npm ci --prefix agent
   npm --prefix agent run build
   pwd
   command -v node
   id -un
   ~~~

2. In Windows PowerShell, run wsl --list --verbose and confirm that the intended Ubuntu distribution uses WSL 2.
3. Copy agent/startup/windows-wsl-launch.ps1 to a stable Windows path. In Task Scheduler, create a **NeonByte Agent WSL** task for the interactive user, triggered **At log on**, with **Do not start a new instance** selected and no run-time limit.
4. Set powershell.exe as the program and use the following arguments, replacing the placeholders:

   ~~~text
   -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "C:\Users\YOUR_WINDOWS_USER\NeonByte\windows-wsl-launch.ps1" -Distribution Ubuntu -LinuxUser USER -CheckoutPath /home/USER/NeonByte -NodePath /absolute/path/to/node
   ~~~

5. Verify that the task starts the agent and that the panel opens at [http://localhost:8787](http://localhost:8787) without sample playback. Check its history and the Linux log at `~/.local/state/neonbyte/agent.log`, or `$XDG_STATE_HOME/neonbyte/agent.log` when `XDG_STATE_HOME` is set. The log directory uses private permissions; one previous log is retained when the current file exceeds 1 MiB at launch.
6. To remove this startup, stop the task, verify the Linux agent has exited, and remove or disable **NeonByte Agent WSL** in Task Scheduler. Forced WSL shutdown or Windows logoff can interrupt agent shutdown.

Linux uses its Linux keyring rather than Windows Credential Manager. Secret Service may be unavailable or locked in a scheduled WSL session, and the installed keyring library may fall back to a nonpersistent kernel keyring. The agent has no plaintext token-file fallback. Reliable Spotify reconnection after WSL restart, sleep, or lock has not been established; use Windows-native Node.js for the supported primary path.

## Device installation boundary

This guide installs the desktop software only. The ESP8266 build environments use provisional hardware assumptions and are compilation checks, not firmware images approved for installation. A successful build does not establish compatibility with the display.

A general first-install procedure, complete unit-specific backup and restore, and independent Wi-Fi recovery after a failed boot have not been established. See [hardware evidence](hardware.md) and [recovery limits](recovery.md). Do not use public compile-check binaries or attempt a firmware update as a way to identify the hardware.
