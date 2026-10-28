# Daily Startup and Spotify Synchronization

## Authorized Scope and Design

The maintainer requested local implementation, regression tests, resource checks,
and a future physical procedure. No device access, OTA, reset, credential changes,
commit, release, or advancement of hardware acceptance is authorized. Work stays
in the existing checkout. Existing deployment and recovery gates remain intact.

Keep protocol v1 and the sequential ESP8266 HTTP server. Skip metadata writes on
Spotify unavailability, letting the original metadata expire independently after
45 seconds; confirmed pause and idle still clear playback immediately when local
track history exists. Do not synthesize fresh playing samples from stale data.

Prepare one artwork candidate asynchronously on the computer, with integration-wide bounded
download/decoding and no device requests in that background job. Discard obsolete
track/URL results. Send metadata and heartbeat before a serial cover upload;
bound that upload to 15 seconds and refresh the latest metadata/heartbeat after
it completes or fails. Artwork readiness requests an immediate sequential cycle.
No HTTP multiplexing, firmware rendering change, or
heartbeat exemption is needed. A genuinely unresponsive server still expires.

For the private profile, select automatic startup on clean power-on, using the
existing recovery-ready ten-second window, saved Wi-Fi and one-shot guarded app
initialization. Clean software restarts stay in configuration-only maintenance,
including reboot after OTA; external resets also stay in maintenance. Risky,
unexpected and uncertain resets retain the
stricter AP/HTTP-only path. Preserve RTC layout, identity, storage and partitions.

Allow an automatic-start manifest only with an explicit
`maintenanceAfterSoftwareRestart: true` gate. Legacy maintenance-on-boot manifests
remain valid. Keep post-OTA verification paused, read-only, authenticated, bound
to expected build/new boot, memory floors and two stable observations. Persist
the verified boot ID and require it again before explicit startup. Starting
the app does not verify it. Confirm `/run` actually starts before recording
`started` or resuming synchronization. A power interruption during OTA can lose
RTC evidence; a running app is never accepted by the verifier. This limitation
does not establish durable pending-update storage or independent boot recovery.

## Alternatives

- Concurrent device HTTP would compete with the single-client server and is
  excluded. Extending freshness indefinitely would conceal real outages.
- A new chunked media protocol is larger than necessary for this correction.
- Verifying an automatically running post-OTA application removes the existing
  paused health check. Retain that check and hold software restarts instead.
- A durable pending-update record needs a separately validated migration and
  power-loss model, including the old sender. Do not claim that RTC provides it.

## Tasks and Verification

1. Add failing agent/native-harness regressions for temporary Spotify failures,
   confirmed pauses/idle, stale expiry and recovery. Correct `sendPlayback`.
2. Add delayed-cover, track-change, serial request, bounded-upload and post-upload
   refresh regressions. Separate cover preparation from device synchronization.
3. Add startup policy tests for clean power-on, software restart, risky/unknown
   reset, missing Wi-Fi, failed startup, maintenance authentication and OTA holds.
   Bind the tested policy in the ESP8266 adapter and prepare the private profile
   without touching its recovery identity.
4. Add manifest and OTA state regressions for both boot policies, reject unsafe
   automatic candidates, and require observed app startup after explicit `/run`.
5. Test simultaneous marquee advancement and row-streamed artwork without changing
   rendering. Run `npm run check`, offline scenarios, native firmware tests,
   sanitizers and existing HTTP/OTA/deployment probes. Compile only the existing
   documented target assumptions, inspect images and record static RAM/size.
6. Document causes, changed files, boot/OTA behavior, limitations and a future
   physical checklist. Update PLANNING only for verified software results.

## Review Focus

- A rate limit, slow download or stale cover must not publish a false pause or
  postpone heartbeats indefinitely.
- A changed track during preparation/upload must converge to the latest track.
- Cover failure must not suppress mode/animation work or cause HTTP overlap.
- Startup failures must not loop or disable authenticated recovery access.
- Lost OTA responses and agent restarts must not re-send an approved image.
- Boot policy must not substitute for expected-build and paused health checks.

## Verified Offline Closeout

- Regressions failed before correction for false pauses, delayed preparation,
  missing post-upload freshness, prompt serial scheduling, unsafe automatic
  manifests, unobserved `/run` completion, reboot-after-verification approval,
  and overlapping downloads across scheduler replacement. All now pass.
- `npm run check` passed: Markdown/language, nine root tests plus a Windows-only
  skip, TypeScript build/type checking and 109 agent tests.
- Native suites passed 101/101 normally and with ASan/UBSan; offline scenarios
  passed 25/25 normally and with ASan/UBSan. HTTP, diagnostics, image, color,
  compatibility and synthetic deployment checks passed.
- Both existing public compile-only profiles and the private automatic candidate
  compiled. The private image is 371,984 bytes with 46,016 bytes reported static
  RAM plus 56 separate `.noinit` bytes; identity equality/embedding and both
  production image validators passed. Runtime memory/timing remain pending.
- Independent review reproduced and resolved isolated artwork failure suppressing
  other work, missing verified-boot binding, reset policy ambiguity and duplicate
  background jobs. Final focused review reported no remaining concrete issue.
- The [report](../../daily-startup-and-sync.md) lists changed files, limitations
  and the unexecuted physical procedure. No credentials or Windows startup
  settings were changed; no device, OTA, commit or release operation occurred.
  All physical acceptance and deployment gates remain pending or blocked.
