# NeonByte — Implementation Plan

> **Status: NOT RELEASE READY.** Phases 1, 2, and 3 are complete; the maintainer confirmed Windows 11 automatic startup, hidden execution, and real Spotify reconnection after restart on 2026-10-26. Phase 4 includes locally compiled ESP8266 adapters, host-validated safe first-boot preparation, and the maintenance-only raw staging implementation. The 2026-10-27 Part 6 decision is **NO-GO** and Part 7 remains blocked; display/flash/boot validation and Wi-Fi-only installation/recovery remain pending. Part 8 documentation and offline quality results are recorded in [the readiness report](docs/release-readiness.md) · **Intended license:** MIT · **Target device:** JUZIPi SD PRO (ESP-12F / ESP8266 visually confirmed; remaining hardware identification pending)
>
> **Primary rule:** implement phases sequentially; do not flash firmware until the hardware is validated and recovery is documented.

## 1. Objective and Scope

Build **NeonByte**, an open-source project consisting of custom firmware for a small Wi-Fi display and a desktop agent that reads Spotify. The device presents **exactly two screens**:

1. **Spotify Now Playing:** centered 176 × 176 album cover, title, and artist; no playback bar or times.
2. **Fullscreen GIF:** animation fills the entire screen and loops with no overlays.

**Default behavior:** active Spotify playback → Spotify; paused playback, no playback, or an unavailable agent → GIF. The user can manually select `auto`, `spotify`, or `gif`. In `spotify` mode with no music, show a subtle waiting state (do not invent a track). The GIF must remain available after the clock restarts; if the PC shuts down while the display remains powered, the GIF continues.

### Out of Scope for the First Version

- Home Assistant, MQTT, databases, Docker, required cloud services, mobile apps, playback control, or integration with other players.
- GIF editor, multiple GIFs, elaborate transitions, or multiple themes.
- Audio playback on the clock: it **displays** information; it does not play music.
- Compatibility with unverified SD PRO variants.

## 2. Assumptions Requiring Validation

- **Do not assume** the chip, SPI pinout, LCD driver, backlight, orientation, flash size, partition scheme, file system, or OTA layout from the device's commercial name alone.
- The expected display is **240 × 240**; validate resolution, rotation, and colors on the actual hardware.
- Confirm a reliable Wi-Fi-only way to back up and restore the original firmware and recover after a failed boot before installation. Physical programming, UART, soldering, and USB-serial are out of scope.
- Investigate RAM, storage, maximum firmware size, drawing speed, and flash wear limits.
- Confirm current Spotify Web API requirements (scopes, app mode, rate-limit rules, and credentials) in the official documentation during implementation.
- Verify licenses for libraries, fonts, and assets added to the project, including attribution requirements.

**Blocking milestone:** installation remains blocked without validated hardware and independent Wi-Fi-only recovery. The maintainer explicitly authorized local Phase 4 ESP8266 compilation with documented provisional hardware assumptions; that authorization does not permit device operations.

## 3. Proposed Architecture

~~~text
Spotify Web API
      |
      | OAuth + HTTPS polling (computer only)
      v
NeonByte Agent (Node.js + TypeScript)
  - OAuth, refresh token, and secure storage
  - Polling and state normalization
  - Album art conversion and cache
  - GIF conversion and optimization
  - Configuration UI bound to localhost only
  - Communication and synchronization with the clock
      |
      | Authenticated local HTTP / Wi-Fi
      v
NeonByte Firmware (C++ / PlatformIO, platform to be confirmed)
  - Wi-Fi and local pairing
  - Spotify screen rendering
  - Fullscreen optimized animation player
  - Persistent storage for GIFs and settings
  - Fallback when connectivity is lost
~~~

The agent starts automatically **when the user logs in** (Windows 11 natively; Ubuntu WSL2 is the development environment), without requiring an open terminal. It does not need to start before login. Local connectivity and Spotify can fail temporarily; the system must recover without intervention.

### Responsibilities

| Component | Responsibilities | Must not do |
|---|---|---|
| Agent | OAuth, Spotify, polling, caching, media conversion, configuration UI, sending updates | Store secrets in firmware; require a container or database |
| Firmware | Display scenes, retain protocol timing, play GIFs, persist assets, and respond to commands | Call Spotify directly; depend on the Internet for GIF playback |
| Simulator | Reproduce visual behavior and test protocols before flashing | Pretend browser tests validate hardware |

## 4. Repository Structure

~~~text
NeonByte/
├── PLANNING.md
├── README.md
├── LICENSE
├── AGENTS.md
├── .gitignore
├── docs/
│   ├── hardware.md
│   ├── protocol.md
│   ├── firmware-development.md
│   ├── development.md
│   ├── installation.md
│   └── recovery.md
├── agent/
│   ├── package.json
│   ├── src/
│   │   ├── main.ts
│   │   ├── spotify/
│   │   ├── device/
│   │   ├── media/
│   │   ├── config/
│   │   └── web/
│   └── tests/
├── simulator/
│   └── ...
├── firmware/
│   ├── platformio.ini
│   ├── include/
│   ├── src/
│   │   ├── main.cpp
│   │   ├── display/
│   │   ├── scenes/
│   │   ├── network/
│   │   └── storage/
│   └── test/
└── assets/
    └── samples/
~~~

The structure may change when there is a documented reason. Avoid premature abstractions and heavy dependencies.

## 5. Functional Behavior

### 5.1 Display Modes

| Setting | Spotify playing | Paused/no track/agent offline |
|---|---|---|
| `auto` (default) | Spotify | GIF |
| `spotify` | Spotify | Spotify waiting state |
| `gif` | GIF | GIF |

- In `auto` mode, detect playback from the confirmed API state; do not infer playback from an open Spotify window.
- Apply a configurable **update timeout**: if the agent stops sending a heartbeat for a defined period (initial example: 45 seconds), firmware returns to GIF.
- When Spotify pauses, switch to GIF without requiring a reboot.
- The manual selection must persist after restart.

### 5.2 Spotify

- Display a centered 176 × 176 cover, title and artist with unchanged font sizes, up to two safely truncated lines each, and no progress bar or playback times.
- Protocol progress advances in firmware between syncs and is corrected when a new playback timestamp arrives; it does not trigger display redraws.
- Suggested initial polling interval: **15 seconds** (configurable); handle `429` and `Retry-After`, network failures, `204 No Content`, token expiration, and token refresh.
- Update the cover only when the track or cover changes; transfer data in a format suitable for the LCD.
- Do not show tokens or secrets in logs, shared URLs, or device responses.
- Recommended Spotify flow for a local app: **Authorization Code with PKCE**, with a loopback redirect allowed by the platform and the minimum playback-read scope. Check current rules before coding.

### 5.3 Fullscreen GIF

- The agent interface lets the user select a GIF and preview it at 240 × 240.
- Convert to a final size of 240 × 240: default `cover` policy (fill and crop), with `contain` offered only if it is actually needed.
- Preserve frame timing where possible; reduce FPS, palette, or frame count as required by measured flash/RAM limits.
- **Do not assume the ESP8266 can decode an original GIF in real time.** The agent produces a documented, custom optimized animation format suitable for sequential/streaming reads from flash.
- Validate integrity (size, version, checksum) before replacing the current animation. Use atomic writes or a recoverable procedure so a failure does not destroy the working GIF.
- The GIF must loop without a computer connection while the device is powered.

### 5.4 Local Configuration App

The app is available only at `http://localhost:8787` (configurable port) and includes:

- Device connection status.
- **Connect Spotify** / reconnect button.
- Spotify preview using mock data or current data.
- GIF upload and preview of the device display.
- `Auto` / `Spotify` / `GIF` selector.
- Device address or local discovery (only if discovery is reliable).
- Actionable error messages that do not reveal secrets.

**Local security:** bind only to `127.0.0.1`, validate inputs, protect mutating endpoints against unauthorized origins (CSRF/origin), and limit upload size. Do not store credentials in plaintext in the repository; prefer the operating system's credential manager, with documented fallback and restricted permissions.

## 6. Agent ↔ Firmware Protocol (Initial Proposal)

The protocol below **is a specification to implement**, not a set of existing endpoints. Define the exact format in `docs/protocol.md`, with versioning (`v1`). Authenticate mutating operations with a pairing token stored by the agent and device; do not expose the token in logs.

| Method | Endpoint | Use |
|---|---|---|
| `GET` | `/api/v1/status` | Firmware version, protocol version, IP, free space, mode, and active scene |
| `PUT` | `/api/v1/mode` | Set `auto`, `spotify`, or `gif` |
| `PUT` | `/api/v1/spotify` | Update metadata, `isPlaying`, duration, progress, and timestamp |
| `PUT` | `/api/v1/cover` | Send an optimized image with track identification |
| `PUT` | `/api/v1/animation` | Send an optimized animation file with integrity validation |
| `POST` | `/api/v1/heartbeat` | Refresh the agent presence state |

Example payload for `PUT /api/v1/spotify`:

~~~json
{
  "trackId": "example-track-id",
  "title": "Example Track",
  "artist": "Example Artist",
  "isPlaying": true,
  "durationMs": 180000,
  "progressMs": 42000,
  "sampledAtUnixMs": 1790000000000
}
~~~

Specify and test: size and text limits, version, HTTP errors, authentication, timeout, reconnect, idempotency, checksum, and behavior when the cover arrives before or after metadata. The clock must not open Spotify cover HTTPS URLs directly.

> **Security:** Local HTTP with a token protects against accidental or unauthorized changes on trusted networks, but it **does not encrypt** traffic. Document this limitation; evaluate a secure alternative for untrusted networks in future work.

## 7. Implementation Phases

Each phase includes deliverables, tasks, tests, acceptance criteria, and dependencies. Proceed only after acceptance criteria are met and the maintainer explicitly approves.

### Phase 1 — Foundation and Investigation (Do Not Touch the Clock)

**Deliverables:** repository structure, `README.md`, `AGENTS.md`, initial documentation, contracts, basic tests, and hardware investigation.

- [x] Create the monorepo and conventions for scripts, code style, and basic CI.
- [x] Record evidence for the model in `docs/hardware.md` (photos, original interface, official firmware/repository link, board and hardware identification when available).
- [x] Identify pinout, bootloader, flash, OTA, file-system, and recovery risks; mark unknowns as `PENDING` without guessing.
- [x] Specify `auto`/`spotify`/`gif` flows, data model, and v1 API.
- [x] Define a preliminary resource budget to measure on hardware (flash, RAM, FPS), without invented values.
- [x] Prepare `.env.example` with non-secret settings and placeholders only.

**Acceptance:** the repository setup is usable, initial lint/tests run, contracts and pending items are documented, no integration or flashing has started, and language consistency is verified.

### Phase 2 — Spotify Agent (No Firmware)

**Deliverables:** executable Node.js + TypeScript app, authentication, and reading/normalization of playback state.

- [x] Configure the TypeScript project, unit tests, logs, and error handling.
- [x] Implement Spotify OAuth Authorization Code + PKCE, loopback callback, and secure refresh-token storage.
- [x] Read current playback with the smallest applicable scope; handle `204`, `401`, `429`/`Retry-After`, offline state, and expired tokens.
- [x] Implement configurable polling (initial value 15 seconds), a comparator to avoid identical updates, and metadata caching.
- [x] Create a mock adapter for development without a Spotify account or external requests in tests.
- [x] Expose internal state to the simulator through a defined and tested local interface (without exposing credentials).

**Acceptance:** OAuth and refresh flows are covered by mock-based tests; real Spotify reconnection after restart is maintainer-verified as recorded in Phase 6. Initial authorization and forced token-expiration/revocation cases were not separately reported as manual tests. The mock reproduces play/pause/track changes; tests pass; secrets are not sent to the logger; and language consistency is verified.

**Corrective review:** `make check` passed locally with Node.js 22.12.0 and 24.21.0. CI was configured for both major versions; the remote run for that change still depends on a new push. Deduplication accounts for expected progress and corrects deviations greater than 2 seconds; clock integration remains pending for its corresponding phase.

### Phase 3 — Simulator and Local Interface (No Flashing)

**Deliverables:** faithful 240 × 240 preview and functional local dashboard.

- [x] Create a simulator for the two scenes with scaling that does not change the logical 240 × 240 composition.
- [x] Spotify screen: cover, title, artist, progress bar, and no-playback state.
- [x] GIF screen: upload, validation, fullscreen preview, looping, crop policy, and a clear message for unplayable GIFs.
- [x] Implement `auto`/`spotify`/`gif` modes and agent-timeout behavior in the simulator.
- [x] Implement the `localhost:8787` local interface for Spotify connection, mode, GIF, and status.
- [x] Implement GIF and cover conversion to the proposed intermediate format, with integrity and limit tests.

**Acceptance:** with the mock, starting/stopping/changing tracks changes scenes correctly; the GIF fills the frame; invalid uploads are rejected; everything works without the device; and language consistency is verified.

**Phase validation:** `npm run check` passed with contract, media, scene, mode, OAuth integration, and upload tests; the page and assets were checked through `http://localhost`. The preview is local and does not validate the physical unit.

### Phase 4 — Custom Firmware and Hardware Validation

**Required block before flashing:** confirm the chip, pinout, power, display, resolution, backlight, flash, linked layout, bootloader, original full backup, and independent Wi-Fi-only recovery procedure. The module is now visually confirmed; other critical items remain PENDING. Serial and physical programming are out of scope. If any critical item cannot be confirmed, do not flash.

**Deliverables:** compilable PlatformIO project, scenes, network, storage, implemented API, and bench tests.

**Verified hardware-independent progress:** the [native firmware notes](docs/firmware-development.md) document the host-only project, protocol coverage, memory constraints, and remaining dependencies. The native suite covers scene selection and timeout, progress correction, v1 JSON validation and responses, authentication, service interfaces, and bounded animation reads. This progress does not complete hardware validation, recovery, the binary upload routes, or Phase 4 acceptance.

**Core review (2026-10-26):** the [review report](docs/firmware-core-review.md) records fixes for metadata that stayed active under continued heartbeats and rejection of valid JSON whitespace. The expanded 31-test native suite, AddressSanitizer/UndefinedBehaviorSanitizer run, and complete repository checks passed. Host stack measurements are documented as integration constraints; target memory, hardware validation, recovery, uploads, and all board-specific work remain **PENDING**. No later phase is authorized by this review.

**ESP8266 integration authorization (2026-10-26):** the maintainer visually confirmed ESP-12F / ESP8266 and authorized local firmware integration and compilation, with Wi-Fi as the exclusive communication/update method. The [integration report](docs/esp8266-integration.md) records artifact/resource evidence. No device was contacted or modified. The default native environment is preserved. Provisional 4 MB/DIO/4m3m assumptions do not validate the installed hardware. Display activation and OTA remain disabled in the review artifact; the enabled validation environment is also compilation-only.

**Stock OTA research (2026-10-26):** the [Wi-Fi-only installation report](docs/stock-ota-installation-research.md) compares SmartClock AI and Mini-Display source/release evidence. NeonByte fits the nominal stock size guard and shares the published Mini-Display bootstrap's boot region; direct OTA is the proposed candidate, pending first-boot/provisioning changes and existing hardware, full-backup, and independent Wi-Fi-only recovery gates. Research does not authorize installation implementation or device operations; all physical acceptance tasks remain open.

**Safe first-boot preparation authorization (2026-10-26):** the maintainer authorized Phase 4 startup/provisioning/maintenance implementation, host fault injection, target compilation, and CI checks only. The [preparation report](docs/safe-first-boot.md) records the private recovery-identity design and residual limits. No device contact, installation package, release, safety-gate removal, or Phase 5 work is authorized. Hardware validation, full backup, and independent Wi-Fi-only boot recovery remain deployment blockers.

**OTA readiness review (2026-10-26):** the [readiness report](docs/ota-readiness-review.md) records the Windows manual results, remaining stock OTA gates, safe evidence sources, backup/recovery feasibility, and the original maintenance-only updater proposal. Part 4 later implemented that change offline under separate authorization. Installation remains **NO-GO**: no documented stock full-flash export or independent Wi-Fi boot recovery exists in the reviewed evidence. All physical acceptance tasks remain pending.

**Maintenance OTA implementation (2026-10-27):** Part 4 is verified offline. `npm run check` passed with 9 root tests, 1 Windows-only skip, and 54 agent tests; `npm run test:offline` passed 19 scenarios; PlatformIO native passed 61 tests, including a regression for pending automatic startup racing an upload and a shared address-backed flash/RTC model; both ESP8266 profiles compiled; the synthetic local build guard and `git diff --check` passed. The [implementation report](docs/maintenance-ota-design.md) records the maintenance-only raw staging transaction and runtime limits. No device was contacted, no private identity or installation-ready package was created, and independent recovery/full-backup gates remain blocked. Phase 5 was not started.

**Maintenance Wi-Fi Stage 2 (2026-10-27):** the maintainer authorized the offline implementation in the existing plan. Clean maintenance boot now waits for AP/HTTP and a fresh ten-second window, makes one guarded configuration-only mount/load, and may retry valid saved Wi-Fi while keeping the application paused and recovery AP active. Crash/risky or uncertain reset evidence stays AP/HTTP-only; the versioned startup guard moved to RTC word offset 32 beyond eboot's reserved 128 bytes. Storage lifecycle doubles, startup/RTC/OTA interlock tests, and host maintenance scenarios cover the behavior. The source, docs, and offline suites are recorded in the [Stage 2 plan](docs/superpowers/plans/2026-10-27-lcd-maintenance-wifi-dashboard-ota.md). Hardware radio/RTC/filesystem behavior, independent recovery, exact installation profile, and the full-backup gate remain pending; no device or OTA operation was performed, and no installation package was prepared.

**End-to-end offline validation authorization (2026-10-26):** the maintainer separately authorized a native host harness, agent communication through existing v1, playback/media/timeout/persistence validation, and mocked provisioning/maintenance failures. The [offline report](docs/offline-validation.md) records 16 integration scenarios, an existing Unicode normalization defect fixed with regressions, and the remaining initial-null playback-clearing gap. This narrowly authorizes the PC-only client and runner, not production LAN activation, physical installation, installation-ready packages, or deployment-protection changes. All hardware acceptance and later phase checklists remain pending.

**Part 5 offline continuation (2026-10-27):** host coverage now includes the real `DeviceDisplay::tick` adapter compiled against test-only panel/storage doubles for frame timing and looping, plus zero-capacity replacement followed by process restart. The fresh report records 20 offline scenarios and 63 native tests, sanitizer results, compile-only image sizes, stack reports, and the unchanged v1 initial-null fallback. `npm run check` passed with Markdown lint on 22 files, the language check, 9 root tests plus 1 Windows-only skip, TypeScript build/typecheck, and 54 agent tests; the local build guard and `git diff --check` passed. No device or LAN endpoint was accessed; all physical Phase 4/5 acceptance remains pending.

**Part 6 installation decision (2026-10-27):** [`docs/installation-go-no-go.md`](docs/installation-go-no-go.md) records **NO-GO** based on the evidence available from Parts 1–5. The installed stock version, exact board/flash/display/boot layout, matching stock verifier, preservation regions, complete restorable unit-specific backup, independent Wi-Fi-only failed-boot recovery, private recovery-identity delivery, runtime updater validation, and an identical spare remain unsupported or unknown. No Phase 4/5 hardware checklist item was completed; Part 7 was not started.

**Part 8 documentation review (2026-10-27): NOT RELEASE READY.** The readiness report reconciles desktop installation guidance, Linux keyring limitations, Node.js and CI coverage, known hardware/recovery limits, and dependency notice obligations. `npm run check`, `npm run test:offline`, and the PlatformIO native host suite passed in this review. No ESP8266 target build, device operation, installation package, release, or tag was created. Physical acceptance, Windows-only manual checks, simulator screenshots, and complete redistribution notices remain pending.

**Independent OTA compatibility investigation (2026-10-27):** the [evidence delta](docs/ota-compatibility-investigation.md) records unchanged SmartClock AI/Mini-Display commits, an external failed first-installation/serial-recovery report, non-equivalent display rotation/offsets, a 32 MHz initialization request preceding the intended 20 MHz setting, and conditional recovery-AP address selection. Host probes reproduce library behavior; firmware corrections are proposed only. Direct OTA remains the conditional simplest candidate, with all hardware, full-backup, independent Wi-Fi recovery, and installation gates unchanged. No physical task is completed or later phase authorized.

**Offline compatibility corrections (2026-10-27):** the [corrections report](docs/ota-compatibility-corrections.md) records the bounded initialization clock, checked recovery AP network, and explicitly selected maintenance-on-boot option. The default startup policy is unchanged; selected maintenance mode remains active on every reboot because a safe durable first-boot marker is not established. These software changes do not validate hardware or change the **NO-GO** decision.

**Final first-installation OTA safety audit (2026-10-27):** the maintainer authorized offline audit/corrections and stock-restoration research only, with no clock access or installation and mandatory **NO-GO**. The [audit report](docs/final-ota-safety-audit.md) records checked/retried HTTP startup, recovery-network gating and a fresh maintenance window, WPA2/SSID/password/DHCP AP readback, and cooperative raw OTA verification. All 69 native tests, 20 offline scenarios, sanitizers, repository checks, both existing compilation-only profiles, image checks and synthetic deployment guards passed. The unchanged original V1.0.6 has valid legacy checksums and fits hypothetical staging, but both modern runtime validators reject it. A separate live return-to-stock operation remains unimplemented and would not supply independent boot recovery or restore missing unit data. No private identity, installation package, or hardware evidence was created; all physical acceptance and backup/recovery gates remain open.

**Final offline technical preparation (2026-10-27):** the maintainer explicitly authorized this last planned offline cycle, including a separate authenticated live stock-restoration mechanism if feasible and a conditional physical proposal. The [preparation report](docs/final-offline-preparation.md) records the new allowlisted V1.0.6 route, strict legacy validation/actual SHA-256 readback, exact geometry, failure/RTC/preservation tests and existing compile-only profiles. Modern validators, v1 contracts and all prior deployment gates remain intact; the new stock gate defaults off. No device was accessed, no private identity/installable package/release was produced, and all hardware items remain pending. The [progressive checklist](docs/pre-installation-checklist.md) requires separate explicit operation-specific authorization and marks the first persistent flash mutation. **Installation remains NO-GO** because full unit backup/restore, independent Wi-Fi failed-boot rescue, exact hardware/verifier and spare runtime evidence remain missing.

**Display orientation correction authorization (2026-10-27):** the maintainer reported text rotated 180 degrees on the real SD PRO and authorized a local correction, offline tests and a new private build using exactly the existing recovery identity. The [correction report](docs/display-orientation-correction.md) records Adafruit rotation 2, matching BGR MADCTL `0x08` and offsets 0/0. Pinout, SPI, colors, maintenance policy, provisional layout and deployment guards are preserved. The report of the previous orientation is maintainer-supplied evidence; the corrected physical output and all other hardware/backup/recovery gates remain PENDING. This authorizes no device access, OTA, publication or later phase.

**HTTP recovery authorization (2026-10-27):** the maintainer reported HTTP timeouts and closed sockets on a physical SD PRO, approved an offline correction and private rebuild with the existing identity, and prohibited device contact and OTA. The [HTTP recovery report](docs/http-recovery-investigation.md) records the reproduced disconnected-client lifecycle defect, bounded media deadlines, authenticated diagnostics, offline validation and remaining hardware questions. The single-client architecture, OTA policy and all physical backup/recovery gates remain in force.

**Spotify/GIF display authorization (2026-10-27):** The maintainer authorized offline layout/flicker corrections, GIF-limit clarification, color investigation and a private rebuild with exactly the existing recovery credentials, while prohibiting device access and OTA. The [display report](docs/spotify-gif-display.md) describes the 176 × 176 incremental cover, unchanged fonts, two bounded lines per field, content-based redraw, storage-capacity feedback and controlled RGB565 fixtures. The maintainer identifies the current 180-degree orientation as validated; rotation 2/MADCTL 0x08 is preserved. No other hardware acceptance item or later phase is completed by this authorization. The original Phase 3 progress-bar implementation below is superseded by this explicit display request.

**LCD color Stage 1 offline execution (2026-10-27):** the reference fixtures, both software color paths, and SPI traces were checked against declared and cached library sources; the display probe rejects the stale MADCTL `0xC8` mutation. Repository checks, 20 offline scenarios, focused media tests, and 11 native display tests passed. The PlatformIO CLI was unavailable, so the complete PlatformIO native suite was not run; the focused display suite was compiled directly and also passed with ASan/UBSan. The controlled physical chart signature remains unobserved, so the source-level cause and color acceptance remain **PENDING**; MADCTL `0x08` is unchanged. No target build, firmware image, device access, OTA, or later-stage work occurred. The Phase 4 LCD initialization/color hardware checkbox below remains open.

**LCD color Stage 1 evidence-driven correction (2026-10-27):** the maintainer reported that the pre-correction `lcd-red-240.gif` showed pure/dark/medium red as blue and pure blue as red, with green, gray, white, and black correct. This confirms the plan's symmetric RGB/BGR signature. The source now sends MADCTL `0x00` instead of `0x08`; rotation 2, offsets 0/0, inversion, SPI mode/frequency and RGB565 conversion remain unchanged. The native suite passed 82/82, compatibility probes reject both old `0x08` and stale `0xC8`, the RGB565/SPI probe and image validators passed, and repository/offline checks passed. A private candidate was built with the exact existing recovery identity, which remained byte-identical and is present in the binary/ELF. Its restricted non-secret manifest is outside Git. No clock or OTA operation occurred. Post-correction visual acceptance and the Phase 4 LCD hardware checkbox remain **PENDING**.

**Spotify marquee layout revision:** the maintainer authorized an offline change to the Spotify LCD layout and Windows preview. The display keeps the 176 × 176 cover, uses a larger font with one line per field, and scrolls long title and artist values independently. Native and preview regressions cover timing, track changes, the full text tail, and text-only redraws. Rotation 2, RGB MADCTL `0x00`, scene selection, GIF playback, recovery, Wi-Fi, and OTA code are preserved. No board build, device access, or OTA was performed. Physical flicker, runtime resource margin, and HTTP/Wi-Fi responsiveness remain **PENDING**.

**Spotify smooth marquee rasterization (2026-10-29):** the maintainer authorized implementation, host tests, and both existing ESP8266 compilation profiles, without device operations. The text renderer now composes complete RGB565 scanlines from the pinned Adafruit GFX 1.11.11 font subset in `PROGMEM`, sends at most two lines per cooperative display tick through the existing 480-byte pixel buffer, and steps one physical pixel at a 40 ms minimum interval. Title/artist timing remains independent; artwork keeps priority and the GIF renderer is unchanged. Native tests, the pixel oracle against upstream `drawChar()`, preview regressions, sanitizers, and both compilation profiles passed. Physical cadence, tearing, heap/stack margin, cover transfer behavior, and HTTP/Wi-Fi responsiveness remain **PENDING**.

**Daily-startup and Spotify correction authorization (2026-10-28):** the maintainer requested offline synchronization fixes, automatic private-profile power-on startup, safe Windows OTA compatibility, regression tests and local resource checks, with no device operations or commit. The [report](docs/daily-startup-and-sync.md) records false-pause prevention with bounded metadata expiry, integration-wide asynchronous artwork preparation, serial bounded cover uploads and immediate freshness updates. Only clean power-on may start automatically after the existing protected ten-second window; software/external resets remain maintenance paths and crash/RTC guards are preserved. Legacy manifests remain valid; automatic candidates require an explicit maintenance-after-software-restart gate. OTA verification still requires paused, authenticated stable observations and binds subsequent explicit startup to the verified boot. Native tests passed 101/101 normally and with ASan/UBSan; offline integration passed 25/25 with sanitizers, the existing compilation profiles and private automatic candidate compiled, image/probe/deployment checks passed, and the existing private recovery identity is unchanged. No inbox-ready manifest was issued because device binding and approved live-resource floors remain unsupported. Physical power-on, Wi-Fi/SPI timing, runtime memory, OTA/RTC behavior, backup/recovery and production acceptance remain **PENDING/BLOCKED**. No hardware phase is completed by this correction.

- [x] Connect the desktop agent components to the existing native firmware core through loopback HTTP v1 without a board build.
- [x] Verify offline playback/artwork/progress, scene switching, expiry, simulated storage/restarts, and mocked provisioning/maintenance failures.
- [x] Run native and agent regressions, sanitizer checks, repository validation, and synthetic deployment-guard checks; document defects and remaining hardware gaps.

- [x] Start authenticated recovery networking before filesystem/configuration/display dependencies; verify with native fault injection.
- [x] Add explicit confirmed/temporary provisioning, guarded application maintenance, and private secret-delivery requirements without changing API v1 contracts.
- [x] Add native firmware tests and both compilation-only ESP8266 profiles to CI; validate locally and document remaining deployment risks.
- [x] Implement the authenticated maintenance-only raw sketch staging transaction with checked readback and native failure injection; compile it in the existing non-installable integration-check profile. Keep installation NO-GO and independent recovery/full-backup gates blocked.

- [x] Create a C++17 PlatformIO native test environment without selecting a device board.
- [x] Implement host-tested scene modes, Spotify progress correction, and heartbeat fallback.
- [x] Implement transport-independent validation and handling for the v1 JSON status, mode, Spotify, and heartbeat routes.
- [x] Define display, storage, clock, authentication, and network interfaces with native mocks.
- [x] Stream the existing version 1 RGB565 animation format from storage in caller-sized chunks.
- [x] Document host memory costs, resource limits, protocol compatibility, and remaining hardware dependencies.
- [x] Host-test `DeviceDisplay::tick` frame delays, row streaming, frame order, looping, and slow-render behavior with a fake panel and in-memory storage.
- [x] Host-test zero-capacity animation replacement and verify the installed asset and mode survive a process restart.
- [x] Investigate and reduce last-to-first NBIF v2 playback overhead offline: coalesce bounded frame-zero row-header reads, remove one idle restart tick, and verify repeated 14/20/48/60-frame seams and the supplied 48-frame GIF. See the [loop transition report](docs/gif-loop-transition.md); physical pause elimination and runtime resource acceptance remain pending.
- [x] Complete the separately authorized safe memory/loop review on the existing integration branch: account for the 524-byte increase, recover 480 bytes of static RAM while preserving full marquee behavior, add separately authenticated stage maxima without changing the deployed diagnostics response, and verify native/offline/sanitizer/target/private builds. See the [review report](docs/safe-memory-and-loop-review.md). Candidate live heap/largest-block floors, physical timing and stability remain pending; no device operation or later phase is authorized.

**Optimized firmware finalization authorization (2026-10-29):** the maintainer authorized final workspace/route review, necessary regressions/corrections, an integration-branch-only commit and a new private package with the retained Build ID. The [finalization notes](docs/optimized-firmware-finalization.md) document serial workspace lifetimes, partial-cover/decoder transitions, the reproduced and corrected entry-time read-failure retry, expanded HTTP admission coverage and exact-commit package binding. Main/merge/push, device contact, Windows copy and installation remain unauthorized. Complete unit backup/restore, independent failed-boot Wi-Fi recovery and candidate physical resource/stability acceptance remain blocked or pending.

- [x] Add pinned, locally compilable ESP8266 profiles while retaining native tests and blocking PlatformIO device-operation targets.
- [x] Bind the core to the ESP8266 clock, cooperative Wi-Fi retry/protected provisioning, and bounded HTTP v1 implementation; validate compilation and portable logic.
- [x] Implement candidate/readback/atomic replacement for configuration and mode, staged SHA-256 media uploads, track-bound covers, and row-streamed playback; verify portable failure cases.
- [x] Implement compile-gated device-hosted firmware OTA with exact size, SHA-256, image checks, and staging bounds; compile the enabled code without deploying it.
- [x] Evaluate local binary size, static RAM, stack frames, filesystem geometry, stock image format, and the nominal 512 KiB stock guard; document unverified physical behavior.

- [x] Verify the 176 × 176 Spotify layout, larger one-line metadata, pixel-exact one-pixel marquee composition, independent timing, cover priority, and installed-GIF fallback through native, preview, and pinned-font regressions.
- [x] Clarify original GIF versus converted RGB565 limits and verify actionable insufficient-staging-space feedback without interrupting heartbeats.
- [x] Verify software color packing and SPI byte order, prepare controlled color fixtures, preserve rotation/colors/HTTP/recovery, and produce the authorized private rebuild with unchanged existing credentials; physical color validation remains pending.

- [ ] Document verified hardware and prepare a testable backup/restore procedure.
- [ ] Configure the board, framework, flags, and partition scheme based on evidence.
- [ ] Initialize the LCD, orientation, colors, and backlight with a minimal visual test.
- [ ] Configure Wi-Fi recoverably, without hardcoded credentials.
- [ ] Implement the local HTTP API and authentication/pairing.
- [ ] Draw the Spotify scene and render received images incrementally within RAM limits.
- [ ] Read and animate optimized frames from storage with limited memory, timing, and looping.
- [ ] Persist the mode and asset, validate checksums, and recover the last valid asset after an interrupted upload.
- [ ] Implement a watchdog/GIF fallback when the agent is lost; ensure Wi-Fi failures do not block rendering.
- [ ] Measure actual RAM, free space, and FPS; adjust codec, limits, and documentation.

**Acceptance:** reproducible build; flashing only with authorization; recoverable device; GIF runs on its own and the interface responds without observable stalls during extended tests; and language consistency is verified.

### Phase 5 — End-to-End Integration

**Deliverables:** agent ↔ SD PRO connection over LAN with synchronized scenes.

**Software-only integration progress:** the agent can opt in to scheduled v1
playback and heartbeat synchronization with a configured address and pairing
credential. Configuration is stored in the operating system credential manager,
and the native host harness covers restart, reconnect, address changes, and
shutdown. The broader tasks below remain open until their remaining software and
physical acceptance criteria are verified.

- [x] Integrate the scheduler, v1 client, and synchronizer into the desktop lifecycle.
- [x] Configure the address in the local dashboard, keep new pairing secrets in foreground CLI entry, and leave device connectivity disabled until explicitly enabled.
- [x] Store device settings and credentials in the system credential manager and exclude the token from dashboard responses and logs.
- [x] Test configuration, startup restoration, reconnect, address changes, and shutdown using the native host harness and local tests.
- [x] Synchronize dashboard modes, decoded Spotify artwork, and validated GIFs with the native host using protocol v1.
- [x] Report GIF transfer stages and attempts, retry failed replacements, and suppress duplicate successful uploads in the same session.
- [x] Reject public, hostname, and link-local device destinations before transmitting a pairing token.

- [x] Implement and test the agent HTTP client for v1 against the loopback native host.
- [x] Exercise host-side address/token configuration and address changes through the local native harness.
- [ ] Pair an actual clock and validate DHCP/IP changes after clock restart.
- [x] Test cover caching, metadata-before-cover ordering, cover-before-metadata behavior, and track-bound artwork against the native core.
- [x] Test current animation stage/attempt reporting, safe retries, and firmware-side validation in the native host; byte-level progress and physical transfers remain pending.
- [x] Test heartbeat, simulated disconnect/reconnect, timeout, and agent/native-process restart behavior offline.
- [x] Test manual modes, track changes, pause/resume, and end-of-session behavior against the native core.
- [x] Simulate transport outages, host-process restarts, and unavailable Spotify in the offline harness.
- [ ] Validate RF instability, PC suspend/resume, actual clock restart, and large GIF transfer behavior on hardware.

**Acceptance:** stable automatic switching; no manual intervention after network loss/return; GIF persists; Spotify does not affect the GIF while manual mode is active; and language consistency is verified.

**Independent dashboard OTA Stage 3 (2026-10-27):** the maintainer separately authorized the offline source/test/documentation work in [the LCD maintenance/Wi-Fi/dashboard OTA plan](docs/superpowers/plans/2026-10-27-lcd-maintenance-wifi-dashboard-ota.md). That implementation is recorded there and documented in [the Windows OTA procedure](docs/windows-dashboard-ota.md). The offline closeout below supersedes that initial record's statements about private compilation and Windows-native ACL testing. This does not complete Phase 5 hardware integration or change Phase 4 installation/recovery gates.

**Stage 2/3 offline closeout (2026-10-27):** the panel accepts an already paused application, rechecks identity and maintenance readiness after scheduler drain, pauses only an active app, and sends at most one firmware PUT per approval. Safe preflight aborts release the scheduler only when fresh status confirms the app is still active. Reboot verification remains read-only, restart recovery never replays firmware, and `/maintenance/v1/run` remains explicit. The Windows ACL command parser defect is corrected and covered with restricted/broadened temporary ACLs. A private target image compiled with the unchanged WSL2 recovery identity and a unique build ID; the Windows procedure records why it has no inbox-ready manifest. Local Windows native tests and all offline/project/firmware validations are recorded in the [Stage 2/3 plan closeout](docs/superpowers/plans/2026-10-27-lcd-maintenance-wifi-dashboard-ota.md). No device, clock endpoint, or OTA was accessed. Exact flash/hardware compatibility, actual AP+STA and RTC/eboot behavior, full backup, independent Wi-Fi recovery, live resource floors, and physical display/stability checks remain pending or blocked. Remote GitHub Actions still reflects the prior committed checkout until the maintainer commits/pushes these changes; no commit was made.

**Targeted GIF upload repair (2026-10-29):** the maintainer explicitly authorized agent correction, preserving the prepared NBIF, restarting only the Windows agent, read-only clock checks and one controlled physical replacement. The [repair evidence](docs/gif-upload-runtime-repair.md) identifies a stale live Windows module despite a corrected artifact on disk, and a stale legacy address distinct from the answering authenticated effective address. The exact 53,489-byte prepared file was exported and restored without reconversion through a validated loopback-only API. After agent restart, one panel replacement reached firmware session `00fbd49d` state `installed`, with all 53,489 bytes received and no validation error. Source, Windows HTTP/upload/web, offline, native and sanitizer checks passed. Credentials, `.env`, safety limits and firmware were preserved; no OTA, device restart, manual flash deletion, commit or push was performed. The maintainer separately confirmed that this GIF is animating on the physical screen. This confirms this upload and immediate playback only; reboot persistence, endurance, recovery and broader Phase 4/5 acceptance remain pending.

### Phase 6 — Automatic Startup, Distribution, and Quality

**Deliverables:** opt-in Windows-native startup instructions, optional WSL2 configuration, and a future release version.

**Windows priority:** the maintainer uses Windows-native Node.js for the agent and Ubuntu WSL2 for development. The Windows launcher was exercised with Windows PowerShell 5.1 and Node 22.4, and an isolated synthetic Windows credential was recovered by a second process. Automatic startup, hidden execution, and Spotify reconnection after restart are now maintainer-verified below. Safe shutdown, failure logging, startup removal, and separately exercised OAuth failure cases remain pending. WSL2 startup and Fedora configuration are optional references; Linux keyring persistence remains unverified.

**Desktop preparation (2026-10-26):** opt-in Windows Task Scheduler scripts, a Fedora user-service template, local logging instructions, and a loopback instance guard are implemented. No startup settings were changed by the coding agent during development. The maintainer's later Windows manual results are recorded below; Fedora login/keyring, shutdown, and restart validation remain pending. The CI workflow now includes an isolated Windows launcher process test; it does not register or change a scheduled task. Physical Phase 4/5 validation and deployment protections remain unchanged.

**Manual Windows validation recorded on 2026-10-26:** the maintainer reported successful Windows 11 automatic startup, hidden execution without a persistent terminal window, and Spotify reconnection after restart. This is maintainer-supplied real-machine evidence, not a test rerun by the coding agent. The report does not separately identify an agent-only restart, forced token expiration, shutdown cleanup, log inspection, or startup removal; those broader checks remain open. No credentials or logs were supplied or recorded. These desktop results do not validate clock installation, LAN integration, or recovery.

- [x] Add and test an OS-released single-instance guard and safe generic startup errors.
- [x] Prepare opt-in Windows and Fedora startup configurations and document their installation, removal, logs, and troubleshooting.

- [x] Windows 11: validate automatic agent startup at **login** and hidden execution without a persistent terminal window (maintainer report).
- [x] Validate real Spotify reconnection after the reported Windows restart (maintainer report).
- [ ] Validate safe shutdown, accessible failure logs, startup removal, and a separate agent-only restart with real Spotify credentials; follow the [pending manual Windows checklist](docs/installation.md#pending-manual-windows-acceptance). Installation/removal and logging instructions are documented.
- [ ] Prevent multiple concurrent instances, log errors without exposing tokens, and shut down cleanly.
- [x] Document a reproducible Windows installation on the Node.js 22/24 major lines exercised by CI, including dependencies, configuration, credential storage, and optional startup removal.
- [x] Reconcile `README.md`, desktop installation guidance, recovery status, and known limitations with the Part 6 **NO-GO** decision.
- [ ] Add simulator screenshots; none are currently tracked, and no physical screenshot is available as hardware evidence.
- [x] Add CI workflows for lint, build, tests, and compilation-only firmware validation.
- [ ] Select and prepare version `0.1.0` after the remaining quality and acceptance checks.

**Acceptance:** restarting the PC and logging in starts the agent automatically; Spotify reconnects when possible; failures are visible; the uninstall procedure works; and language consistency is verified.

## 8. Test Plan

### Minimum Automated Tests

- Agent: Spotify states, refresh token, `204`/`401`/`429`, retry, timeout, change deduplication, and cover cache.
- Media: invalid GIF, wrong dimensions, oversized file, missing frames, checksum, and frame timing.
- Protocol: invalid payload, unknown mode, wrong token, interrupted connection, incomplete uploads, and incompatible version.
- Simulator: `auto ↔ spotify ↔ gif` changes, 240 × 240 UI, and no redraw from progress updates.

### Manual Tests on Real Hardware

- Display starts and renders colors/orientation correctly.
- A 240 × 240 GIF loops and survives reboot.
- Spotify updates track/cover without excessive flicker.
- PC sleeps/shuts down; the clock returns to GIF if it remains powered.
- Wi-Fi disconnects/returns; the agent reconnects automatically.
- Restarting the device during transfer does not permanently corrupt configuration or the previous asset.
- Run continuously for 1–2 hours without an unexpected reset (increase duration for release testing).

## 9. General Quality Criteria

- Firmware must not contain Spotify credentials.
- All mutating endpoints require local authentication, except for any documented pairing flow.
- The agent UI is not exposed on external network interfaces by default.
- The repository contains no tokens, `client_secret`, Wi-Fi passwords, or real `.env` files.
- External dependencies have licenses compatible with MIT or documented obligations.
- Do not add a database, container, cloud service, multi-user authentication, or unrequested features.
- Keep code testable, builds reproducible, and recovery documentation available.

### Project Language Policy

English (en-US) is mandatory throughout the NeonByte project, including all current and future phases. This policy covers source code, identifiers, filenames and directories, comments, documentation, tests, configuration, logs, error messages, and UI text. Language consistency is a required acceptance criterion for every development phase.

## 10. MVP Definition of Done

- [ ] During first startup, the user can configure Wi-Fi, pair the clock, and connect Spotify.
- [ ] Active Spotify playback shows the larger cover, artist and track without a progress bar or playback times.
- [ ] Paused/no playback or an unavailable agent shows the GIF in `auto` mode.
- [ ] A custom GIF fills 240 × 240 and loops when the PC is off (while the clock remains powered).
- [ ] The `auto`, `spotify`, and `gif` modes can be selected and persist.
- [x] The agent starts natively at Windows login and reconnects to Spotify after restart (maintainer manual validation recorded on 2026-10-26).
- [ ] Installation, troubleshooting, backup, and recovery documentation is complete.
- [ ] No credentials appear in logs or version control; automated tests and hardware tests are approved.

## 11. Instructions for GitHub Copilot (Agent Mode)

1. Read this entire document, `AGENTS.md`, and the existing files before changing code.
2. Execute only the phase explicitly authorized. Do not advance to future phases.
3. Before implementation, present a phase summary, affected files, risks, and test plan.
4. Do not invent library behavior, endpoints, pinouts, or memory limits; confirm them in documentation, code, or on hardware.
5. Prefer a small, functional solution with corresponding tests.
6. At the end of each phase, run relevant tests/lint/build, document results, and note pending items.
7. Update this file's checklist **only for items actually completed and verified**.
8. Do not flash, run OTA, erase, change partitions, or perform destructive operations without explicit maintainer authorization.
9. Stop after completing the phase and request approval before continuing.

**Instruction to the coding agent:**

> Read all of `PLANNING.md` and execute only the phase explicitly authorized by the maintainer. Phases 1, 2, and 3 are complete; Windows automatic startup, hidden execution, and real Spotify reconnection after restart are maintainer-verified, with remaining manual checks listed in Phase 6. Phase 4 local ESP8266 integration is authorized and compile-validated with provisional assumptions. Safe Wi-Fi-only first installation and independent boot recovery are BLOCKED. Preserve all physical validation tasks as pending. Do not contact, upload to, or modify the device, and do not begin Phase 5 without separate authorization.

## 12. Decision Log

| Decision | Initial choice | Revisit when |
|---|---|---|
| Name | NeonByte | — |
| License | MIT | Before publishing third-party dependencies/artwork |
| Agent | Node.js + TypeScript | If requirements change |
| Firmware | C++ + PlatformIO | After the actual chip is validated |
| Communication | Local HTTP + token | If the threat model requires encryption |
| Modes | `auto`, `spotify`, `gif` | After MVP |
| Spotify polling | 15 seconds, adjustable | After measuring limits and latency |
| Offline GIF | Persistent asset on the device | After measuring flash and performance |
| Agent startup | At user login | If operation without login is required |
| Configuration interface | `localhost:8787` | Port conflict or security need |

---

**Note:** this plan guides implementation; technical decisions that depend on hardware and current Spotify API rules require confirmation during their corresponding phases. The clock's original web interface alone does not prove compatibility with any specific firmware.
