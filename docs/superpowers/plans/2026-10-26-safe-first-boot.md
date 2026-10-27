# Safe First-Boot Preparation Implementation Plan

**Authorization:** Phase 4 implementation and offline validation only, as requested on 2026-10-26. No installation, release packaging, deployment, device access, or Phase 5 work.

**Goal:** preserve authenticated Wi-Fi access when recoverable application dependencies fail.

**Design:** start a protected recovery AP and a statically allocated HTTP service before filesystem access or application allocations. Use independent, privately supplied per-device recovery credentials, never stock credentials or an LCD as the only secret-delivery channel. Missing credentials disable networking in compilation-only artifacts rather than exposing an open AP. Keep the AP available alongside station Wi-Fi. Delay risky application initialization by ten seconds; an RTC startup guard and crash reset reasons select maintenance on the next boot. RTC failure also selects maintenance.

The maintainer authorized implementation; routine design choices below are implementation decisions, not a separate installation approval. Work proceeds in this checkout, without commits or releases.

## Decisions and Tradeoffs

- Prefer privately supplied recovery identity over stock credential reuse or LCD-generated secrets: it survives missing configuration and display failure. A future private package must securely deliver and retain this identity; this task generates no identity or package.
- Keep one application and existing adapters. A second bootstrap adds another replacement and does not provide independent boot recovery.
- Add authenticated maintenance routes outside API v1 for status, pausing/resuming the application, staged Wi-Fi, and explicit confirmation. Persist only after connection confirmation; support explicitly requested temporary Wi-Fi when storage fails. Preserve existing API v1 schemas and routes.
- Keep LittleFS autoformat disabled and write only namespaced settings. Retain the existing file-staged OTA verifier and gates. Authenticated maintenance can use it when storage is available, but cannot repair an unmountable filesystem. Filesystem-independent verified updates remain a deployment requirement.
- Keep recovery AP available after station connection. This costs radio exposure and AP/STA channel coupling; independent high-entropy WPA2 and bearer secrets restrict access.

## Task 1: Portable Startup and Provisioning Policy

Files: new `firmware/include/neonbyte/safe_startup.h`, `firmware/src/safe_startup.cpp`, and `firmware/test/test_startup/test_main.cpp`.

- [x] Write and run failing tests for network-before-storage order, missing identity, AP retry, mount/configuration/application/RTC failures, station retry deadlines, authentication, staged confirmation, failed persistence, temporary configuration, and reset behavior.
- [x] Implement an injected service interface and bounded state transitions; rerun the native suite.

## Task 2: ESP8266 Integration

Files: `firmware/src/esp8266/main.cpp`, HTTP/storage headers and implementations, `.gitignore`, `firmware/platformio.ini`.

- [x] Bind the tested policy to Wi-Fi, RTC, namespaced storage, and application allocation. Keep the HTTP service static, authenticate maintenance before reading bodies, and bound its bodies without allocating maximal JSON buffers.
- [x] Add delayed guarded application initialization, explicit maintenance controls, and optional private identity input with no built-in usable credentials.
- [x] Compile both existing ESP8266 profiles and inspect image/resource evidence.

## Task 3: CI and Documentation

Files: `.github/workflows/ci.yml`, `docs/safe-first-boot.md`, protocol, firmware, integration, recovery, hardware, installation documentation, and `PLANNING.md`.

- [x] Add sequential native tests, both compile profiles, image validation, and deployment-guard checks to CI without publishing firmware artifacts.
- [x] Document the startup audit, security assumptions, residual boot/filesystem/radio risks, RAM limits, and exact future package requirements.
- [x] Run all native tests, sanitizers, both target compilation checks, repository checks, offline inspectors, and `git diff --check`. Mark only verified preparation work complete.

## Review Focus

- A false-positive station connection must not commit candidate credentials.
- Failed persistence must preserve the previous configuration and recovery identity.
- A crash or RTC failure must avoid automatic reentry into risky application initialization.
- Missing credentials must never create an open or predictable AP.
- HTTP availability cannot be promised after a library hang without a functioning watchdog/reset or after nonbooting firmware.

## Execution Record

All three implementation tasks were completed and validated within the authorized boundary. Native tests first failed before the new interfaces existed. Final verification: 54 native tests, all sanitizer suites, both target builds, both offline image validators, deployment-guard tests, repository checks, and whitespace checks. No commits, credentials, release packages, or device operations were created.

Review corrected configured-SSID confirmation by requiring fresh station association/GotIP evidence after a successful disconnect request. Native fault injection covers stale status, failed disconnect, and changed credentials for the same SSID. Remaining physical and filesystem-independent update limits are documented rather than marked complete.
