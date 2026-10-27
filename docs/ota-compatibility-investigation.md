# Independent SD PRO OTA Compatibility Investigation

**Date:** 2026-10-27. **Result: NO-GO remains unchanged.** This investigation adds
library-boundary evidence and an upstream failure report to the existing research.
It does not establish compatibility with the project unit or authorize installation.

**Subsequent offline implementation:** [compatibility corrections](ota-compatibility-corrections.md)
records the 20 MHz initialization, explicit AP network configuration, selectable
maintenance-on-boot policy, new tests, and remaining limitations. The findings,
probe outputs, and proposed changes below are the historical investigation state.

## Scope and Evidence Delta

Read `AGENTS.md`, all of `PLANNING.md` and `NEXT_STEPS.md`, and the existing
[hardware](hardware.md), [stock analysis](stock-firmware-analysis.md),
[installation research](stock-ota-installation-research.md),
[readiness review](ota-readiness-review.md), [first-boot](safe-first-boot.md),
[maintenance OTA](maintenance-ota-design.md), [integration](esp8266-integration.md),
[offline validation](offline-validation.md), [installation](installation.md),
[recovery](recovery.md), [evidence matrix](device-evidence-matrix.md), and
[GO/NO-GO](installation-go-no-go.md) reports before making changes.

The V1.0.6 disassembly, modern-image CRC analysis, nominal stock size guard,
bootstrap storage overlap, and backup/recovery assessment are already complete.
They are referenced here rather than repeated. Startup-before-storage, private
identity validation, staged Wi-Fi confirmation, and filesystem-independent
maintenance OTA are already implemented; they need no duplicate implementation.

Public GitHub reads on this date confirmed unchanged default-branch heads:

| Project | Current reviewed commit | Change since the previous investigation |
|---|---|---|
| [SmartClock AI](https://github.com/visued/smart-clock/tree/a86a31c31db3cec6189b65157566a66f4abe4fd0) | `a86a31c31db3cec6189b65157566a66f4abe4fd0` | None |
| [Home Assistant Mini-Display](https://github.com/piotrkochan/homeassistant-minidisplay/tree/ae012e7a81d873692eb67dc606927c69ab16cf49) | `ae012e7a81d873692eb67dc606927c69ab16cf49` | None; latest release remains [v0.3.0](https://github.com/piotrkochan/homeassistant-minidisplay/releases/tag/v0.3.0) |

“New” below means evidence absent from the previous local reports, including
older public evidence newly incorporated here. No new unit-specific evidence was
obtained. Third-party hardware observations remain observations of other units.

## Newly Established Findings

### A Reported First-Installation Failure Required Physical Recovery

Mini-Display [issue 4](https://github.com/piotrkochan/homeassistant-minidisplay/issues/4)
reports a black, unresponsive SD PRO after installing v0.1.1. The maintainer
[attributes the failure to the original updater's smaller image budget](https://github.com/piotrkochan/homeassistant-minidisplay/issues/4#issuecomment-5648495121).
The reporter subsequently [describes recovery through serial flashing](https://github.com/piotrkochan/homeassistant-minidisplay/issues/4#issuecomment-5651134762).

This supplies concrete external failure/recovery testimony where earlier local
reports described the size/truncation risk from source alone. It is not an
independent observation, proof of the precise failure mechanism, a failure rate,
or evidence that the smaller NeonByte image will fail. The reported recovery is
outside this project's Wi-Fi-only constraints. No UART procedure was executed or
adopted. A successful update between custom builds does not validate the initial
transition from stock.

### Display Rotation Numbers Do Not Specify Equivalent Register Settings

NeonByte uses Adafruit ST7735/ST7789 **1.11.0**, while both reference projects use
TFT_eSPI with a `^2.5.43` dependency. Comparing the actual initialization semantics
reveals a difference beyond the already-known CS discrepancy:

| Rotation-zero setting for a 240 × 240 BGR panel | NeonByte / Adafruit 1.11.0 | TFT_eSPI 2.5.43 reference |
|---|---|---|
| Final MADCTL | `0xC8` (`MX`, `MY`, BGR) | `0x08` (BGR) |
| Column / row start | 0 / 80 | 0 / 0 |
| Panel initialization | Generic nine-command table | Additional porch, gate, voltage, and gamma configuration |

Sources: [NeonByte adapter](../firmware/src/esp8266/display.cpp),
[Adafruit initialization and rotation](https://github.com/adafruit/Adafruit-ST7735-Library/blob/1.11.0/Adafruit_ST7789.cpp),
[TFT_eSPI definitions](https://github.com/Bodmer/TFT_eSPI/blob/6ae4c97c5a07bd64fce8993e9cfa95d9a81e7c81/TFT_Drivers/ST7789_Defines.h),
[rotation](https://github.com/Bodmer/TFT_eSPI/blob/6ae4c97c5a07bd64fce8993e9cfa95d9a81e7c81/TFT_Drivers/ST7789_Rotation.h), and
[initialization](https://github.com/Bodmer/TFT_eSPI/blob/6ae4c97c5a07bd64fce8993e9cfa95d9a81e7c81/TFT_Drivers/ST7789_Init.h).
The reviewed Mini-Display library patch changes font/filesystem behavior, not these
rotation tables. Its dependency range does not identify the exact library bytes
used in every published build; the TFT comparison is pinned to the 2.5.43 baseline.

The new host probe executes the installed Adafruit method bodies and NeonByte's
`DeviceDisplay::begin()` with I/O doubles. It confirms `MADCTL=200` (`0xC8`),
column offset 0, and row offset 80. It proves a software difference, not incorrect
pixels on the unit. Mirroring and offsets interact; an 80-row offset alone does
not prove clipping. Controller tolerance and the needed initialization table
remain physical questions. Do not blindly replace the driver or copy register
values from another unit.

**Required follow-up:** define the eventual profile by explicit MADCTL, offsets,
initialization sequence, inversion, and pins. Add command/address-window trace
coverage when changing it, then validate borders, orientation, RGB colors, and
backlight on an identified identical spare. Current frame-timing tests replace
the panel's initialization with no-ops and do not verify these properties.

### The Claimed 20 MHz Limit Does Not Cover Display Initialization

`DeviceDisplay::begin()` calls `panel_.init(...)` before
`panel_.setSPISpeed(20'000'000)`. In the pinned library, `init()` calls
`commonInit()`, which calls `begin()` with its default zero argument;
[`Adafruit_ST77xx::begin()` substitutes 32,000,000 Hz](https://github.com/adafruit/Adafruit-ST7735-Library/blob/1.11.0/Adafruit_ST77xx.cpp).
Panel initialization commands therefore use a **32 MHz request**, followed by the
20 MHz drawing request. The probe reproduces that order. These are requested bus
settings; the physical clock and signal margin were not measured.

**Required correction before relying on a 20 MHz profile:** use an initialization
path that applies the intended clock before the first panel command, with a host
trace asserting that bound. Simply moving `setSPISpeed()` before `init()` is
insufficient because `commonInit()` calls `begin()` again. This is locally
correctable; the maximum reliable physical SPI rate still needs hardware testing.
No driver or firmware correction is implemented by this investigation.

### Recovery AP Address Selection Is Conditional

[`startRecoveryAp()`](../firmware/src/esp8266/main.cpp) calls `WiFi.softAP()` without
an explicit `softAPConfig()`. The pinned
[Arduino 3.1.2 implementation](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/ESP8266WiFi/src/ESP8266WiFiAP.cpp)
sets `192.168.4.1` only when the SDK returns an AP address of zero. It preserves an
existing nonzero address. The new SDK-boundary probe confirms both cases, with no
persistent configuration writes in the simulated nonpersistent path.

This is an address-determinism gap in the documented provisioning contract. It
does **not** prove that this stock firmware supplies a nondefault address, that
such an address persists across an OTA reboot, or that the clock is unreachable.
Those SDK/runtime facts remain unknown. The maintenance status response contains
booleans rather than a discoverable AP address, and the desktop dashboard expects
an already-provisioned v1 device rather than providing a maintenance setup portal.

**Required correction:** explicitly configure and check the intended AP address,
gateway, and subnet, retaining the protected AP and current-only credential
policy. Cover zero/nondefault addresses and configuration failure offline. Provide
a reviewed operator provisioning workflow with private credential handoff; then
validate association, DHCP, AP/STA channel changes, and reachability physically.

## Remaining Compatibility Differences

The following unresolved items were already known; the table connects them to
the new findings without reopening completed reverse engineering.

| Area | Stock and alternative projects | Current NeonByte consequence |
|---|---|---|
| Bootloader / firmware | Published stock has old eboot/image metadata; Mini-Display's documented bootstrap uses the modern combined image. SmartClock's build script only renames the normal binary. | Keep the complete modern combined image. Matching format/boot bytes in previous research does not prove installed-stock acceptance or a successful boot. No legacy CRC patch or boot transplant is justified. |
| Flash layout | Stock-researched 4m3m; Mini-Display 4m2m; SmartClock inherits its manifest layout. Mini-Display erases its EEPROM record and formats LittleFS. | Retain provisional 4m3m and disabled autoformat. Do not use either project as a preservation-compatible intermediate installer. Physical capacity, installed map, volume contents, and preservation remain unknown. |
| Pins / controller | Mini-Display's tested unit uses no CS; SmartClock configures GPIO15 and cites the SmallTV/Ultra family template. Both name ST7789-compatible panels and GPIO13/14/0/2/5. | Shared names/pins do not settle this unit's CS, boot straps, or controller. Hardware SPI also configures GPIO12 as MISO in the pinned core; include it in the eventual pin review even though NeonByte performs no panel reads. |
| Wi-Fi startup | SmartClock tries SDK credentials, then a fixed-password fallback AP; Mini-Display asks for new credentials through its bootstrap. | NeonByte deliberately imports neither stock SDK credentials nor EEPROM settings. Private recovery identity and explicit provisioning are prerequisites. Public compile checks start no network and are unsuitable for installation. |
| First boot / storage | Stock alone supplies no NeonByte configuration or NBIF asset. | After ten seconds on a clean boot, current startup attempts storage even if configuration is absent. `beginStorage()` can create `/neonbyte/` and remove NeonByte temporary paths before configuration loading fails. AP-first startup is not a read-only first boot; a missing asset can leave a black screen while maintenance works. |
| Return to stock | Community restoration relies on a running replacement updater or physical programming. | The current modern-image validator rejects the original V1.0.6 file. That rejection was reproduced offline and is intentional. Neither existing OTA route is a demonstrated stock-restoration path. Keep the validation gates; a restoration design must be separately reviewed. |

Relevant code: [storage](../firmware/src/esp8266/storage.cpp),
[startup](../firmware/src/safe_startup.cpp),
[image validation](../firmware/src/firmware_image.cpp), and
[ESP8266 SPI initialization](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/SPI/SPI.cpp).
The fresh stock-file rejection adds execution evidence for an already documented
format restriction; it is not a newly discovered firmware defect.

Crash/invalid warm-reset evidence can suppress automatic storage access after an
OTA reset. It does not establish that every first or subsequent cold boot stays
in maintenance; the storage observation above is conditional on a clean boot,
not a measured stock-to-NeonByte transition.

## Risks Addressable Offline Versus Physical Dependencies

| Risk | Code/tests can resolve offline | Evidence still required from hardware |
|---|---|---|
| Unintended initialization clock | Bound the first command's requested frequency and trace it. | Electrical timing, signal integrity, actual usable speed. |
| Driver profile mismatch | Make registers/offsets explicit and test emitted commands and address windows. | Which profile this controller and orientation actually require. |
| AP address uncertainty | Explicit checked AP configuration; inject existing addresses and SDK errors. | Initial SDK state, DHCP, RF, channel migration, real client access. |
| Unintended first-boot storage access | A future first-install policy can require explicit storage/run confirmation before automatic mounting; test the cold/missing-config paths. | Whether mounting/writing this stock volume is compatible and preserves all required data. |
| Transfer / geometry / activation defects | Existing fault tests verify bounded staging, readback, length, hash, CRC, and fail-closed activation. Preserve them. | Actual flash geometry, erase/program behavior, eboot copy, reset and power-loss behavior. |
| Wrong public image / missing private identity | A later preparation preflight can reject identity-less or wrong-profile artifacts and verify the final private candidate's size/hash. | First boot and private operator access on the exact supported hardware. |
| Complete backup and failed-boot recovery | Analyze existing exports and recovery designs offline if supplied. Tests cannot invent a stock export or a retained rescue service. | Complete unit-specific capture/restore and independently executing Wi-Fi recovery, proven on an identical spare. |

The new probe is diagnostic, not a firmware fix or a replacement for permanent
regressions accompanying future changes. No true hardware acceptance item is
completed by this report. Adding a new protected rescue architecture would be a
major separately authorized project; it cannot make its own first installation
safe under the current evidence.

## Simplest Conditional First-Installation Path

The prior direct-OTA recommendation still stands. **There is no currently
eligible installation procedure.** If all existing evidence/recovery gates are
eventually satisfied, the smallest candidate is one private, uncompressed
combined NeonByte image sent through the matching stock web updater, followed by
authenticated maintenance provisioning. No intermediate SmartClock or
Mini-Display firmware, filesystem image, partition migration, gzip conversion,
or bootloader transplant is needed by the available size/format evidence.

Before preparing that candidate:

1. Resolve the installed stock/browser/verifier, exact PCB/display/flash/layout,
   complete restorable unit-specific backup, independent Wi-Fi-only failed-boot
   recovery, and identical-spare prerequisites in [the existing gate](installation-go-no-go.md).
   This investigation does not initiate vendor contact or device access.
2. Address the initialization-clock and deterministic-AP gaps. Resolve the
   explicit driver profile and an operator provisioning workflow. For a future
   maintenance-first installation, prevent automatic storage/display work until
   explicitly requested; do not depend on an operator racing the ten-second
   startup timer. These are proposed corrections, not changes made here.
3. Separately review a private installation profile and credential handoff. Keep
   authenticated maintenance OTA available in that future profile, preserve the
   identity across updates, retain the verified linker boundaries, and delay
   display activation until its profile is validated. Keep all current public
   build/deployment guards unchanged.
4. Only after separate packaging authorization, measure the exact private image:
   complete E9 images, modern CRC, SHA-256, confirmed flash declarations, and
   **at most 458,752 bytes** under the existing preparation policy. An `SDP` prefix
   and the researched multipart `POST /update_ota` field `update` are envelope
   candidates, not proof of the installed verifier's behavior.
5. Only after the gates and separate physical authorization, establish stock
   acceptance, first maintenance access, storage preservation, provisioning,
   display behavior, subsequent updates, and restoration on the identical spare.
   A transfer response is not a first-boot or recovery test.

Current public artifacts satisfy only local size/structure checks. Their missing
private identity independently makes them unsuitable for installation. A
maintenance-first single application can reduce display/storage exposure after
boot; it cannot repair failure before networking or interruption of the boot copy.

## Offline Validation Performed

No ESP8266 target build or third-party firmware execution was performed. Only
preexisting binary files were read. New probes compile temporary **host**
executables, execute extracted library/adapter method bodies against I/O doubles,
and delete the temporary directory. They do not execute a complete SDK, command
table, radio, LCD controller, or device image.

| Check | Fresh result |
|---|---|
| `python3 firmware/scripts/probe_compatibility.py` | Passed; requested initialization/drawing clocks 32,000,000 / 20,000,000 Hz; MADCTL `0xC8`; offsets 0/80; zero-IP fallback and preservation of an injected nonzero AP address reproduced. |
| Existing Python image inspector, both compile checks | Passed; 361,168 / 362,192 bytes; modern CRC and segment checks; `installationApproved: false`. |
| Existing C++ runtime validator, both compile checks | Accepted both modern files; no installation approval implied. |
| Same C++ validator, original V1.0.6 | Expected rejection, exit 1; original SHA-256 still matches `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b`. |
| `uv tool run --from platformio pio test -d firmware -e native` | Passed, all 63 cases in four host suites. |
| `npm run test:offline` | Passed, all 20 host integration scenarios. |
| `python3 firmware/scripts/test_local_build_guard.py` | Passed; only synthetic device-target inputs were tested. |
| `npm run check` | Passed: Markdown lint on 25 files, English check, 9 root tests plus 1 Windows-only skip, agent build/typecheck, and all 54 agent tests. |
| `git diff --check` | Passed; new-file whitespace/encoding checks also passed. |

The dependency probe requires the already installed Adafruit 1.11.0 sources,
Arduino ESP8266 package `3.30102.0`, Python 3, and a host C++17 compiler. It checks
dependency versions, accepts explicit `--display-library` and `--framework`
paths, and never installs dependencies. Its SDK state is synthetic; source
extraction is limited to the reviewed methods, not a general C++ parser.

To reproduce the image checks before any native tooling cleans build outputs:

~~~sh
python3 firmware/scripts/probe_compatibility.py
python3 firmware/scripts/inspect_image.py firmware/.pio/build/esp8266-provisional/firmware.bin
python3 firmware/scripts/inspect_image.py firmware/.pio/build/esp8266-integration-check/firmware.bin
c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include \
  firmware/scripts/validate_image.cpp firmware/src/firmware_image.cpp \
  -o /tmp/neonbyte-compatibility-validator
/tmp/neonbyte-compatibility-validator firmware/.pio/build/esp8266-provisional/firmware.bin
/tmp/neonbyte-compatibility-validator firmware/.pio/build/esp8266-integration-check/firmware.bin
/tmp/neonbyte-compatibility-validator SDPro_V1.0.6_20260525_174828.bin
~~~

The last command must return 1 for the unchanged stock artifact. Do not change
its CRC/boot bytes or weaken the validator to make it pass.

## Residual Risk and Stop Boundary

**The probability of making the unit unusable cannot be quantified from these
sources. The consequence can be indefinite loss of the device under Wi-Fi-only
constraints.** A valid, small, fully received image can still fail before the AP,
or a power interruption can leave boot/application bytes unusable. No confirmed
independent service would then execute a restore. The external failure report
demonstrates that application-level OTA success and later physical recovery are
different claims; its serial rescue is unavailable here.

Clock/controller/profile and provisioning corrections can reduce specific risks.
They cannot reduce failed-boot recovery risk to zero, substitute for a complete
backup, or change the mandatory NO-GO decision. If the independent recovery and
restorable-backup prerequisites cannot be established within the existing
constraints, leave this unit on stock firmware.

No manufacturer was contacted. No clock request, discovery, reset, flash, OTA,
erase, secret generation, installation package, partition change, security-gate
change, commit, or release occurred. Firmware implementation and v1 contracts
remain unchanged. Stop at this investigation; physical phases remain pending.
