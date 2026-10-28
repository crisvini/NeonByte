# Daily Startup and Spotify Synchronization

**Date:** 2026-10-28. **Scope:** authorized offline source fixes, tests and local
compilation using the existing documented private profile assumptions. No device
was accessed, flashed, updated, restarted or otherwise operated. No credentials,
installed Windows task or running Windows agent were changed. No commit was made.
Physical acceptance remains **PENDING** and release readiness is unchanged.

## Identified Causes and Corrections

`DeviceClient.sendPlayback()` previously treated every null `nowPlaying` as a
pause of the last track. The poller intentionally publishes null on temporary
network/API/rate-limit/authentication failures, so those failures incorrectly
sent `isPlaying: false` and selected GIF immediately. Unavailability now sends no
metadata. Heartbeats continue; the firmware's independent 45-second age limit
expires the last real sample without inventing a fresh playing timestamp.
Confirmed pause and successful idle responses still stop playback promptly.
With no local track history, the existing v1 clear-playback limitation still
requires expiry; no fake track identifier or protocol change was introduced.

This distinction follows Spotify's separate successful no-content and error
responses; rate limiting retains its existing `Retry-After` handling. See the
[official response reference](https://developer.spotify.com/documentation/web-api/concepts/api-calls)
and [rate-limit guidance](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).

The synchronization cycle previously awaited source download, decoding and the
entire cover upload before scheduling more metadata/heartbeats. Covers could
occupy that cycle for 90 seconds, longer than the 45-second freshness window.
Now one source/decoder job runs independently on the computer, shared across
scheduler replacements. Downloads retain their ten-second deadline, decoding has
a ten-second processing deadline and the existing pixel/size limits remain.
Changed track/URL results are discarded before upload. Ready artwork requests an
immediate cycle through the same sequential scheduler.

The agent sends metadata/heartbeat before a cover and limits the cover PUT to
15 seconds, then refreshes the latest metadata/heartbeat after success or
failure. It never attempts heartbeats concurrently with an upload: ESP8266 HTTP
is sequential. If only artwork fails and the refresh works, mode/animation work
continues and artwork can retry. Failed metadata/heartbeat still reports a
disconnection, invalidates artwork synchronization and retains bounded recovery.
An explicit test timeout override remains supported. Large GIF uploads retain
their previous finite deadlines; uninterrupted playback through those separate
long transfers is not guaranteed by this cover correction.

The title/artist marquee updates both text areas and then advances one cover row
in each display tick. A new host regression advances both marquees while all
176 late-artwork rows are rendered correctly. This provides no evidence that
scrolling causes artwork starvation, so rendering, fonts, SPI, colors and pinout
were preserved. Physical SPI/LittleFS/HTTP timing remains unmeasured.

Polling and regular device synchronization remain 15 seconds by default.
Ordinary device and Spotify HTTP deadlines remain ten seconds. Spotify's existing
bounded reconnect backoff and `Retry-After` remain intact. Persistent API failures,
missing heartbeats or genuinely stalled device communication still select GIF
after freshness expires; this correction does not mask them indefinitely.

## Automatic Power-On Behavior

The new confidential local profile selects `NEONBYTE_MAINTENANCE_ON_BOOT=0` while
preserving its previous recovery identity, display/OTA/stock gates and provisional
DIO/40 MHz/4 MiB/4m3m declaration. Public compile-check profiles are unchanged.

| Boot evidence | Behavior |
|---|---|
| Clean power-on with a valid/initializable clean RTC guard | Recovery AP/HTTP first; fresh ten-second maintenance window; one guarded storage/configuration/application attempt |
| Valid saved configuration, station unavailable | Application can start; station retries every 30 seconds; recovery AP remains active |
| Missing/invalid saved configuration or failed initialization | Application stays paused; authenticated maintenance remains available; no endless application-start loop |
| Clean software restart, including OTA, or external reset | Configuration-only maintenance and saved-Wi-Fi retry; application requires explicit authenticated start |
| Crash, watchdog, risky or uncertain warm-reset evidence | Existing stricter AP/HTTP-only recovery path |

AP/HTTP startup failures retain their retries and a fresh window after recovery.
The RTC layout, guard write/readback, pairing, Wi-Fi storage, filesystem, flash
regions and OTA validators were not changed. Normal power-on requires no panel
action once valid configuration and the separately approved image are installed.
The Windows agent retains its existing startup-at-login and Spotify reconnection
behavior; no scheduled task was installed or modified here. USB must actually
lose power for this path: a port that stays powered after PC shutdown does not
cause a new firmware boot.

## Safe OTA Transition

Update/build the agent first. Existing maintenance-on-boot manifests remain
accepted. An automatic candidate additionally requires
`maintenanceAfterSoftwareRestart: true`; the trusted private build record must
substantiate this policy. All previous identity/profile, length/SHA-256, image,
flash/capacity, memory, private-file and runtime validation checks remain.

No intermediate firmware is required by the software protocol if the installed
NeonByte image already implements the authenticated maintenance/info/OTA routes.
If those capabilities or trusted binding/resource evidence are absent, transition
is blocked rather than bypassed. No inbox-ready manifest was created: the actual
device ID and approved live-heap floors remain unsupported by local evidence.

The updater pauses/drains synchronization, sends at most one approved image and
records intent before PUT. The new image holds software restart in maintenance,
even though later clean power-ons may start automatically. Verification remains
read-only and requires expected identity/build, a new boot, paused app, running
AP, resource floors and two observations of the same boot at least two seconds
apart. Only then does the journal become `verified`. Explicit `/run` must observe
the application running on that exact verified boot before the journal becomes
`started` and synchronization resumes.

The optional `verifiedBootId` journal field preserves old journal readability;
old `verified` records without that field require verification again. Lost
responses, process restarts and address corrections never replay a firmware PUT.
An application that starts by itself is never sufficient to approve firmware.

RTC is not durable pending-update storage. A power interruption before verification
can lead to a later clean automatic boot, or strict maintenance if risky/invalid
evidence remains. A running app fails paused verification. A reboot after
verification invalidates the recorded boot's startup approval. Keep the result
unresolved and use separately authorized maintenance/recovery; do not resend the
image or relax the checks. This work does not claim automatic rollback or
independent failed-boot recovery. The source trace supports the SDK software
restart path, but actual RTC/eboot/reset behavior requires physical validation.

## Changed Files

| Files | Purpose |
|---|---|
| `agent/src/device/client.ts` | Separate unavailability from pause; asynchronous bounded cover preparation, serial deadline and refresh |
| `agent/src/device/scheduler.ts`, `integration.ts` | Prompt serial artwork scheduling; share one download/decoder across scheduler replacement |
| `agent/src/device/firmware-inbox.ts` | Accept explicit safe automatic policy and preserve legacy manifest validation |
| `agent/src/device/firmware-update.ts` | Bind approval to the verified boot; observe startup before recording completion |
| `firmware/include/neonbyte/startup_guard_layout.h`, `firmware/src/esp8266/main.cpp` | Apply the tested power-on-only automatic policy without changing RTC layout |
| Agent client/cover/scheduler/OTA tests and offline failure/media tests | Temporary failures, pauses, expiry, recovery, delayed/obsolete artwork, serial requests, lifecycle bounds and OTA transitions |
| Native startup/display tests | Boot policy, Wi-Fi failure, protected maintenance, one-shot initialization and marquee/artwork coexistence |
| Protocol/startup/OTA/HTTP docs, implementation plan and `PLANNING.md` | Align current behavior and record evidence without completing physical gates |

The confidential automatic profile and local build record are outside Git under
the existing private-build directory in `2026-10-28-daily-startup`. Its retained
header is byte-identical to the prior profile and both recovery values were
checked in the image and ELF without printing them. This is an offline candidate,
not an approved installation package or public artifact.

## Validation and Resource Evidence

- PlatformIO native: 101/101 passed, including 17 display and 26 startup tests.
- Native tests also passed AddressSanitizer/UndefinedBehaviorSanitizer. The local
  sanitizer configuration required explicit linker flags; its initial harness
  link error was corrected without changing project compilation settings.
- Offline integration: 25/25 passed under ASan/UBSan, including real native-core
  expiry, recovery and slow-download/scheduler-replacement coverage.
- Both existing public ESP8266 profiles and the confidential automatic profile
  compiled locally; no upload/monitor/device target was invoked.
- Compatibility/color, HTTP lifecycle, authenticated diagnostics, stock HTTP and
  synthetic deployment guards passed. HTTP lifecycle/diagnostics/stock HTTP also
  passed with sanitizers. Independent Python image inspection and both production
  C++ validators accepted all three images.
- Final repository check and review results are recorded in the plan closeout.
- `npm run check` passed: 44 Markdown files, language policy, nine root tests
  plus one Windows-only skip, agent build/type checking and 109 agent tests.
  Windows-native execution was not rerun; existing startup acceptance remains
  maintainer-supplied evidence. Independent review found no remaining concrete
  issue after the boot-binding and shared-artwork-job corrections.

| Compile-only profile | Combined image bytes | Program bytes | Linked static RAM bytes |
|---|---:|---:|---:|
| `esp8266-provisional` | 370,320 | 366,167 | 45,876 |
| `esp8266-integration-check` | 371,344 | 367,195 | 45,824 |
| Private automatic candidate | 371,984 | 367,827 | 46,016 |

The private image is 86,768 bytes below the existing 458,752-byte preparation
ceiling, and 152,304 bytes below the nominal 524,288-byte guard. It is 48 bytes
larger than the previous private artifact; `.data` is unchanged, while `.rodata`
and `.bss` are each eight bytes smaller. Toolchain/build identity differences mean
this comparison alone does not isolate runtime behavior.

The separate `.noinit` section is 56 bytes and is not included in the PlatformIO
static-RAM total above. Compiler stack frames include 48 bytes for `setup` and guard writes, 32 bytes for
startup-failure classification and 16 bytes for application startup; individual
frames are not call-chain limits. Static RAM excludes dynamic Wi-Fi/TCP/LittleFS,
application allocation, request bodies, library temporaries and fragmentation.
Actual free heap, largest block, stack margin, FPS and sustained HTTP latency are
**PENDING**. No firmware production-readiness claim follows from these numbers.

## Future Physical Validation Proposal — Not Executed

1. Resolve existing unit-specific backup/recovery, exact hardware/flash and live
   resource gates. Review the trusted private artifact, unchanged credentials,
   expected device/build and approved memory floors. Obtain operation-specific
   authorization before installation or any device operation.
2. Using the separately approved path, validate old-to-new maintenance OTA,
   paused post-reboot verification and explicit startup. Test uncertain responses
   and process restart on an appropriate recoverable spare; verify zero replays.
3. After separate authorization, test actual USB power loss/restoration. Confirm
   AP/HTTP and the full ten-second maintenance window before display startup,
   saved Wi-Fi reconnection and automatic Windows-agent synchronization.
4. Test Wi-Fi absent/returning, missing configuration and safe injected startup
   failures on a recoverable spare. Confirm no application-start loop and that
   protected maintenance remains available without a working LCD.
5. Exercise long scrolling titles, rapid track changes, pause/resume, temporary
   Spotify API loss, slow/failed artwork and PC shutdown. Observe metadata and
   heartbeat expiry, diagnostics loop gaps, free heap/largest block and watchdog.
6. Test post-OTA power interruption and reboot-after-verification on a recoverable
   spare. Require fresh paused verification and no upload replay; document any
   manual maintenance action needed. Do not treat app startup as approval.
7. Run sustained playback/GIF/reconnection tests for at least one to two hours,
   recording memory fragmentation, HTTP latency, resets and visual correctness.
   Keep physical acceptance and release readiness open until evidence is reviewed.
