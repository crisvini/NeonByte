# Phase 4 ESP8266 Integration Report

**Date:** 2026-10-26. **Result:** local implementation and compilation completed; deployment is **BLOCKED**. The maintainer visually confirmed ESP-12F / ESP8266 and authorized this local work. No physical device was contacted, uploaded to, flashed, erased, or modified. Stock firmware and filesystem remain untouched. Phase 5 is not started, and physical Phase 4 acceptance is incomplete.

**Subsequent preparation:** the [safe first-boot report](safe-first-boot.md) supersedes the original startup, secret delivery, and allocation arrangement described below. Measurements in this report identify the earlier integration artifacts; current preparation measurements are recorded in that report. Deployment remains blocked.

## Implemented Scope

- Preserved the native PlatformIO environment as the default and added pinned provisional ESP8266 profiles.
- Bound the existing C++17 core to Wi-Fi, a bounded device HTTP v1 server, persistent configuration/mode, protected provisioning/reconfiguration, optional SNTP, and monotonic rollover handling.
- Added streamed, authenticated NBIC/NBIF uploads with exact lengths, complete staged-file SHA-256, format/timing validation, available-space reserve, and atomic asset replacement. Covers retain their track identity in the same installed file.
- Added the researched provisional ST7789 adapter, Spotify layout, RGB565 artwork rows, and looping animation rows without a full framebuffer.
- Added gated device-hosted firmware OTA with strict length, absolute and runtime size limits, ESP8266 structure/checksums, modern CRC, SHA-256, and exact-size `Update.end(false)` staging.
- Added offline image inspection/validator harnesses, native failure tests, build-operation guards, and updated protocol/hardware/recovery documentation.

The provisional artifact disables display GPIO activation and OTA. A second validation profile enables both code paths solely for compiler/resource analysis. Both profiles reject deployment-related PlatformIO targets. No physical programming, UART, soldering, USB-serial setup, or fallback is implemented or proposed.

## Build Inputs and Reproduction

| Input | Version / choice | Purpose |
|---|---|---|
| PlatformIO Core used | 6.2.0 | Local build/test tool |
| PlatformIO Espressif8266 | 4.2.1 | Pinned platform/toolchain selection |
| ESP8266 Arduino | 3.1.2 | Wi-Fi, LittleFS, TCP, SDK RNG, BearSSL SHA-256, and updater |
| Xtensa GCC | 10.3.0 | Target compiler |
| Board manifest | `esp12e` | Generic ESP8266 compilation scaffold; not a verified PCB profile |
| CPU / flash | 80 MHz / DIO, 40 MHz, declared 4 MB | Build assumptions, not device measurements |
| Linker layout | `eagle.flash.4m3m.ld` | Matches the analyzed stock artifact's linked filesystem addresses |
| Adafruit ST7735/ST7789 | 1.11.0 | ST7789 initialization and SPI display operations |
| Adafruit GFX | 1.11.11 | Basic text/shape rendering |
| Adafruit BusIO | 1.17.0 | Display-library SPI abstraction dependency |

These runtime dependencies are needed for the ESP8266 adapters. Native core code does not depend on the Arduino/display libraries. Unity remains development-only. Adafruit ST7735/ST7789 and BusIO are MIT-licensed; Adafruit GFX carries BSD license obligations; ESP8266 Arduino includes LGPL code, SDK components and bundled third-party notices; LittleFS is BSD-3-Clause and BearSSL is MIT. Preserve upstream licenses and notices when distributing any later firmware. No third-party community firmware source or artwork was copied. Toolchain/platform packages can contain additional components not linked into this image.

Run the commands in [firmware development](firmware-development.md) sequentially. The independent Python inspector accepts a local binary path and reports headers, checksums, modern CRC, SHA-256, and distance below the stock guard. To exercise the exact runtime validators offline:

~~~sh
c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include \
  firmware/scripts/validate_image.cpp firmware/src/firmware_image.cpp \
  -o /tmp/neonbyte-image-validator
/tmp/neonbyte-image-validator firmware/.pio/build/esp8266-integration-check/firmware.bin
python3 firmware/scripts/test_local_build_guard.py
~~~

## Final Local Artifact Measurements

| Metric | esp8266-provisional | esp8266-integration-check |
|---|---:|---:|
| Display / OTA enabled | No / No | Yes / Yes, compilation only |
| Combined firmware.bin bytes | 348,816 | 352,304 |
| PlatformIO program sections, bytes | 344,659 | 348,147 |
| PlatformIO static RAM, bytes | 35,200 | 35,188 |
| Distance below 524,288-byte stock guard | 175,472 | 171,984 |
| Modern whole-image CRC | `0x783AF1F2` | `0xCCEB8BA5` |

SHA-256 of the measured artifacts:

- Provisional: `6aedabcc4ac000ab3a5bdbd29d4187f1200b25cf6358193920cdf4f9980a81d3`.
- Enabled validation: `7609711012073c175d813c5db1a1948524fa88981f5cce3b9c9f19df63735b91`.

Program sections differ from complete update-package length because the package also contains boot code, headers, and padding. The slightly smaller static RAM in the enabled build is a linker/content-placement result; it is not a measured runtime benefit. Build products stay under ignored `.pio/` directories and are not committed. Hashes identify these local builds, not a released or installable firmware.

The enabled ELF contains `.data` 1,620, `.rodata` 4,800, `.bss` 28,768, and a separate `.noinit` 56 bytes. PlatformIO reports the first three as static RAM, 43.0% of its configured 81,920-byte budget. IRAM sections `.text` 258 plus `.text1` 26,753 total 27,011 bytes, within the selected 32 KiB IRAM profile. These are linked artifact measurements, not observed device memory.

## RAM and Stack Estimates

An offline Xtensa compilation probe (`firmware/scripts/resource_probe.cpp`) measured these `sizeof` values. It was compiled outside the firmware image using the enabled profile's compiler flags/includes from a local PlatformIO compilation database.

| Object | Target bytes | Allocation |
|---|---:|---|
| SceneManager | 3,160 | Heap, once at startup |
| ProtocolHandler | 3,120 | Heap, including retained Spotify transaction scratch |
| DeviceHttpServer | 6,232 | Heap, includes headers, response, SHA context, and I/O chunk |
| BearerTokenAuthenticator | 12 | Heap, once |
| DeviceDisplay | 1,672 | Global, already included in static RAM |
| PersistentStorage | 1,276 | Global, already included in static RAM |
| DeviceConfiguration | 184 | Included in storage; stack copies during configuration |
| HashJob / FileSource | 24 / 48 | Temporary heap objects during finalization |

The four startup heap objects total **12,524 bytes**, excluding allocator overhead. A maximal JSON request adds 12,289 bytes. Subtracting those values and static RAM leaves approximately **21,919 bytes** from the configured RAM budget before SDK/Wi-Fi/TCP/FS allocations, allocator overhead, temporary Strings, other runtime use, and the separate noinit region. This arithmetic is not free-heap telemetry. Binary uploads avoid the JSON allocation and full frames; hash finalization adds only the small job/source objects plus filesystem internals. The updater additionally allocates a flash-sector-sized buffer, normally 4 KiB when heap permits in this pinned core. Actual free heap, largest allocation, fragmentation, stack high-water mark, and long-run behavior remain PENDING.

The default core continuation stack is 4,096 bytes. Target GCC `-fstack-usage` reports these frames after moving Spotify scratch off stack, bounding parser keys, and removing duplicate status response construction:

| Function | Frame bytes |
|---|---:|
| ProtocolHandler::handle | 208 |
| ProtocolHandler::statusResponse | 144 |
| DeviceHttpServer::dispatchJson | 1,152 |
| DeviceHttpServer::bodyComplete | 64 |
| DeviceHttpServer::finishBinary | 96 |
| PersistentStorage::applyFirmware | 592 |

The application status path's known frames total about 1.7 KiB when including HTTP tick/header/body dispatch, protocol status handling, and loop entry, before deeper response/string/filesystem/library calls. OTA and validation have different call paths. These numbers reduce the previous host handler's 4,352-byte stack concern but do not prove complete target stack safety. No adapter-level stack watermark or sustained Wi-Fi/display test was performed.

## Filesystem and OTA Space

The pinned [4m3m linker script](https://github.com/esp8266/Arduino/blob/3.1.2/tools/sdk/ld/eagle.flash.4m3m.ld) defines:

| Region | Flash offsets | Meaning |
|---|---|---|
| Code and temporary OTA staging | Below `0x100000` | About 1 MiB must accommodate the running rounded sketch and update staging |
| LittleFS | `0x100000–0x3FA000` | 3,121,152 linked bytes before filesystem overhead |
| Gap / EEPROM / SDK tail | At and above `0x3FA000` | Retained linked boundaries; stock contents and compatibility PENDING |

The enabled package rounds from 352,304 to 356,352 bytes (`0x57000`). If this linked layout actually applied, free sketch space would be 692,224 bytes (`0xA9000`), and the adapter's conservative `(freeSpace - 4096) & ~4095` budget would be 688,128 bytes (`0xA8000`). The independent 512 KiB route cap is lower. These are derived layout estimates; no physical capacity or staging was measured. Runtime also checks detected capacity/configuration and refuses mismatches.

Every candidate media file must coexist with the previous installed asset plus at least 32 KiB free reserve. The maximum 2,304,051-byte animation therefore cannot be safely replaced by another maximum animation inside the 3,121,152-byte linked volume. Even an otherwise empty ideal volume allows only about 13 full frames in each of two simultaneous animations; settings, filesystem overhead, stock assets, cover art, and retained firmware packages reduce this further. The implementation enforces measured runtime free space and can reject much smaller files with `409 conflict`.

No filesystem image was built or installed. Autoformat is explicitly disabled, no stock files are removed or migrated, and no filesystem OTA command exists. Matching offsets alone cannot establish preservation: the installed filesystem, settings, free space, version compatibility, and complete backup are still unknown.

## Stock OTA and Boot Compatibility Assessment

Both generated files are **below** the nominal 512 KiB stock guard. This removes a local size blocker only. It does not prove acceptance, installation safety, or startup.

| Aspect | Analyzed stock V1.0.6 | New local artifacts | Conclusion |
|---|---|---|---|
| Packaging | E9 boot at 0; app at `0x1000` | Same combined offsets | Structurally similar |
| Flash header | DIO, 40 MHz, 4 MB | Same declared values | Installed chip/layout unmeasured |
| Boot image | One segment; entry `0x4010F45C` | Two segments; entry `0x4010F480` | Different boot code and structure |
| Application | Five segments; entry `0x401000B8` | Five segments; entry `0x401000C0` | Different core/toolchain/runtime |
| Whole-image metadata | Length/CRC at `0xFF8/0xFFC` | Length/CRC at `0x1010/0x1014` | Old/new validation behavior must not be conflated |
| Filesystem offsets | `0x100000–0x3FA000` | Same linked range | Contents/format/migration compatibility PENDING |
| Stock upload guard | Nominal 524,288 bytes, imperfect accounting | 352,304-byte enabled image | Below nominal guard; exact installed checks PENDING |
| Backup/rollback | Not established | Not implemented | Wi-Fi-only deployment BLOCKED |

The modern [elf2bin source](https://github.com/esp8266/Arduino/blob/3.1.2/tools/elf2bin.py) writes length/CRC after generating image segment XOR. Validators must treat those eight patched IROM bytes as zero for the segment checksum; full-file CRC and SHA-256 then cover their required roles. Native regression tests and both independent offline validators accept the genuine generated images. The old stock image uses different metadata placement and is deliberately unsupported by NeonByte's future OTA route.

The [stock analysis](stock-firmware-analysis.md) found a generic-looking updater, a filename-prefix error that did not reject in the traced callback, and a guard that skipped oversized chunks before permissive finalization. The installed version, browser-side checks, complete verifier setup, modern-image acceptance, boot behavior, and stock data preservation remain unknown. No rename/bootstrap trick or upload experiment is authorized. The [upstream updater](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp) stages an application update and schedules eboot copy; the [OTA documentation](https://arduino-esp8266.readthedocs.io/en/3.1.2/ota_updates/readme.html) does not establish independent recovery for this clock.

## Verification and Review

- Native PlatformIO: **41 passed** (31 existing core tests plus 10 integration/helper tests).
- AddressSanitizer/UndefinedBehaviorSanitizer: both suites passed, 41 tests total, with temporary host executables outside Git.
- Both ESP8266 profiles compiled successfully without project compiler warnings, including enabled display and OTA paths.
- Python inspector and the exact C++ runtime image validators accepted both generated artifacts, including both segment checksums and modern CRC.
- Build guard passed synthetic permitted/blocked target tests without invoking any device target.
- Repository `npm run check`: Markdown, English-language check, 8 root tests, agent build/type checks, and 39 agent tests passed.
- `git diff --check`: passed.

An independent code review found two Important issues: silent candidate sync/close failures could replace valid settings, and full-file animation hashing blocked the main loop. Candidate readback now precedes promotion; native fault tests preserve the previous file after short/corrupt close, read, and rename failures. Hashing now uses one 512-byte step per loop, with a test proving bounded reads and application scheduling opportunities. Deliberately unprotected variants reproduced both the settings and modern checksum defects before the corrected suite passed. Compiler stack review also removed the duplicate status response allocation.

Remaining test limits: no ESP8266 runtime socket/timeouts/disconnect fault harness, real filesystem power-cut tests, live pairing/reconfiguration, complete nested library-stack measurement, measured FPS/free heap, or 1–2 hour stability run. Firmware image checks and flash staging are synchronous maintenance operations that can pause application rendering even though the SDK is yielded; seamless playback during OTA is not claimed. The native scheduler/hash tests validate the portable work budget, not hardware responsiveness.

## Deployment Blockers and Stop Boundary

The provisional pin profile is unverified, including boot-sensitive GPIO0/GPIO2. Physical flash capacity, board power, display behavior, installed layout, filesystem compatibility, complete unit backup, and successful boot are PENDING. There is no demonstrated recovery path independent of the replaced application that satisfies Wi-Fi-only operation.

OTA on a running NeonByte application cannot rescue firmware that fails before networking. Safe first-boot preparation removes the LCD/filesystem dependency for recovery secret delivery and retains authenticated maintenance during representative application failures. It still requires a privately prepared identity; public compile-check builds have no usable identity. Firmware staging still needs LittleFS, and independent boot recovery remains unproven. Automatic formatting, physical rescue, and stock credential migration remain absent.

**Stop before deployment.** The stock firmware/filesystem must remain untouched. Physical Phase 4 tasks stay unchecked in [PLANNING.md](../PLANNING.md). A safe Wi-Fi-only installation has not been established; no further device operation or phase is authorized by these results.
