# Windows Dashboard Firmware Updates

**Status (2026-10-27): offline implementation only.** The Windows agent now has a protected firmware inbox, manifest/hash checks, a recovery-authenticated maintenance client, one-use confirmation, read-only reboot verification, and explicit application startup. No private image was prepared, no target image was compiled, no Windows keyring/ACL run was performed, and no device or OTA operation was performed. Hardware, backup, and independent recovery gates remain **PENDING/BLOCKED** as recorded in [recovery](recovery.md).

## Requirements Before Using the Panel

The installed firmware must already implement authenticated `GET /maintenance/v1/info`, Stage 2's maintenance boot and RTC policy, the existing authenticated pause/firmware/run routes, and an OTA-enabled private identity. A legacy image or the current provisional profile cannot acquire these capabilities from an agent update. The current checkout has no `firmware/private/neonbyte_private_identity.h`, no approved private build ID/profile, and no PlatformIO CLI; no installable firmware image is available here.

Use this flow only after the maintainers have separately approved the exact target, backup, recovery, private artifact, and operation. A successful hash check does not prove the artifact publisher, physical flash geometry, or boot compatibility. The final panel confirmation shows the hash and build for comparison with the independently approved private build record.

## Prepare the Windows Agent and Credentials

Run Windows-native Node.js under the same Windows account that owns the scheduled task and Windows Credential Manager entries. Build and start the agent from the repository root:

~~~powershell
npm ci
npm ci --prefix agent
npm --prefix agent run build
~~~

Stop the running agent before either credential command. If it runs as a scheduled task, stop `NeonByte Agent` in Task Scheduler or run `Stop-ScheduledTask -TaskName 'NeonByte Agent'` and wait until `http://localhost:8787` stops responding. Both commands take the agent's exclusive instance lock, so a second enrollment or configuration process cannot race the system credential manager. Restart it after enrollment/configuration. New pairing credentials are entered in a foreground terminal, never in the browser:

~~~powershell
node .\agent\dist\main.js configure-device
~~~

Recovery enrollment is a separate, explicit action. It compares the entered token and AP password with the trusted recovery fingerprint and verifies the recovery-authenticated device identity before adding the `NeonByte` / `device-maintenance-v1` credential entry:

~~~powershell
node .\agent\dist\main.js enroll-recovery
~~~

Start the existing scheduled task, or run `npm --prefix agent run start` in a foreground PowerShell window. Open `http://localhost:8787` after the agent is running.

Use the trusted device ID, firmware profile, and fingerprint from the retained private build record. A saved pairing token can be reused only when the operator opts in; it is still checked against the independently retained recovery identity. Secret prompts do not echo. Enrollment does not start the application, prepare an image, or send firmware. Existing `device-configuration` and Spotify credential entries are preserved.

The protected inbox is fixed at `%LOCALAPPDATA%\NeonByte\firmware-inbox`. Copy exactly two files there with File Explorer:

- `firmware.bin`: the complete approved, uncompressed combined ESP8266 eboot/application image, within the 458,752-byte Windows preparation ceiling.
- `manifest.json`: the matching non-secret manifest produced from the trusted private build record. It binds exact byte length and SHA-256, expected build/device/profile, recovery-identity fingerprint, target, linked flash regions, enabled maintenance/OTA gates, minimum resources, source revision, and validation results.

The accepted target fields are fixed to ESP8266, DIO, 40 MHz, and 4 MiB. Both E9 headers are checked locally before readiness; the firmware remains responsible for its full segment, CRC, geometry, and flash validation. The manifest is not signed by this implementation. Compare its digest and identity to the separately approved private record; a digest copied only from the same untrusted file is not an independent trust check.

The closed manifest format uses these exact fields:

| Field | Required value or shape |
|---|---|
| `schemaVersion`, `fileName`, `byteLength`, `sha256`, `imageFormat` | `1`, `firmware.bin`, exact positive byte count (minimum 4,129; maximum 458,752), lowercase 64-character SHA-256, and `esp8266-combined-e9` |
| `firmwareVersion`, `buildId`, `deviceId`, `profile` | Bounded ASCII identifiers from the approved private build record and expected device |
| `recoveryIdentityFingerprint`, `sourceRevision` | Lowercase 64-character fingerprint and 40-character Git revision |
| `target` | Exactly `family: esp8266`, `flashMode: dio`, `flashFrequencyMHz: 40`, `flashBytes: 4194304` |
| `linkedRegions` | Exactly `bootloaderStart: 0`, `applicationStart: 4096`, and the approved filesystem start/end and EEPROM start within the 4 MiB target |
| `featureGates` | Both `maintenanceOnBoot` and `otaEnabled` set to `true` |
| `minimumResources` | Positive integer `minimumFreeHeapBytes` and `minimumLargestBlockBytes` from the approved build validation |
| `validation` | `combinedImage`, `modernCrc`, `runtimeBounds`, and `recoveryIdentity` all `true` in the approved build record |

These fields are requirements, not proof by themselves: the operator compares them with the trusted private build record, and the existing firmware repeats the image checks that it can perform at runtime.

The agent reads the fixed inbox only after **Prepare local firmware** is selected. It rejects missing/extra files, weak local permissions, reparse/path redirection, changing or oversized files, malformed manifests, identity/profile mismatch, unsupported headers, and SHA-256/length mismatch. It holds one bounded in-memory image snapshot. The browser receives only an opaque candidate ID and sanitized non-secret metadata; no firmware upload, path, or download route is provided.

## Update Procedure

1. Open `http://localhost:8787` in the same Windows user session. Confirm the enrolled maintenance credentials and approved device are available.
2. Copy the reviewed `firmware.bin` and `manifest.json` pair to the fixed inbox. Wait for the copy to finish.
3. Select **Prepare local firmware**. Review the displayed filename, byte length, SHA-256, expected build ID, and device ID. Compare them with the independent approved build record.
4. Select **Confirm firmware update** and accept the separate confirmation. This suspends and drains the agent scheduler, checks status/diagnostics/capacity, pauses the application, records a credential-free intent journal, and sends at most one raw firmware PUT. Progress counts bytes handed to the HTTP transport; it does not mean flash validation is complete.
5. Select **Verify device** after the reboot begins. The agent uses the last verified private address with bounded read-only attempts for up to 120 seconds. Success requires authenticated info/status/diagnostics, the same device and recovery identity, a changed boot ID, the expected build ID, the application still paused, a running recovery AP, minimum memory thresholds, and two matching observations at least two seconds apart. The two observations must report the same new boot ID.
6. If DHCP changed the address, enter the device's private IPv4 HTTP origin in **Verified maintenance IPv4 address** and select **Verify and save device address**. The agent authenticates and checks the same device identity before persisting the maintenance-only address. After any PUT attempt, changing the address only resumes read-only reconciliation; it never re-sends the image.
7. Only after the panel reports **verified**, select **Start application** and confirm. This sends the separate maintenance `/run` request. The dashboard scheduler resumes only after the application is confirmed running, and only if its existing `enabled` setting is true.

The panel checks `Origin` on every mutation and accepts loopback requests only. Device traffic uses the existing bearer over plaintext HTTP, so keep it on a trusted private LAN. The dashboard does not search the network, use mDNS, change the recovery AP, install a bootstrap image, or select a browser file.

## Failure Handling and Limits

- A missing keyring entry, old firmware without verifiable info, disabled OTA, wrong identity/profile, insufficient capacity, or invalid manifest prevents any pause/PUT.
- A failed pause prevents the firmware PUT. Later errors do not automatically start the application.
- A lost PUT response becomes **outcome unknown**. The agent records the consumed approval and performs read-only reconciliation; it never retries that PUT after a timeout, process restart, or second tab.
- An old/wrong build, wrong device, repeated boot, missing maintenance route, unhealthy diagnostics, or exhausted reconnect window is not success. Keep the recovery AP available and use the separately approved recovery procedure.
- The agent journal contains no token, AP password, binary, or file path. It invalidates a ready candidate after process restart and prevents scheduler startup after an unresolved attempted update.
- Verification is not byte-for-byte post-flash readback, extended stability testing, rollback, or independent failed-boot recovery. The panel cannot promise that the AP will survive a firmware image that does not start.

The protected inbox/Windows ACL behavior, same-user native keyring restoration and readback, maintenance-address correction, hidden-task interactions, and the actual update path still require Windows and device acceptance. No native file picker is included; the inbox is the first-version selection path.
