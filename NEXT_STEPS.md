# NeonByte — Remaining Work Execution Plan

**Status:** Execution plan for outstanding work, based on `PLANNING.md`, `AGENTS.md`, and the readiness reports as of 2026-10-26. This document does not override the existing deployment restrictions. It is not evidence of device compatibility or permission to flash.

## How to Execute This Plan

When the maintainer says **"execute a parte N do plano"**, **"execute part N of the plan"**, or an equivalent instruction, execute **only `Part N` in this document**, not `Phase N` in `PLANNING.md`. The maintainer's instruction authorizes the specified **local/offline work only**. Never infer approval for device contact, firmware installation, changing Windows configuration, publishing a release, or changing an existing safety gate.

For each requested part:

1. Read `AGENTS.md`, `PLANNING.md`, the complete current part, its prerequisites, and the linked technical documents. Examine actual files before changing them. Treat this plan as a work order, not as proof that code or hardware behaves as intended.
2. Check the current working tree and existing implementation. Preserve unrelated work; never reset, clean, overwrite, or revert user changes. Do not repeat work already verified. If a prerequisite is missing, document it and stop the dependent work.
3. Execute the explicitly permitted work autonomously, with minimal changes, tests, and documentation. Do not ask the maintainer about decisions already settled in the repository. If a user-only fact or a prohibited action is needed, mark it `BLOCKED — requires maintainer evidence/authorization` rather than guessing.
4. Keep code, comments, filenames, logs, UI, and repository documentation in American English; use Portuguese only when replying to the maintainer. Keep `contracts/v1/` and `docs/protocol.md` synchronized if an authorized change truly requires touching the contract. Avoid changes to the v1 contract unless expressly approved.
5. Run `npm run check` and `git diff --check` for every part with local source changes. Run the part-specific tests below where dependencies are available. Fix failures caused by your changes; if an external prerequisite prevents a test, report its exact cause and mark it `NOT RUN`, never `PASS`.
6. End with a short report in Portuguese: **Part / Outcome (PASS, PARTIAL, BLOCKED, or FAIL) / Changed files / Commands and results / Verified evidence / Remaining blockers / Next eligible part**. Mark a checklist item complete only when its acceptance evidence exists. Do not silently proceed to another part.
7. Do not commit, push, create releases, install scheduled tasks, alter secrets, or contact the physical clock unless the maintainer separately requests the relevant action. Never commit a real `.env`, tokens, passwords, private recovery identity, or a private firmware binary.

**Absolute device boundary:** No connection to the SD PRO (even for a supposedly read-only endpoint), discovery, port scan, reset, Wi-Fi configuration, OTA attempt, upload, erase, flash, firmware package for installation, or stock modification is authorized by invoking a part. Physical programming, UART, soldering, and USB-serial are out of scope. Keep **Enable device connection** disabled until separately authorized after all installation gates are satisfied.

### Current Verified Baseline

- Windows 11 native agent, dashboard, real Spotify connection/reconnection after restart, login startup without a visible terminal: **maintainer-reported success**. Additional shutdown, agent-only restart, failure logs, and uninstall checks remain unverified.
- Native firmware, guarded ESP8266 compilation profiles, secure-first-boot preparation, and offline agent/firmware integration: **software-tested only**; not tested on the actual display, flash, or Wi-Fi radio.
- Manufacturer [`JUZIPi-tech/SD_PRO`](https://github.com/JUZIPi-tech/SD_PRO) publicly contains V1.0.4 and V1.0.6 binaries. V1.0.6 was statically analyzed; the actual installed version remains **unknown**. The stock HTML already supplied to the maintainer does not display a firmware version; do not infer that the installed version is V1.0.6.
- **Installation remains NO-GO.** There is no verified unit-specific complete stock flash backup/restore or an independent Wi-Fi-only recovery mechanism when the application cannot boot.

## Part 1 — Establish Hardware and Stock Recovery Evidence

**Purpose:** Try to resolve the true blockers from evidence instead of assuming that a published firmware image matches this unit.

**Read:** `docs/hardware.md`, `docs/stock-firmware-analysis.md`, `docs/stock-ota-installation-research.md`, `docs/ota-readiness-review.md`, `docs/recovery.md` and the pinned vendor/research sources already referenced there.

**Work:**

1. Audit existing evidence and provenance. Record separately: **verified on this unit**, **documented for its exact revision**, **inferred from another SD PRO**, and **unknown**. Avoid duplicating the already completed V1.0.6 reverse engineering.
2. Review only public repositories, public vendor documentation, and files already in the project; look for exact PCB revision, flash chip/capacity, voltage, display controller, SPI/CS/backlight/reset pins, boot mode, installed firmware identification, stock OTA validation, filesystem and configuration handling.
3. Investigate documentary evidence for a **complete, unit-specific, nonmutating flash export over stock Wi-Fi**, its full-region restoration, and **an independent Wi-Fi recovery service that works when the installed application fails to boot**. Distinguish a stock updater, a new application maintenance AP, and a true independent rescue path.
4. Create/update `docs/device-evidence-matrix.md` with source URLs/commits, confidence, missing data, and precise blocking conditions. Draft a concise English vendor inquiry requesting a schematic/BOM, version-identification method, full backup/restore, and independent failed-boot recovery. **Draft only; do not send it.**
5. Summarize user-supplied evidence required later (for example, existing PCB labels/photographs and the installed version if shown on an ordinary existing screen); do not require physical probing or a live network call in this part.

**Acceptance:** clear evidence matrix and source references; explicit `UNKNOWN` values where unverified; vendor inquiry draft; unchanged NO-GO unless all independent gates have documented qualifying evidence. `npm run check` and `git diff --check`.

**Stop boundary:** Do not contact local clock IPs, assume read-only GET operations are side-effect free, install temporary dumping firmware, create a flashing file, or claim a manufacturer update file is a complete backup.

## Part 2 — Complete Desktop Quality and Status Accuracy

**Purpose:** Finish tasks that can be completed safely on the PC while preserving the verified Windows startup behavior.

**Read:** `PLANNING.md` Phase 6, `README.md`, `docs/installation.md`, `agent/startup/`, `agent/tests/`, `package.json`, and existing CI workflows.

**Work:**

1. Reconcile stale desktop/OAuth/startup statements in `README.md`, `docs/installation.md`, and `PLANNING.md` with the reported Windows 11 tests. Preserve the distinction between maintainer-reported live tests and automated synthetic tests. Do not declare forced OAuth expiry/revocation, clean shutdown, uninstall, or failure logging verified unless independently evidenced.
2. Audit the existing Windows scheduled-task / WScript / PowerShell launch chain for path quoting, detached/orphaned processes, duplicate-instance behavior, stop/restart behavior, logging, and secrets. Add or improve safe automated regression tests using mocks or child processes. Do not register, stop, or modify the real Windows scheduled task.
3. Check the local agent's reproducible Windows installation procedure, supported Node version, first-run behavior, `.env.example`, credential-manager assumptions, and the documented uninstall procedure. Fix confirmed defects only, without adding unnecessary dependencies or a new installer.
4. Produce a short **manual Windows acceptance checklist** for the maintainer: isolated agent-only restart with real Spotify credentials, safe stop, log inspection without sharing secrets, duplicate-start handling, and optional startup removal/restoration. These require explicit manual execution and must remain unchecked until reported.

**Acceptance:** `npm run check`; relevant tests; consistent status/docs; Windows startup code preserves invisible operation and secure credentials; manual-only tasks explicitly labeled pending. **Do not claim final Phase 6 acceptance without its manual checks.**

**Stop boundary:** No automatic Windows system configuration changes, no real credential access, no physical device contact, no release.

## Part 3 — Design a Filesystem-Independent Maintenance OTA Transaction

**Purpose:** Produce a reviewable offline design for firmware maintenance when LittleFS is unavailable. **Design and tests specification only; no firmware implementation in this part.**

**Prerequisite:** Read Part 1's evidence matrix (it may still report NO-GO for installation).

**Read:** `docs/ota-readiness-review.md` (maintenance updater section), `docs/safe-first-boot.md`, `docs/recovery.md`, `firmware/src/esp8266/http_server.cpp`, `firmware/src/esp8266/storage.cpp`, existing `TransferSink`/`ImageSource` interfaces, and pinned Arduino ESP8266 3.1.2 updater source.

**Work:**

1. Compare current LittleFS-file staging to direct use of the existing raw sketch OTA staging area. Establish actual buffering, erase/program alignment, updater lifetime, image-readback semantics, pre-activation verification hooks, and the difference between `Update.end(false)` and abort.
2. Document a transaction state machine where **no boot-copy command or restart can be scheduled until the candidate is fully received and independently read back and verified**. Include image boundaries, exact length, expected SHA-256, E9 segments, CRC, flash mode, declared/physical size consistency, reserved regions, free-staging geometry, and secrets-preservation assumptions.
3. Specify tests with injected backends for missing/corrupt/full LittleFS, bad auth, disabled OTA, wrong framing, extra/missing bytes, CRC/hash mismatch, interrupted transmission, flash write/read errors, insufficient space, boundary overlap, and complete-but-invalid images. Prove failures cannot activate the candidate; no LittleFS access on the new maintenance route.
4. Create `docs/maintenance-ota-design.md` with a minimal file-by-file implementation plan and unresolved assumptions; keep the existing protocol v1 unchanged and all build/deployment safety guards active.

**Acceptance:** a security-oriented design that can be reviewed before coding; a concrete validation matrix and immutable safety boundaries; `npm run check` and `git diff --check`. **State explicitly that this does not solve independent failed-boot recovery.**

**Stop boundary:** Do not implement or enable the raw updater, generate a private identity or installation image, change bootloader/layout, or interact with the clock.

## Part 4 — Implement and Test the Maintenance OTA Improvement Offline

**Purpose:** Implement **only** the reviewed maintenance-only raw staging path from Part 3, for native/host and compilation-only profiles. Invoking Part 4 authorizes these **local source and test changes**, not firmware installation.

**Prerequisite:** Part 3 design is complete, internally consistent, and not blocked by missing safety-critical updater information. Otherwise report `BLOCKED` and stop.

**Work:**

1. Reuse existing transfer, hash, image validation, and authentication abstractions. Change only the maintenance firmware path; preserve regular asset storage, existing v1 routes, private identity requirements, and compile/deployment guards.
2. Implement flash-staging transaction enforcement and readback with a portable test seam. Never finalize an unverified complete candidate; test failure cleanup without accidentally scheduling eboot activation.
3. Add native fault-injection regressions for **every failure class** in the Part 3 matrix. Assert no boot-copy command, no restart, no filesystem use, and no asset/configuration mutation on failure. Verify only a fully validated candidate is eligible for activation.
4. Compile the existing **non-installable** ESP8266 integration-check profile. Keep provisional profiles without a usable recovery identity and never create, rename, copy, or publish an installation-ready binary.
5. Update `docs/safe-first-boot.md`, `docs/recovery.md`, and `PLANNING.md` with actual results and remaining hardware/rollback limitations. Leave independent failed-boot recovery and full-backup gates blocked.

**Acceptance commands** (run sequentially in Ubuntu WSL2, with installed prerequisites):

~~~sh
npm run check
npm run test:offline
uv tool run --from platformio pio test -d firmware -e native
uv tool run --from platformio pio run -d firmware -e esp8266-provisional
uv tool run --from platformio pio run -d firmware -e esp8266-integration-check
python3 firmware/scripts/test_local_build_guard.py
git diff --check
~~~

Where justified, also run the existing sanitizer suites. If tooling is missing, document the exact missing prerequisite and do not present tests as passed.

**Stop boundary:** Never invoke `pio upload`, erase, a port/serial monitor, HTTP OTA, firmware package generation, or live device operations. A successful build does **not** change the installation decision.

## Part 5 — Finish Hardware-Independent Firmware and Integration Validation

**Purpose:** Close remaining **testable offline** correctness gaps without presenting simulation results as physical validation.

**Read:** `PLANNING.md` Phases 4 and 5, `docs/offline-validation.md`, `docs/firmware-development.md`, firmware scene/display/storage code, `contracts/v1/`, and agent device synchronization tests.

**Work:**

1. Cross-check existing native/runtime features against the still-open Phase 4/5 checklists. Split tasks into **already implemented and host-proven**, **testable offline but missing a regression**, and **requires the real unit**. Avoid creating duplicate implementations.
2. Add meaningful, focused host tests for startup failure, persistence, mode changes, Spotify pause/resume and metadata expiry, Unicode, track-bound cover ordering, GIF frame timing/looping, corrupt media, Wi-Fi/heartbeat interruption, reconnection, and full/restarted storage. Prefer existing harnesses and fault-injection hooks.
3. Review the known initial-null playback-clearing limitation from `docs/offline-validation.md`. Fix only if fully compatible with existing v1 contracts and tested on both sides; otherwise document the 45-second fallback clearly instead of silently changing the protocol.
4. Recheck measured **build** sizes/stack artifacts/host bounds and document that LCD colors/orientation, physical RAM/FPS, flash geometry, Wi-Fi radio, and actual power-loss behavior cannot be established by host tests.
5. Keep `PLANNING.md` honest: check only host-verifiable subtasks and leave all true on-device acceptance items pending.

**Acceptance:** `npm run check`, `npm run test:offline`, native tests, relevant sanitizer runs, both existing ESP8266 compilation-only builds if modified, `git diff --check`; concise evidence for every newly checked item.

**Stop boundary:** No physical display or RF claims, no production LAN activation, no clock connection, no new protocol version or expanded product scope.

## Part 6 — Installation GO/NO-GO Decision Gate

**Purpose:** Decide, using evidence rather than hope, whether any physical validation may even be proposed.

**Prerequisite:** Review outputs of Parts 1–5 and any **newly supplied** exact-unit evidence. This part remains executable as a **NO-GO assessment** even when the evidence is insufficient.

**Work:**

1. Build a dated evidence checklist with source links for: actual installed stock version; unit PCB/flash/display/boot layout; compatible original web verifier and first-install image; all flash/storage/activation preservation regions; complete restorable unit-specific Wi-Fi backup; independent Wi-Fi-only recovery if the main application/boot copy fails; safe recovery identity distribution; validated maintenance updater; and an identical spare for restoration/failure tests.
2. Independently distinguish **source-supported**, **mock-tested**, **real-hardware-tested**, and **unknown** for each claim. A second application updater or recovery AP within the main application cannot satisfy independent boot recovery.
3. Publish/update `docs/installation-go-no-go.md` with decision and unresolved blockers. Update `docs/recovery.md`, `docs/hardware.md`, and `PLANNING.md` only as the evidence supports.
4. If a single mandatory requirement is missing, record **NO-GO**, list the minimum specific missing evidence or maintainer action, and stop. Do not propose an experimental flash as a way of resolving uncertainty.
5. If and only if **all** requirements are supported, record **ELIGIBLE FOR SEPARATE PHYSICAL AUTHORIZATION** (not permission to install). Prepare a review-only hardware validation checklist for the maintainer; do not execute it.

**Acceptance:** an auditable, consistent gate decision with no invented evidence; `npm run check`; `git diff --check`. Default is **NO-GO** until proven otherwise.

**Stop boundary:** Do not flash, package firmware for installation, probe the clock, bypass backup/recovery criteria, or downgrade a safety requirement to pass the gate.

## Part 7 — Physical Acceptance (Explicit Separate Authorization Required)

**Purpose:** Validate the actual board and end-to-end behavior **only after** the Part 6 gate is demonstrably satisfied and the maintainer separately authorizes a specific bounded device operation.

**Prerequisites:** `docs/installation-go-no-go.md` supports all gates; verified full backup and independent Wi-Fi-only recovery; identical spare validation where required; user-provided explicit authorization of the particular operation. The instruction **"execute a parte 7 do plano" alone is not physical authorization**.

**Work allowed without separate authorization:** Review prerequisites and prepare an inert checklist: safe install/recovery procedure, LCD orientation/color/backlight, Wi-Fi provisioning, free RAM/flash space, OTA behavior, autonomous fullscreen GIF, Spotify artwork/progress, manual/auto modes, network outages, sleep/restarts, timeouts, and extended FPS/stability. State which tests need the user's physical participation.

**Work after distinct, explicit device authorization:** Only the approved operation on the specified device, within the validated backup/restore/recovery procedure. Stop immediately on an unexpected result. Do not assume UART or other physical programming can recover failures.

**Acceptance:** real measurements and evidence from the specific hardware for each approved criterion. Unrun tests stay pending; failure or missing prerequisites yields `BLOCKED`, not a fabricated `PASS`.

**Stop boundary:** No automatic device action based only on part number. No extension of authorization to other operations, hardware, or releases.

## Part 8 — Documentation and Release Readiness

**Purpose:** Make a clean, reproducible release **only when** physical acceptance and outstanding quality criteria are met; otherwise produce an honest pre-release readiness report.

**Prerequisites:** Review Part 6 and Part 7 outcomes. If device acceptance is blocked, stop before creating an installable firmware distribution, public recovery secrets, version tag, or release.

**Work:**

1. Reconcile `README.md`, `PLANNING.md`, `docs/installation.md`, `docs/recovery.md`, hardware limitations, user-facing examples, screenshots, license/dependency notices, reproducible local builds, secure configuration, supported Node versions, and CI.
2. Verify all acceptance tests against documented evidence, not only passing mocks. Keep the stock firmware recovery limits prominent.
3. If physical acceptance is still blocked, document **NOT RELEASE READY** and optionally improve non-installable desktop documentation/tests. Do not claim NeonByte firmware works on the clock.
4. If all criteria actually pass, prepare a release checklist, release notes, and proposed `0.1.0` scope for maintainer review. **Do not create a version tag, publish a release, or distribute installable/private device binaries without separate explicit authorization.**

**Acceptance:** reproducible checks, accurate known limitations, evidence-based readiness report, and no accidental release or secret disclosure.

## Milestones and Execution Order

| Part | Result | Requires the clock? | Can be done now? |
|---|---|---|---|
| 1 | Hardware/recovery evidence matrix and vendor request | No | Yes; may end with unresolved evidence |
| 2 | Desktop hardening and honest status | No | Yes |
| 3 | Maintenance OTA security design | No | Yes, after reading Part 2 |
| 4 | Offline maintenance OTA implementation and fault tests | No | Only after Part 3 passes review |
| 5 | Complete offline firmware/integration test coverage | No | Yes; after Part 4 if that changes the updater |
| 6 | Auditable installation GO/NO-GO decision | No | Yes; likely NO-GO without new external evidence |
| 7 | Hardware validation | Yes | **No**, until gates + separate authorization |
| 8 | Release readiness and documentation | No for review, yes for full firmware acceptance | Review possible; firmware release blocked until Part 7 passes |

**Important:** Part numbers are separate work orders, not synonyms for the historical project phase numbers. The operator may explicitly invoke any part, but the prerequisites and stop conditions always apply. A blocked part should produce a useful blocker report rather than an unsafe workaround.
