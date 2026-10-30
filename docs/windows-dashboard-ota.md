# Windows Dashboard Firmware Updates

**Offline implementation scope (2026-10-29): not installable or physically validated.** The panel supports a protected firmware inbox, local image and manifest checks, recovery-authenticated maintenance, one-use confirmation, read-only reboot verification, and explicit application startup. An earlier private ESP8266 image was compiled, but current HEAD has not been compiled or packaged in this phase. The production manifest remains unavailable because approved live-resource floors and hardware acceptance evidence are unresolved. No device, clock endpoint, or OTA operation was accessed for this implementation work. A separate, later 2026-10-29 session performed one status/capability read and one GIF replacement; that limited evidence does not validate firmware installation or recovery. Hardware, backup, and independent recovery gates remain **PENDING/BLOCKED** as recorded in [recovery](recovery.md).

## Requirements Before Using the Panel

The installed firmware must already implement authenticated `GET /maintenance/v1/info`, Stage 2's maintenance boot and RTC policy, the existing authenticated pause/firmware/run routes, and an OTA-enabled private identity. A legacy image cannot acquire these capabilities from an agent update. The private build record is stored outside the repository. Its compiled image is not an approved installation package: device binding and minimum live-resource values remain unresolved, and physical board/flash/recovery gates are still open.

Production installation requires separate approval of the exact target, backup, recovery, private artifact, and operation. A successful hash check does not prove the artifact publisher, physical flash geometry, or boot compatibility. The panel's experimental-test purpose enables a separately authorized experiment only; it does not satisfy or waive any production gate. The final panel confirmation shows the hash, build, source revision, profile, target geometry, and linked layout for comparison with an independently retained private build record.

## First Manual Installation and Legacy Wi-Fi Bridge

The first update from the old firmware is a separate manual installation using the maintainer's already established vendor workflow. Use only a separately approved image and target. A host probe confirms that the prepared combined E9 image passes the pinned Arduino updater's header gate and that the historical vendor image passes its stock-format checks; neither result identifies the installed verifier or proves physical boot compatibility.

After an image that has been separately approved and installed through a validated procedure boots, authenticate `GET /maintenance/v1/info` and `/maintenance/v1/status` before relying on the LCD. Confirm the recovery AP is active. The clean maintenance path may keep the app paused while it retries saved Wi-Fi, so verify both `recoveryApRunning=true` and the station state. If a legacy RTC record prevents automatic configuration loading, issue one authenticated `POST /maintenance/v1/storage`, then re-read status. This is a storage-initialization operation: it can create `/neonbyte` and remove temporary media or update files. It is not a read-only configuration load. Do not call `/maintenance/v1/run` until the later explicit start action. If storage still cannot load, keep the device in maintenance and follow only an independently validated recovery procedure.

The earlier private image is not accompanied by `firmware.bin` plus an accepted `manifest.json` pair, and no current-HEAD image or package was made in this phase. A manifest must use the exact current source revision from the trusted build record. Missing device identity or production live-resource floors must never be guessed. A null resource floor is accepted only for a manifest explicitly marked `experimental-test` and does not grant production approval.

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
- `manifest.json`: the matching non-secret manifest produced from the trusted private build record. It binds exact byte length and SHA-256, expected build/device/profile, recovery-identity fingerprint, target, linked flash regions, enabled maintenance/OTA gates, resource-floor purpose, source revision, and validation results.

The accepted target is fixed to ESP8266, DIO, 40 MHz, and 4 MiB with the exact linked 4m3m layout: bootloader at 0, application at 4,096, filesystem from 1,048,576 through 4,169,728, and EEPROM at 4,173,824. Before readiness, the agent checks the complete combined E9 image structure, segment load ranges and XOR checksums, padding, modern length/CRC, exact application boundary, manifest length, and SHA-256. The firmware independently repeats its image, runtime-bound, and actual flash-configuration/capacity checks before activation. These checks do not prove that the physical board matches the declared profile or that its boot path is compatible. The manifest is not signed by this implementation. Compare its digest and identity to the separately approved private record; a digest copied only from the same untrusted file is not an independent trust check.

The closed manifest format uses these exact fields:

| Field | Required value or shape |
|---|---|
| `schemaVersion`, `fileName`, `byteLength`, `sha256`, `imageFormat` | `1`, `firmware.bin`, exact positive byte count (minimum 4,129; maximum 458,752), lowercase 64-character SHA-256, and `esp8266-combined-e9` |
| `firmwareVersion`, `buildId`, `deviceId`, `profile` | Bounded ASCII identifiers from the approved private build record and expected device |
| `recoveryIdentityFingerprint`, `sourceRevision` | Lowercase 64-character fingerprint and 40-character Git revision |
| `target` | Exactly `family: esp8266`, `flashMode: dio`, `flashFrequencyMHz: 40`, `flashBytes: 4194304` |
| `linkedRegions` | Exactly `bootloaderStart: 0`, `applicationStart: 4096`, `filesystemStart: 1048576`, `filesystemEnd: 4169728`, and `eepromStart: 4173824` (4m3m profile) |
| `featureGates` | `otaEnabled: true`; either legacy `maintenanceOnBoot: true`, or `maintenanceOnBoot: false` with the additional `maintenanceAfterSoftwareRestart: true` gate |
| `purpose` | Omit for production; set exactly to `experimental-test` for a separately authorized experimental test |
| `minimumResources` | Production requires positive integer `minimumFreeHeapBytes` and `minimumLargestBlockBytes`; experimental-test accepts the same positive floors or explicit JSON `null` for pending floors |
| `validation` | `combinedImage`, `modernCrc`, and `recoveryIdentity` must be `true`. Production requires `runtimeBounds: true`; experimental-test also accepts a pending `runtimeBounds` object bound to the reviewed installed build |

These fields are requirements, not proof by themselves: the operator compares them with the trusted private build record. Production still requires approved positive resource floors and validated runtime bounds. Experimental candidates may provide positive floors, which remain enforced during preflight and post-boot checks. A `device-check-pending` state binds the exception to the authenticated `requiredBuildId` whose pre-write checks were reviewed. It means actual geometry has not been observed before upload; it is never accepted for production or reported as independently validated. The installed firmware must verify its runtime geometry, flash mode, and staging bounds before beginning flash writes. This qualification does not prove the device will boot or establish independent recovery.

The non-secret experimental manifest fields are exactly:

~~~json
{
  "purpose": "experimental-test",
  "minimumResources": {
    "minimumFreeHeapBytes": 22168,
    "minimumLargestBlockBytes": 21544
  },
  "validation": {
    "combinedImage": true,
    "modernCrc": true,
    "runtimeBounds": { "state": "device-check-pending", "requiredBuildId": "reviewed-installed-build-id" },
    "recoveryIdentity": true
  }
}
~~~

This excerpt omits the other mandatory manifest fields. Do not use zero, guessed
values, or omitted resource floors. Explicit `null` remains supported for a
separately authorized experiment with unmeasured floors; the agent does not treat
them as passed. Positive floors are checked normally and retained in the journal.
The deferred geometry state also remains in the journal after the device check;
it is not converted to an independent geometry measurement.

The agent reads the fixed inbox only after **Prepare local firmware** is selected. It rejects missing/extra files, weak local permissions, reparse/path redirection, changing or oversized files, malformed manifests, identity/profile mismatch, unsupported headers, and SHA-256/length mismatch. It holds one bounded in-memory image snapshot. The browser receives only an opaque candidate ID and sanitized non-secret metadata; no firmware upload, path, or download route is provided.

## Update Procedure

1. Open `http://localhost:8787` in the same Windows user session. Confirm the enrolled maintenance credentials and approved device are available.
2. Copy the reviewed `firmware.bin` and `manifest.json` pair to the fixed inbox. Wait for the copy to finish.
3. Select **Prepare local firmware**. Review the displayed purpose, filename, byte length, SHA-256, expected build ID, device ID, profile, source revision, target geometry, and linked layout. Compare them with the independent trusted build record.
4. For a production manifest, select **Confirm firmware update** and accept the production confirmation. For `experimental-test`, the panel asks for separate explicit authorization. If geometry is pending, the prompt identifies the deferred device check and the request carries an additional acknowledgement. The service rejects an absent acknowledgement before pausing or uploading. It suspends and drains the agent scheduler, rechecks identity/network/diagnostics/capacity, and accepts either an already paused app or an active app that can be paused. It sends `/pause` only for the active case, confirms the paused state, records a credential-free intent journal, and sends at most one raw firmware PUT. It never starts the application as part of OTA. If preflight aborts before pause/upload, the scheduler resumes only when the last maintenance status confirms that the application is still active; an already paused or uncertain state stays held. Progress counts bytes handed to the HTTP transport; it does not mean flash validation is complete.
5. Select **Verify device** after the reboot begins. The agent uses the last verified private address with bounded read-only attempts for up to 120 seconds. Both production and experimental verification require authenticated info/status/diagnostics, the same device and recovery identity, a changed boot ID, the expected build ID, the application still paused, active recovery AP and station, loaded configuration and storage, no pending/volatile Wi-Fi, and two matching observations at least two seconds apart on the same new boot. Production additionally requires both approved memory floors. Experimental success is reported as `experimentallyVerified`; its journal retains null floor values and production approval remains pending.
6. If DHCP changed the address, enter the device's private IPv4 HTTP origin in **Verified maintenance IPv4 address** and select **Verify and save device address**. The agent authenticates and checks the same device identity before persisting the maintenance-only address. After any PUT attempt, changing the address only resumes read-only reconciliation; it never re-sends the image.
7. After the panel reports **verified** for production or **experimentallyVerified** for an experimental test, select the corresponding **Start application** button and confirm. The experimental prompt repeats that the action does not grant production approval. Either action sends the separate maintenance `/run` request only after operator confirmation. The dashboard scheduler resumes only after the application is confirmed running, and only if its existing `enabled` setting is true.

### Experimental Test Boundary

An `experimental-test` manifest and a separate panel acknowledgement permit the
panel to prepare a candidate whose live resource floors are explicitly
unmeasured or whose geometry check is deferred to the device. Positive resource
floors, when supplied, are enforced. Deferred geometry requires its own explicit
acknowledgement and remains recorded as pending, not as independent validation.
This path still requires trusted device/profile/recovery identity,
exact source revision, complete local image integrity checks, the fixed target
and linked layout, authenticated preflight, capacity, pause safety, a one-use
PUT, and healthy same-boot maintenance observations. A zero, placeholder, or
omitted floor is never treated as an experimental null.

`experimentallyVerified` means only that the expected build identity and
maintenance state were observed twice. It is not the production `verified`
state and does not approve runtime resource floors, physical flash/boot
compatibility, the complete backup/restore procedure, independent failed-boot
Wi-Fi recovery, or installation. Those production gates remain **PENDING** in
the [installation GO/NO-GO decision](installation-go-no-go.md). Physical
testing still requires its own explicit operation authorization; no test result
may be inferred from a prepared candidate.

## History and Blockers

| Commit | OTA change or evidence | Blocker status after the commit |
|---|---|---|
| `6f11985` | Added authenticated raw maintenance OTA staging, bounded flash checks, readback validation, delayed activation, and host fault tests. | Software transaction safety is source-supported; no exact-unit flash map, installed verifier, or physical activation evidence was established. |
| `2003752` | Recorded the explicit installation **NO-GO** and unit-specific evidence gaps. | Installed version/verifier, exact board and flash geometry, complete restorable backup, and independent Wi-Fi recovery remain blockers. |
| `37291a3` | Added independent compatibility probes and an external first-install failure report; probes also found display initialization and conditional-AP concerns. | Findings identify additional failure modes but do not identify this unit's installed firmware or prove its first-install, display, or recovery behavior. |
| `7c9ea4a` | Corrected listener startup checks, gated risky startup on recovery service readiness, validated recovery AP configuration, and made OTA hash/read paths cooperative. | Host/source checks improve fail-closed behavior; actual AP availability, flash programming, boot and recovery remain physically unverified. |
| `bb2bddd` | Added a separate allowlisted raw restore route for one pinned stock image, behind disabled-by-default OTA and stock-restore gates with rechecked geometry. | This is not a full unit backup or independent failed-boot rescue, and it does not weaken modern OTA validation or establish installed-verifier compatibility. |
| `d3fdff7` | Introduced the protected dashboard inbox and update service. The manifest requires positive `minimumFreeHeapBytes` and `minimumLargestBlockBytes`; preflight, post-boot verification, and manual reconciliation compare live diagnostics against those floors. | This was the concrete software gate that rejected a candidate when no approved live-floor measurements existed. It combined a useful production resource policy with an absolute preparation blocker for an unmeasured test. |
| `405364e` | Hardened inbox access and update journaling, rechecked identity/readiness after scheduler drain, and changed preflight to accept an already-paused application while pausing only an active one. | It did not introduce the resource-floor gate; it reduced an earlier pause-state restriction. Current identity, network, capacity, and operator-confirmation checks remain required. |

At `e943911`, the dashboard OTA client and ESP8266 OTA/startup implementation
were already present. Comparing that commit with current `HEAD` shows no changes
to `agent/src/device/firmware-inbox.ts`, `agent/src/device/firmware-update.ts`,
or the ESP8266 maintenance OTA/startup sources. Current `HEAD` does change the
display firmware for Spotify text rendering, so an image from `e943911` cannot
stand in for a current-HEAD image or source-revision record. This phase does not
build that image or create an inbox package. The installation **NO-GO** and its
hardware, verifier, backup and independent-recovery blockers remain unchanged.

### Reconcile a Previously Running Build

If an attempted update remains unresolved in the protected journal but the
expected firmware is already running, the original verification still requires
a paused application and cannot mark that attempt verified. The panel offers
**Reconcile running firmware** for an eligible unresolved attempt. It displays
the journaled device and expected build and requires a separate confirmation.

After confirmation, the agent holds its scheduler and performs two independent,
authenticated maintenance observations at least two seconds apart. Both must
report the enrolled device, profile and recovery fingerprint, the expected
build, the same new boot ID, an active application and recovery AP, connected
station, loaded configuration and storage, no pending or volatile Wi-Fi, OTA
capacity, and the original journaled memory floors. A mismatched identity,
failed or rejected transfer, changed boot, unhealthy diagnostics, timeout, or
journal write failure keeps the update blocked. The action does not send a
firmware upload, pause the clock, or request application startup.

Successful reconciliation records a distinct `manuallyReconciled` result and
both observations' memory evidence; it does **not** mark the previous OTA as
verified or prove flashed bytes match the original hash. The protected journal
retains the earlier attempt and the manual result when the next candidate is
prepared. History is bounded to eight snapshots; if full, preparation or
reconciliation fails rather than silently discarding an entry. The scheduler
resumes only after the reconciliation record is saved. The panel then permits a
new candidate to be prepared, subject to all normal identity, preflight, OTA,
and post-boot checks.

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
