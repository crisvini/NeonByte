# Windows Dashboard Firmware Updates

**Status (2026-10-27): offline implementation and private compile prepared; not installable or physically validated.** The agent supports a protected firmware inbox, manifest/hash checks, recovery-authenticated maintenance, one-use confirmation, read-only reboot verification, and explicit application startup. A private ESP8266 image was compiled with the retained recovery identity, but no inbox-compatible manifest is issued: the real chip-derived device ID and approved runtime heap floors have not been observed. Windows-native tests ran under Node 22 in an isolated temporary checkout. Existing device/Spotify Credential Manager records were read-only checked across processes; no maintenance credential was added. The real firmware inbox does not exist yet, and the installed agent/task were left untouched. No device, clock endpoint, or OTA operation was accessed. Hardware, backup, and independent recovery gates remain **PENDING/BLOCKED** as recorded in [recovery](recovery.md).

## Requirements Before Using the Panel

The installed firmware must already implement authenticated `GET /maintenance/v1/info`, Stage 2's maintenance boot and RTC policy, the existing authenticated pause/firmware/run routes, and an OTA-enabled private identity. A legacy image cannot acquire these capabilities from an agent update. The private build record is stored outside the repository under the WSL2 NeonByte private-build directory. Its compiled image is not an approved installation package: device binding and minimum live-resource values remain unresolved, and physical board/flash/recovery gates are still open.

Use this flow only after the maintainers have separately approved the exact target, backup, recovery, private artifact, and operation. A successful hash check does not prove the artifact publisher, physical flash geometry, or boot compatibility. The final panel confirmation shows the hash and build for comparison with the independently approved private build record.

## First Manual Installation and Legacy Wi-Fi Bridge

The first update from the old firmware is a separate manual installation using the maintainer's already established vendor workflow. Use only a separately approved image and target. A host probe confirms that the prepared combined E9 image passes the pinned Arduino updater's header gate and that the historical vendor image passes its stock-format checks; neither result identifies the installed verifier or proves physical boot compatibility.

After the new image boots, authenticate `GET /maintenance/v1/info` and `/maintenance/v1/status` before relying on the LCD. Confirm the recovery AP is active. The clean maintenance path may keep the app paused while it retries saved Wi-Fi, so verify both `recoveryApRunning=true` and the station state. If a legacy RTC record prevents automatic configuration loading, issue one authenticated `POST /maintenance/v1/storage`, then re-read status. That operation loads configuration only; do not call `/maintenance/v1/run` until the later explicit start action. If storage still cannot load, keep the device in maintenance and use the documented recovery procedure.

The current private image is not accompanied by `firmware.bin` plus an accepted `manifest.json` pair, so it must not be placed in the Windows inbox or treated as ready for installation. The missing device ID and approved live-resource floors must come from the actual device/build acceptance record, never from guessed values.

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
| `featureGates` | `otaEnabled: true`; either legacy `maintenanceOnBoot: true`, or `maintenanceOnBoot: false` with the additional `maintenanceAfterSoftwareRestart: true` gate |
| `minimumResources` | Positive integer `minimumFreeHeapBytes` and `minimumLargestBlockBytes` from the approved build validation |
| `validation` | `combinedImage`, `modernCrc`, `runtimeBounds`, and `recoveryIdentity` all `true` in the approved build record |

These fields are requirements, not proof by themselves: the operator compares them with the trusted private build record, and the existing firmware repeats the image checks that it can perform at runtime.

The agent reads the fixed inbox only after **Prepare local firmware** is selected. It rejects missing/extra files, weak local permissions, reparse/path redirection, changing or oversized files, malformed manifests, identity/profile mismatch, unsupported headers, and SHA-256/length mismatch. It holds one bounded in-memory image snapshot. The browser receives only an opaque candidate ID and sanitized non-secret metadata; no firmware upload, path, or download route is provided.

## Update Procedure

1. Open `http://localhost:8787` in the same Windows user session. Confirm the enrolled maintenance credentials and approved device are available.
2. Copy the reviewed `firmware.bin` and `manifest.json` pair to the fixed inbox. Wait for the copy to finish.
3. Select **Prepare local firmware**. Review the displayed filename, byte length, SHA-256, expected build ID, and device ID. Compare them with the independent approved build record.
4. Select **Confirm firmware update** and accept the separate confirmation. This suspends and drains the agent scheduler, rechecks identity/network/diagnostics/capacity, and accepts either an already paused app or an active app that can be paused. It sends `/pause` only for the active case, confirms the paused state, records a credential-free intent journal, and sends at most one raw firmware PUT. It never starts the application as part of OTA. If preflight aborts before pause/upload, the scheduler resumes only when the last maintenance status confirms that the application is still active; an already paused or uncertain state stays held. Progress counts bytes handed to the HTTP transport; it does not mean flash validation is complete.
5. Select **Verify device** after the reboot begins. The agent uses the last verified private address with bounded read-only attempts for up to 120 seconds. Success requires authenticated info/status/diagnostics, the same device and recovery identity, a changed boot ID, the expected build ID, the application still paused, a running recovery AP, minimum memory thresholds, and two matching observations at least two seconds apart. The two observations must report the same new boot ID.
6. If DHCP changed the address, enter the device's private IPv4 HTTP origin in **Verified maintenance IPv4 address** and select **Verify and save device address**. The agent authenticates and checks the same device identity before persisting the maintenance-only address. After any PUT attempt, changing the address only resumes read-only reconciliation; it never re-sends the image.
7. Only after the panel reports **verified**, select **Start application** and confirm. This sends the separate maintenance `/run` request. The dashboard scheduler resumes only after the application is confirmed running, and only if its existing `enabled` setting is true.

### Transition to Automatic Power-On Startup

Update the local agent before selecting an automatic-start candidate; older
agents correctly reject its manifest. No intermediate firmware is required by
the local protocol when the installed image already supports the authenticated
maintenance/info/OTA routes described above. The new manifest must come from a
trusted private build record that verifies the software-restart maintenance gate;
adding a Boolean to an unrelated image does not establish compatibility.

The prepared automatic profile retains maintenance after software restart,
including the updater's `ESP.restart()` path. Continue the exact paused,
authenticated, two-observation verification and explicit `/run` sequence for
that update. The journal records the verified boot ID; a later reboot invalidates
the right to start without fresh verification. Legacy verified journals without
that ID require read-only verification again and never replay the upload.

Subsequent clean USB power-ons may start automatically after ten seconds, without
opening the panel. External/software resets and crash evidence remain maintenance
paths. If power is interrupted before update verification, the app might start on
a later clean power-on because RTC is not durable update storage. A running app
fails the paused verification check and never approves the firmware. Leave the
result unresolved and use a separately authorized maintenance/recovery action;
never re-send the image or relax verification. Physical RTC/SDK reset behavior,
resource floors, and recovery acceptance remain pending. See the
[daily-startup report](daily-startup-and-sync.md).

The panel checks `Origin` on every mutation and accepts loopback requests only. Device traffic uses the existing bearer over plaintext HTTP, so keep it on a trusted private LAN. The dashboard does not search the network, use mDNS, change the recovery AP, install a bootstrap image, or select a browser file.

## Failure Handling and Limits

- A missing keyring entry, old firmware without verifiable info, disabled OTA, wrong identity/profile, insufficient capacity, or invalid manifest prevents any pause/PUT.
- A failed pause prevents the firmware PUT. Later errors do not automatically start the application.
- A preflight abort before any pause resumes agent synchronization only when the post-drain status confirmed that the application is still running. Already paused or uncertain states remain held for maintenance; this does not issue `/run`.
- A lost PUT response becomes **outcome unknown**. The agent records the consumed approval and performs read-only reconciliation; it never retries that PUT after a timeout, process restart, or second tab.
- An old/wrong build, wrong device, repeated boot, missing maintenance route, unhealthy diagnostics, or exhausted reconnect window is not success. Keep the recovery AP available and use the separately approved recovery procedure.
- The agent journal contains no token, AP password, binary, or file path. It invalidates a ready candidate after process restart and prevents scheduler startup after an unresolved attempted update.
- Verification is not byte-for-byte post-flash readback, extended stability testing, rollback, or independent failed-boot recovery. The panel cannot promise that the AP will survive a firmware image that does not start.

The Windows Node.js 22 run passed the root suite and all applicable agent tests (97 passed, one POSIX WSL-launcher test skipped). Temporary Windows ACL tests exercised both accepted restricted ACLs and rejection after a broad grant. Existing legacy device and Spotify Credential Manager entries were present and stable across native processes; the maintenance entry is absent. The actual `%LOCALAPPDATA%\NeonByte\firmware-inbox` directory was absent, so its ACL and real candidate reads remain unverified. The existing scheduled task was inspected read-only and left running and unchanged. DHCP correction, hidden-task interaction during an update, same-user maintenance enrollment, and the actual device update path still require acceptance. No native file picker is included; the inbox is the first-version selection path.
