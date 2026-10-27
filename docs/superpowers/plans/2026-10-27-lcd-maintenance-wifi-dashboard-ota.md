# LCD Colors, Maintenance Wi-Fi, and Windows OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, or superpowers:subagent-driven-development if separately selected, to implement an approved stage task by task. All execution checkboxes below remain unchecked. This document authorizes no implementation or device operation.

**Goal:** Correct LCD color reproduction without changing the validated orientation, reconnect saved Wi-Fi while remaining in maintenance, and operate the existing authenticated OTA transaction from the Windows dashboard.

**Architecture:** Retain the Adafruit row renderer, portable `SafeStartup` policy, namespaced persistent configuration, single-client HTTP server, and raw maintenance updater. Separate saved-network loading from application startup. Add Windows-side maintenance orchestration and authenticated firmware identification; reconnect through the last known IP with manual address correction. mDNS/DNS-SD is an optional later enhancement, not a first-version dependency.

**Tech Stack:** Existing C++17/ESP8266 Arduino 3.1.2 adapters, Adafruit ST7789 1.11.0, LittleFS, Node.js/TypeScript, Windows Credential Manager through the existing keyring package, native Node.js HTTP/crypto/filesystem APIs, and the existing loopback dashboard. UDP/mDNS is excluded from the required first-version stack.

**Spec:** Maintainer's analysis-only request and subsequent planning refinements dated 2026-10-27, captured in the requirements and evidence below; [project planning](../../../PLANNING.md), [protocol](../../protocol.md), [safe startup](../../safe-first-boot.md), [maintenance OTA](../../maintenance-ota-design.md), [HTTP correction](../../http-recovery-investigation.md), and [display report](../../spotify-gif-display.md).

**Status:** The three-stage architecture is approved; the refinements below are submitted for review before implementation of Stage 1. Initial analysis baseline: `014ec6241193ca568cc9c3edd518b4456b1c7dd2`; revision baseline: local `main` at `afcf390`, which records the original plan. These identify inspected checkouts, not a newly fetched remote head or the installed device image. Only this existing planning document is modified by this revision. No stage implementation, source changes, credential migration, hardware operation, or `PLANNING.md` completion mark is authorized or performed.

## Global Constraints

- Current authorization is analysis and planning only: no implementation, target compilation, firmware generation, discovery, clock requests, restart, OTA, erase, formatting, partition change, serial access, UART, or soldering.
- Future stages require separate authorization. Physical operations also require their own bounded authorization and the existing evidence/recovery gates; approving source work does not approve deployment.
- Preserve 180-degree orientation: Adafruit rotation 2, 240 by 240 bounds, offsets 0/0, and the current geometry bits. A color correction may change MADCTL bit 3 alone if justified.
- Preserve Spotify's centered 176 by 176 cover, current font sizes, no progress bar, content-based redraw, and Auto behavior: confirmed playback selects Spotify; pause/no playback selects the installed GIF.
- Preserve strict HTTP framing, disconnected-client ownership/cleanup, bounded deadlines, diagnostics, bearer authentication, SHA-256 readback, image/CRC/geometry validation, fail-closed activation, and delayed-reboot protection.
- Preserve the exact existing private recovery identity and valid pairing/configuration records. A public compile-check image lacks that identity and is not an update candidate.
- Preserve the existing Windows task/user profile, `NeonByte` / `device-configuration` credential entry and `NeonByte` / `spotify-refresh-token` entry. Maintenance enrollment is additive; do not require pairing or Spotify authorization again merely to upgrade the agent.
- Start recovery AP/HTTP before storage/display work. Keep the AP at `192.168.4.1` in addition to STA. Do not introduce automatic LittleFS formatting, SDK credential erasure, configuration replacement, or a new persistent boot flag.
- Keep recovery credentials and private binary bytes out of the Windows browser, dashboard responses, URLs, logs, Git, and public artifacts. The selected private image itself contains recovery secrets.
- Use existing runtime dependencies and libraries. Prefer bounded buffers and cooperative work; add no full framebuffer, database, cloud service, new partition, rescue bootloader, or alternative OTA engine.
- Keep API v1 schemas unchanged unless a separately justified contract change is approved; align any changed contract, examples, tests, and `docs/protocol.md`.
- Write repository content, tests, errors, logs, and UI copy in American English; use UTF-8/LF.

## Review Focus

- Valid network credentials might exist in NeonByte LittleFS, SDK storage, or only current RAM; only the first source is presently loaded by this application, and none was inspected on the clock.
- A mount/configuration operation can reset or hang after HTTP starts; retain guarded one-attempt loading and crash-start suppression instead of an automatic retry loop.
- An upload can activate successfully while its response is lost; one failed HTTP exchange must never cause an automatic second firmware PUT.
- A changed DHCP address, wrong device, stale build, or agent restart must not produce a successful-update message based on reachability alone.
- A private binary, misleading filename, matching self-calculated hash, or browser retry must not bypass artifact identity checks or expose recovery secrets.

## Current Architecture and Findings

| Area | Source evidence | Consequence for the plan |
|---|---|---|
| LCD initialization | `firmware/src/esp8266/display.cpp:22`: 20 MHz initialization/drawing, SPI mode 3, rotation 2, explicit MADCTL `0x08`, inversion enabled. The installed Adafruit initialization selects COLMOD `0x55`. | BGR is an explicit override after rotation. Changing rotation is unnecessary for a color-order test. |
| RGB565 conversion | `agent/src/media/animation.ts:62` and `agent/tests/media.test.ts:132`: standard R5/G6/B5 packing and little-endian NBIC/NBIF words. | Existing primary/secondary color regressions already cover both cover and GIF conversion. |
| SPI bytes | Renderer rebuilds each numeric word; `firmware/scripts/probe_display_colors.py` executes dependency write methods with register doubles. | Expected wire bytes are high byte then low byte. Host correctness does not prove physical SPI or scanout. |
| Safe startup | `firmware/src/safe_startup.cpp:15`: maintenance-on-boot clears automatic application startup. Saved configuration is loaded in `initializeStorage()`, reached automatically only through that startup path. | Maintenance boots retain an empty `activeWifi_`; the existing STA retry loop has no saved target. This explains the source-level reconnection gap. |
| Existing reconnection | `SafeStartup::tick()` retries an available target every 30 seconds; `connectStation()` uses fresh Connected/GotIP evidence and never waits for association. | Reuse this mechanism and preserve the AP while enabling STA; do not add a blocking Wi-Fi loop. |
| Persistent settings | `firmware/src/esp8266/storage.cpp:67`: `/neonbyte/config.bin`, version/length/terminator checks and SHA-256. `WiFi.persistent(false)` is selected in `setup()`. | Saved NeonByte credentials can be reused without recompilation. SDK/stock credentials are a different persistence layer; do not silently import them. |
| Storage side effects | `PersistentStorage::beginStorage()` disables autoformat but creates `/neonbyte/` and removes temporary assets. | Calling the existing preparation path during automatic maintenance boot would add writes/cleanup. Split configuration-only mounting from explicit preparation. |
| RTC after OTA | `main.cpp:117` stores the guard at user RTC offset 0. The pinned core reserves the first 128 user bytes for eboot's command; eboot clears its command magic/CRC before loading the application. | Even a successful OTA can produce an invalid warm-reset guard and suppress automatic saved-network loading. Separate the RTC regions and plan legacy migration before promising automatic LAN recovery. |
| OTA | `firmware/src/esp8266/http_server.cpp:45` and `firmware/src/ota_staging.cpp`: authenticated, paused-only raw maintenance staging; independent of LittleFS. | Use `PUT /maintenance/v1/firmware`, not the application/file-staging route or stock-restoration route. |
| Windows client | `agent/src/device/client.ts:68`: GET omits bearer; mutations first query application `/api/v1/status`, which returns 409 while paused. | Add a maintenance client. Reusing the current mutation helper unchanged would fail in maintenance. |
| Dashboard/security | `agent/src/web/server.ts`: loopback binding, Host/Origin checks; `SystemDeviceConfigStore` already uses the OS credential manager. | Retain those protections and use a distinct recovery-credential entry; do not equate recovery and pairing tokens. |
| Existing Windows credentials | `agent/src/device/integration.ts:20`: service `NeonByte`, account `device-configuration`, JSON containing `address`, `token`, `enabled`. `agent/src/spotify/token-store.ts:59`: separate account `spotify-refresh-token`. | Keep the existing record shape and names. Add maintenance credentials separately; do not rewrite either existing entry on startup or migration. |
| Address-change behavior | `DeviceIntegration::configure()` currently keeps a saved token only when the address is unchanged; its regression explicitly rejects a new address without a new token. | A manual DHCP correction needs a separate identity-verified rebind path; calling the existing helper unchanged would unnecessarily request pairing again. |
| Hidden Windows launch | `windows-register.ps1` selects `Interactive`/`Limited` at user logon; `windows-hidden.vbs` runs PowerShell `-NonInteractive` with window style 0; `windows-launch.ps1` redirects Node output into the agent log. | An interactive principal makes a dialog plausible, not validated. Verify actual visibility through this chain; capture helper output privately and retain a dialog-independent selection path. |
| Shared token values | `main.cpp:88` initializes an absent pairing token with the recovery token; the current browser pairing form accepts a token. | Different roles/keyring entries do not imply different values. Move device bearer import out of the browser, including ordinary pairing, without rotating existing device identity. |
| Verification/discovery gaps | Maintenance status contains booleans; diagnostics contain counters. Application firmware version is hardcoded as `0.1.0-phase4`. Discovery is absent; the current client rejects hostnames. | Add authenticated build identity, keep last-IP retry and manual private-IP correction, and preserve the hostname restrictions. First-version acceptance does not depend on discovery. |
| Mobile recovery | Authenticated maintenance endpoints exist; a browser control page at `/` does not. The maintainer selected an authenticated HTTP client for the phone. | Treat `http://192.168.4.1` as the base URL and document full endpoint paths; no recovery web portal is needed. |

The maintainer confirms that factory firmware displayed all colors correctly, the current NeonByte firmware makes red appear blue, and the current orientation is correct. Green and blue are described as apparently correct. These are accepted maintainer observations; this analysis neither reran them nor identified the exact installed binary. Older statements that orientation is pending are historical and must not override this confirmation. Backup, independent failed-boot recovery, actual flash geometry, and successful future-candidate boot remain unsupported by these observations.

### Recommended Approach and Alternatives

Retain the approved conditional one-bit LCD correction, guarded configuration-only maintenance boot path, and agent orchestration around the existing updater. The refinements make last-IP/manual reconnection the baseline, file selection independent of GUI availability, and credential enrollment additive. Implementation still awaits separate approval.

Changing the global RGB565 format would affect both asset types and hide a panel-profile mismatch. Replacing Adafruit or importing another project's gamma/power table would expand the physical risk without exact factory evidence. SDK credential persistence/import, a second settings store, a second updater, partition migration, and a full embedded dashboard add unnecessary dependencies or preservation questions. Reconsider an alternative only if controlled evidence rules out the smaller approach.

## Stage 1: LCD Color Correction

### LCD Files and Responsibilities

- Modify conditionally: `firmware/src/esp8266/display.cpp`, only the final color-order choice in `DeviceDisplay::begin()`.
- Preserve: `firmware/include/neonbyte/esp8266/display.h` and its bounded SPI initialization and row buffer.
- Extend tests as needed: `firmware/test/test_display/test_main.cpp`, its panel fake, `firmware/scripts/probe_compatibility.py`, and `firmware/scripts/probe_display_colors.py`.
- Reuse: `agent/src/media/animation.ts`, `agent/tests/media.test.ts`, and `agent/scripts/prepare-display-colors.ts`; change conversion only if a failing independent fixture demonstrates a converter defect.
- Update after evidence: `docs/spotify-gif-display.md`, `docs/hardware.md`, and the current display-profile documentation. No speculative hardware completion marks.

### Diagnosis and Minimal Proposed Change

The leading hypothesis is a panel RGB/BGR mismatch introduced by the explicit final MADCTL `0x08`. MADCTL D3 selects RGB/BGR independently of MX/MY/MV; see the [ST7789V datasheet, MADCTL section](https://newhavendisplay.com/content/datasheets/ST7789V.pdf). The pinned [Adafruit rotation implementation](https://github.com/adafruit/Adafruit-ST7735-Library/blob/1.11.0/Adafruit_ST7789.cpp) selects RGB for rotation 2 before NeonByte overwrites it with BGR.

This remains a hypothesis: a pure RGB/BGR swap exchanges both red and blue, leaves green unchanged, and preserves white, black, and magenta. If controlled blue really remains blue while red becomes blue, that observation does not fit a simple symmetric swap. Do not mark the root cause confirmed from the reported symptom alone.

- [ ] Revalidate the packing and command traces against the exact dependency bytes intended for any later candidate. The previous report records a GFX/BusIO discrepancy between declared and cached versions; preserve and record the actual reviewed inputs rather than upgrading during diagnosis.
- [ ] Compare the unchanged reference chart through both cover and animation paths. Record each expected patch's observed color, not only whether an album cover looks plausible.
- [ ] If the chart confirms symmetric red/blue exchange with neutral black/white, propose changing the final MADCTL byte from `0x08` to `0x00`. Keep `setRotation(2)`, offsets, bounds, SPI mode/frequency, inversion, and geometry bits unchanged. Do not restore historical `0xC8`.
- [ ] If the chart does not match that signature, retain the current setting and investigate the first differing boundary. Byte reversal affects RGB565 fields differently from a channel swap; inversion would also disturb neutrals/complements. Recheck those before considering any evidenced initialization difference.
- [ ] Compare with factory initialization only if an exact relevant command sequence/source or a defensible trace from an already supplied factory artifact becomes available. The reviewed stock reports do not establish that sequence for this unit. Another project's TFT_eSPI BGR/gamma table is not factory evidence. Do not alter gamma, voltage, porch settings, or pins from that comparison alone.

### Color Fixtures and Automated Tests

Use the existing eight-strip generator; its requested minimum colors have these exact values:

| Patch | RGB565 word | NBIC/NBIF bytes | SPI bytes |
|---|---|---|---|
| Red | `0xF800` | `00 F8` | `F8 00` |
| Green | `0x07E0` | `E0 07` | `07 E0` |
| Blue | `0x001F` | `1F 00` | `00 1F` |
| White | `0xFFFF` | `FF FF` | `FF FF` |
| Black | `0x0000` | `00 00` | `00 00` |
| Magenta | `0xF81F` | `1F F8` | `F8 1F` |

Cyan and yellow remain useful additional controls. Use an asymmetric orientation/border reference alongside the color chart; strips alone do not adequately establish a half turn.

- [ ] Keep exact-word assertions for both RGBA cover and decoded GIF paths, including neutral and secondary colors and SHA-256 verification.
- [ ] If the bit change is justified, update the native expectation to final `0x00` and add a trace assertion that the before/after bytes differ only by `0x08`; retain rotation 2, COLMOD `0x55`, inversion and literal full-screen/corner/cover windows.
- [ ] Retain byte-reversal and stale-`0xC8` mutation checks so a test proves the incorrect variant would be rejected.
- [ ] Retain 176 by 176 incremental cover, no-progress redraw, track-bound artwork, GIF timing/looping, and Auto play/pause regressions.

### Physical Risks, Protection, and Acceptance

A color-register change is small, but installing any candidate still exposes boot-copy/power-loss risk. Preserve private identity, exact reviewed build inputs, all update gates, and a retained previous candidate/manifest. A previous binary is an operator resource, not independent rollback.

Future physical observation is separately authorized. First observe the unchanged chart; change one setting only if justified. Both cover and full-screen rendering must show distinct red/green/blue, neutral white/black, and magenta with red plus blue. Confirm the asymmetric orientation reference, all borders, the current Spotify layout, and absence of new flicker.

Uploading a chart as the installed animation replaces the user's GIF. Require a retained original GIF/NBIF and checksum on the PC plus an explicitly authorized restoration step before that test. If unavailable, use a track-bound cover first and leave the full-screen criterion pending. Do not assume the device offers an asset-backup endpoint.

**Exit condition:** a source-level cause is supported by controlled observations; focused and repository checks pass; visual criteria are recorded for the exact candidate. Host checks alone do not complete physical color acceptance. Stop for separate Stage 2 authorization; if only independent offline Stage 2 work is authorized while visual testing is blocked, leave this stage's physical criteria pending.

## Stage 2: Wi-Fi During Maintenance

### Maintenance Wi-Fi Files and Responsibilities

- Modify: `firmware/src/safe_startup.cpp`, `firmware/include/neonbyte/safe_startup.h`, and `firmware/src/esp8266/main.cpp` for independent saved-network initialization and existing station retries.
- Modify: `firmware/src/esp8266/storage.cpp` and `firmware/include/neonbyte/esp8266/storage.h` to separate configuration-only mounting from directory creation/temporary-file cleanup.
- Reuse: `firmware/src/wifi_configuration.cpp`, `firmware/include/neonbyte/wifi_configuration.h`, and `firmware/include/neonbyte/recovery_ap.h` for validation, fresh association evidence, and checked AP setup.
- Touch only if necessary for the initialization/OTA interlock: `firmware/src/esp8266/http_server.cpp` and its header; preserve client ownership, abort ordering, deadlines, and restart-pending behavior.
- Update test adapters: `firmware/host/main.cpp`, `firmware/test/test_startup/test_main.cpp`, `firmware/test/test_integration/test_main.cpp`, and `agent/tests/offline/maintenance.test.ts`.
- Update: `docs/safe-first-boot.md`, `docs/recovery.md`, and `docs/protocol.md`; add a precise description of clean-maintenance versus crash-recovery loading.

### Proposed Startup Policy

- [ ] Start the existing protected AP and HTTP listener first, using checked `192.168.4.1` configuration and existing retry behavior. No display, scene/protocol allocation, or SNTP startup is part of maintenance Wi-Fi.
- [ ] Separate the intent to load saved Wi-Fi from the intent to run the application. After the existing fresh 10-second recovery window on a clean maintenance boot, make one RTC-guarded configuration-only mount/load attempt. Keep `applicationRunning=false` and automatic application start disabled indefinitely.
- [ ] Introduce `PersistentStorage::mountForConfiguration()` and a corresponding startup-service seam. It may mount with autoformat disabled and open/validate the existing configuration; it must not create directories, delete temporary files, save settings, or prepare media. Track configuration loading separately so later explicit `/storage` or `/run` still performs the existing preparation when needed. LittleFS mounting itself is not a guarantee of zero internal filesystem writes; physical mount compatibility remains a gate.
- [ ] Reuse the valid stored SSID/password and pairing record. Validate the stored network fields before attempting STA; do not overwrite a valid record just because association fails. Preserve an explicitly staged or temporary network over background saved-network loading.
- [ ] Use the existing station connection method and 30-second retry cadence from `tick()`. Preserve AP mode when enabling STA; verify the resulting AP+STA state rather than repeatedly cycling `WiFi.mode()`. No association waits, delay-based retry loop, Wi-Fi scans, or repeated configuration writes.
- [ ] Preserve Connected/GotIP evidence for the current attempt and live `WL_CONNECTED` checks. Do not treat configured SSID readback as proof of association. A late event from a previous attempt must not confirm new credentials.
- [ ] Keep automatic storage loading disabled after a risky RTC marker, watchdog/exception, invalid warm-reset record, RTC failure, or uncertain reset. Recovery remains AP/HTTP-only until an authenticated operator explicitly requests guarded storage preparation or temporary Wi-Fi. This intentionally prioritizes recovery over STA availability when saved credentials cannot safely be read.
- [ ] Move/version the startup guard into a verified disjoint RTC region before depending on STA after OTA. The pinned [RTC API/layout](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Esp.cpp) exposes 512 user bytes and uses offsets in four-byte units; word offset 32 places the current 12-byte record in bytes 128-139, beyond eboot's first 128 bytes. Add explicit offset/size/version constants and bounds/nonoverlap assertions; inspect all RTC users when dependencies change. This is transient RTC allocation, not a flash/partition change or a durable boot counter.
- [ ] Preserve fail-closed migration: an unknown new guard on a warm reset remains AP-only. Do not reinterpret an overwritten legacy eboot/guard record as clean startup. The first separately authorized upgrade from legacy firmware may require the phone to request `/maintenance/v1/storage` once to load saved Wi-Fi without starting the application; clean power-on can initialize an unknown guard under the existing policy. Subsequent updates from firmware already using the separated valid guard can retain clean-start evidence and automatically reconnect. Document this initial bridge explicitly, rather than promising Ethernet reconnection for the legacy transition.
- [ ] Interlock background initialization with accepted OTA work and reboot-pending state: no mount, cleanup, startup-guard write, or station reconfiguration may race an active/activated update. In particular, a delayed configuration-load timer must never overwrite the eboot command sharing RTC memory. Explicit Wi-Fi staging cancels the stale background-load task.
- [ ] On mount/load failure, retain AP/HTTP, report unavailable configuration, and stop automatic storage attempts for that boot. Never autoformat or create a replacement configuration. Explicit operator retry remains available.

This deliberately changes the selected maintenance policy from "never automatically mount" to "one guarded configuration-only attempt on a clean boot." That architectural change requires approval with this stage. Display startup remains an explicit authenticated `/maintenance/v1/run` action. The SDK may still block inside an individual mount call; cooperative scheduling cannot guarantee HTTP progress during a call that never returns. The RTC/watchdog strategy protects later boots, not the duration of that first call.

### Credentials and `.env` Decision

**Recommended baseline: no Wi-Fi `.env` dependency.** A valid `/neonbyte/config.bin` already solves persistence and future password changes through authenticated provisioning. HSPOT is an operator-provided current network name, not a hardcoded firmware default.

- [ ] Distinguish valid NeonByte settings, absent/corrupt settings, and an explicit RAM-only candidate in tests and status. Do not infer a NeonByte record from the fact that the clock previously joined HSPOT; it might have used SDK or temporary credentials.
- [ ] Preserve the existing staged provisioning flow: `PUT /maintenance/v1/wifi`, fresh association/reachability checks, then `POST /maintenance/v1/wifi/confirm`. Save only on confirmation; failed persistence preserves the installed record. Use `/wifi/temporary` only after explicit RAM-only selection.
- [ ] If evidence later shows credentials exist only in SDK/stock storage, review a bounded read-only import separately instead of silently enabling SDK persistence or reading unknown EEPROM regions. Do not import a factory AP password or pairing token.
- [ ] Only if provisioning from the PC is actually needed, add a separate opt-in agent operation consuming `WIFI_SSID`/`WIFI_PASSWORD` from the local environment, sending the same staged maintenance request. It must show only whether credentials are available, require explicit provisioning/confirmation, and never submit on ordinary startup or overwrite a valid configuration automatically. This optional operation is outside the baseline implementation until that need is established.

Environment-based provisioning does not solve first reachability: an Ethernet-only PC cannot send those credentials to an AP it cannot reach. Initial/recovery provisioning would use the phone's authenticated HTTP client. Changing Wi-Fi later needs no firmware recompilation. The current `.env.example` does not implement Wi-Fi provisioning; its existing device placeholders are not evidence of such a feature.

### Maintenance Wi-Fi Automated Tests

- [ ] Clean maintenance boot: AP and HTTP precede storage; after 10 seconds saved credentials are loaded once, STA is attempted, and display/application starts remain zero even after a successful association and long simulated time.
- [ ] AP or HTTP startup failure: no configuration attempt until both work and a new full recovery window has elapsed; existing five-second service retries remain bounded.
- [ ] Missing, truncated, checksum-invalid, version-invalid, unterminated, or semantically invalid Wi-Fi fields: no station attempt, no automatic save/cleanup/format, AP and authenticated diagnostics still available.
- [ ] Configuration-only mount failure, read failure, RTC set/clear failure, crash reset and explicit `/storage` retry: preserve the conservative recovery policy and do not enter an automatic mount/reset loop.
- [ ] Test the storage adapter's actual configuration-only path with filesystem doubles, not only the portable policy: assert no mkdir/remove/configuration-save calls. Explicit preparation must retain its documented behavior.
- [ ] Simulated unavailable HSPOT, wrong password, network return, disconnect/reconnect, stale events, and changed password on the same SSID: retries no faster than every 30 seconds; HTTP ticks continue; AP is never intentionally disabled on successful STA.
- [ ] Pending/temporary credentials take precedence, confirm is explicit, failed save preserves the previous record, and RAM-only settings disappear at restart.
- [ ] Start OTA before the configuration-load deadline, across the deadline and after activation: no background storage or RTC mutation, no candidate replacement, and exactly one successful scheduled restart in the fake model.
- [ ] Expand the shared RTC fake to the full 512-byte user region; execute the actual pinned eboot command write and clear behavior followed by the new startup guard read. A valid separated guard survives and clean maintenance reconnects after OTA; risky/corrupt/read-failed guards still prevent automatic mounting. Unknown legacy migration remains AP-only until explicit storage access. Assert sentinel bytes and all region bounds, not only marker preservation before reboot.
- [ ] Keep response/log assertions proving no password, recovery token, or request body is disclosed.

### Maintenance Wi-Fi Hardware Risks, Protection, and Acceptance

AP and STA share one radio channel; association/channel migration may briefly interrupt a phone even while AP mode remains enabled. This limitation is documented by the [ESP8266 core](https://arduino-esp8266.readthedocs.io/en/3.1.2/esp8266wifi/soft-access-point-class.html). Test eventual AP reconnection and HTTP service, rather than promising simultaneous uninterrupted RF links. Keep retry intervals and fixed buffers; measure heap, largest free block, reset reason and HTTP loop gaps before/after reconnection.

Under separate physical authorization, validate:

- Clean restart with already saved credentials: maintenance remains active; the PC reaches maintenance over Ethernet through the HSPOT LAN; phone reaches the same maintenance service through `NeonByte-...` at `192.168.4.1`.
- Legacy first-upgrade and subsequent supported-update behavior are distinguished. Record any one-time AP/phone storage preparation; it is not successful automatic Ethernet recovery. RTC retention and eboot behavior on the actual device remain separate hardware criteria.
- HSPOT absent at boot, restored later, disconnected later, and wrong saved password: AP remains usable and the application never starts automatically. Do not deliberately corrupt the only unit's storage; inject those failures offline or on an authorized spare.
- Phone client can authenticate status/diagnostics, pause/run, and manually call the existing firmware endpoint when separately authorized. `/` is not a dashboard; document full paths and headers. The STA interface must not replace the AP.
- PC Ethernet and clock STA actually have mutual routing; router client isolation/VLANs/firewalls can prevent access despite a shared network name. Diagnose that separately from firmware association.
- Detect an HSPOT subnet overlapping `192.168.4.0/24`; preserve the AP address, report the routing limitation, and require network correction rather than silently moving recovery.
- Ordinary maintenance requests complete within the existing 10-second client deadline outside a deliberate upload. Record maximum loop gap, free heap/largest block, unexplained timeouts/resets and a 1-2 hour reconnect soak. Single-client uploads can delay other clients until completion or deadline.

**Exit condition:** host fault tests pass, no automatic application/storage-write regressions occur, and separately authorized PC/phone/outage criteria are recorded. Do not claim credentials were recovered or AP+STA tested without evidence. Stage 3 needs separate approval; its offline implementation can be authorized independently, but automatic LAN recovery acceptance requires this behavior.

## Stage 3: OTA from the Windows Dashboard

### Files and Component Boundaries

| Files | Responsibility |
|---|---|
| New `agent/src/device/maintenance-client.ts` and `agent/tests/maintenance-client.test.ts` | Authenticated maintenance GET/POST/PUT, typed safe errors, exact framing, bounded HTTP upload with backpressure/progress; no implicit retry. |
| New `agent/src/device/firmware-update.ts` and `agent/tests/firmware-update.test.ts` | Candidate preparation, immutable bytes/SHA-256, approval binding, one active job, state machine, last-IP/manual reconnection, non-secret intent journal, post-boot verification. |
| New `agent/src/device/recovery-store.ts` and `agent/tests/recovery-store.test.ts` | Additive `NeonByte` / `device-maintenance-v1` keyring entry, verified role/device binding, readback and failure recovery without replacing existing device/Spotify entries. |
| New `agent/src/device/firmware-inbox.ts` and `agent/tests/firmware-inbox.test.ts` | Fixed, protected local inbox for file/manifest selection without a dialog or browser file transfer; bounded snapshots and opaque candidate IDs. |
| Optional new `agent/scripts/select-firmware.ps1` and Windows-only selection tests | Candidate native dialog, first validated through the actual hidden launch chain using harmless fixtures. Include it only if that validation succeeds; the inbox remains sufficient for the first version. |
| Optional later `agent/src/device/discovery.ts`, its tests and built-in ESP8266mDNS integration in `firmware/src/esp8266/main.cpp` | Separately reviewed DNS-SD convenience after measuring resources; excluded from first-version dependencies and acceptance gates. |
| Existing `agent/src/device/integration.ts`, `scheduler.ts`, `main.ts` and their tests | Preserve legacy configuration loading, add verified address rebinding, exclusive suspension/draining, native/CLI credential enrollment, explicit run/resume. |
| Existing `agent/src/web/server.ts`, `public/index.html`, `public/app.js`, `public/styles.css`, `agent/tests/web.test.ts`, `display-preview.test.ts` | English update UI, Host/Origin enforcement on every mutation, sanitized cached status, no device token/binary endpoints. |
| Existing `firmware/src/esp8266/http_server.cpp` and header; new `firmware/include/neonbyte/build_identity.h` | Add bounded maintenance build/device/boot identification and update-capability response. Keep current OTA route and transaction unchanged. |
| Existing host harness and `agent/tests/offline/maintenance.test.ts`; focused HTTP probes | Model old/new build IDs, reset epochs, address changes, failures and absence of repeated firmware PUTs. |
| Existing protocol/startup/recovery/installation documentation and launcher tests | Document new maintenance information, last-IP/manual correction, inbox/dialog workflow, additive credential enrollment, deadlines and verification; preserve the existing scheduled-task registration. |

### Maintenance Interfaces and Compatibility

Reuse these existing routes, all with the recovery bearer, including GET:

| Method | Existing route | Use |
|---|---|---|
| GET | `/maintenance/v1/status` | Application, AP, station and configuration state. |
| GET | `/maintenance/v1/diagnostics` | Memory/reset/HTTP evidence before and after update. |
| POST | `/maintenance/v1/pause` | Stop application/display work while preserving networking. |
| PUT | `/maintenance/v1/firmware` | Raw binary, exact Content-Length, `application/octet-stream`, lowercase `X-Content-SHA256`; success is 204 followed by scheduled reboot. |
| POST | `/maintenance/v1/run` | Explicitly start the application after verification and a separate user action. |

- [ ] Add recovery-authenticated `GET /maintenance/v1/info`, available without storage/application startup. Proposed bounded fields: `deviceId`, `bootId`, `buildId`, `firmwareVersion`, `stationIp`, `recoveryApIp`, `otaEnabled`, `maxFirmwareBytes`, and `profile`. Keep the response within the existing fixed response capacity and return no credentials/SSID. Derive capacity conservatively from existing geometry checks; the upload path remains authoritative.
- [ ] Use a stable non-secret chip/device identifier, a fresh boot-instance identifier per startup, and a unique immutable build identifier assigned by the future trusted private-build process. An authenticated response identifies the running build; do not pretend a constant version or reset counter is sufficient. No final-image SHA-256 is embedded into its own image.
- [ ] Require a maintainer-approved private-build manifest binding the selected bytes' SHA-256/length to the expected build ID, target/profile, existing recovery-identity fingerprint and enabled maintenance-on-boot/OTA gates. Verify the actual final artifact during the separately authorized build process. A request digest alone does not establish image provenance, identity preservation, boot compatibility or a publisher signature.
- [ ] Keep legacy `/status`, `/diagnostics`, all API v1 schemas, stock restoration, and raw activation rules intact. Document the additive information route. A legacy firmware lacking verifiable identity must be reported as unsupported for fully verified dashboard OTA; never invent a successful verification. Any required bootstrap/manual upgrade is a separate operation, not an automatic compatibility fallback.

Dashboard OTA acceptance requires authenticated identification firmware support and Stage 2's nonoverlapping RTC policy to be installed through a separately approved transition. It requires no mDNS/DNS-SD support. The current legacy image cannot acquire the required features from a Windows UI change alone. A manual bridge uses the existing authenticated endpoint and phone/AP if necessary; it introduces no UART dependency and remains subject to the existing deployment gates. Do not hide that prerequisite or automatically run the bridge from the panel.

### Candidate Selection and Approval

- [ ] Let the panel prepare a candidate from the protected local inbox, or from the native selector only after its Windows validation. Both paths use the same agent-only file/manifest validation and one bounded immutable snapshot. No browser file input/ArrayBuffer, arbitrary browser-supplied filesystem path, firmware download route, or remote URL input is permitted.
- [ ] Hash the bytes with Node.js SHA-256 and compare with the trusted reference manifest. Display only sanitized basename, byte length, digest, expected build and device. A computed digest compared only with itself is not independent integrity validation. Reject missing/mismatched reference, empty/oversized files and unsupported image headers/profiles before device mutation; final full image/CRC validation remains the existing firmware's responsibility.
- [ ] Retain the current private preparation ceiling of 458,752 bytes, the firmware's separate absolute 524,288-byte limit, and any lower runtime capacity. Do not relax one because another allows a larger image. Reject identity-less public artifacts, identity/profile mismatch, and stock/FS/compressed images.
- [ ] Prepare an opaque single-use candidate ID bound to SHA-256, device identity and expected build. Show an explicit final confirmation before any pause or firmware PUT. Replacement, expiration, target/configuration change, or process restart invalidates the confirmation. File mutation after selection cannot alter the in-memory approved snapshot.

### Windows File Selection: Evidence, Validation, and Fallback

The registration source uses `New-ScheduledTaskPrincipal -LogonType Interactive -RunLevel Limited`, launched at the same user's login. The documented [interactive logon type](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype) runs in an existing interactive session. WScript nevertheless hides its child, the PowerShell host uses `-NonInteractive`, and all Node stdout/stderr reaches `%LOCALAPPDATA%\NeonByte\agent.log`. The existing launcher test proves hidden execution/output/exit handling, not file-dialog visibility.

The [PowerShell documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1) distinguishes apartment state, noninteractive shell prompts and window style. Do not infer that these flags either guarantee or universally prevent a WinForms dialog. A dedicated helper can request `-NoProfile -STA -File` explicitly; its ability to show a usable dialog still requires actual session validation. [Environment.UserInteractive](https://learn.microsoft.com/en-us/dotnet/api/system.environment.userinteractive?view=netframework-4.8.1) is a preliminary check, not proof of visibility/focus. No dialog, scheduled-task setting or credential store is exercised in this planning revision.

- [ ] Before enabling native selection, test a harmless local fixture through the actual Windows-native Node process launched by the existing task, not just a foreground shell or WSL interop call. Verify visible/selectable dialog, correct active user/session, cancel, paths with spaces/Unicode, panel responsiveness, and no orphaned helper. Bound selection to 120 seconds; timeout, unavailable/locked desktop or helper error leaves no prepared firmware and no device mutation. Do not automatically open another dialog.
- [ ] Capture the helper's result and errors in private process pipes; never inherit its stdout/stderr into the launcher log or serialize a spawn exception/absolute path to HTTP. Use fixed executable/script arguments without a shell, generic error codes and sanitized non-sensitive labels. Do not change the task to an elevated/service account or weaken execution policies to force GUI access.
- [ ] Provide a dialog-independent baseline: the operator copies the approved binary and manifest with File Explorer into `%LOCALAPPDATA%\NeonByte\firmware-inbox`, using fixed names `firmware.bin` and `manifest.json`, then selects `Prepare local firmware` in the panel. The agent reads only this fixed inbox on that explicit request, using the same logged-in Windows account. No automatic watching, preparation, device request or upload follows merely from a file appearing.
- [ ] Restrict inbox access to the current user and required OS principals; reject broad writable permissions, unexpected files, nonregular files and path escapes/reparse redirection outside the inbox. Handle missing, locked, changing or partially copied files as local preparation errors. Enforce length limits, take an immutable snapshot, and verify its manifest/hash before readiness. Return only an opaque candidate ID, generic label and approved non-secret metadata; never resolve or return user-profile paths in HTTP/logs.
- [ ] If native selection remains unverified or fails, ship the first version with the inbox path alone. The optional picker must not block OTA planning or require a second agent instance, task re-registration, browser firmware upload, or new privileged UI service. Inbox selection still requires the normal final OTA confirmation.

### Additive Windows Credential Enrollment and Compatibility

Current source stores `{ address, token, enabled }` in service `NeonByte`, account `device-configuration`, through `SystemDeviceConfigStore`. `start()` restores it and enables the scheduler only if the saved flag is true. The UI currently submits a pairing token, while responses expose only pairing status. Spotify's refresh token lives in the separate `spotify-refresh-token` account. These are code facts; no installed credential values were read. Both the documented task and keyring access must use the same Windows user/profile and native Node installation.

- [ ] Keep the legacy account name, payload and startup loading intact. Agent upgrades read it without rewriting/deleting it, changing `enabled`, re-pairing the device or starting Spotify OAuth. Leave `spotify-refresh-token` and its store API untouched. A maintenance enrollment failure disables only maintenance/OTA, preserving the existing application connection and Spotify session.
- [ ] Add service `NeonByte`, account `device-maintenance-v1`, containing a versioned record with the recovery token, trusted device ID, enrolled recovery-identity fingerprint and last verified maintenance address. Create it only after explicit enrollment and identity checks. If a valid maintenance record already exists, reuse it without overwrite; conflicting enrollment requires a separate reviewed operator action, not startup migration.
- [ ] Offer native/CLI-only secure enrollment under the same Windows account, with no secret command-line arguments, `.env` token fallback, raw exception logging or browser token input. Keep token/identity inputs in memory until verified. Preserve configured pairing even when no recovery credential is available; show only `Maintenance credentials required` in the page.
- [ ] A fallback enrollment CLI is launched deliberately by the operator in a foreground Windows terminal under that same user. Do not attempt `Read-Host` inside the hidden `-NonInteractive` host, launch another long-running agent or modify the existing task. Enrollment stores credentials only; it never starts the application or sends firmware.
- [ ] Reuse of a stored pairing token for recovery is opt-in and requires local comparison with the retained trusted private recovery record plus successful recovery-authenticated maintenance identification for the expected device. Then, and only then, store it in the maintenance role. Equal values are supported; equality, a working application API or configured IP alone cannot verify recovery authority. On 401, identity mismatch or legacy firmware without adequate identification, preserve the existing entry and request the separate native recovery-enrollment/manual-bridge flow; do not try other tokens automatically.
- [ ] Enroll the expected recovery-identity fingerprint from the retained private record, not the candidate manifest. Define it as SHA-256 of the ASCII prefix `NeonByte recovery identity v1`, a NUL byte, the token, another NUL byte and the AP password. The trusted build process computes the same fingerprint; only that digest enters the manifest. Compare against the previously enrolled value before any update; never rotate the installed token or AP password in this migration.
- [ ] Write and read back the new maintenance record; require exact agreement before enabling maintenance mutations. Handle denied access, write/read failure, malformed/partial records and process interruption without mutating either legacy account. No cross-entry transaction is assumed. On subsequent startup, validate the new record and recheck device identity before use; a partial/unverified record cannot enable OTA, and the legacy device/Spotify records remain the recovery source for ordinary agent operation.
- [ ] Remove browser token entry only while retaining the existing configured pairing internally and providing the native enrollment alternative for genuinely new credentials. Reject token-bearing browser configuration requests. Manual DHCP correction uses the verified rebind described below, so removing the token field must not make existing users pair again or lose connectivity.

Migration acceptance covers unchanged legacy values across agent/task restart, shared versus distinct token values, absent recovery enrollment, verification/write failures and repeated enrollment. It never clears a valid existing credential to make a new workflow pass. Windows-native keyring readback under the scheduled user's profile remains a manual validation requirement; Linux mocks do not establish it.

### Update State Machine and Exclusive Operation

Proposed states: `idle`, `preparing`, `ready`, `preflight`, `pausing`, `uploading`, `validating`, `waitingForReboot`, `reconnecting`, `verifying`, `verified`, `rejected`, `transferFailed`, `verificationFailed`, and `outcomeUnknown`.

- [ ] After confirmation, obtain an exclusive per-device operation lease. Suspend and drain the scheduler's current request; do not permanently call the integration's shutdown method or reset pairing settings. Block concurrent mode/media/configuration/run/firmware actions from any dashboard tab until the operation ends.
- [ ] Read authenticated maintenance status/info/diagnostics; bind device ID and pre-update boot/build identity, check compatibility, enabled OTA and available capacity. Preflight is read-only; never probe OTA availability by starting a write.
- [ ] Send `/pause`, then confirm `applicationRunning=false` through maintenance status. If pausing is rejected or cannot be confirmed, send no firmware bytes. Keep synchronization suspended and the application paused on later errors; do not resume automatically.
- [ ] Persist a minimal credential-free intent record before the one firmware PUT: job/candidate hash, target/build IDs, previous boot ID, state and attempt count. It supports read-only reconciliation after an agent restart; it does not authorize replay.
- [ ] Use native Node.js HTTP streaming with bounded chunks/backpressure and explicit Content-Length; disable redirects and automatic retries. Send the existing bearer and SHA-256 headers. Keep ordinary request timeout at 10 seconds; use a 75-second agent OTA ceiling as the existing 60-second firmware budget plus response margin. Firmware retains its five-second idle and 60-second total OTA deadlines.
- [ ] Report bytes handed to transport as transfer progress, never as flash verification. After the last bytes, show validation/reboot as separate stages; 100% sent is not completed. The HTTP server is single-client: while the PUT is active, dashboard polling reads agent-cached progress, not parallel device status requests.
- [ ] A received 204 means the candidate was accepted/activated, not that it booted. The current firmware schedules restart about two seconds later. If the final response is lost, enter `outcomeUnknown` and perform only bounded read-only reconnection/verification; never resend automatically.
- [ ] Persist terminal/ambiguous state safely. After agent/browser restart or double confirmation, recover/display the existing job; perform zero automatic firmware PUTs. A later manual retry requires fresh preflight, preparation and explicit confirmation after the previous outcome is assessed.

### Reconnection Without a Fixed IP

- [ ] First retry the last authenticated private IPv4 address from the maintenance record/job; for initial enrollment use the already configured legacy address only as an unverified candidate. Retain the existing local-origin/private-address checks, hostname rejection and redirect prohibition. No mDNS responder, DNS-SD resolver, UDP listener, network scan or additional ESP8266 RAM allocation is needed for first-version reconnection.
- [ ] Use a 120-second total automatic reconnect/verification window with bounded read-only attempts and backoff, never concurrent polls. If the device is unavailable, keep `outcomeUnknown` and offer `Correct device address` in the panel, accepting only a validated private IPv4 HTTP origin. The operator obtains it from router DHCP information or the phone's authenticated maintenance info. Never imply the PC's Ethernet connection can reach the recovery AP directly; a router reservation remains optional convenience.
- [ ] Authenticate `/maintenance/v1/info` at the corrected address using the existing recovery credential and require the enrolled device ID/profile. Before declaring OTA success, also require the existing job's expected build ID, a changed boot ID and all status/diagnostic checks. A different private IP or a successful TCP connection never transfers identity. Identity checking over trusted-LAN HTTP is not cryptographic server authentication; retain the current transport boundary.
- [ ] Add an internal verified-address rebind path instead of calling `DeviceIntegration::configure()` unchanged: its current new-address rule intentionally drops token reuse. After server-side identity verification, save the effective address in the maintenance record and construct the scheduler client internally with that verified address and the unchanged legacy pairing token/`enabled` flag. Display the effective address in the panel; leave the legacy `device-configuration` entry untouched. Revalidate the maintenance binding before applying its address on restart. Keep normal rejection for unbound/different devices. If persistence fails, retain the prior effective settings and report the correction as uncommitted; never prompt for pairing/Spotify authentication to work around that failure.
- [ ] Before a PUT, address/configuration changes invalidate prepared confirmation and require fresh preflight/approval. After a PUT has been attempted, a manual correction continues only read-only reconciliation for that same job, retaining expected build/device/boot evidence and attempt count. Offer an explicit new bounded verification window; do not reset the job or resend firmware. Keep the scheduler suspended until explicit application startup and honor its saved enabled state on resume.

**Optional later enhancement:** DNS-SD/mDNS may propose candidate private addresses for this same flow after separate scope/resource review. It cannot bypass authenticated identification, alter the AP, advertise credentials, send a bearer to every answer, or become a prerequisite for updating/verifying firmware. Measure RAM, largest heap block, loop gaps and reconnect behavior on ESP8266 before adopting it. Manual address correction remains supported even if discovery is later added.

### Post-Boot Verification and Manual Resume

- [ ] Query `/maintenance/v1/info`, `/status` and `/diagnostics` after reconnection; require the same device ID, a different boot ID, the selected manifest's expected build ID, `applicationRunning=false`, a running AP, and working maintenance over the selected LAN path. Record reset/memory evidence; do not infer healthy memory from linked static RAM.
- [ ] Require two successful maintenance observation rounds at least two seconds apart within the total window. A reachable old build, wrong device, unchanged boot ID, repeated reset, wrong expected build, disabled/missing maintenance, or failed diagnostics is not verified.
- [ ] Only then set `verified` and offer `Start application`. `/run` is a separate explicit action; after it succeeds, the scheduler may resume and synchronize current mode/playback/media. Failures leave maintenance visible and networking available.

The manifest/digest checks bind the approved file; post-boot checks confirm the expected build is running and maintenance works. They do not claim a complete post-flash byte-for-byte SHA-256 readback, an extended stability test, automatic rollback, or independent failed-boot recovery. No trustworthy expected build identity means the result remains unverified.

### Error Classification

| Condition | Required behavior |
|---|---|
| Invalid candidate, SHA/reference/profile/identity mismatch, missing keyring credential | Reject locally; no pause or firmware PUT. |
| 401, OTA-disabled/conflict, insufficient capacity, failed pause | Safe specific error; no automatic retry or application resume. Do not expose a remote body. |
| Interrupted/incomplete upload or explicit device validation/write rejection | `transferFailed` or `rejected` as supported by evidence; keep maintenance accessible, never automatically PUT again. |
| Body sent but final response lost or agent exits around activation | `outcomeUnknown`; reconnect/read only, then classify by authenticated boot/build observations. |
| 204 followed by expected temporary disconnect | `waitingForReboot`/`reconnecting`; not an immediate transfer failure or success. |
| Reachable old/wrong build, wrong device, or unhealthy reboot | `verificationFailed`; no false completion and no automatic second write. |
| No device before bounded verification deadline | `outcomeUnknown`; provide AP/phone and address-correction instructions, without implying physical recovery is available. |

### Windows OTA Automated Tests

- [ ] Candidate tests: wrong/missing SHA reference, oversized/empty/non-image file, profile/identity mismatch, public compile artifact, changed file after selection, cancellation, stale candidate IDs, and native selector failure. Confirm zero device mutation before approval and no private binary/token/path reaches HTML/JSON/JS/log output.
- [ ] Inbox tests: missing or partially copied pair, locked/changed file, oversized input, weak permissions, path escape/reparse redirection and malicious candidate ID. The page cannot request arbitrary files or download firmware; file arrival does not prepare/upload anything, and an immutable verified snapshot is required.
- [ ] Identity tests reject a candidate's self-asserted fingerprint if it differs from the existing enrolled binding, including unchanged recovery token with a changed AP password. Missing prior binding cannot silently trust the candidate's value.
- [ ] Credential tests: restore the original `device-configuration` shape, preserve exact `token`/`enabled`/address on startup and failed enrollment, leave Spotify's entry/store calls untouched, and repeat migration/restart without duplication or overwriting valid entries. Model equal and different tokens; copying pairing to recovery requires opt-in, trusted local comparison and authenticated expected identity. Cover 401, wrong device, unavailable legacy identification, read/write/readback failure and interrupted enrollment. An unavailable maintenance record must not disable ordinary pairing/Spotify.
- [ ] Windows-only tests: synthetic selector cancel/success/errors and private stdout/stderr handling, filenames with spaces/metacharacters, no command injection, restricted native credential input, native keyring access under the scheduled user, and inbox ACLs. Separately require the real hidden-task dialog visibility/timeout/cancel checklist; a mock or Linux skip does not pass that gate. An unverified dialog leaves the fully tested inbox flow available.
- [ ] Maintenance transport tests: bearer on GET and mutation, strict length/content type/SHA header, safe HTTP-code mapping, no redirect/public destination, no application-status precheck, backpressure/progress, idle/total timeout and dropped response. Count actual firmware requests; assert at most one per confirmed job.
- [ ] Orchestration tests: active media request drained; two tabs/double click cannot overlap; pause failure sends no PUT; unexpected errors never restart application; candidate/target changes invalidate approval; browser/agent restart never replays intent; activated OTA survives client cleanup.
- [ ] Verification tests: 204 then reboot, lost 204 then successful expected build, old build, missing legacy info, unchanged boot ID, wrong device, repeated boots, diagnostics failure, delayed DHCP and address change. Only two valid rounds can produce `verified`; `/run` remains explicit.
- [ ] Reconnection tests with discovery absent: retry the saved IP, exhaust the bounded window, accept a manual private-IP candidate, reject public/link-local/hostname/redirect/other-device inputs, and rebind only after expected authenticated identity. Confirm the pairing token and enabled state survive a verified DHCP change; old settings survive failed verification or persistence. After a lost OTA response, manual correction must verify the same job with zero additional firmware PUTs. Optional future DNS-SD tests belong only to separately approved discovery work.
- [ ] Retain raw OTA fault matrix, complete/incomplete abort behavior, eboot/RTC preservation, no LittleFS dependency, HTTP lifecycle/diagnostic probes, v1 contract tests and all display/Auto regressions. Use mocks/spare-only plans for interrupted writes; never test power loss on the only clock.

### Windows OTA Hardware Risks, Protection, and Acceptance

This stage exposes an existing flash operation through a UI; authentication and hash checks do not make an unsupported image bootable. Validate candidate identity and gates before writes, keep the AP/phone procedure and exact approved previous artifacts, and require stable power for any separately authorized update. Do not promise that the AP survives an image that never starts. The current repository's missing independent recovery/full-backup evidence is not resolved by this panel.

Before device operations, validate Windows selection through the existing hidden task, or explicitly choose the protected-inbox-only first version. Validate same-user native keyring restoration/enrollment without re-pairing or Spotify OAuth; forced selection/keyring failures must not disclose paths/tokens or change current configuration. These Windows criteria are pending and do not require clock mutation to assess the local behavior.

Under separate operation-specific authorization and the existing gates, validate one approved update, truthful progress, expected reboot, last-IP reconnection and manual correction after a DHCP address change with discovery disabled, authenticated new-build/boot checks, and explicit application startup. Check phone AP access before/after and confirm saved network/configuration/GIF, orientation, colors, cover layout, no flicker and Auto behavior. Simulate failed transfer/response and recovery first in host tests; destructive interruption testing belongs only on an approved spare.

**Exit condition:** Windows and host tests pass using either a validated native selector or the protected inbox, legacy device/Spotify credentials survive enrollment/restart, every error path sends at most one firmware PUT per approval, no secret/browser exposure occurs, and a separately authorized hardware run meets the entire post-boot criterion using last-IP/manual reconnection. mDNS/DNS-SD and native-dialog availability are not release dependencies when the baseline flows pass. If boot/recovery gates remain missing, mark physical OTA acceptance blocked; do not approve a release, perform an update, or mark a project phase complete.

## Verification Commands and Stage Boundaries

For this planning task, run `npm run check` and `git diff --check`; these validate documentation/contracts and the existing host agent suite. The TypeScript build is not firmware generation. Source changes and target builds remain prohibited. Existing read-only host dependency probes may be run to check the software evidence; they compile temporary host executables, never an ESP8266 image.

For a later approved source stage, use its focused tests plus `npm run check`, `npm run test:offline`, and native-only `pio test -d firmware -e native`, with existing sanitizers/probes as relevant. Target compilation/private packaging needs separate explicit authorization; do not copy build commands from historical work orders as authority. Never run upload/device/discovery commands as part of offline validation.

Every stage ends with an evidence review and an approval boundary. Keep the three changes independently reviewable; do not combine speculative LCD settings, startup behavior and a new panel operation into one physical experiment. Approval can explicitly allow an independent later stage's offline work while a previous physical criterion remains pending; it cannot turn a pending criterion into a pass. Update `PLANNING.md` only for separately implemented and verified work, never for this proposal.

## Preserved Decisions and Refined Acceptance

- The recommended LCD fix is conditional on the red/blue chart signature; no color setting is changed by this plan.
- Maintenance Wi-Fi permits one guarded configuration-only LittleFS attempt on clean boot, with no automatic application start and no automatic attempt after crash evidence.
- Move the startup guard beyond eboot's reserved RTC region and preserve conservative legacy migration; the first upgrade may need one authenticated phone/AP storage action before later automatic LAN recovery is available.
- Saved NeonByte settings are preferred; `.env` Wi-Fi provisioning is optional work only if persistent settings do not solve the need.
- The phone uses an authenticated HTTP client, as explicitly selected; no embedded recovery dashboard is included.
- Firmware selection uses an agent-owned local snapshot; the protected inbox is the dialog-independent baseline and a native selector is enabled only after hidden-task validation. Neither path sends firmware bytes or resolved paths to the browser. A trusted matching artifact manifest and authenticated build identity remain mandatory.
- Maintenance enrollment adds a separate verified keyring record. Existing pairing and Spotify accounts, saved values and Windows-user compatibility are preserved, including shared-token cases; no automatic role promotion or needless reauthorization is permitted.
- Last known IP and manual identity-verified address correction are sufficient for the first version. Authenticated firmware information and the RTC fix remain required; mDNS/DNS-SD is optional later work with a separate ESP8266 resource check.

### Remaining Windows and Hardware Validation

- **Windows pending:** real dialog visibility/focus/cancellation through the hidden task; protected inbox ACLs/partial-copy handling; native keyring restore/enrollment/readback and verified address rebinding under the same user. Existing startup/restart reports do not establish these new behaviors. If GUI access fails, validate the inbox path and omit the picker.
- **Hardware pending:** controlled LCD colors with unchanged orientation; AP+STA radio/channel behavior, HSPOT outage/recovery and RAM; RTC retention across the legacy bridge and subsequent OTA; authenticated new-build/boot verification and same-device manual DHCP correction. No source/mock result supplies these observations.
- **Existing gates preserved:** full backup, independent Wi-Fi failed-boot recovery, exact flash/layout and operation-specific authorization. Neither GUI fallback nor simpler address handling reduces those requirements.

The next approval requested is implementation of **Stage 1 only**, limited to its authorized offline diagnosis/tests and any evidence-justified source correction. Stage 2/3 implementation, target compilation/private firmware generation, device access and OTA require separate authorization. Windows selection/enrollment questions are Stage 3 acceptance dependencies, not reasons to delay independent Stage 1 offline work or expand its scope.

## Original Analysis Verification Record

- `npm run check` passed: Markdown on 39 files, language checks, 9 root tests, 1 Windows-only skip, TypeScript build/typecheck and all 62 agent tests. No target compiler was invoked.
- `probe_display_colors.py` passed for eight colors, high-byte-first SPI and a byte-reversal mutation using cached GFX 1.13.0. Physical colors remain pending.
- `probe_compatibility.py` passed: requested 20 MHz initialization/drawing, rotation 2, MADCTL 8, offsets 0/0, checked AP setup and recovery-adapter probes. No hardware compatibility was established.
- `probe_http_lifecycle.py` and `probe_http_diagnostics.py` passed their existing host-only disconnect/cleanup/deadline/activation and authenticated diagnostic/non-disclosure checks.
- Independent read-only review identified the RTC collision and shared pairing/recovery token case; both are now explicit proposed tasks and acceptance tests. The RTC finding is source analysis, not a physical observation or a newly implemented fix.
- Tracked-file whitespace checks passed; the new document was also checked separately. Only this Markdown plan is a repository source addition. No stage is implemented, no firmware was generated, and no device or credential store was accessed.

## Planning Revision Record

- Updated this same document after approval of the three-stage architecture; Stage 1/2 execution scope and all pending physical acceptance remain intact.
- Inspected the existing launcher chain, credential-store identifiers/payloads, address-change guard and tests. Consulted official Microsoft session/PowerShell documentation; no dialog was opened, task changed or installed credential read.
- First-version dependencies now exclude mDNS/DNS-SD and unvalidated GUI behavior. Added the protected local inbox, additive role-verified credential enrollment and explicit authenticated manual-IP correction with preservation tests.
- Validate this documentation revision with `npm run check` and `git diff --check`; Windows GUI/keyring and physical checks remain pending regardless of those results. No new plan, product code or firmware is part of this revision.
