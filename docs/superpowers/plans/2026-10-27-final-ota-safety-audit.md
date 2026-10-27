# Final OTA Safety Audit Plan

**Goal:** Correct offline-reproducible startup and recovery-service defects while preserving NO-GO.

**Scope:** The maintainer authorized this audit, local corrections, offline tests, and stock-restoration research. No device access, installation package, private identity, deployment, or later physical phase is authorized.

**Architecture:** Keep the existing startup state machine, pinned ESP8266 adapters, private authentication, flash layout, and strict modern-image validators. Make HTTP startup success observable and retry transient failures. Require recovery networking before automatic risky initialization. Verify AP security/DHCP readback and keep raw-flash verification cooperative.

## Tasks

- [x] Reproduce failed HTTP startup and failed AP startup with native regressions; correct `SafeStartup`, `StartupServices`, the HTTP begin adapter, and host doubles. Preserve a ten-second maintenance window after recovery networking succeeds.
- [x] Extend the actual AP adapter probe for wrong SSID/password/authentication, disabled AP, failed SDK configuration reads, and stopped DHCP. Reject those states and retry through the existing AP policy.
- [x] Reproduce missing cooperative service opportunities in raw OTA readback/hash adapters; add bounded yield points without changing activation or validation rules.
- [x] Independently inspect the unchanged stock image and exercise the exact runtime validators. Document conditional live return-to-stock feasibility, unsupported legacy metadata, full-backup limits, and boot-copy interruption risk. Do not implement or weaken a restoration route.
- [x] Run repository checks, offline integration, native and sanitizer suites, dependency/adapter probes, both existing non-installable compile profiles, image checks, and synthetic deployment guards. Record actual counts and remaining blockers in the final report and project status links.

## Review Focus

- Permanent AP/listener failure must not permit automatic filesystem/display startup.
- Network recovery must leave time for authenticated maintenance before risky startup.
- AP readback must not mistake a correct IP for working WPA2/DHCP.
- Complete invalid OTA images must remain inactive despite added cooperative yields.
- An intact vendor application image is not a full unit backup or independent failed-boot recovery.

## Execution Record

Work proceeds directly under the maintainer's explicit correction/test request. No additional execution-method approval is needed. Hardware acceptance checkboxes remain unchanged. Final results are recorded in `docs/final-ota-safety-audit.md`.

The independent read-only code reviewer found no Critical or Important regression. A minor diagnostic-length narrowing issue was reproduced with `4295330256` bytes, corrected with argument bounds before compilation, and checked against negative, zero, upper-bound and overflowing inputs. Modified stock fingerprints were also rejected. Radio, flash, real watchdog timing, and power-loss behavior were explicitly left unverified.
