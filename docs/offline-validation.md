# End-to-End Offline Validation

**Date:** 2026-10-26. **Scope:** PC-only validation authorized by the maintainer. The SD PRO was not contacted or modified. No installation-ready package or private device identity was generated. Protocol v1 schemas and deployment protections are unchanged.

## Run the Validation

Use Node.js 22 or later, the existing npm dependencies, a C++17 compiler, OpenSSL development headers/libcrypto, and PlatformIO for the native unit suites. On Fedora the host compiler dependencies are `gcc-c++` and `openssl-devel`; on Ubuntu they are `g++` and `libssl-dev`. OpenSSL is a host test dependency only, not an agent runtime or target dependency. The command below was validated on Linux; Windows-native harness compilation is not yet verified.

~~~sh
npm run check
npm run test:offline
uv tool run --from platformio pio test -d firmware -e native
python3 firmware/scripts/test_local_build_guard.py
git diff --check
~~~

For AddressSanitizer and UndefinedBehaviorSanitizer on the full offline integration path:

~~~sh
NEONBYTE_HOST_SANITIZERS=1 npm run test:offline
~~~

`CXX` selects the host compiler. The binary is generated under ignored `build/neonbyte-host`; the command never selects a board or builds a firmware package. Ordinary repository checks remain usable without native compiler dependencies. CI additionally runs the offline command on both existing Node.js matrix versions. A remote CI result still requires a push.

## What Runs

~~~text
Mock Spotify HTTP/provider and decoded artwork pixels
  -> existing Spotify API client, PlaybackPoller, normalizer, media converters
  -> DeviceSynchronizer / DeviceClient
  -> real HTTP on an ephemeral 127.0.0.1 port
  -> test-only Node adapter / serialized private process pipes
  -> native C++ HttpHeaders / ProtocolHandler / SceneManager / SafeStartup
  -> simulated disk storage, display recording, station evidence, and clock
~~~

The harness has no physical address, discovery, target toolchain, Wi-Fi driver, or updater. Fault controls and observations exist only on private process pipes, outside protocol v1. Maintenance requests use the existing native handler. The HTTP adapter preserves raw headers for native parsing; tests can also inject incomplete or ambiguous requests directly into that parser boundary.

The C++ storage adapter uses temporary disk files, the existing `Transfer`, `HashJob`, `AnimationReader`, and `replaceAtomicFile` logic, plus host SHA-256. Media is staged and checked before rename; candidates survive an injected interruption and are discarded only on explicit successful storage mounting after restart. Real process termination, including `SIGKILL` at an uncommitted-candidate checkpoint, tests that volatile state disappears while installed files survive. This is not a flash power-loss durability claim.

`SceneManager::render` calls a recording display. Frame tests read complete RGB565 frames through the existing reader in 480-byte chunks, check independent pixel hashes and delays, and repeat frame reads without an agent. The target LCD driver, animation scheduler, radio, and LittleFS adapters are not executed. Repeated frame reads establish data availability and ordering; they do not measure autonomous frame timing or FPS on the ESP8266.

The synchronizer is explicitly instantiated by the offline runner. Each cycle reads `PlaybackPoller.currentSnapshot`, sends metadata, then heartbeat, then track-bound artwork when needed. Poller change notifications remain deduplicated. Successful covers are cached by track ID and URL; failed conversion/upload is retried on a later cycle and text remains available. Transport failure invalidates the cover cache. GIF upload is explicit and uses the existing converter and validators. Status compatibility is checked before every mutation; redirects and request deadlines are enforced, and remote errors are not echoed.

This work does not activate device connectivity in `agent/src/main.ts`, change the dashboard's simulation status, or configure a physical endpoint. A production scheduling/service lifecycle, device-address configuration, discovery, and LAN acceptance remain later authorized integration work. The runner drives periodic synchronization with simulated time rather than installing an agent background service.

## Verified Scenarios

| Area | Evidence |
|---|---|
| Spotify path | Mock HTTP `200`, `204`, `401` refresh/retry, and `429` flow through the existing API client and poller into native v1; no external Spotify request |
| Metadata/progress | Exact title/artist/track delivery, Unicode boundary, local progression, seek correction, duration clamping |
| Artwork | Existing crop/RGB565 converter, full-body SHA-256, percent-encoded Unicode track ID, metadata-before-cover and cover-before-metadata, mismatched artwork hidden, caching and retry |
| Scene matrix | Automatic play/pause/resume/no-playback/Internet-unavailable changes; forced GIF and manual Spotify waiting |
| Freshness | Refreshes despite deduplication, exact 45,000/45,001 ms presence boundary, independent metadata expiry despite continued heartbeat |
| Transport | Wrong pairing, malformed JSON, duplicate framing, incompatible protocol, request deadlines, safe errors, simulated disconnect/reconnect, restarted native process |
| GIF/storage | Converted multi-frame pixel hashes and 50/70 ms delays, persisted mode/GIF after restart, corrupt checksum/format, incomplete transfer, failed write/readback/promotion, space reserve, interrupted candidate plus abrupt process termination |
| Provisioning | Authentication, malformed forms, wrong/stale station evidence, same-SSID new-password confirmation, 30-second retry, explicit confirmation, failed persistence retains installed Wi-Fi |
| Maintenance | Paused v1 rejection, application-start failure, unavailable storage, explicit retry, explicit temporary Wi-Fi, temporary settings lost at restart, protected status without secret echo, disabled updater |

The existing 54 native tests additionally exercise AP retries, missing/invalid identities, startup guard failures, image validation, short/corrupt close, atomic readback, and bounded hashing. These existing tests remain part of the validation evidence rather than being copied into the integration suite.

## Defects and Review Findings

- **Fixed existing defect: Unicode truncation.** The normalizer used UTF-16 `slice(0, 256)`, splitting a surrogate pair when a supplementary character followed 255 ASCII characters. Native JSON validation then rejected the agent update. Both the focused agent regression and the end-to-end reproduction failed before changing the normalizer to count Unicode code points. No protocol change was needed.
- **Prevented integration defect: metadata deduplication and expiry.** Heartbeat alone cannot keep playback fresh. The runner sends the current sample every synchronization cycle, even when subscribers receive no changed-state event. A 90-second simulated playback regression confirms continued Spotify display with only one poller change notification. The original poller behavior remains intact.
- **Fixed during implementation/review:** the initial new client attempted an invalid empty-track update on idle, status validation initially coerced enum arrays into strings, and the initial host storage fixture cleaned candidates before startup policy mounted storage. Regressions now cover valid paused-last-track updates, strict status types/lengths, and candidate preservation throughout crash maintenance until explicit storage preparation.
- **Known v1 gap: a fresh agent cannot immediately clear unknown prior playback.** If the agent restarts with no track history while the device still holds a playing sample, v1 status does not return its track ID and v1 has no clear-playback operation. The agent sends no fabricated track. A regression records the remaining Spotify scene and confirms fallback at 45,001 ms even with heartbeats continuing. `synchronize() === true` means the requested transport operations succeeded, not proof of immediate scene agreement for an initial null snapshot. Resolving immediate clearing requires a separately considered contract or persistence design.

## Local Results

- Repository `npm run check`: Markdown and English checks, 8 root/contract tests, TypeScript build/type checking, and 42 agent tests passed.
- `npm run test:offline`: 16 integration scenarios passed against the native host executable.
- PlatformIO `native`: all 54 tests passed across the core, integration/helper, and startup suites.
- The offline scenarios and all 54 native tests passed AddressSanitizer and UndefinedBehaviorSanitizer. Native Unity defaults needed explicit C linkage in the temporary standalone sanitizer harness; the corrected harness passed. Temporary standalone artifacts remained outside version control.
- Synthetic deployment-guard checks and `git diff --check` passed. No target rebuild was necessary: this task changes no target adapter, build profile, deployment guard, or shared firmware implementation.

## Remaining Gaps and Hardware Readiness

The portable integration is ready to inform a separately authorized hardware-validation plan. **Deployment remains BLOCKED.** Passing host tests does not satisfy physical Phase 4 acceptance or authorize installation.

- Real-account OAuth and live Spotify/artwork downloads remain unverified. The browser normally decodes artwork; tests supply decoded RGBA fixtures and run the real converter, not a new server-side image decoder.
- The target TCP server, Wi-Fi SDK event ordering, RF outages, AP association, DHCP, RTC retention, LCD initialization/layout/glyphs/colors, and frame scheduling need actual hardware evidence. The Node HTTP adapter does not validate ESP8266 socket timeouts or interrupted TCP behavior.
- Host storage models failure points and real process restarts; it does not establish LittleFS compatibility, flash endurance, real power-cut atomicity, or stock filesystem preservation. Host Wi-Fi fixture records are not target configuration records.
- Actual flash size/layout, pinout, display/backlight, boot compatibility, free heap/fragmentation, full stack depth, throughput/FPS, and sustained device operation remain PENDING.
- Full original backup, verified hardware configuration, independent Wi-Fi-only failed-boot recovery, and filesystem-independent verified maintenance updates remain unresolved installation gates. Existing public compilation profiles still lack a usable private recovery identity.
- Production LAN scheduling/address configuration, reboot identification beyond v1 status, OS startup/distribution, and the initial-null clearing gap remain integration work. No Phase 5 physical/LAN checklist or MVP hardware item is marked complete here.

Stop at this offline boundary. See [recovery](recovery.md), [hardware](hardware.md), and [safe first-boot preparation](safe-first-boot.md) before proposing any physical work.
