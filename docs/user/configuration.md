# Configure NeonByte

The desktop agent reads configuration from the repository-root .env file. Use the variables below; device credentials use the operating system credential manager instead.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| **SPOTIFY_CLIENT_ID** | Empty or the example placeholder | Public Client ID from your Spotify Developer app. |
| **SPOTIFY_REDIRECT_URI** | `http://127.0.0.1:8787/callback` | OAuth callback registered with Spotify. The redirect IP and path must match exactly. |
| **NEONBYTE_PORT** | 8787 | Local dashboard and OAuth callback port. Must match the port in SPOTIFY_REDIRECT_URI. |
| **SPOTIFY_POLL_INTERVAL_MS** | 15000 | Interval between current-playback checks. |
| **SPOTIFY_REQUEST_TIMEOUT_MS** | 10000 | Timeout for Spotify requests. |
| **SPOTIFY_RECONNECT_MAX_INTERVAL_MS** | 60000 | Maximum reconnect delay after a Spotify request fails. |
| **NEONBYTE_AGENT_TIMEOUT_MS** | 45000 | Freshness timeout for the dashboard's local playback preview. This does not change the firmware's own timeout. |

The three Spotify timing values and the preview timeout must be at least 1,000 milliseconds. The dashboard port must be between 1 and 65,535 and must match the callback port. Restart the agent after changing .env.

Do not put Spotify access tokens, refresh tokens, a Spotify client secret, Wi-Fi passwords, or device pairing tokens in .env. The repository's example uses placeholders. The agent stores the Spotify refresh token and device configuration separately in the operating system credential manager.

## Connect an existing device

This procedure configures a device that already runs compatible NeonByte firmware. It does not install firmware or configure the device's Wi-Fi.

1. Stop the running agent. The foreground configuration command needs its exclusive instance lock.
2. From the repository root, build the agent if it has not been built:

   ~~~powershell
   npm --prefix agent run build
   ~~~

3. Enter the device address, pairing token, and whether synchronization should be enabled:

   ~~~powershell
   node .\agent\dist\main.js configure-device
   ~~~

   The token prompt is hidden. Choose **yes** only when you are ready to allow the agent to send updates. The command verifies the saved configuration in the credential manager.

4. Restart the agent, open [the local dashboard](http://localhost:8787), and check **Device connection settings**. The panel can change the address and enable or disable an existing connection; it does not accept the pairing token in the browser.

Use the device's current private IPv4 address. The agent does not discover devices automatically. Its local HTTP traffic is unencrypted, so use a trusted network. Public addresses, host names, and IPv4 link-local addresses are rejected. A changed address may require updating the device credential entry with the foreground command.

The device must already have the correct private credentials for its maintenance routes. Those credentials are distinct from the application pairing token. See the [hardware evidence](../hardware.md), [recovery limits](../recovery.md), and [maintenance implementation](../windows-dashboard-ota.md) before attempting any firmware or provisioning operation.
