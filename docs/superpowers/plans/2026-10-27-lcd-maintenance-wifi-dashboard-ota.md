# LCD Colors, Maintenance Wi-Fi, and Windows OTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans, or superpowers:subagent-driven-development if separately selected, to implement an approved stage task by task. All execution checkboxes below remain unchecked. This document authorizes no implementation or device operation.

**Goal:** Correct LCD color reproduction without changing the validated orientation, reconnect saved Wi-Fi while remaining in maintenance, and operate the existing authenticated OTA transaction from the Windows dashboard.

**Architecture:** Retain the Adafruit row renderer, portable `SafeStartup` policy, namespaced persistent configuration, single-client HTTP server, and raw maintenance updater. Separate saved-network loading from application startup. Add Windows-side maintenance orchestration and narrowly scoped firmware identification/discovery support, without introducing another updater.

**Tech Stack:** Existing C++17/ESP8266 Arduino 3.1.2 adapters, Adafruit ST7789 1.11.0, LittleFS, Node.js/TypeScript, Windows Credential Manager through the existing keyring package, native Node.js HTTP/crypto/UDP APIs, and the existing loopback dashboard.

**Spec:** Maintainer's analysis-only request dated 2026-10-27, captured in the requirements and evidence below; [project planning](../../../PLANNING.md), [protocol](../../protocol.md), [safe startup](../../safe-first-boot.md), [maintenance OTA](../../maintenance-ota-design.md), [HTTP correction](../../http-recovery-investigation.md), and [display report](../../spotify-gif-display.md).

**Status:** PROPOSED, awaiting maintainer approval. Analysis baseline: local `main` and local `origin/main` both reference `014ec6241193ca568cc9c3edd518b4456b1c7dd2`. This identifies the inspected checkout, not a newly fetched remote head or the installed device image. Only this planning document is added by this task. No source, contracts, credentials, hardware settings, or `PLANNING.md` checkboxes are changed.

## Global Constraints

- Current authorization is analysis and planning only: no implementation, target compilation, firmware generation, discovery, clock requests, restart, OTA, erase, formatting, partition change, serial access, UART, or soldering.
- Future stages require separate authorization. Physical operations also require their own bounded authorization and the existing evidence/recovery gates; approving source work does not approve deployment.
- Preserve 180-degree orientation: Adafruit rotation 2, 240 by 240 bounds, offsets 0/0, and the current geometry bits. A color correction may change MADCTL bit 3 alone if justified.
- Preserve Spotify's centered 176 by 176 cover, current font sizes, no progress bar, content-based redraw, and Auto behavior: confirmed playback selects Spotify; pause/no playback selects the installed GIF.
- Preserve strict HTTP framing, disconnected-client ownership/cleanup, bounded deadlines, diagnostics, bearer authentication, SHA-256 readback, image/CRC/geometry validation, fail-closed activation, and delayed-reboot protection.
- Preserve the exact existing private recovery identity and valid pairing/configuration records. A public compile-check image lacks that identity and is not an update candidate.
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
| Shared token values | `main.cpp:88` initializes an absent pairing token with the recovery token; the current browser pairing form accepts a token. | Different roles/keyring entries do not imply different values. Move device bearer import out of the browser, including ordinary pairing, without rotating existing device identity. |
| Verification/discovery gaps | Maintenance status contains booleans; diagnostics contain counters. Application firmware version is hardcoded as `0.1.0-phase4`. Discovery is absent; the current client rejects hostnames. | Existing endpoints alone cannot establish the expected build after reboot or automatically find a changed address. Add bounded identification/discovery support. |
| Mobile recovery | Authenticated maintenance endpoints exist; a browser control page at `/` does not. The maintainer selected an authenticated HTTP client for the phone. | Treat `http://192.168.4.1` as the base URL and document full endpoint paths; no recovery web portal is needed. |

The maintainer confirms that factory firmware displayed all colors correctly, the current NeonByte firmware makes red appear blue, and the current orientation is correct. Green and blue are described as apparently correct. These are accepted maintainer observations; this analysis neither reran them nor identified the exact installed binary. Older statements that orientation is pending are historical and must not override this confirmation. Backup, independent failed-boot recovery, actual flash geometry, and successful future-candidate boot remain unsupported by these observations.

### Recommended Approach and Alternatives

Use a conditional one-bit LCD correction, a guarded configuration-only maintenance boot path, and agent orchestration around the existing updater. This is the recommended design for approval, not an already selected implementation.

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
| New `agent/src/device/firmware-update.ts` and `agent/tests/firmware-update.test.ts` | Candidate preparation, immutable bytes/SHA-256, approval binding, one active job, state machine, non-secret intent journal, post-boot verification. |
| New `agent/src/device/recovery-store.ts` and focused credential-store tests | Separate system-keyring entry for the recovery token and known device binding; no plaintext fallback or browser import. |
| New `agent/src/device/discovery.ts` and `agent/tests/discovery.test.ts` | Bounded DNS-SD candidate resolution and private-address validation; no subnet scan or broadcast bearer transmission. |
| New `agent/scripts/select-firmware.ps1` and Windows-only selection tests | Native local file/manifest dialog, invoked with fixed arguments; returns selection only to the agent. No binary upload through browser JavaScript. |
| Existing `agent/src/device/integration.ts`, `scheduler.ts`, `main.ts` and their tests | Exclusive device-operation suspension/draining, maintenance lifecycle, secure device-credential import through a local non-browser operator flow, explicit run/resume. |
| Existing `agent/src/web/server.ts`, `public/index.html`, `public/app.js`, `public/styles.css`, `agent/tests/web.test.ts`, `display-preview.test.ts` | English update UI, Host/Origin enforcement on every mutation, sanitized cached status, no device token/binary endpoints. |
| Existing `firmware/src/esp8266/http_server.cpp` and header; new `firmware/include/neonbyte/build_identity.h` | Add bounded maintenance build/device/boot identification and update-capability response. Keep current OTA route and transaction unchanged. |
| Existing `firmware/src/esp8266/main.cpp` | Built-in ESP8266mDNS advertisement/update handling on STA, including maintenance; no effect on AP availability. |
| Existing host harness and `agent/tests/offline/maintenance.test.ts`; focused HTTP probes | Model old/new build IDs, reset epochs, address changes, failures and absence of repeated firmware PUTs. |
| Existing protocol/startup/recovery/installation documentation | Document new maintenance information, operator file/credential workflow, discovery fallback, deadlines, security and verification semantics. |

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

Dashboard OTA acceptance requires the identification/discovery firmware support and Stage 2's nonoverlapping RTC policy to be installed through a separately approved transition. The current legacy image cannot acquire those features from a Windows UI change alone. A manual bridge uses the existing authenticated endpoint and phone/AP if necessary; it introduces no UART dependency and remains subject to the existing deployment gates. Do not hide that prerequisite or automatically run the bridge from the panel.

### Candidate Selection and Approval

- [ ] Make the panel's `Select firmware` button ask the agent to open a native Windows file dialog. Use the same operator flow to select the approved manifest. Load one bounded immutable candidate snapshot inside the agent; no browser file input/ArrayBuffer, arbitrary browser-supplied filesystem path, firmware download route, or remote URL input.
- [ ] Hash the bytes with Node.js SHA-256 and compare with the trusted reference manifest. Display only sanitized basename, byte length, digest, expected build and device. A computed digest compared only with itself is not independent integrity validation. Reject missing/mismatched reference, empty/oversized files and unsupported image headers/profiles before device mutation; final full image/CRC validation remains the existing firmware's responsibility.
- [ ] Retain the current private preparation ceiling of 458,752 bytes, the firmware's separate absolute 524,288-byte limit, and any lower runtime capacity. Do not relax one because another allows a larger image. Reject identity-less public artifacts, identity/profile mismatch, and stock/FS/compressed images.
- [ ] Store the recovery bearer only in a dedicated existing-keyring-backed entry, distinct from the ordinary pairing token. Import it through a local native/CLI secure flow without command-line secret arguments or browser transit. Require the credential manager; no `.env` or plaintext fallback for that token.
- [ ] Bind the keyring record to the known device ID and an expected recovery-identity fingerprint enrolled from the retained private identity record through that native operator flow. Define the fingerprint as SHA-256 of a versioned domain prefix, the token, a NUL separator and the AP password; the trusted private-build process computes the same value for its manifest. Only the fingerprint, never either secret, enters the manifest. Compare the candidate manifest with this previously enrolled expected value; do not enroll a new expected identity from the candidate being checked. Missing binding requires explicit local enrollment, not a bypass. This also verifies AP-password preservation without returning or storing that password in the page.
- [ ] Remove browser-based entry/submission of device bearer credentials from the existing pairing settings as well. Retain already configured tokens in the keyring and offer native/CLI-only credential import; the dashboard continues changing address/enabled state without reading a token. Reject token-bearing browser configuration requests. Existing pairing and recovery values may be equal: preserve their roles and valid installed values without automatic rotation or copying a presumed pairing credential into the recovery role. Historical manual browser entry is not retroactively erased by this change.
- [ ] Prepare an opaque single-use candidate ID bound to SHA-256, device identity and expected build. Show an explicit final confirmation before any pause or firmware PUT. Replacement, expiration, target/configuration change, or process restart invalidates the confirmation. File mutation after selection cannot alter the in-memory approved snapshot.

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

- [ ] Advertise a small `_neonbyte._tcp.local` DNS-SD service through the core's built-in mDNS implementation on STA; include only the non-secret stable device ID. Start/update it during maintenance and after GotIP, stop/reannounce on network changes, and keep networking usable if advertisement fails.
- [ ] In the agent, try the last validated private IPv4 first, then a bounded DNS-SD lookup for the known device. Resolve to a private literal before connecting; preserve rejection of public/link-local destinations and redirects. Do not simply relax the existing client's hostname rule.
- [ ] Use a 120-second total reconnect/verification window with bounded read-only attempts and backoff, never concurrent polls. Discovery packets contain no bearer. Authenticate the selected candidate and require the known device ID before accepting an address change. Discovery/HTTP on a trusted LAN is not cryptographic server authentication and must not be presented as such.
- [ ] If multicast is blocked or the device is not found, report an unresolved outcome and offer explicit address correction from router DHCP information or the phone's authenticated maintenance info. Do not scan an entire subnet with a bearer, accept an unrelated device, or claim that `192.168.4.1` is reachable from an Ethernet-only PC. An optional router reservation is convenience, not a fixed-IP dependency.

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

- [ ] Candidate tests: wrong/missing SHA reference, oversized/empty/non-image file, profile/identity mismatch, public compile artifact, changed file after selection, cancellation, stale candidate IDs, and native selector failure. Confirm zero device mutation before approval and no private binary/token reaches HTML/JSON/JS/log output.
- [ ] Identity tests reject a candidate's self-asserted fingerprint if it differs from the existing enrolled binding, including unchanged recovery token with a changed AP password. Missing prior binding cannot silently trust the candidate's value.
- [ ] Credential tests explicitly model equal pairing/recovery tokens and different values, restored existing keyring entries, rejection of browser token submissions, and native-only import. Both configurations preserve access without returning or requesting bearer values through the page.
- [ ] Windows-only tests: native picker cancel/select via injected dialog seam, filenames with spaces/metacharacters, no command injection, restricted operator credential import and keyring failures. A Linux skip is reported as pending Windows evidence.
- [ ] Maintenance transport tests: bearer on GET and mutation, strict length/content type/SHA header, safe HTTP-code mapping, no redirect/public destination, no application-status precheck, backpressure/progress, idle/total timeout and dropped response. Count actual firmware requests; assert at most one per confirmed job.
- [ ] Orchestration tests: active media request drained; two tabs/double click cannot overlap; pause failure sends no PUT; unexpected errors never restart application; candidate/target changes invalidate approval; browser/agent restart never replays intent; activated OTA survives client cleanup.
- [ ] Verification tests: 204 then reboot, lost 204 then successful expected build, old build, missing legacy info, unchanged boot ID, wrong device, repeated boots, diagnostics failure, delayed DHCP and address change. Only two valid rounds can produce `verified`; `/run` remains explicit.
- [ ] Discovery tests: matching/mismatched IDs, malformed/unrelated answers, hostname/private-literal filtering, public/link-local addresses, redirects, multicast unavailable and manual-address fallback. No request with a bearer is sent to every advertised service or every LAN address.
- [ ] Retain raw OTA fault matrix, complete/incomplete abort behavior, eboot/RTC preservation, no LittleFS dependency, HTTP lifecycle/diagnostic probes, v1 contract tests and all display/Auto regressions. Use mocks/spare-only plans for interrupted writes; never test power loss on the only clock.

### Windows OTA Hardware Risks, Protection, and Acceptance

This stage exposes an existing flash operation through a UI; authentication and hash checks do not make an unsupported image bootable. Validate candidate identity and gates before writes, keep the AP/phone procedure and exact approved previous artifacts, and require stable power for any separately authorized update. Do not promise that the AP survives an image that never starts. The current repository's missing independent recovery/full-backup evidence is not resolved by this panel.

Under separate operation-specific authorization and the existing gates, validate one approved update, truthful progress, expected reboot, LAN rediscovery including a changed DHCP address, authenticated new-build/boot checks, and explicit application startup. Check phone AP access before/after and confirm saved network/configuration/GIF, orientation, colors, cover layout, no flicker and Auto behavior. Simulate failed transfer/response and recovery first in host tests; destructive interruption testing belongs only on an approved spare.

**Exit condition:** Windows and host tests pass, every error path sends at most one firmware PUT per approval, no secret/browser exposure occurs, and a separately authorized hardware run meets the entire post-boot criterion. If boot/recovery gates remain missing, mark physical OTA acceptance blocked; do not approve a release, perform an update, or mark a project phase complete.

## Verification Commands and Stage Boundaries

For this planning task, run `npm run check` and `git diff --check`; these validate documentation/contracts and the existing host agent suite. The TypeScript build is not firmware generation. Source changes and target builds remain prohibited. Existing read-only host dependency probes may be run to check the software evidence; they compile temporary host executables, never an ESP8266 image.

For a later approved source stage, use its focused tests plus `npm run check`, `npm run test:offline`, and native-only `pio test -d firmware -e native`, with existing sanitizers/probes as relevant. Target compilation/private packaging needs separate explicit authorization; do not copy build commands from historical work orders as authority. Never run upload/device/discovery commands as part of offline validation.

Every stage ends with an evidence review and an approval boundary. Keep the three changes independently reviewable; do not combine speculative LCD settings, startup behavior and a new panel operation into one physical experiment. Approval can explicitly allow an independent later stage's offline work while a previous physical criterion remains pending; it cannot turn a pending criterion into a pass. Update `PLANNING.md` only for separately implemented and verified work, never for this proposal.

## Decisions for Maintainer Review

- The recommended LCD fix is conditional on the red/blue chart signature; no color setting is changed by this plan.
- Maintenance Wi-Fi permits one guarded configuration-only LittleFS attempt on clean boot, with no automatic application start and no automatic attempt after crash evidence.
- Move the startup guard beyond eboot's reserved RTC region and preserve conservative legacy migration; the first upgrade may need one authenticated phone/AP storage action before later automatic LAN recovery is available.
- Saved NeonByte settings are preferred; `.env` Wi-Fi provisioning is optional work only if persistent settings do not solve the need.
- The phone uses an authenticated HTTP client, as explicitly selected; no embedded recovery dashboard is included.
- Windows selection uses an agent-owned native file dialog because private firmware bytes contain recovery secrets. Verified OTA requires a trusted matching artifact manifest and build identity.
- Device bearer import, including ordinary pairing when it shares the recovery value, moves to the native/CLI operator flow. Existing identity/configuration is preserved.
- Minimal authenticated firmware information and DNS-SD support are additive prerequisites for reliable post-reboot identity verification and changed-IP recovery; they do not replace the updater or remove deployment gates.

Approve the plan and explicitly identify which stage may be implemented next. Hardware access, firmware generation and OTA remain outside the current authorization.

## Analysis Verification Record

- `npm run check` passed: Markdown on 39 files, language checks, 9 root tests, 1 Windows-only skip, TypeScript build/typecheck and all 62 agent tests. No target compiler was invoked.
- `probe_display_colors.py` passed for eight colors, high-byte-first SPI and a byte-reversal mutation using cached GFX 1.13.0. Physical colors remain pending.
- `probe_compatibility.py` passed: requested 20 MHz initialization/drawing, rotation 2, MADCTL 8, offsets 0/0, checked AP setup and recovery-adapter probes. No hardware compatibility was established.
- `probe_http_lifecycle.py` and `probe_http_diagnostics.py` passed their existing host-only disconnect/cleanup/deadline/activation and authenticated diagnostic/non-disclosure checks.
- Independent read-only review identified the RTC collision and shared pairing/recovery token case; both are now explicit proposed tasks and acceptance tests. The RTC finding is source analysis, not a physical observation or a newly implemented fix.
- Tracked-file whitespace checks passed; the new document was also checked separately. Only this Markdown plan is a repository source addition. No stage is implemented, no firmware was generated, and no device or credential store was accessed.
