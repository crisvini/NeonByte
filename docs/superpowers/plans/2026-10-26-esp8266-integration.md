# ESP8266 Integration Implementation Plan

> **For agentic workers:** execute the authorized Phase 4 local integration only. The maintainer's request is the specification. No device contact, deployment, serial operations, filesystem image generation, or later-phase client work is authorized.

## Design and Boundaries

Preserve the native core and add an explicitly provisional ESP-12F compilation profile: ESP8266 Arduino 3.1.2, DIO/40 MHz, 4 MB, and the stock-researched 4m3m linker layout. These are artifact assumptions, not confirmed installed geometry. Use cooperative Wi-Fi, a single bounded HTTP connection, incremental LittleFS media, and a gated device-hosted OTA route. Mount with autoformat disabled, use only `/neonbyte/` files, never migrate stock settings, and never expose filesystem erase/update routes. Display GPIO activation and OTA remain compile-time disabled in the review build.

Wi-Fi setup uses a randomly generated WPA2 AP password and bearer token shown locally on the display only after display validation is explicitly enabled. Configuration is authenticated and persisted atomically. Unconfigured devices retain their setup AP; configured devices retry station Wi-Fi without blocking playback. No UART or USB setup fallback exists. A missing/unmountable filesystem fails closed and requires a separately designed installation path.

Media and firmware transfers require exact Content-Length, bearer authentication, lowercase SHA-256, timeout, format validation, and available-space checks before atomic replacement. Firmware is first staged as a file and validated in full; only an explicitly OTA-enabled future build may call `Update.begin(exactSize, U_FLASH)` and `Update.end(false)`. No rollback is claimed. Preserve all installation and recovery blockers.

## Task 1: Bounded Core Integration

- Add tests for strict HTTP framing, interrupted/oversized/checksum-mismatched transfers, and ESP8266 image validation.
- Observe missing implementation failures, then implement pure helpers under `firmware/include/neonbyte/` and `firmware/src/`.
- Reduce protocol stack pressure by retaining the transactional Spotify scratch object in the handler; keep schemas and existing behavior stable.
- Run native tests, including malformed images and framing cases.

## Task 2: ESP8266 Runtime

- Add pinned `esp8266-provisional` environment; retain `native` as default. Add a local-only guard against upload/erase targets.
- Implement clock, namespaced no-autoformat storage/configuration, authenticated bounded HTTP streaming, cooperative Wi-Fi retry, ST7789 provisional adapter, cover rows, animation scheduling, and gated staged OTA.
- Compile locally, inspect stack reports, ELF sections, image headers, checksums, CRC, and size versus 512 KiB. Hardware behavior remains unverified.

## Task 3: Documentation and Verification

- Update hardware, recovery, firmware, protocol, README, and planning documents with the visual ESP-12F confirmation and current implementation status.
- Document binary limits, credentials, provisioning limitations, exact build results, staging budget, static RAM and dynamic estimates, licenses, and boot/recovery blockers.
- Run native tests, sanitizers where available, ESP8266 build, `npm run check`, and `git diff --check`.
- Review the complete change and stop before deployment. Do not mark hardware acceptance complete.

## Progress

- Baseline: 31 native tests pass; working tree initially clean.
- Decision: perform local edits in the shared workspace requested by the maintainer; do not create commits or change integration state.

- Task 1 verified: 41 native tests pass after bounded helper/core changes.
- Task 2 verified: both ESP8266 profiles compile; offline C++ and Python validators accept both artifacts.
- Review: independent reviewer found settings close/sync readback and synchronous media hashing issues; both fixed with portable fault/budget regression tests.
- Decision: firmware validation and flash staging may pause rendering during maintenance; seamless OTA playback is outside this phase, while normal media hashing is cooperative.
- Decision: physical validation, full backup, and independent Wi-Fi-only recovery remain blockers; preserve all device operations for separate authorization.
- Task 3 verified: repository checks and diff whitespace checks passed; artifact sizes, target object/stack estimates, stock comparison, limits, and deployment blockers are documented. No phase boundary was crossed.
