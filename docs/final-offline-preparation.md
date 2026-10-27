# Final Offline Technical Preparation

**Date:** 2026-10-27. **Decision: NO-GO for installation.** The maintainer authorized this final planned offline cycle, including a separately authenticated live stock-restoration mechanism if feasible, testing and a conditional physical proposal. No device was contacted, discovered, reset, flashed, erased or updated. No private identity, installable private package, filesystem image, release or tag was created.

## Implemented Live Return-to-Stock Mechanism

The separate device extension is `PUT /maintenance/v1/stock-firmware`. It uses raw sketch staging and has no LittleFS dependency. It requires the private recovery bearer token, a paused application with no pending automatic startup, `NEONBYTE_ENABLE_OTA`, and the additional `NEONBYTE_ENABLE_STOCK_RESTORE` gate. The new gate defaults to zero; only the existing non-installable integration-check profile selects it for local compilation. Existing deployment guards, public identity failure behavior and provisional OTA/display settings remain in force.

The only admitted artifact is the unchanged vendor V1.0.6 combined image: **488,304 bytes**, SHA-256 `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b`. Other versions, arbitrary legacy images, modified files, gzip, filesystem images and appended bytes are unsupported. Request size/hash must match before staging. Checked raw-flash readback independently verifies actual SHA-256 before activation; matching request headers cannot bypass it.

The new validator checks exact old E9 headers/entry points, the known boot and five application segments, all addresses/lengths, original XOR rules, zero footer padding, the `0xAA` boot gap, exact EOF and legacy length/CRC at `0xFF8`/`0xFFC`. It does not apply the modern metadata exclusion to original IROM bytes. Modern validators in `firmware_image.cpp`, existing API v1 contracts and both modern firmware route policies remain unchanged.

An immutable stock policy reuses the existing maintenance transaction and fail-closed updater hook. It additionally requires exactly the researched 4 MiB/DIO/4m3m geometry, including filesystem `0x100000–0x3FA000` and EEPROM `0x3FB000`. Existing current-sketch/free-space consistency and one-sector reserve checks remain mandatory. Geometry is rechecked during pre-activation verification. No successful finalization means no eboot command and no restart eligibility. Abort of a complete unverified candidate still rejects activation.

**Actual capability:** implementation and host verification now exist for live application-level return to the allowlisted vendor boot/application bytes. It is no longer merely a proposed route. **Still unproven:** acceptance/programming/boot on the actual unit or an identical spare, appropriateness of V1.0.6 for the installed revision/version, and preservation of real stock data. The artifact identity is confirmed against the [pinned vendor tree](https://api.github.com/repos/JUZIPi-tech/SD_PRO/git/trees/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d); that is not a unit-specific compatibility guarantee or publisher signature.

This is not a full-flash restore. It does not restore filesystem/web assets, settings/activation, EEPROM or SDK/RF data that are missing or changed. It does not export a backup, add rollback slots, retain a rescue application, or recover a nonbooting NeonByte. After successful replacement, NeonByte's AP/token/routes are gone. An image different from the unit's installed original must not be represented as exact restoration of that unit.

## Startup, AP, Display, Memory and Preservation Review

- The existing selected maintenance-on-every-boot policy suppresses automatic storage/display initialization, including cold restart and missing configuration. A future first-install candidate must explicitly select it; the provisional default was not silently changed. No unverified durable marker or new flash region was introduced.
- A valid privately delivered identity is still required before AP or HTTP can start. The AP checks address/gateway/mask, mode, SSID, terminated password, WPA2 and DHCP status; failed startup and failed HTTP-listener creation retry. Automatic risky startup in the default policy waits for both services and provides a fresh ten-second maintenance window after recovery.
- These observations do not continuously monitor later RF/listener loss or prove real client association/DHCP. SDK state, AP/STA shared-channel behavior, transient advertisements, radio interference and allocation failures remain hardware questions.
- Filesystem/display operations remain guarded by RTC risky-operation markers. Warm reset/crash evidence selects maintenance; RTC is not power-loss-durable recovery. A hang must actually yield or reset. Pre-`setup()` constructor/SDK failure and a broken boot image remain outside the application's reach.
- Display initialization remains explicit in selected maintenance mode and bounded to a 20 MHz request from the first command. Mode 3, MADCTL `0xC8`, 0/80 offsets, inversion and GPIO choices remain provisional. Matching a software trace cannot identify the physical controller, boot-strap loading or correct colors/orientation. No pin/profile guess was added.
- Raw OTA readback and updater hashing retain cooperative `optimistic_yield(1000)` calls. Legacy parsing/CRC reads are at most 256 bytes through the same yielding backend. Host counters prove call placement, not target watchdog margin or HTTP responsiveness during synchronous final verification.
- Autoformat remains disabled; no stock credential import, EEPROM erase, filesystem update or partition change was introduced. Explicit storage preparation can still create `/neonbyte/` and remove its temporary files, and ordinary provisioning/media writes alter filesystem metadata. It is not a nonmutating preservation check. SDK/RF behavior is not proven bit-for-bit by `WiFi.persistent(false)`.
- The stock route touches only the calculated staging interval before activation in the host flash model. Native sentinels and the real-SHA probe check preservation outside staging, including the current sketch, filesystem/configuration, EEPROM and tail. Actual erase/program/reset/SDK behavior is unmeasured.

## Compatibility: Confirmed Properties and Unknowns

| Item | Confirmed offline/source evidence | Still unknown |
|---|---|---|
| MCU and board | Maintainer previously reported an ESP-12F marking; generated images target ESP8266 | Exact PCB, power, flash population and display wiring |
| NeonByte image | Complete modern E9 boot at zero and application at `0x1000`; DIO/40 MHz/4 MB declaration; valid segment checksums and modern CRC | Physical flash compatibility, installed bootloader/verifier acceptance and resulting boot |
| Stock updater | Published V1.0.6 analysis supports generic multipart OTA with nominal 512 KiB guard; published modern bootstrap precedent exists | Installed version, browser assets, complete verifier/signature setup and safe rejection behavior |
| First-install size | Both new compile checks fit the nominal guard and the conservative 448 KiB preparation cap | Exact later private identity-bearing candidate; current files deliberately have no recovery identity |
| Flash layout | NeonByte retains the researched stock 4m3m linked boundaries; strict stock restore rejects other layouts | Actual map, filesystem contents/version, free space, activation/settings and preservation |
| Return image | Unchanged V1.0.6 legacy XOR/CRC/SHA-256 and structure verified; production restore transaction succeeds with real SHA-256 over a flash model | Whether this exact old application and bootloader work on the unit after replacement |
| Recovery | AP/HTTP/startup/transfer failure logic is host-tested | Independent Wi-Fi rescue after boot/application/copy failure remains unestablished |

The [stock analysis](stock-firmware-analysis.md), [installation research](stock-ota-installation-research.md) and [prior final audit](final-ota-safety-audit.md) remain the evidence sources for original updater behavior. No new unit-specific evidence was supplied. Direct installation of a small combined image remains a conditional structural candidate; there is no justification for a bootstrap, old-CRC patch, boot transplant, filesystem format or layout migration.

## Approved Offline Tests and Pending Acceptance

Fresh results and reproduction commands are recorded below. All tests use host mocks, local files, loopback or compilation-only profiles; none run a device update.

| Check | Result |
|---|---|
| `npm run check` | Passed: Markdown/language policy, 9 root tests plus 1 Windows-only skip, agent build/typecheck, 54 agent tests |
| `npm run test:offline` | Passed: 20 host integration scenarios |
| PlatformIO `native` | Passed: 74 tests in four suites |
| Native ASan/UBSan and sanitized offline runner | Passed; host behavior only |
| Pinned dependency/startup/AP/yield probes | Passed, including sanitizer execution |
| `probe_stock_http.py` | Passed all four OTA/restore gate combinations, wrong auth, pending application, invalid framing/length/hash, raw route selection and modern-route isolation; the real body/hash/finalization adapter bindings are also exercised |
| `probe_stock_restore.py` and real-SHA C++ transaction probe | Passed with unchanged vendor bytes; modern validators still reject the same legacy file; actual host SHA-256 permits intact stock restoration and rejects corruption, complete abort and changed geometry |
| Native stock fault matrix | Passed parser/header/entry/segment/footer/CRC/read failures, short/extra/invalid files, both feature gates, bad request/hash, write/read errors at first/middle/final positions, insufficient/wrong geometry, finalizer failure, complete abort and RTC/region preservation |
| Both existing ESP8266 profiles | Passed compilation; no installation authorization or working identity |
| Both image inspectors/runtime modern validators and synthetic deployment guard | Passed; `installationApproved: false`; no real device target invoked |
| `git diff --check` | Passed |

Synthetic legacy fixtures are deliberately not the vendor bytes and use a test-only digest double to exercise policy/fault branches. Real hash acceptance is separately established using the original ignored public file and OpenSSL, not by that double. Native tests also cover abort of one policy followed by the other through the shared backend. The read-only code reviewer found no Critical or Important defect; suggested combined-adapter/shared-backend coverage was added.

The stock image is not tracked or redistributed. Its optional local probe requires the already-installed OpenSSL development library and pinned Arduino source; the normal CI native/parser/HTTP tests need no vendor binary. No runtime dependency was added. CI was extended with the offline HTTP probe; a remote CI result still requires a later push.

~~~sh
npm run check
npm run test:offline
NEONBYTE_HOST_SANITIZERS=1 npm run test:offline
uv tool run --from platformio pio test -d firmware -e native
uv tool run --from platformio pio run -d firmware -e esp8266-provisional
uv tool run --from platformio pio run -d firmware -e esp8266-integration-check
python3 firmware/scripts/probe_compatibility.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_compatibility.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_stock_http.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_stock_restore.py SDPro_V1.0.6_20260525_174828.bin
python3 firmware/scripts/inspect_image.py firmware/.pio/build/esp8266-provisional/firmware.bin
python3 firmware/scripts/inspect_image.py firmware/.pio/build/esp8266-integration-check/firmware.bin
python3 firmware/scripts/test_local_build_guard.py
git diff --check
~~~

PlatformIO jobs must run sequentially. Native test preparation can remove target build outputs; rebuild compilation-only profiles before image inspection if needed. Native sanitizer suites were compiled separately with the installed Unity source, all portable sources, C++17 and `-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer -fno-pie -no-pie`; temporary harnesses remained outside Git.

Pending: real boot, RF/AP/DHCP/HTTP socket behavior, exact-unit flash and preserved contents, actual free heap/largest allocation/full stack depth, watchdog margin, LCD/color/orientation/backlight/FPS, power-loss durability, physical maintenance update and stock boot, full-backup restore and independent rescue on an identical spare. The Windows-only root test is skipped locally on Linux, not presented as passed.

## Measured Compilation Resources

| Metric | Provisional | Integration check |
|---|---:|---:|
| Complete combined image bytes | 363,872 | 364,848 |
| Program section bytes | 359,727 | 360,691 |
| Static RAM bytes reported by PlatformIO | 44,464 | 44,404 |
| Headroom below nominal stock 524,288-byte guard | 160,416 | 159,440 |
| Headroom below 458,752-byte first-install preparation cap | 94,880 | 93,904 |
| Whole-image CRC | `0x4A4CBBBD` | `0xAD280EA3` |

Local non-installable output hashes:

- Provisional: `13a1b8e3e03cf2a71ca9310ac83804a0cb0150fd59e39a06aa0a76f6db64e363`.
- Integration check: `0e2089967c0c0133b26e8b266605423ce21e2115e4a4b1986b5c8d46ce6d7aa0`.

The enabled ELF's symbol sizes show the static HTTP object at 7,448 bytes, startup state at 280, display at 1,672 and storage at 1,276; these are included in static RAM. Application scene/protocol objects still require 6,280 heap bytes, maximal v1 JSON 12,289 contiguous bytes, and the updater normally adds a 4 KiB buffer. Subtracting static RAM, application objects and maximal JSON from the configured 81,920 bytes leaves 18,947 bytes in the enabled build before SDK/Wi-Fi/TCP/LittleFS, allocator overhead, fragmentation, noinit data and other runtime use. This is budget arithmetic, not free-heap telemetry; paused maintenance avoids application/maximal-JSON allocations.

Target stack frames are 416 bytes for candidate verification, 352 for legacy validation, 304 for its image parser, 96 for HTTP admission and 128 for binary finalization. JSON dispatch remains 1,152 bytes on a different path. Nested SDK/yield/filesystem callbacks and the complete 4,096-byte continuation stack still need measured high-water marks. Restoration adds static transaction/transfer state and reuses the existing small hash-job/updater allocations; it adds no full image/frame buffer. Different linked totals between profiles are compiler artifacts, not evidence of runtime savings.

## Recoverable Failures and Permanent-Loss Risks

| Failure | Wi-Fi recovery capability and limit |
|---|---|
| Missing/corrupt/full/incompatible LittleFS or bad NeonByte settings | Maintenance/raw update/stock restore can remain usable if NeonByte boots, radio/HTTP work and private credentials are retained. No filesystem repair or reconstruction of missing stock data is supplied |
| Wrong station credentials or unavailable LAN | Private AP plus explicit temporary provisioning can help; real association/channel behavior is still unvalidated |
| Display/application initialization fault | Guarded maintenance after a watchdog/crash reset can help only if reset occurs and the next boot reaches networking. A permanent hang, bad boot strap or pre-startup failure cannot be rescued by the same application |
| Invalid/interrupted upload before activation | Tests reject boot-copy/restart; current application and reserved regions remain unchanged in the model. Staging pages may already have been erased/programmed |
| Lost HTTP response after successful activation | It is not a cancellation. Restart/copy may still occur. Do not blindly resend; identify the running firmware through a separately approved observation |
| Nonbooting image, damaged boot sector, failed flash or interruption during eboot copy | No proven independent Wi-Fi service exists. Indefinite/permanent loss of access under the allowed recovery methods is possible |
| Lost private identity or radio/network service that cannot run | No unauthenticated reset or guaranteed alternative access is provided; Wi-Fi restoration may be impossible |
| Lost stock web/assets/settings/activation data | Reinstalling the vendor application cannot recreate absent unit data; a full unit-specific backup/restore is required |

For stock V1.0.6, hypothetical staging is `0x88000–0x100000`; eboot's destination is sector-rounded through `0x78000`. The differing boot sector is rewritten. Neither pre-activation SHA-256 nor CRC proves successful subsequent copy or boot; the pinned eboot post-copy comparison remains disabled. No numerical failure probability can be justified from these offline results. Permanent loss here means unrecoverable under the project's Wi-Fi-only constraints, not a claim that every failed chip is physically destroyed.

## GO/NO-GO and Proposed Physical Procedure

**NO-GO.** Implementation closes the earlier missing live-restoration-code item; it does not close the mandatory hardware, preservation, full-backup/full-restore, independent failed-boot recovery, private candidate/identity or identical-spare/runtime-validation gates. A single missing mandatory item is enough. Exact-unit backup plus independently executing Wi-Fi rescue remain sufficient blockers by themselves.

The [pre-installation checklist and progressive physical proposal](pre-installation-checklist.md) start with existing evidence and explicitly authorized nonmutating observations. They mark the first persistent flash change at the first accepted OTA staging write, before reboot, and the subsequent destructive in-place boot copy separately. Storage/display work and each update/restore are separate authorization boundaries. No phase is authorized by the existence of that checklist.

There is no qualifying documented stock full-export/restore or independent Wi-Fi rescue mechanism to execute today. Do not substitute a bootstrap/dumper, a public compile binary, a smaller image, successful mocks, or an assumption about the product name. If the mandatory evidence cannot be obtained within the existing constraints, leave the project unit on stock firmware.
