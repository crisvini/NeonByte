# Device Backup and Recovery

**Status (2026-10-27): NOT RELEASE READY; deployment BLOCKED.** The maintainer visually confirmed ESP-12F / ESP8266 on 2026-10-26. Part 6 recorded **NO-GO** in the [installation decision report](installation-go-no-go.md), and Part 7 remains blocked. No safe Wi-Fi-only backup, first installation, or independent failed-boot recovery procedure has been established. No device requests, uploads, flashes, erases, or filesystem changes were performed. See the [release-readiness report](release-readiness.md).

The [OTA readiness review](ota-readiness-review.md) evaluates which evidence can be collected without device modification and why complete backup and independent Wi-Fi recovery remain unestablished. Its maintenance-only raw staging proposal was implemented offline in Part 4; that work preserves this deployment gate and authorizes no device operation.

## Permitted Scope

Communication and future updates must use Wi-Fi exclusively. Physical programming, UART, soldering, and USB-serial are out of scope. The Phase 4 local source/build authorization does not authorize installation or waive the recovery gate.

The ESP8266 ROM downloader is not a Wi-Fi recovery service. A functioning stock web updater or a functioning future NeonByte OTA route requires an application that boots and joins Wi-Fi. Neither is evidence of recovery after a failed boot, damaged filesystem, invalid configuration, interrupted boot copy, or inaccessible network.

## Existing Stock Evidence

The [stock binary report](stock-firmware-analysis.md) identifies a 488,304-byte ESP8266 bootloader/application update, with LittleFS linked at `0x100000–0x3FA000` and EEPROM at `0x3FB000`. It is **not a full-flash backup**: stock web files, animations, settings, provisioning, and flash-tail contents are absent. Its two images are bootloader and application, not rollback slots.

The traced stock `POST /update_ota` uses application-controlled staging and has a nominal 512 KiB guard whose oversized handling is unsafe to interpret as clean rejection. Filename acceptance, generic image validation, or a successful HTTP response cannot establish successful startup or restoration. The installed version and complete verifier/browser behavior remain PENDING.

The vendor repository and independent installation reports do not establish a recovery service independent of the replaced application. No endpoints were probed to investigate this.

## NeonByte Update Limits

The [new runtime](esp8266-integration.md) implements staged SHA-256 verification, exact length, format checks, an absolute 512 KiB cap, runtime staging-space validation, and `Update.end(false)`. The API v1 firmware route still uses LittleFS file staging. The authenticated maintenance firmware route now uses the existing raw sketch staging area and a checked flash-backed readback verifier, so that route has no LittleFS dependency. It remains gated by `NEONBYTE_ENABLE_OTA`, a paused application, exact runtime flash geometry, and the private recovery bearer token. OTA is disabled in the provisional build; the enabled integration-check profile is compilation-only and has no usable recovery identity.

It does not provide a stock-to-NeonByte bootstrap, full backup, rollback image, protected rescue partition, recovery after a failed boot, or restoration of stock configuration. The validation environment compiles enabled OTA paths; it remains blocked from PlatformIO deployment targets. Runtime code never formats LittleFS and never performs a filesystem update.

The [safe first-boot preparation](safe-first-boot.md) now starts an authenticated recovery AP and static HTTP service before storage and display when a valid private identity is supplied. Configuration/display/application failures can leave a usable maintenance service. Guarded risky initialization and crash reset evidence avoid automatic reentry after representative failures. Explicit temporary Wi-Fi does not require storage; credentials are supplied privately before installation rather than recovered from stock or an LCD.

Configuration readback and atomic rename protect against representative interrupted or failed writes. They do not repair corrupted/unmountable storage. The maintenance raw-staging transaction was fault-tested with native injected backends for unavailable/corrupt/full LittleFS, request and image failures, staging geometry, flash I/O, and fail-closed activation. It checks exact candidate length, request SHA-256, both E9 images, CRC, and checked raw flash reads before `Update.end(false)` can write an eboot command. Its compile-check passed for the existing integration profile. These results do not establish physical flash behavior, filesystem behavior, reset/power-loss safety, or successful boot; runtime staging validation on an identical spare remains pending. RTC/watchdog handling requires an application that boots; it cannot recover a failed bootloader, interrupted boot copy, or nonbooting firmware. Public compile-check artifacts have no usable recovery identity and must never be installed.

The [stock OTA installation research](stock-ota-installation-research.md) documents direct installation and temporary bootstrap examples. Neither supplies independent Wi-Fi boot recovery, and the examined Mini-Display bootstrap changes EEPROM and formats its new filesystem. The existing preservation/recovery gate remains unchanged.

The [independent compatibility investigation](ota-compatibility-investigation.md) adds a public report of failed Mini-Display first installation followed by serial recovery on another unit. That recovery is unavailable under this project's constraints. It also reproduces the current modern-image validator's intentional rejection of the original V1.0.6 file: the existing NeonByte OTA routes are not a verified return-to-stock mechanism. Keep their validation intact; a stock restoration design requires separate review. The report records additional display/provisioning gaps without changing NO-GO.

The [final OTA safety audit](final-ota-safety-audit.md) corrects failed HTTP-listener startup/retry, automatic initialization before recovery networking, incomplete AP readback, and missing cooperative points in raw update verification. Its fresh offline stock probe confirms that the old image's valid legacy CRC and hypothetical staging fit do not make it acceptable to the current strict modern-image routes. A separate live return-to-stock operation is technically plausible while NeonByte works, but remains unimplemented and hardware-unverified. It would restore boot/application bytes only, replace the boot sector, and expose an interruption window with no independent Wi-Fi rescue. It cannot replace a complete unit backup or failed-boot recovery. **NO-GO remains unchanged.**

## Part 6 Decision Gate

The 2026-10-27 review found no newly supplied exact-unit evidence. The published stock image is not a unit-specific backup; host-tested maintenance OTA still requires an already-running application and has not been validated on an identical spare. There is no documented independent Wi-Fi rescue service for a failed application or boot copy. Installation and physical validation therefore remain **NO-GO**. See the [dated evidence checklist and minimum next actions](installation-go-no-go.md).

## Required Evidence Before Deployment

- Confirm the installed flash capacity, layout, stock version, board/display profile, and image boot compatibility.
- Obtain a complete unit-specific backup through a documented, authorized Wi-Fi-only method, including filesystem, settings, and provisioning. Keep backup files encrypted and outside Git; retain independently verified hashes.
- Obtain and validate a recovery service that remains available when the normal application cannot boot, under the Wi-Fi-only constraint. Prove its restoration behavior on an identical spare before considering the project unit.
- Resolve modern-versus-stock bootloader/image conventions, staging boundaries, filesystem compatibility, configuration preservation, and power-loss behavior.
- Obtain separate maintainer authorization for any device operation after those blockers are resolved.

No qualifying independent Wi-Fi recovery mechanism is documented by current evidence. **Keep the original firmware and filesystem untouched. Stop before deployment.** If the constraints cannot be satisfied, this unit must remain on stock firmware; local compilation and simulation do not remove that blocker.
