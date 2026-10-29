# Use the NeonByte dashboard

Start the agent and open [http://localhost:8787](http://localhost:8787). The dashboard has a local display preview, a Spotify connection control, three display modes, GIF preparation, and device connection settings.

## Choose a mode

| Mode | When a supported track is playing | When playback is idle or data is stale |
|---|---|---|
| **auto** | Shows Spotify Now Playing. | Selects the GIF scene. |
| **spotify** | Shows Spotify Now Playing. | Keeps the Spotify scene in a waiting state. |
| **gif** | Shows the GIF scene. | Shows the GIF scene. |

The agent saves a manual mode selection for the current computer user. The dashboard preview follows local agent playback state. A physical display follows the device's latest received state and expires Spotify metadata independently after 45 seconds, so the preview and device can differ temporarily.

## Prepare and replace a GIF

1. In **Prepare a GIF**, choose a .gif file. The file is converted locally to 240 × 240 RGB565 animation data using a centered crop to fill the display.
2. Preview the prepared animation in the dashboard if desired. Preparation and local preview do not change the selected mode or send the animation to the device.
3. Configure and enable a compatible device connection, then select **Replace device animation**.
4. Review the confirmation and transfer status. The dashboard reports removal, upload, validation, and completion or failure.

The current dashboard converts replacements to NBIF v2. Limits are an 8 MiB source GIF, 60 frames, 30 seconds total duration, 2,359,296 encoded bytes, no more than 1,048,576 pixels per logical screen or frame descriptor, and no more than 16,777,216 pixels across all source frame descriptors. The device also needs a 32 KiB storage reserve. A GIF with a single frame is accepted. An older v1-only conversion path is limited to 20 frames and 4,194,304 cumulative source descriptor pixels. Firmware may advertise lower limits; the agent checks device capabilities before transfer. See the [NBIF format reference](../animation-format.md) for wire details.

The confirmed replacement flow removes the current device animation before sending the new one to free storage. If the transfer is cancelled or fails after removal, the old animation is not preserved. The converted animation remains available in the current agent session for an explicit retry. It is not saved to disk by the panel, so it is lost when the agent exits.

The browser preview is a local simulation, not a remote display feed. One replacement and immediate playback were reported on the project device on October 29, 2026. Reboot persistence, endurance, and general firmware compatibility have not been established. See [hardware](../hardware.md) and [recovery](../recovery.md) before any device installation or update.

## Connect or disable device synchronization

Device synchronization starts disabled. Configure the address and credentials using [the device setup instructions](configuration.md#connect-an-existing-device), then enable the connection in **Device connection settings**. Unchecking **Enable device connection** stops ordinary synchronization. The connection uses unencrypted HTTP on a trusted local network.
