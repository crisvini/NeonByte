# Troubleshoot NeonByte

Start by checking that the agent is running in the same Windows user session that installed the dependencies and authorized Spotify. For Windows startup tasks, see [installation](../installation.md). Keep .env, tokens, and credential-manager contents private.

## Installation or build fails

- Confirm that Node.js 22 or 24 is installed and available in PowerShell: node --version and npm --version.
- Run npm ci and npm ci --prefix agent from the repository root, then run npm --prefix agent run build.
- If .env exists already, do not overwrite it while copying the example. Check that it contains a real SPOTIFY_CLIENT_ID, not the example placeholder.
- If dependencies fail to install, record the Node.js and npm versions and the exact error text. Do not include environment values.

## Dashboard does not open

- Confirm the agent is running and open [http://localhost:8787](http://localhost:8787) on the same computer.
- Ensure NEONBYTE_PORT matches the port in SPOTIFY_REDIRECT_URI. Both use 8787 by default.
- If startup reports that another agent is running or its instance port is unavailable, check for an existing NeonByte process. The agent also reserves loopback port 47877 to prevent a second instance in the same network namespace.
- Changes to .env take effect after an agent restart.

## Spotify does not connect or show a track

- Confirm the Spotify app has the exact redirect URI `http://127.0.0.1:8787/callback`, the same Client ID is in `.env`, and the panel and callback use the same port.
- Spotify requires the owner of a Development Mode app to have Premium. Confirm the account is allowed to use the app; Development Mode currently permits up to five authorized users.
- Use **Connect Spotify** in the panel. If you run npm --prefix agent run auth instead, stop the dashboard first so the command can open the callback listener.
- If authorization was revoked or the refresh token was removed, authorize again. A 204 current-playback response means Spotify has no current track; it is not an authentication failure.
- Spotify API outages and rate limits are retried. The panel may report unavailable playback until a later request succeeds.

## Device is disconnected

- Confirm that the device already runs compatible NeonByte firmware and is powered on and reachable on the same trusted local network.
- Check the device's current private IPv4 address. The agent does not discover it automatically and rejects public IPs, host names, and IPv4 link-local addresses.
- Open **Device connection settings** and confirm the address and **Enable device connection** setting. The pairing token is entered with node .\agent\dist\main.js configure-device in a foreground terminal while the agent is stopped; it cannot be entered in the browser.
- If the address changed or the firmware identity differs, do not guess credentials or repeat an update. Review [hardware evidence](../hardware.md) and [recovery limits](../recovery.md).
- The device link uses unencrypted HTTP. Do not expose it to the Internet or an untrusted network.

## GIF is rejected or replacement fails

- Choose a GIF within the input, frame, duration, pixel, and encoded-size limits in [GIF usage](usage.md#prepare-and-replace-a-gif). One frame is allowed.
- Wait for local conversion to complete before previewing or replacing. The conversion worker has a bounded runtime and can reject files that exceed supported descriptors or memory limits.
- A v2 device must report compatible media capabilities and enough free storage for the animation plus the 32 KiB reserve. Firmware may advertise fewer than 60 frames.
- The panel removes the installed animation before the confirmed replacement transfer. If cancellation, connection loss, insufficient space, or validation failure occurs after removal, the previous animation is gone. Retry the prepared animation while the agent is still running; select a smaller GIF if the storage check fails.
- The local preview is held in memory. If the agent exits, select and prepare the original GIF again.

## Share a support report safely

Include the operating system, Node.js and npm versions, command or dashboard action, a sanitized error message, and whether the problem is with Spotify, the agent, a local preview, or a physical device. For a GIF failure, include its file size, frame count, duration, and dimensions if known.

Review logs and screenshots before sharing. Remove Client IDs if your organization treats them as private; always remove OAuth URLs and codes, access and refresh tokens, .env values, pairing and recovery credentials, Wi-Fi details, private IP addresses, and credential-manager contents. Do not attach the GIF if it contains private material.
