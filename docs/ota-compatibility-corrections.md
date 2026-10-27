# Offline OTA Compatibility Corrections

**Date:** 2026-10-27. **Decision: NO-GO.** This work implements the locally
testable corrections identified in [the investigation](ota-compatibility-investigation.md).
No clock was accessed and no installation-ready image or private identity was created.

**Later orientation correction (2026-10-27):** the maintainer reported upside-down
text on the real SD PRO. The [display correction](display-orientation-correction.md)
supersedes this report's historical rotation-zero profile with rotation 2,
MADCTL `0x08` and offsets 0/0. SPI, pins, BGR and inversion remain unchanged.

## Display Initialization and Trace

`BoundedDisplayPanel` overrides the pinned Adafruit library's virtual `begin()`
and supplies 20 MHz before the command table is sent. The existing post-init
20 MHz setting remains. The SD PRO profile retains mode 3, `MADCTL=0xC8`, column
offset 0, row offset 80, inversion, and the previously provisional pin choices.
No orientation or display library was changed.

The native display test reproduces the original 32 MHz failure with a double and
passes after the override. The dependency probe executes the pinned Adafruit
initialization, command table, rotation and address-window method bodies with
host I/O doubles. It asserts the command sequence, 20 MHz for every observed
initialization command, final MADCTL/offsets, full-screen and last-row windows,
and the cover window. The probe does not simulate the controller or electrical
bus. Real colors, clipping, display voltage/timing and correct orientation remain
unverified.

## Recovery AP

The adapter starts the password-protected AP, calls `softAPConfig()` with IP and
gateway `192.168.4.1` and mask `255.255.255.0`, then checks all three values from
`wifi_get_ip_info`. A failure, read error or mismatch requests that the AP be
disabled; the existing startup policy retries. If the SDK rejects the disable
request, the actual AP state is unknown and the device must not be considered
reachable or safely reconfigured on that basis. `WiFi.persistent(false)`, private password,
bearer authentication and the existing OTA gates remain in place. The pinned
Arduino implementation chooses WPA2 for a nonempty password and uses the
current-only Wi-Fi configuration path when persistence is disabled. The probe
checks those library paths and runs the adapter against injected existing
addresses, failures and mismatches.

The AP IP configuration uses the pinned SDK's `wifi_set_ip_info` through
`softAPConfig`; the precise persistence and side effects of that SDK operation
on this unit are not established by the host double. Neither checked readback
nor WPA2 configuration proves DHCP, radio behavior, transient AP state, channel
switches, reachability, or preservation of stock SDK data. Those require
separately authorized hardware validation after all existing gates are satisfied.

## Explicit Maintenance-On-Boot Policy

`NEONBYTE_MAINTENANCE_ON_BOOT` accepts only 0 or 1. The default is 0 and keeps
the existing automatic startup behavior. Explicitly selecting 1 starts the
authenticated recovery service but does not automatically mount LittleFS or
initialize the display. Authorized maintenance provisioning and `/run` can
then prepare storage and start the application. Selection does not add a route,
change API v1 or modify the existing access controls.

The selected policy applies **on every boot**, including after provisioning; a
later restart requires an authenticated `/run` again. Automatically returning
to normal operation after one provisioned boot would require a durable indication
that survives a cold power loss. Reading that indication from LittleFS would
violate the requested no-automatic-mount property; using a separate flash region
would assume an unverified stock layout, and RTC alone is not reliable across
power loss. This dependency remains unresolved rather than inventing a marker or
silently changing existing installations. A future reviewed selection mechanism
must resolve the durable state and preservation boundary.

The public `esp8266-integration-check` compile profile explicitly selects 1 to
compile the selected path. The provisional profile retains default 0. Neither
contains a usable recovery identity, and both retain the local deployment guard.
The flag is a compilation policy, not an installation authorization.

## Validation and Remaining Gates

- `npm run check` and `npm run test`: passed; 9 root tests passed, one
  Windows-only test was skipped, and 54 agent tests passed in `check`.
- Native suite: 67 tests passed, including maintenance selection, provisioning,
  cold-restart simulation, existing automatic startup, AP fault handling, and
  display initialization. All 67 also passed AddressSanitizer and
  UndefinedBehaviorSanitizer in standalone host builds.
- `npm run test:offline`: 20 scenarios passed. The same 20 scenarios and the
  dependency probe also passed AddressSanitizer and UndefinedBehaviorSanitizer.
- Both ESP8266 profiles compiled locally with the deployment guard. They remain
  non-installable compile checks; target compilation is not hardware validation.
- The image inspector accepted both local compile outputs, and the synthetic
  deployment-guard check and `git diff --check` passed.
- Image validators and all current OTA authentication, integrity, flash bounds,
  backup and recovery requirements remain unchanged. No stock firmware
  restoration path was implemented.

The exact flash, board, display, installed updater and filesystem remain unknown.
A complete restorable unit-specific backup and independent Wi-Fi-only recovery
after failed application or boot-copy execution are still absent. **Installation
remains NO-GO.** A power loss or nonbooting image can still make the unit
unreachable under the Wi-Fi-only constraint.
