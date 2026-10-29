# Connect Spotify

NeonByte reads the currently playing Spotify track so the dashboard and a configured display can show its artwork, title, and artist. It does not play audio or control Spotify.

## Create a Spotify Developer app

1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Add this exact Redirect URI to the app's settings:

   ~~~text
   http://127.0.0.1:8787/callback
   ~~~

   Spotify accepts HTTP for an explicit loopback IP address; localhost is not an accepted redirect URI. If you choose a different port, change SPOTIFY_REDIRECT_URI and NEONBYTE_PORT to match, then register that exact URI.
3. Copy the app's **Client ID**. Do not create or use a client secret for NeonByte.
4. If Spotify shows user access management for the app, add the Spotify account you will authorize.

Spotify currently requires the owner of a Development Mode app to have Premium. Development Mode permits one Client ID per developer and up to five authorized users. These provider rules can change; see [Spotify's quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).

## Authorize your account

1. Follow [Windows installation](../installation.md) and set SPOTIFY_CLIENT_ID in the repository-root .env file.
2. Start the agent and open [http://localhost:8787](http://localhost:8787).
3. Select **Connect Spotify** and approve the requested current-playback permission in Spotify.
4. Return to the panel. A connected state confirms authorization; track information appears when Spotify reports an active track.

The app uses Authorization Code with PKCE and requests only user-read-currently-playing. The short-lived access token stays in memory. The refresh token is stored in the operating system credential manager for the same user account that runs the agent. It is not written to .env or application logs. On Linux and WSL, persistence depends on the available Secret Service/keyring session and is not guaranteed; Windows 11 with Windows Credential Manager is the documented primary setup.

## Playback and reconnection

- While Spotify is playing a supported track, NeonByte reads its title, artists, and album artwork.
- A Spotify 204 response means there is no current track. In auto mode the device returns to its GIF scene; in spotify mode it shows a waiting state.
- A pause, temporary network failure, expired authorization, and rate limit are different states. The agent retries temporary failures, honors Spotify's retry delay, and asks you to authorize again if the refresh grant is revoked.
- The Web API integration handles track items. Podcasts or other items without a supported track are not displayed as a track.
- Reconnecting after a restart uses the stored refresh token under the same operating system account. If it was removed or revoked, connect Spotify again from the panel.

The dashboard has a **Connect Spotify** button and no disconnect button. To disconnect, stop the agent, remove NeonByte's access in [your Spotify app connections](https://www.spotify.com/account/apps/), and remove its stored `NeonByte` / `spotify-refresh-token` credential from the operating system's credential store if you also want to erase the local refresh token. On Windows, use Credential Manager; on Linux, use the same keyring service available to the agent. Reconnecting requires authorizing again.

Never share the Client ID together with authorization URLs, tokens, .env, or credential-manager contents when asking for help. The Client ID by itself is not a Spotify password.
