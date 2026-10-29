# NeonByte documentation

Start with the user guides to install the desktop agent, connect Spotify, and use the dashboard. Technical references describe the current protocol and implementation. Hardware and recovery documents explain what remains unverified.

## Using NeonByte

- [Install the agent on Windows 11](installation.md)
- [Configure the agent and an existing device](user/configuration.md)
- [Connect Spotify](user/spotify.md)
- [Use display modes and GIFs](user/usage.md)
- [Troubleshoot common problems](user/troubleshooting.md)

## Technical references

- [Hardware profile and evidence limits](hardware.md)
- [Device recovery limits](recovery.md)
- [HTTP v1 and v2 protocol](protocol.md)
- [NBIF animation file format](animation-format.md)
- [Agent development, validation, and dependency notes](development.md)
- [Firmware architecture and offline build profiles](firmware-development.md)
- [Authenticated maintenance and update implementation](windows-dashboard-ota.md)

The provisional ESP8266 profiles are for local compilation checks; they are not firmware packages for first installation. A successful build or a single device observation does not establish compatibility, backup, or independent boot recovery. Review [hardware evidence](hardware.md) and [recovery limits](recovery.md) before any device operation.
