# NeonByte — Implementation Plan

> **Status:** Phases 1, 2, and 3 are complete; OAuth validation with a real account is pending Spotify credentials. Phase 4 includes locally compiled ESP8266 adapters and host-validated safe first-boot preparation authorized on 2026-10-26; display/flash/boot validation and Wi-Fi-only installation/recovery remain pending · **Intended license:** MIT · **Target device:** JUZIPi SD PRO (ESP-12F / ESP8266 visually confirmed; remaining hardware identification pending)
>
> **Primary rule:** implement phases sequentially; do not flash firmware until the hardware is validated and recovery is documented.

## 1. Objective and Scope

Build **NeonByte**, an open-source project consisting of custom firmware for a small Wi-Fi display and a desktop agent that reads Spotify. The device presents **exactly two screens**:

1. **Spotify Now Playing:** album cover, title, artist, and track progress.
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

The agent starts automatically **when the user logs in** (Windows 11 and Fedora), without requiring an open terminal. It does not need to start before login. Local connectivity and Spotify can fail temporarily; the system must recover without intervention.

### Responsibilities

| Component | Responsibilities | Must not do |
|---|---|---|
| Agent | OAuth, Spotify, polling, caching, media conversion, configuration UI, sending updates | Store secrets in firmware; require a container or database |
| Firmware | Display scenes, update progress locally, play GIFs, persist assets, and respond to commands | Call Spotify directly; depend on the Internet for GIF playback |
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

- Display the cover at the correct aspect ratio, title, artist, controlled truncation/scrolling, and a progress bar.
- Progress advances in firmware between syncs and is corrected when a new playback timestamp arrives.
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

**Acceptance:** OAuth and refresh flows are covered by mock-based tests; real-account authentication remains pending until a Spotify account is configured; the mock reproduces play/pause/track changes; tests pass; secrets are not sent to the logger; and language consistency is verified.

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

**Safe first-boot preparation authorization (2026-10-26):** the maintainer authorized Phase 4 startup/provisioning/maintenance implementation, host fault injection, target compilation, and CI checks only. The [preparation report](docs/safe-first-boot.md) records the private recovery-identity design and residual limits. No device contact, installation package, release, safety-gate removal, or Phase 5 work is authorized. Hardware, full backup, independent Wi-Fi-only boot recovery, and filesystem-independent verified maintenance updates remain deployment blockers.

**End-to-end offline validation authorization (2026-10-26):** the maintainer separately authorized a native host harness, agent communication through existing v1, playback/media/timeout/persistence validation, and mocked provisioning/maintenance failures. The [offline report](docs/offline-validation.md) records 16 integration scenarios, an existing Unicode normalization defect fixed with regressions, and the remaining initial-null playback-clearing gap. This narrowly authorizes the PC-only client and runner, not production LAN activation, physical installation, installation-ready packages, or deployment-protection changes. All hardware acceptance and later phase checklists remain pending.

- [x] Connect the desktop agent components to the existing native firmware core through loopback HTTP v1 without a board build.
- [x] Verify offline playback/artwork/progress, scene switching, expiry, simulated storage/restarts, and mocked provisioning/maintenance failures.
- [x] Run native and agent regressions, sanitizer checks, repository validation, and synthetic deployment-guard checks; document defects and remaining hardware gaps.

- [x] Start authenticated recovery networking before filesystem/configuration/display dependencies; verify with native fault injection.
- [x] Add explicit confirmed/temporary provisioning, guarded application maintenance, and private secret-delivery requirements without changing API v1 contracts.
- [x] Add native firmware tests and both compilation-only ESP8266 profiles to CI; validate locally and document remaining deployment risks.

- [x] Create a C++17 PlatformIO native test environment without selecting a device board.
- [x] Implement host-tested scene modes, Spotify progress correction, and heartbeat fallback.
- [x] Implement transport-independent validation and handling for the v1 JSON status, mode, Spotify, and heartbeat routes.
- [x] Define display, storage, clock, authentication, and network interfaces with native mocks.
- [x] Stream the existing version 1 RGB565 animation format from storage in caller-sized chunks.
- [x] Document host memory costs, resource limits, protocol compatibility, and remaining hardware dependencies.

- [x] Add pinned, locally compilable ESP8266 profiles while retaining native tests and blocking PlatformIO device-operation targets.
- [x] Bind the core to the ESP8266 clock, cooperative Wi-Fi retry/protected provisioning, and bounded HTTP v1 implementation; validate compilation and portable logic.
- [x] Implement candidate/readback/atomic replacement for configuration and mode, staged SHA-256 media uploads, track-bound covers, and row-streamed playback; verify portable failure cases.
- [x] Implement compile-gated device-hosted firmware OTA with exact size, SHA-256, image checks, and staging bounds; compile the enabled code without deploying it.
- [x] Evaluate local binary size, static RAM, stack frames, filesystem geometry, stock image format, and the nominal 512 KiB stock guard; document unverified physical behavior.

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
- [x] Configure the address and pairing credential in the local dashboard, with device connectivity disabled until explicitly enabled.
- [x] Store device settings and credentials in the system credential manager and exclude the token from dashboard responses and logs.
- [x] Test configuration, startup restoration, reconnect, address changes, and shutdown using the native host harness and local tests.
- [x] Synchronize dashboard modes, decoded Spotify artwork, and validated GIFs with the native host using protocol v1.
- [x] Report GIF transfer stages and attempts, retry failed replacements, and suppress duplicate successful uploads in the same session.
- [x] Reject public, hostname, and link-local device destinations before transmitting a pairing token.

- [ ] Implement the agent HTTP client for v1 endpoints.
- [ ] Pair and configure the device IP/hostname; handle IP changes.
- [ ] Send the cover only when needed; ensure metadata and image ordering/consistency.
- [ ] Implement animation upload with progress, safe retries, and device-side verification.
- [ ] Implement heartbeat, disconnect, reconnect, timeout, and synchronization after reboot.
- [ ] Test manual modes, track changes, pause/resume, and end of session.
- [ ] Test unstable Wi-Fi, suspended PC, restarted device, unavailable Internet, and large GIFs.

**Acceptance:** stable automatic switching; no manual intervention after network loss/return; GIF persists; Spotify does not affect the GIF while manual mode is active; and language consistency is verified.

### Phase 6 — Automatic Startup, Distribution, and Quality

**Deliverables:** installers/startup scripts, Windows/Fedora instructions, and a release version.

**Desktop preparation (2026-10-26):** opt-in Windows Task Scheduler scripts, a Fedora user-service template, local logging instructions, and a loopback instance guard are implemented. Actual Windows and Fedora login, credential-manager, shutdown, and restart validation remain pending; no startup settings were changed during development. Physical Phase 4/5 validation and deployment protections remain unchanged.

- [x] Add and test an OS-released single-instance guard and safe generic startup errors.
- [x] Prepare opt-in Windows and Fedora startup configurations and document their installation, removal, logs, and troubleshooting.

- [ ] Windows 11: register a Task Scheduler task to start the agent at **login**; provide accessible logs without a persistent terminal window and document installation/removal.
- [ ] Fedora: create a `systemd --user` service that starts at login, restarts on failure, and has documented enable/disable commands.
- [ ] Prevent multiple concurrent instances, log errors without exposing tokens, and shut down cleanly.
- [ ] Package the agent or document a reproducible installation (supported Node LTS, dependencies, and configuration).
- [ ] Complete `README.md`, `docs/installation.md`, `docs/recovery.md`, simulator screenshots, and known limitations.
- [ ] Add a CI workflow (lint, build, tests) and version `0.1.0` after the final checklist.

**Acceptance:** restarting the PC and logging in starts the agent automatically; Spotify reconnects when possible; failures are visible; the uninstall procedure works; and language consistency is verified.

## 8. Test Plan

### Minimum Automated Tests

- Agent: Spotify states, refresh token, `204`/`401`/`429`, retry, timeout, change deduplication, and cover cache.
- Media: invalid GIF, wrong dimensions, oversized file, missing frames, checksum, and frame timing.
- Protocol: invalid payload, unknown mode, wrong token, interrupted connection, incomplete uploads, and incompatible version.
- Simulator: `auto ↔ spotify ↔ gif` changes, 240 × 240 UI, and progress updates.

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
- [ ] Active Spotify playback shows the cover, artist, track, and progress.
- [ ] Paused/no playback or an unavailable agent shows the GIF in `auto` mode.
- [ ] A custom GIF fills 240 × 240 and loops when the PC is off (while the clock remains powered).
- [ ] The `auto`, `spotify`, and `gif` modes can be selected and persist.
- [ ] The agent starts at login on Windows 11 and Fedora.
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

> Read all of `PLANNING.md` and execute only the phase explicitly authorized by the maintainer. Phases 1, 2, and 3 are complete; real-account OAuth validation still depends on Spotify credentials. Phase 4 local ESP8266 integration is authorized and compile-validated with provisional assumptions. Safe Wi-Fi-only first installation and independent boot recovery are BLOCKED. Preserve all physical validation tasks as pending. Do not contact, upload to, or modify the device, and do not begin Phase 5 without separate authorization.

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
