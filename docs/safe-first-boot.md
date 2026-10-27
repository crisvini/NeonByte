# Phase 4 Safe First-Boot Preparation

**Date:** 2026-10-26. **Scope:** implementation, host fault injection, and local compilation only. No clock was contacted or modified. No installation package, private identity, or release was generated. Deployment remains **BLOCKED**; Phase 4 hardware acceptance and Phase 5 remain pending.

## Startup Audit

The previous `setup()` disabled Wi-Fi and returned before HTTP on any of these paths:

| Condition | Previous consequence | Current handling |
|---|---|---|
| LittleFS mount failure, incompatible volume, or missing volume | No network or HTTP | Recovery AP and HTTP start before mounting; no format |
| Namespaced directory creation failure or full/read-only filesystem | No network or HTTP | Maintenance remains available; explicit temporary Wi-Fi is possible |
| Configuration absent and initial save fails, including the 32 KiB reserve | No network or HTTP | Missing configuration selects maintenance without an automatic write |
| Existing configuration cannot open, has the wrong size/version, short reads, digest failure, invalid terminators, or invalid secret lengths | No network or HTTP | No automatic replacement; authenticated provisioning can explicitly replace only NeonByte settings |
| Scene manager, bearer authenticator, protocol handler, or HTTP allocation fails | No network or HTTP | HTTP and both authenticators are static; failed application allocations leave maintenance running |
| Display initialization blocks, crashes, or has bad wiring | Networking had not started | Network starts first; initialization is guarded and delayed; a watchdog/crash reset selects maintenance |
| No saved Wi-Fi with disabled/broken display | Secrets inaccessible; provisioning unusable | Recovery identity is supplied privately before a future installation, independent of LCD and filesystem |
| Invalid/unreachable station credentials or station association never succeeds | No useful station interface; fallback AP could fail | AP is available from startup and remains available; station retries every 30 seconds |
| AP creation fails | No usable setup interface | Retry every five seconds, with no filesystem or application dependency |
| Station connects but operator cannot reach it, or new credentials are wrong | AP was removed on connection | AP remains active; staged settings require explicit connected confirmation before saving |

Conditions that still prevent useful services include a missing/invalid private identity, SDK/radio failure, network exhaustion, AP initialization failure, unusable power/boot/flash settings, a pre-`setup()` crash, and any hang that does not yield or reset. The application can start a listener before a later library hang, but cannot service it during that hang. No ordering change can recover a failed bootloader or firmware that never boots.

## Recovery Identity and Security

A future private, per-device build must supply `firmware/private/neonbyte_private_identity.h` through the existing `-Iprivate` include path. That directory is ignored by Git. The header defines `NEONBYTE_PRIVATE_RECOVERY_TOKEN` and `NEONBYTE_PRIVATE_RECOVERY_AP_PASSWORD` as null-terminated string literals. Generate them independently using an operating-system cryptographic random generator: 32 random bytes encoded as 64 lowercase hexadecimal characters for the bearer token, and 16 random bytes encoded as 32 lowercase hexadecimal characters for WPA2. No generator, real identity, or installation profile is produced here.

Only syntax and obvious invalid/reused input can be checked by firmware; entropy and uniqueness require a trusted private preparation process. A formatted secret is not proof of randomness. Empty, short, nonhexadecimal, uniform, or directly reused credentials are rejected. Native test fixtures are deliberately public test data and are never target inputs.

The maintainer must securely retain an offline copy of both secrets and deliver them directly to the operator before installation. Do not use build flags on a logged command line, CI secrets in public build jobs, source control, public binaries, public manifests, HTTP responses, URLs, or logs to distribute credentials. The future binary contains the private identity and must itself be treated as confidential. Losing the identity can make recovery inaccessible; rotation/revocation and publisher signatures are not implemented. Every future private update must preserve the same recovery identity until a separately reviewed rotation procedure exists.

Public compilation profiles intentionally have no usable identity. They start neither AP nor HTTP, even if a configuration might otherwise exist. They are not installable builds and cannot be made suitable by renaming their binaries. Display and OTA gates and deployment-target restrictions remain in place.

The recovery AP uses `NeonByte-<chip-id>`; `192.168.4.1` is its intended default address. The [independent compatibility investigation](ota-compatibility-investigation.md#recovery-ap-address-selection-is-conditional) found that the current adapter does not explicitly configure that address: the pinned API preserves an existing nonzero SDK AP address. A host probe confirms that conditional behavior, not this unit's actual SDK state. Deterministic address configuration remains a proposed correction. The chip ID identifies the network and never supplies a security credential. A nonempty private password is always passed to the pinned Arduino WPA2 AP API. Failed AP setup disables AP mode before retry. SDK initialization transitions, actual WPA2 association, DHCP, RF behavior, and the absence of transient inherited AP advertisements still require spare-unit validation. AP and station share one radio/channel; joining another channel can interrupt AP clients. Keeping the AP active improves reachability but increases radio exposure and memory use.

All maintenance requests, including status, require the recovery bearer token. Existing API v1 uses the saved pairing token. New NeonByte settings use the private recovery token for initial pairing; existing valid pairing tokens are retained. The recovery AP password is independent of the legacy configuration record's AP field. No stock credential import, EEPROM migration, SDK configuration erase, or SDK credential persistence is performed. `WiFi.persistent(false)` remains enabled. The pinned [Arduino AP implementation](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/ESP8266WiFi/src/ESP8266WiFiAP.cpp) selects WPA2 for a supplied password and current-only settings when persistence is disabled; its [mode implementation](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/ESP8266WiFi/src/ESP8266WiFiGeneric.cpp) supplies the corresponding nonpersistent mode operations.

HTTP remains plaintext and is suitable only for a trusted network. WPA2 does not replace bearer authentication. A compromised station LAN, disclosure of the private binary, repeated connection starvation, radio interference, or denial of service can still defeat confidentiality or access. There is no unauthenticated reset, format, filesystem OTA, or credential-return route.

## Startup and Maintenance Behavior

With a valid private identity, `setup()` starts the protected AP and static HTTP server before filesystem access, application heap allocation, SPI, display GPIOs, or SNTP. A ten-second window allows authenticated maintenance before automatic initialization. A clean boot then tries storage/configuration once; only valid saved Wi-Fi permits automatic application startup. Missing/corrupt configuration leaves the display application paused. Station connection attempts never block on association and do not close the AP.

A small RTC record marks filesystem/configuration loading and application initialization as risky before they begin. The record is cleared only after the operation returns. It is read back after each write. A retained risky record, invalid warm-reset record, RTC access failure, watchdog/exception reset, or unexpected reset reason selects maintenance with **no automatic filesystem or display initialization**. The authenticated operator can request storage alone or explicitly retry application startup. Pausing frees application scene/protocol objects and stops display work; it does not erase storage or cycle display GPIOs.

The RTC marker is not a rollback slot, a durable flash boot counter, or proof against power cuts. Cold-boot RTC data can be undefined; a clean power-on initializes an unknown record. Power cycling may therefore retry a fault that warm-reset maintenance had avoided. A watchdog must actually run and reset for a hanging application to reach the next boot's maintenance mode. The marker does not protect earlier constructors, SDK initialization, a broken boot image, or the network/HTTP service itself.

### Maintenance Routes

These are additive device extensions outside the API v1 contract. All responses carry `Cache-Control: no-store`. Errors use the existing v1 error shape/codes; no response contains submitted credentials. Requests use strict HTTP/1.1 framing, exact `Content-Length`, no chunking, and no `Expect`.

| Method | Route | Request and result |
|---|---|---|
| GET | `/maintenance/v1/status` | Empty body; authenticated JSON booleans: `storageAvailable`, `configurationLoaded`, `applicationRunning`, `recoveryApRunning`, `stationConnected`, `pendingWifi`, `volatileWifi` |
| PUT | `/maintenance/v1/wifi` | URL-encoded `ssid=<encoded>&password=<encoded>`; at most 512 bytes; 204 stages a candidate and begins association without saving |
| PUT | `/maintenance/v1/wifi/temporary` | Same form; explicitly opts into RAM-only configuration, including when storage cannot mount |
| POST | `/maintenance/v1/wifi/confirm` | Empty body; 204 only after association to the candidate SSID and successful persistent replacement, or explicit temporary selection; otherwise 409 |
| POST | `/maintenance/v1/storage` | Empty body; explicitly mount/load storage behind the RTC guard without initializing the display; retry a previous mount failure; 204 or 409 |
| POST | `/maintenance/v1/run` | Empty body; explicitly try guarded storage/configuration/application initialization; 204, 409 for unavailable storage/configuration, or 500 for allocation/start failure |
| POST | `/maintenance/v1/pause` | Empty body; 204 disables automatic/application display work until explicitly resumed or a clean boot |
| PUT | `/maintenance/v1/firmware` | Recovery-authenticated, gated raw sketch staging; application must be paused; exact length, SHA-256, E9 image, CRC, and runtime geometry are checked before activation |

The operator keeps the AP session, stages Wi-Fi, checks status, and explicitly confirms after testing reachability. Confirmation requires a successful disconnect request, exact readback of the requested SDK SSID/password before connecting, and fresh matching association and GotIP events for the current credential attempt, as well as live station status. Merely reading `WiFi.SSID()` is insufficient because the pinned SDK accessor returns configured credentials. Beginning another attempt, including a changed password on the same SSID, invalidates earlier evidence. SDK event ordering is still a hardware validation item. A wrong SSID, failed association, lost response, malformed form, or failed persistent write does not remove the recovery AP. Wi-Fi confirmation proves association, not Internet access or long-term LAN reachability. Open station networks are accepted by the existing form policy; use a trusted protected network when confidentiality matters.

Failed persistence preserves the previous installed settings and leaves the candidate pending for an explicit retry or replacement. There is no silent temporary fallback. Temporary settings are reported by `volatileWifi` after confirmation and disappear at reset; the private recovery AP/token remain available. A candidate is not saved before confirmation. Existing `PUT /api/v1/config` retains its documented immediate-save behavior for compatibility; maintenance's staged flow is preferred for provisioning. In maintenance, ordinary v1 application routes return 409 until resumed; existing JSON schemas and successful application responses are unchanged.

## Filesystem and Update Limits

LittleFS autoformat remains explicitly disabled. Startup never writes a new configuration automatically or modifies undocumented stock files/settings. Explicit storage preparation can create `/neonbyte/` and discard NeonByte temporary media, as before. Explicit provisioning writes only `/neonbyte/config.part` and `/neonbyte/config.bin`, preserving the record version/layout and existing token when valid. Atomic candidate readback and rename tests cover short/corrupt close, read failure, and failed promotion. Neither namespacing nor an atomic rename establishes compatibility with the installed filesystem or real power-loss durability.

The `/maintenance/v1/firmware` path no longer uses LittleFS for staging, validation, or activation. It writes only to the Arduino updater's sector-rounded raw sketch staging interval, which ends at the runtime `FS_start` boundary and must remain above the rounded current sketch. Before writes, the path requires the existing OTA gate, exact 4 MiB physical flash, matching flash configuration, DIO/40 MHz/4 MB candidate header, consistent runtime sketch/free-space geometry, and a one-sector reserve. It buffers and validates the first four image bytes before `Update.begin()`. Checked flash readback then verifies the complete request SHA-256, both E9 images, and modern Arduino CRC in a fail-closed updater verifier before eboot can be scheduled. Only a successful finalizer permits delayed restart. The API v1 firmware route and regular media uploads retain LittleFS staging.

Part 4 added native fault injection for request admission/framing, LittleFS unavailable/corrupt/full states, incomplete and extra bodies, digest and image failures, geometry/capacity failures, flash begin/write/read/finalizer failures, and successful activation ordering. The fake updater now erases, programs, and reads through absolute offsets in a 4 MiB host flash vector with sentinels outside the computed staging range. It shares a modeled 128-byte RTC region with startup-guard writes: an explicitly paused successful upload keeps the eboot marker past the delayed-start deadline, and a complete invalid candidate preserves the previous guard bytes. The write-fault cases stream 512-byte chunks so middle and final failures follow successful prefixes. These tests exercise the portable transaction and injected backend behavior; they do not exercise target flash, filesystem, eboot, reset, or power-loss behavior. The ESP8266 integration-check profile remains compilation-only and has no usable recovery identity. OTA remains disabled in the provisional profile. **Independent failed-boot recovery and the full-backup gate remain blocked**, and the installation decision remains NO-GO.

**Part 4 local results (2026-10-27):** `npm run check` passed Markdown/language validation, 9 root tests (1 Windows-only test skipped on Linux), agent build/type checks, and 54 agent tests. `npm run test:offline` passed 19 tests; PlatformIO native passed 61 tests, including delayed-start/OTA RTC-overlap and address-backed preservation regressions. Both `esp8266-provisional` and `esp8266-integration-check` compiled with 43,900 bytes static RAM; reported flash use was 357,019 and 358,043 bytes, respectively. The synthetic local deployment-guard check and `git diff --check` passed. PlatformIO produced only the normal ignored compile-check outputs; no private identity or installation-ready package was created, and no artifact was copied, renamed, or published. These local results do not change NO-GO.

The [OTA readiness review](ota-readiness-review.md) records the original proposal and its safety rationale. Part 4 implemented that narrow maintenance updater offline; it did not change the installation decision or resolve independent failed-boot recovery.

## Exact Requirements for a Future Installation Package

No package is generated by this work. A later separately approved package must satisfy all of these requirements:

1. Resolve the existing verified-board/power/display/flash/layout, complete unit backup, and independent Wi-Fi-only boot-recovery gates. If qualifying boot recovery is impossible, deployment remains blocked under the current policy. Application maintenance does not satisfy that gate.
2. Define a separately reviewed private installation profile with authenticated OTA enabled, a validated display policy, and a valid unique recovery identity securely delivered before installation. Preserve deployment guards until separately authorized. Validate the raw maintenance updater and missing/full/incompatible filesystem behavior on an identical spare before representing the package as safe.
3. Pin platform/core/compiler/library versions and record the exact source revision, profile, flags, linker script, declared flash mode/frequency/capacity, filesystem boundaries, boot format, and license notices. Current provisional inputs are `esp12e`, 80 MHz, DIO/40 MHz/4 MB, and 4m3m; their use here does not validate this unit.
4. Use the complete uncompressed combined E9 eboot/application image, boot at offset zero and application at `0x1000`, modern length/CRC at `0x1010`/`0x1014`, with valid segment checksums and modern whole-image CRC. Do not extract the application, transplant old boot code, patch legacy CRC, gzip, append data, migrate partitions, or add a filesystem payload.
5. Keep the final private binary at or below **458,752 bytes (448 KiB)**, reserving at least 65,536 bytes below the stock nominal 524,288-byte guard. This is a conservative preparation policy, not evidence that the stock guard rejects bad input safely. Revalidate final identity-bearing length, SHA-256, both runtime image validators, staging bounds, and RAM/stack after building that exact candidate.
6. Use a descriptive case-sensitive `SDP`-prefixed filename such as `SDP-NeonByte-<version>.bin`. The researched stock envelope is multipart `POST /update_ota`, field `update`; verify the installed browser/verifier rules on an identical spare under separate authorization. This specifies package compatibility requirements and is not an upload procedure or authorization.
7. Produce a non-secret manifest recording exact filename, bytes, SHA-256, image format, revision, profile, linked regions, feature gates, minimum resource requirements, and validation results. Exclude credentials and identify the confidential operator credential handoff separately. Publish no private binary through CI artifacts or public releases.
8. Validate stock acceptance, first AP connection before relying on LCD, saved/changed/missing Wi-Fi, RTC/crash behavior, memory, filesystem preservation, interruption behavior, and later authenticated updates on an identical spare under explicit authorization. Keep backup and independent recovery requirements intact.

## Validation Evidence and Remaining Measurements

The new native suite exercises the real portable startup/maintenance policy with injected Wi-Fi, storage, application, and RTC services. Existing core/integration tests continue to exercise API validation, atomic writes, streaming, and image verification. Tests do not execute actual SDK Wi-Fi, TCP sockets, LittleFS flash operations, or RTC hardware. Build-only target profiles verify compilation of those bindings. GitHub Actions now runs native tests and both ESP8266 compile profiles sequentially, validates images and deployment guards, and publishes no firmware artifact. Remote CI results require a later push.

Final local test counts and resource measurements are recorded below. Linked memory is not observed runtime free heap. The original resource limitations remain: no full RGB565 framebuffer, only 480-byte display rows; maximal v1 JSON still needs 12,289 contiguous bytes; Wi-Fi/TCP/LittleFS, station event subscriptions, event String copies, and update buffers add unmeasured heap use. Subscription/library allocation failure can still reset the application; host tests do not model the allocator inside SDK callbacks. Maintenance bodies use a fixed 513-byte buffer and never request a maximal JSON allocation. Actual heap fragmentation, largest free allocation, complete stack depth, radio availability, reset retention, and sustained runtime remain PENDING.

### Local Results

- PlatformIO native: **54 passed**: 31 existing core, 10 existing integration/helper, and 13 startup/maintenance/station-evidence tests. The new suites first failed with missing interfaces before implementation; the review regression also failed before its fix.
- AddressSanitizer/UndefinedBehaviorSanitizer: all three native suites passed, 54 tests total. Temporary harness files stayed outside Git; weak no-op setup/teardown functions support the existing core suite that relies on PlatformIO-provided defaults.
- Both ESP8266 profiles compiled without warnings. The enabled profile compiles display and OTA; neither profile contains a usable recovery identity or permits deployment targets.
- Independent Python inspection and exact C++ runtime validators accepted both complete images, segment checksums, and modern CRC. Synthetic deployment-guard checks passed without invoking a device target.
- Repository `npm run check` passed: Markdown, English-language policy, 8 contract/root tests, agent build/type checking, and 39 agent tests. `git diff --check` passed. Existing API v1 schema files are unchanged.
- Independent read-only review identified configured-SSID confirmation as insufficient. The implemented event-evidence helper now invalidates old attempts and requires fresh association/GotIP evidence; its regression covers stale status, failed disconnect/configuration, wrong SSID, and a password change for the same SSID. Actual SDK event ordering still needs spare-unit validation.

| Metric | esp8266-provisional | esp8266-integration-check |
|---|---:|---:|
| Combined image bytes | 355,184 | 358,688 |
| Program section bytes | 351,027 | 354,531 |
| Static RAM bytes | 43,240 | 43,228 |
| Headroom below nominal 524,288-byte stock guard | 169,104 | 165,600 |
| Modern whole-image CRC | `0x8B7A9574` | `0x6EDFB2E6` |

Measured SHA-256 values, identifying local compile checks only:

- Provisional: `4e3562bddec29cb09d014ed0c68ff27bf6a95725faf9730a2a05f0efe739ac85`.
- Enabled validation: `40d90dfcd5c0583585ad7c54dd260bbf912f1428af666abf4084dff4c7a9ab1c`.

The Xtensa object-size probe reports `SafeStartup` at 272 bytes and the static HTTP object at 6,744 bytes, including its 513-byte control buffer and existing header/response/chunk/hash state. The static HTTP service replaces the previous startup heap dependency. Scene and protocol objects remain 3,160 and 3,120 bytes, totaling 6,280 bytes on the application heap. The separate station-evidence record/subscription handles are also statically allocated; subscriptions and library event delivery can allocate additional heap.

For the enabled profile, 81,920 minus 43,228 static bytes, 6,280 application object bytes, and 12,289 maximal JSON bytes leaves **20,123 bytes** before allocator overhead, SDK/Wi-Fi/TCP/LittleFS, event subscriptions, temporary Strings, separate noinit data, update buffers, and other runtime use. This is budget arithmetic, not measured available heap. Maintenance avoids the JSON/application allocations while paused, but the actual radio/listener memory requirement is still unmeasured. A private identity-bearing build must be remeasured; these compilation-only artifacts cannot establish runtime capacity.

Target compiler stack frames include 1,152 bytes for HTTP JSON dispatch, 112 for maintenance handling, 128 for guarded storage initialization, 144 for staging Wi-Fi, and 368 for configuration save. These are individual frames, not complete call-chain bounds. The configured continuation stack is 4,096 bytes; nested filesystem, event, allocation, and display library calls still require runtime measurement.

**Stop boundary:** preparation is implemented and validated offline. Physical Phase 4 acceptance stays open. Installation planning/packaging, spare-unit operations, and any clock access require separate maintainer authorization; no later phase begins.
