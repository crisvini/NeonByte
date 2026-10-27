# Release Readiness Review

**Review date:** 2026-10-27. **Status: NOT RELEASE READY.** Part 6 concluded **NO-GO**; Part 7 physical acceptance remains blocked. This review covers documentation, desktop quality checks, and offline host tests only.

## Current Project State

| Area | Evidence-based status |
|---|---|
| Desktop agent and simulator | Phases 1–3 are documented complete. The simulator and agent work without a connected clock; real-account use requires the user's Spotify configuration. |
| Windows startup | The maintainer reported successful Windows 11 login startup, hidden execution, and Spotify reconnection after a PC restart. Agent-only restart, safe stop, logs, and startup removal/restoration remain unverified on Windows. |
| Firmware source | Native firmware logic, ESP8266 adapters, startup, and maintenance OTA code exist. Prior compilation and host tests are software evidence only; provisional build settings do not establish unit compatibility. |
| Physical clock acceptance | **BLOCKED.** No device was contacted, probed, updated, flashed, erased, or otherwise modified. Display, flash, boot, RF, power-loss, and runtime performance remain unverified on the unit. |
| Installation and recovery | **NO-GO.** A complete restorable unit-specific backup and independent Wi-Fi-only recovery after application or boot-copy failure are not established. The full gate is in [the Part 6 report](installation-go-no-go.md). |
| Release distribution | No version tag, release, or installation package was created. The project must not be represented as firmware validated for the clock. |

## Required Release Blockers

The following Part 6/7 conditions remain open. Passing host tests cannot substitute for them:

- Identify the installed stock version and exact board, flash, display, power, boot layout, and preservation regions.
- Verify the matching stock web verifier and first-install image requirements.
- Establish a complete, coherent, unit-specific Wi-Fi backup and a matching full restore procedure.
- Prove independent Wi-Fi-only recovery when the normal application or boot copy cannot run.
- Establish the private recovery-identity process, validate the updater on an identical spare, and prove restoration/failure behavior there.
- Separately authorize and complete bounded physical acceptance after the evidence gates are satisfied.
- Complete remaining Windows manual checks and review all dependency and bundled-library notices before any binary distribution.

Do not use an experimental installation to answer these questions. The constraints in [recovery](recovery.md), [hardware](hardware.md), and the Part 6 report remain in effect.

## Documentation and Dependency Review

The README, desktop installation instructions, development guide, hardware status, and recovery status now state the current readiness boundary. Desktop instructions configure only the agent; they do not authorize firmware installation. The README and installation guide distinguish the package engine range (Node.js 22 or later) from the Node.js 22/24 major versions exercised by CI.

Linux keyring persistence is not guaranteed: the installed keyring package can fall back to a nonpersistent kernel keyring when Secret Service is unavailable. The agent has no plaintext token-file fallback. Windows uses Credential Manager. The `.env.example` contains placeholders, and `.env` is ignored by Git.

Direct npm versions and known license obligations are summarized in [development](development.md#direct-dependency-and-license-notes). Lockfiles pin npm dependencies. Before distribution, collect and review transitive npm, bundled native-library, and PlatformIO library notices. No distributable bundle was prepared.

The current CI workflow exercises Node.js 22 and 24, a Windows launcher regression, the offline agent/native integration suite, PlatformIO native tests, two compile-only ESP8266 profiles, and local image/deployment guards. The workflow does not upload firmware artifacts or publish releases. A CI compile or native mock result is not physical acceptance. No simulator screenshot is currently tracked; no physical image or measurement was added as evidence.

## Validation Run for This Review

- `npm run check` — passed. Markdown lint covered 24 files; the English language check passed; 9 root tests passed and 1 Windows-only test was skipped on this non-Windows host; the agent build and typecheck passed; all 54 agent tests passed.
- `npm run test:offline` — passed, 20 integration scenarios against the host harness.
- `uv tool run --from platformio pio test -d firmware -e native` — passed, 63 native C++ test cases across four suites.
- `python3 firmware/scripts/test_local_build_guard.py` — passed; permitted build targets and blocked synthetic device-operation targets were verified.
- ESP8266 target compilation was not run in this review, to avoid generating firmware images. This does not invalidate the earlier compilation records; it keeps this review within its documentation/offline-test scope.
- Physical, Windows-only manual, and real Spotify-account acceptance checks were not run.

These results verify only the host behavior described by the tests. They do not validate the clock's display, flash, boot, radio, recovery, or power-loss behavior. No protocol contract or security requirement was changed during this review.
