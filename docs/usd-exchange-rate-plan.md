# USD Exchange Rate Feature — Final Implementation Plan

## Status and Authorization

Planning is finalized. This document records the consolidated design agreed with
the maintainer. Saving this document does not authorize implementation, builds,
branches, commits, deployment, or hardware access. Implementation requires the
maintainer's separate explicit authorization.

Do not reopen the architectural decisions below or expand the scope to unrelated
problems. Do not modify `PLANNING.md`, mark physical acceptance tasks complete,
or relax existing deployment and resource gates for this feature.

## 1. Definitive Architecture

- Node.js is the only source of truth for `usdEnabled`.
- Extend the existing local display-mode settings record. The default is
  `false`; an absent field in an older record also means `false`.
- The Node.js quote service uses AwesomeAPI's `bid` and `pctChange`, polls every
  five minutes while enabled, and retains one quote in RAM.
- Add exactly one device endpoint: authenticated `PUT /api/v1/usd-state`.
- The ESP8266 retains the received configuration and quote only in RAM.
- `SceneManager` holds the received USD state and evaluates its validity.
- `DeviceDisplay` owns the visual alternation, using the existing player,
  cooperative loop, and graphics buffers.
- Add only one dashboard toggle, labeled **Mostrar cotação do dólar**, inside
  the existing mode card. Add no cards, sections, or additional controls.

Preserve `auto`, `gif`, and `spotify`, including their existing semantics.
Preserve all existing status, mode, and Spotify contracts. USD is a secondary
presentation of the logical GIF scene; the existing device status continues to
report `gif` while USD is displayed. There is no new device readback endpoint or
independent confirmation of the physical screen.

Do not add dependencies, quote history, LittleFS configuration records, firmware
timers or tasks, another decoder, or another playback pipeline. Do not change
storage, boot, recovery, OTA, authentication policy, NBIF encoding/decoding,
GIF management, or Spotify marquee behavior unnecessarily.

The exact Portuguese toggle label and display label **DÓLAR COMERCIAL** are
maintainer-requested exceptions to the English-only project convention. Keep
source identifiers, comments, tests, logs, and other documentation in English.

## 2. Complete Dashboard, Agent, and Device Flow

### Local Configuration

1. Load the existing `FileDisplayModeStore` record.
2. Normalize a missing `usdEnabled` to `false`; validate a present value as a
   boolean.
3. Receive the toggle change through the local dashboard server.
4. Save it through the controller's existing serialized, atomic persistence.
5. Only after successful persistence, update the quote service and request
   synchronization through the existing scheduler.

A persistence failure retains the previous preference. Every settings write must
preserve `usdEnabled`, the selected mode, and the mode command's existing pending
state. Changing the toggle must not call `selectManual()` or introduce another
persisted revision, fingerprint, or confirmation mechanism.

The browser-to-agent mutation is a private local dashboard operation. It does not
add a second ESP8266 endpoint. Reuse the current origin protection, error
notification, and mutation locks, including the existing OTA-related UI lock.

### Device Payload

`PUT /api/v1/usd-state` requires the existing bearer credential and exactly four
mandatory fields:

```json
{
  "enabled": true,
  "priceCents": 525,
  "changeBasisPoints": 42,
  "validForMs": 300000
}
```

This represents `R$ 5,25`, a change of `+0,42%`, and five minutes of remaining
validity. One basis point here is 0.01 percentage point of the source's
`pctChange` value.

| State | Representation |
| --- | --- |
| Disabled | `enabled: false`, with all three numeric fields zero |
| Enabled without a usable quote | `enabled: true`, with all three numeric fields zero |
| Enabled with a usable quote | Positive price, signed percentage change, and positive remaining validity |

The body limit is 128 bytes. `validForMs` must not exceed 900,000 ms. Define
numeric representation and layout bounds in the new contract and enforce them
consistently in the agent and firmware. Reject overflow and inconsistent field
combinations instead of clamping invalid input into a valid state.

Respond with `204` only after accepting the complete state in RAM. This receipt
does not imply persistent storage or confirmation of the physical presentation.

### Resynchronization

- Send the persisted preference after agent startup, reconnection, and preference
  changes, including when disabled.
- While enabled, resend the complete current snapshot in each normal device
  synchronization cycle, approximately every 15 seconds.
- When disabling, retain the need to send the disabled state until accepted;
  retry through normal cycles rather than an immediate retry loop.
- Repeated snapshots do not restart the display phase or extend old data's
  validity.
- Ignore acknowledgments belonging to an obsolete pairing/session.

Periodic enabled snapshots also cover device restarts that do not cause an
observed communication failure: the unchanged v1 status has no boot identifier.
Following a restart, the preference returns in the next successful cycle rather
than immediately at power-on.

During animation replacement or maintenance, USD waits for the existing serial
queue and scheduler lifecycle. Do not change `serviceUploadControls()` or issue
device requests from the asynchronous quote job. A quote may expire while USD
synchronization is suspended; normal fallback then applies.

### Quote Retrieval and a Single Validity Policy

Use the fixed HTTPS endpoint
`https://economia.awesomeapi.com.br/json/last/USD-BRL` exclusively from Node.js.
Use `bid` as the reference purchase price and `pctChange` as the source-provided
percentage change. Do not substitute tourism or PTAX data, calculate a different
market change, or add provider fallback. See the
[AwesomeAPI documentation](https://docs.awesomeapi.com.br/api-de-moedas).

- Fetch on enable, then every five minutes while enabled.
- Use one Node.js timer and at most one outstanding request.
- Use native `fetch`, a five-second total timeout, and an actual received-body
  limit of 8 KiB. Do not trust `Content-Length` alone for this limit.
- Do not follow redirects or accept a browser-supplied provider URL.
- Validate the pair, structure, complete decimal values, positive price, signed
  percentage, timestamp, and conversion bounds. Reject invalid/future timestamps
  according to the documented validation bounds and reject numeric overflow.
- Normalize price and percentage with consistent two-decimal rounding and avoid
  a negative-zero display.
- Cancel on disable/shutdown and ignore late results after cancellation.
- Share one RAM cache between the device synchronization and dashboard preview.
  Dashboard status polling must never trigger another provider request.
- Handle network errors, timeout, invalid HTTP/JSON, and rate limiting without
  blocking Spotify, heartbeat, or device communication. Respect applicable
  `Retry-After`; do not create aggressive retries.

There is one expiration policy: a quote expires **15 minutes after its source
timestamp**. A successful HTTP response is not evidence that the quote itself is
recent.

The agent checks that absolute deadline and retains a conservative monotonic
deadline so a backward local-clock adjustment cannot extend it. Recheck the
absolute deadline after computer suspension. A repeated source timestamp retains
its original expiration; reconnecting or receiving the same sample cannot renew
it.

Immediately before the USD PUT, after the main synchronization's awaits, compute
the remaining validity and subtract the USD request's transport budget. Send an
unavailable quote when no safe positive remainder exists. The ESP8266 counts
down the supplied remainder using its existing monotonic clock and does not need
Unix time or any external request for this feature.

An older cached quote may remain usable after an API failure only until its
original deadline. Outside source-update periods, including weekends, the quote
is hidden after expiration.

## 3. Isolated USD Synchronization Failures

### Existing Behavior That Must Be Preserved

- `DeviceScheduler` turns its callback's boolean result into `connected` or
  `disconnected`.
- `DeviceSynchronizer` returns `false` on failures of its main transport work.
- `DeviceIntegration` also returns `false` if its existing status or mode
  synchronization fails.

Do not place USD under a catch that determines the main result. Keep both
`DeviceScheduler` and the body of `DeviceSynchronizer` unchanged.

### Definitive Execution Order

1. Run the existing `DeviceSynchronizer.synchronize()`.
2. Run the existing status queries, pending mode command, and mode observation.
3. If main work fails, preserve its existing `false` return and skip USD.
4. After main work succeeds, perform USD in its own failure-isolated block.
5. Return `true` regardless of the USD result.

| Main synchronization | USD result | Cycle result |
| --- | --- | --- |
| Failed | Not attempted | `false` |
| Succeeded | Accepted | `true` |
| Succeeded | Timeout, authentication, HTTP, transport, or local USD error | `true` |
| Succeeded | Unsupported firmware | `true` |

The USD client method uses its own 1,000 ms timeout and calls the existing request
method directly. Do not use `mutate()` for USD, because it adds another status
preflight. Distinguish `204` and `404` using the HTTP status and discard response
bodies without interpreting remote JSON. Do not change global request behavior
for other operations.

Never send concurrent or unawaited device requests. A temporary USD failure is
retried in the next normal cycle and does not request an immediate retry. USD
must not alter the main connection state, reset artwork synchronization, or
prevent existing operations from running.

The extra request has a bounded residual timing cost of approximately one
second. Do not claim zero timing impact; measure that cost on hardware.

## 4. Unsupported Firmware

Only an HTTP `404` from the USD route means that the firmware does not support
the feature. Timeouts, `401`, `403`, `409`, `5xx`, and transport failures must
never set that classification.

Keep a small compatibility record in `DeviceIntegration` RAM, associated with
the existing pairing fingerprint. Do not put it only in `DeviceClient` or a
scheduler instance: those objects are recreated during ordinary operations.

After a `404`:

- Stop periodic USD attempts for that pairing.
- Preserve the persisted preference and main connection status.
- Retain the classification across ordinary reconnects, GIF replacement,
  scheduler recreation, and safe preflight aborts.
- Do not create another persisted record or confirmation protocol.

Allow a new attempt after a real pairing change, agent restart, or firmware
update performed by NeonByte. For the update case, invalidate the RAM record
when the existing `DeviceIntegration.resumeAfterExplicitRun()` or
`resumeAfterManualReconciliation()` hook releases the verified/reconciled
application. Do not clear it through `resumeAfterSafePreflightAbort()`.

No change to the OTA service or its safety decisions is required.

## 5. HTTP Reception Without Dynamic Application Allocation

The current `firmware/src/esp8266/http_server.cpp` has two relevant behaviors:

- `headersComplete()` allocates `body_` for ordinary JSON requests.
- `dispatchJson()` constructs an IP `String` before calling the protocol handler.

The USD route must bypass both behaviors without changing other routes.

### `headersComplete()`

- Recognize the exact USD path as a fixed-buffer control request.
- Apply its 128-byte body limit before receiving the body.
- Do not allocate `body_` for this path.
- Preserve existing bearer admission, paused-application rejection, framing,
  query rejection, and all other routes' limits and behavior.
- Use a local path classification; do not add a persistent request flag or
  enlarge `DeviceHttpServer`.

The existing lifecycle supports this: `close()` resets `body_`, and `bodyData()`
returns `controlBody_.data()` when the dynamic body is absent.

### Reception and `bodyComplete()`

The current `tick()` reads a bounded portion into the existing fixed `chunk_`
and copies it into `bodyData()`. For USD, accumulation must target
`controlBody_[513]` from the first received portion. Do not receive into a dynamic
buffer and copy into the fixed buffer afterward.

The existing staging copy through `chunk_` remains; no new receive buffer is
needed. USD is nonbinary and outside `/api/v2/*`, so the existing
`bodyComplete()` path already forwards it to `dispatchJson()`.

### `dispatchJson()` and Protocol Validation

- Create only a synchronous `string_view` into the fixed body.
- Dispatch USD before constructing the IP `String`.
- Pass empty `DeviceInfo`, which this route does not use.
- Reuse the existing response storage.
- Parse into a small local candidate using bounded keys and a required-field
  mask. Do not retain views into request memory.
- Validate every field and combination before changing any USD state.
- Reject missing, duplicate, unknown, mistyped, overflowing, or out-of-range
  fields; malformed JSON; trailing content; and oversized bodies.
- Enforce the body bound in the portable handler as well as the target adapter.
- Keep USD number parsing isolated from the existing routes' number rules.

No `new`, additional `unique_ptr`, `String`, or dynamic JSON object is allowed
for USD reception, interpretation, or response handling in application code.
This does not assert that the existing TCP/SDK implementation performs no
internal allocations.

## 6. Display Behavior With and Without a Playable GIF

### Normal Alternation

| Condition | Presentation |
| --- | --- |
| `auto`, USD disabled | Existing behavior |
| `auto`, USD enabled, valid quote and playable GIF | GIF for 15 seconds, then USD for 5 seconds, repeating |
| `auto`, USD enabled, valid quote without a playable GIF | Continuous USD |
| `auto`, unavailable/expired quote | Existing GIF behavior |
| `gif` | Existing GIF-only behavior |
| `spotify` | Existing Spotify or waiting behavior |

Spotify preempts alternation on the next display tick after valid playing state
is received. It also preempts USD screen preparation. When playback stops,
restart with GIF and a fresh 15-second period if a GIF is playable; otherwise,
use continuous USD while the quote is usable. Do not preserve an interrupted
phase's remaining time.

Switch GIF to USD at the first safe frame boundary after 15 seconds, honoring
the frame's display deadline. That boundary may slightly extend the GIF period.
Return from USD by reconstructing the keyframe through the current player; never
resume a delta over USD pixels. Repeated state updates and price changes do not
reset the phase.

Preserve the current disconnected-agent diagnostic presentation. A USD failure
alone must not cause that diagnostic by changing the agent connection state.

### Missing, Unopenable, or Invalid Animation

In eligible `auto` mode with a valid quote:

- Show USD continuously when no GIF can be played.
- Do not wait for a frame boundary that will never occur.
- Do not alternate with an empty screen or call `showGif()` every five seconds
  just to rediscover the same opening failure.
- If the quote expires or USD is disabled, return to the existing GIF path and
  do not introduce a new error screen.

Reuse the existing one-second reopening backoff and monotonic scheduling in the
display. Do not add a timer, decoder, or parallel playback mechanism.

| Failure | Treatment while USD is usable |
| --- | --- |
| Missing file or failed open | Keep USD visible; retry using the existing backoff |
| I/O/read failure | Keep bounded recovery, including recovery of the same file/revision |
| Recognized structural NBIF error | Keep USD visible; stop retrying that revision until installation/promotion or return to the ordinary non-USD path |
| Unknown error | Conservatively retain bounded recovery |

`AnimationDecoder::error()` already distinguishes read failures from explicit
structural errors. The renderer may recognize only a small exact set of
structural errors, covered by tests. Never treat the generic decode `Error`
status alone as proof that the installed file is invalid. Unknown messages must
remain recoverable.

### Validation and Promotion

- Preserve the current HTTP validation process and its dedicated buffers and
  decoder.
- Never open `animation.part` for display.
- While USD is displayed, call the existing
  `promoteAnimationCandidateAtBoundary()` mechanism: no frame is being read for
  display then.
- Retain existing promotion failure guarantees.
- An `animationRevision` change invalidates the prior availability
  classification and permits opening the newly installed animation.
- When a playable animation becomes available, restart GIF with a fresh
  15-second period.
- Avoid opening the same animation twice in one display tick.

There is a concrete detection limit: `open()` does not validate every frame's
payload in advance. A structural error can be discovered after some rows have
already been drawn. Continuous USD is guaranteed after unavailability is
detected. Guaranteeing no initial visual attempt at all would require additional
advance validation, outside this scope; do not claim it is already guaranteed.

### Rendering and Resource Discipline

Use a black background, pink/cyan accents, `USD/BRL`, a prominent value such as
`R$ 5,25`, a signed percentage and direction indication, and the commercial-dollar
label. Use green for USD appreciation, red for depreciation, and a neutral color
for zero. No charts, history, extra animations, new fonts, or libraries.

Render incrementally with bounded work per tick, using existing graphics
buffers and small formatting buffers. Keep constants in flash where supported.
Draw the required accent and direction indicators with small existing
primitives. Leave the USD screen static between actual content changes.

Preserve the lifetimes of `pixels_[480]` and `encodedWorkspace_[512]`, including
the latter's GIF prefetched header and Spotify metadata caches. Reentry must
rebuild the appropriate contents. Do not animate, format continuously, or
advance the USD phase while Spotify is displayed.

The dashboard uses its existing canvas and render loop for the preview and
preserves the explicit prepared-GIF preview behavior. It remains a local
simulation, not a synchronized remote framebuffer.

## 7. Definitive File List

### Agent Code

| File | Required change |
| --- | --- |
| `agent/src/exchange/usd-quote.ts` — new | Quote retrieval, normalization, cache, validity, and the Node.js timer |
| `agent/src/main.ts` | Wire settings, quote service, and shutdown |
| `agent/src/device/mode-controller.ts` | Persist the preference in the existing record while preserving mode state |
| `agent/src/device/client.ts` | Add the bounded USD PUT and status classification without changing `DeviceSynchronizer` |
| `agent/src/device/integration.ts` | Isolate USD work, resend state, and retain/reset compatibility knowledge in RAM |
| `agent/src/web/server.ts` | Save the toggle and expose USD data through the existing private dashboard status |
| `agent/src/web/public/index.html` | Add the single toggle inside the current card |
| `agent/src/web/public/app.js` | Toggle state, existing locks, and preview rendering |

### Firmware Code

| File | Required change |
| --- | --- |
| `firmware/include/neonbyte/scene_manager.h` | Declare USD RAM state and validity access |
| `firmware/src/scene_manager.cpp` | Apply validated state and evaluate availability |
| `firmware/src/protocol.cpp` | Add the endpoint and transactional parser |
| `firmware/src/esp8266/http_server.cpp` | Receive into the fixed buffer and bypass IP `String` construction for USD |
| `firmware/include/neonbyte/esp8266/display.h` | Declare minimal alternation and recovery state |
| `firmware/src/esp8266/display.cpp` | Render USD and integrate alternation, unavailable GIFs, priorities, and promotion |

### Contracts and Documentation

| File | Required change |
| --- | --- |
| `contracts/v1/usd-state.schema.json` — new | Specify fields, numeric limits, and valid state combinations |
| `contracts/v1/examples/usd-state.json` — new | Provide a compact payload example |
| `docs/protocol.md` | Describe the endpoint, validity, and legacy logical-scene reporting |
| `docs/user/usage.md` | Explain the toggle and feature behavior |

### Tests

| File | Required coverage |
| --- | --- |
| `agent/tests/usd-quote.test.ts` — new | Provider behavior, cache, deadlines, cancellation, and external failures |
| `agent/tests/mode-controller.test.ts` | Persistence, migration, and mode preservation |
| `agent/tests/device-client.test.ts` | PUT, timeout, and HTTP classification |
| `agent/tests/device-integration.test.ts` | Failure isolation, resends, and compatibility lifecycle |
| `agent/tests/web.test.ts` | Local preference mutation and current protections |
| `agent/tests/dashboard-state.test.ts` | Toggle state and existing locks |
| `agent/tests/display-preview.test.ts` | Preview, priorities, and periods |
| `agent/tests/offline/usd-sync.test.ts` — new | Communication and process restarts with the current harness |
| `firmware/test/test_firmware/test_main.cpp` | Parser, authentication, expiry, and existing contracts |
| `firmware/test/test_display/test_main.cpp` | Production renderer, alternation, GIF failures, and recovery |
| `firmware/scripts/probe_usd_http.py` — new | Actual adapter receive behavior with offline I/O doubles, fixed-buffer selection, and application allocation checks |
| `tests/contracts.test.mjs` | Validate the new contract and preserve existing contracts |

### Files and Mechanisms That Stay Unchanged

Do not modify `PLANNING.md`, `agent/src/device/scheduler.ts`,
`agent/src/device/firmware-update.ts`, `agent/src/web/scene.ts`, dashboard styles,
firmware storage code, storage interfaces, mode/scene enums, protocol public
signatures, `DeviceHttpServer`'s header, the host harness implementation, NBIF
codecs, boot/recovery, or marquee implementation for this feature.

Do not create another LittleFS record, capability endpoint, device readback
route, or independent persisted confirmation state.

## 8. Implementation Sequence

After separate explicit authorization:

1. Add the contract and payload, validity, and compatibility tests.
2. Implement the Node.js quote service and extend existing local persistence.
3. Add the USD PUT and isolated secondary synchronization.
4. Implement fixed-buffer reception and transactional firmware state updates.
5. Integrate rendering and alternation, including GIF absence and failures.
6. Add only the toggle and the existing-canvas preview.
7. Run relevant tests, regressions, sanitizers, and `npm run check`.
8. Compare compiled resources only within the authorized compilation scope.
9. Present results for separately authorized physical validation.

Do not change physical acceptance checklists or lower resource floors to finish
the implementation. This plan does not authorize hardware operations.

## 9. Automated Tests and Regressions

### Main Synchronization Isolation

- Successful main synchronization with USD timeout, authentication failure,
  `409`, `500`, and an exception still returns `true` and stays connected.
- Main failures retain their current result.
- USD follows status, heartbeat, Spotify, and mode operations.
- The approximately one-second timeout adds no status preflight.
- Temporary failures retry through normal cycles without a retry storm.

### Unsupported Firmware

- One USD `404` stops recurring attempts for that pairing.
- Reconnection and scheduler/client recreation retain the classification.
- Pairing change, agent restart, and release after a firmware update permit
  another attempt.
- A safe preflight abort does not reset compatibility knowledge.
- No other error is classified as unsupported firmware.

### HTTP and Protocol

- Fragmented receipt accumulates in the fixed control buffer from the start.
- `body_` stays null throughout USD reception.
- A preceding ordinary JSON request is closed and followed by correct USD
  fixed-buffer selection.
- Test 128-byte and 129-byte bodies, incomplete input, and safe termination.
- Verify no application allocation in USD receive, parse, and response paths.
- Reject missing/extra/duplicate fields, wrong types, overflow, invalid numeric
  combinations, and malformed or trailing input.
- Rejected input never changes the prior USD state.
- Existing routes keep their framing, authentication, limits, and behavior.
- Existing v1 status, mode, and Spotify contracts remain intact.

### Quote and Configuration

- An older settings record defaults to disabled.
- Agent restart preserves the preference; failed saves retain the old value.
- Changing mode after USD, or USD after mode, loses neither preference.
- No external polling occurs while disabled or because the dashboard refreshes.
- Test provider success, timeout, network/HTTP/rate-limit errors, oversized and
  invalid responses, rounding, invalid timestamps, and overflow.
- Repeated timestamps, retransmission, reconnection, suspension, and local clock
  changes never extend an old sample's lifetime.
- Disabling invalidates late provider results.
- Resends recover after reconnection and a reboot without an observed outage.

### Display and GIF Behavior

- Test 15/5-second periods, safe boundaries, and resends without phase resets.
- Spotify interrupts USD, incremental screen preparation, and partial GIF work.
- Returning from Spotify starts GIF with a fresh period when playable.
- Missing/unopenable animations keep USD visible without empty-screen cycles.
- Backoff prevents aggressive reopen attempts.
- A transient read failure recovers the same file/revision while USD is enabled.
- Recognized structural errors do not repeatedly expose empty/invalid playback.
- Unknown errors remain recoverable.
- Successful promotion restores alternation; failed promotion preserves current
  guarantees. Validation continues without displaying the candidate file.
- Quote expiration returns to the current GIF behavior.
- Verify cover binding, complete marquee text, keyframe reconstruction, frame
  delays, and graphics workspace lifetimes across interruptions.
- Manual `gif` and `spotify` remain unchanged.
- The toggle and preview preserve all other controls and existing locks.

Use the production `DeviceDisplay` with existing panel/storage doubles rather
than adding a second visual implementation to the host harness. Run existing
media, authentication, mode, persistence, maintenance, and OTA regressions.

The new HTTP probe must exercise real adapter paths rather than only a portable
parser. Preserve compatibility with the existing source-extraction probes.

## 10. Real-Hardware Acceptance Criteria

The initial state-size target is roughly 32–64 additional bytes, subject to actual
layout and implementation. This is an estimate, not a measurement or approval.
There must be no new framebuffer, resident receive buffer, per-tick allocation,
history, or periodic quote write to flash.

Enabled resynchronization sends at most approximately 2.5 KiB of request bodies
per five minutes at the 128-byte limit and 15-second cycle, excluding HTTP
headers and exceptional sends. Measure the actual impact rather than claiming
only one device transmission per provider update.

Compare before and after on the same device, profile, dependencies, media, and
workload:

- Measure static RAM, `SceneManager` size, stack, and transient allocations.
  `SceneManager` is allocated on the heap, so linker static RAM alone is
  insufficient.
- Preserve a minimum free heap of **22,168 bytes**.
- Preserve a minimum largest free block of **21,544 bytes**.
- Sample memory during scene transitions, artwork, marquee, upload, failures,
  and reconnections. Point samples may miss transient peaks.
- Verify no progressive memory loss or increasing fragmentation.
- Compare loop-stage maxima and HTTP/Wi-Fi responsiveness using existing
  diagnostics.
- Check colors, readability, flicker, phase timing, Spotify preemption, and
  recovery from missing/failed animations.
- Verify resynchronization after agent/device restarts and actual reconnection.
- Run at least two hours of sustained testing without new resets or stalls.

The historical largest-block margin was narrow. Static estimates cannot approve
runtime resources. Do not reduce floors to fit this feature. Production readiness
requires physical acceptance under separate authorization, with all existing
hardware, backup, installation, and independent recovery gates preserved.

## 11. Remaining Technical Risks and Boundaries

- The known memory margin is small. Compiled size does not prove runtime margin.
- The server still handles one connection at a time; the secondary request has
  a bounded but nonzero cost that must be measured.
- A restarted device receives its preference in the next successful cycle.
- `204` confirms RAM acceptance, not the physical display. The legacy status
  continues to report the logical GIF scene during USD presentation.
- Structural-error classification is coupled to a small tested set of existing
  decoder messages. Unknown errors must retain bounded recovery.
- A streaming-only corruption may be detected after initial rows have appeared;
  do not promise complete advance corruption detection.
- Prolonged provider failure or an old source timestamp hides the quote as
  required by the validity policy.
- The dashboard preview remains a simulation and can temporarily differ from
  the device's received state and physical timing.

No structural blocker was identified for the consolidated scope, subject to the
explicit corruption-detection boundary above. Runtime memory and performance
remain unverified and can block acceptance. If implementation or measurements
show a requirement cannot be met within these constraints, report that technical
blocker instead of silently expanding scope, simplifying existing features, or
claiming success.

Planning is complete. Await the maintainer's explicit implementation authorization.
