# Animation Storage Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task after explicit maintainer authorization. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-frame animation storage with an exact compressed streaming
format that preserves quality and keeps display, Wi-Fi, and HTTP cooperative.

**Architecture:** The desktop resolves GIF semantics and emits NBIF v2 palettes,
independent row compression, and overwrite deltas. The ESP8266 retains its current
480-byte output buffer, expands bounded row spans, and keeps legacy v1 support.
Short upload requests and background validation preserve control-service access.

**Tech Stack:** Existing Node.js/TypeScript, gifuct-js, C++17 portable core,
ESP8266 Arduino adapters, LittleFS, and Adafruit display library. No new runtime
dependency in the initial codec. A benchmark-only decoder/emulated filesystem
requires a pinned revision and documented license.

**Spec:** [Animation Storage and Playback Optimization Design](../specs/2026-10-27-animation-storage-design.md).

## Global Constraints

- Local offline implementation and validation were authorized by the maintainer
  on 2026-10-28. Device access, OTA, flash, private installation artifacts, and
  commit remain prohibited by the implementation request.
- Preserve the current uncommitted firmware changes; reconcile this plan with
  them before implementation. Do not reset, overwrite, or commit unrelated work.
- Use English (en-US), UTF-8, LF, and descriptive English identifiers.
- No device access, discovery, OTA, flash, erase, partition change, credential
  access, automatic commit, or assumed-board compilation.
- Preserve v1 schemas, NBIC v1, modes/freshness, fixed Spotify title/artist text
  with compact ellipses, colors,
  orientation, recovery identity, maintenance policy, and deployment guards.
- NBIF v2: 240 x 240, 1..20 frames, delays >=20 ms, total <=30,000 ms,
  encoded bytes <=2,359,296; one <=240-pixel span per changed row.
- Original input limits and delay normalization remain as specified in the design.
- Fixed state <=2 KiB per active decoder context; playback reuses the current
  480-byte row. Candidate validation gets a separate fixed 480-byte output row.
  Target <=6 KiB extra whole-feature peak memory including both contexts and
  filesystem caches; never share a partially decoded output row.
- Keep the 32 KiB reserve; measure additional allocation/metadata requirements.
- Upload requests <=1024 bytes, writes <=512 bytes per main-loop iteration;
  5-second connection inactivity, 60-second session inactivity, 10-minute total
  session deadline. Polls and identical retries do not extend progress deadlines.
- Hardware timing, runtime memory, physical storage behavior, and other device
  measurements remain PENDING until separately authorized and measured.

## Review Focus

- Local palettes can leave >256 final colors; raw RGB565 escape must remain exact.
- A partial delta followed by Spotify requires a full keyframe on return.
- A connection-free upload session must still block conflicting maintenance and
  automatic startup work that would invalidate its storage.
- A valid header and SHA do not prove compressed records are safe; validate all
  payloads with bounded decoding before promotion.
- A full 240 x 240 update cannot meet a 20 ms delay at the requested 20 MHz SPI;
  do not silently skip frames or label host timing as target performance.

## File and Interface Map

This map records the intended implementation boundaries. The desktop upload
client was added to the existing `client.ts` and `integration.ts` rather than a
new `animation-upload.ts` module.

| Area | Files | Responsibility |
|---|---|---|
| Baseline/reference | `agent/scripts/benchmark-animation.ts`, `assets/samples/animation-codecs/`, `docs/animation-codec-benchmark.md` | Reproducible corpus, hashes, exactness, size and operation-count comparisons. |
| Wire specification | `docs/animation-format.md`, `docs/protocol.md`, `contracts/v2/`, `contracts/v2/examples/` | Freeze binary v2 and additive media-session contracts; preserve v1 behavior. |
| Desktop codec | `agent/src/media/animation.ts`, new `animation-format.ts`, `animation-encoder.ts`, `animation-decoder.ts` | Share composition, preserve v1 entry points, provide v2 encode/decode and complete validation. |
| Portable decoder | New `firmware/include/neonbyte/animation_decoder.h`, `firmware/src/animation_decoder.cpp`; existing `animation_reader.*` retained | Bounded v2 parser/validator; keep v1 offsets/API separate. |
| Asset lifetime/player | `firmware/include/neonbyte/esp8266/storage.h`, `firmware/src/esp8266/storage.cpp`, `firmware/include/neonbyte/esp8266/display.h`, `firmware/src/esp8266/display.cpp` | Stable file handle, separate animation generation, span display, frame-boundary promotion. |
| Transfer service | New `firmware/include/neonbyte/animation_upload.h`, `firmware/src/animation_upload.cpp`; existing `http_server.*`, `main.cpp`, and `hash_job.*` as needed | One bounded upload session, background verification, expiry, and safe application/maintenance arbitration. |
| Desktop transfer/preview | Existing `agent/src/device/client.ts`, `integration.ts`, `web/server.ts`, `web/public/app.js`, `web/public/index.html` | Capabilities, control service between chunks, retries, format-aware preview and size feedback. |
| Host integration | `firmware/host/storage.*`, `firmware/host/main.cpp`, display/storage doubles, host build script | Reproduce the new session and player behavior without pretending a host filesystem is physical LittleFS. |
| Verification | Agent media/device/web tests; new native `test_animation_codec` and `test_animation_upload`; existing display/startup tests; offline media/persistence/failures tests | Cross-language vectors, corruption/fault coverage, compatibility and lifecycle regressions. |

Proposed portable interfaces, to freeze in Task 1:

- `AnimationSource::size() const -> uint32_t` and
  `readAt(uint32_t, uint8_t*, size_t) const -> bool`; the player owns its lifetime.
- `AnimationDecoder::open(const AnimationSource&) -> DecodeResult`;
  `step(uint16_t maxInputBytes) -> DecodeResult`;
  `row() const -> AnimationRow`; `consumeRow() -> void`;
  `restart() -> void`. A step returns Progress, RowReady, FrameComplete,
  AnimationComplete, or Error. `open` initializes bounded state; directory and
  payload work proceeds through steps. `row()` references the supplied reusable
  output buffer and supplies x/y/width; no next decode before consumeRow.
- `AnimationRow` contains `uint16_t x/y/width/byteCount` and
  `const uint8_t* pixels`. `AnimationFrameInfo` contains `uint16_t frameIndex`
  and `delayMs`, plus an enum kind (Keyframe/Delta/Hold).
  `frameInfo() const -> AnimationFrameInfo` exposes the current frame on
  FrameComplete. `metadata() const -> AnimationMetadata` exposes validated
  dimensions/count/duration only after the header/directory pass completes.
- Construct the decoder with a caller-owned 480-byte output buffer. Decoded rows
  use little-endian RGB565. Validation mode consumes rows without panel writes,
  using its own output buffer/context while playback retains partial row state.
- `AnimationUploadSession::begin(sizeBytes, sha256, nowMs)`,
  `append(offset, bytes, nowMs)`, `complete(nowMs)`, `tick(nowMs)`, `cancel()`, and
  `status()` use explicit bounded request/result structures and the state/limits
  in the design. `tick` advances at most one bounded I/O/decoder/hash unit.
  Task 1 defines their exact field layouts: uploadId, nextOffset, state,
  expected/received size, expected digest, deadlines, and stable error code;
  append results distinguish accepted/identical replay/conflict/error.
- Desktop `encodeAnimationV2(frames) -> AnimationAsset`,
  `validateAnimationV2(bytes, sha256) -> MediaMetadata`, and
  `decodeAnimationV2(bytes) -> reconstructed frames` share a frozen byte layout,
  but golden vectors also come from an independent reference to avoid shared bugs.

## Task 1: Benchmark the Alternatives and Freeze Contracts

**Deliverable:** an evidence-backed codec decision and exact binary/API vectors.
No target firmware work begins before this gate.

- [x] Obtain the actual 14-frame GIF or record that the central size gate cannot
  yet be evaluated; retain its hash and exact baseline of 1,612,839 v1 bytes.
- [ ] Assemble generated/licensed corpus entries covering Section 8 of the spec.
  Compare current composition against an independent renderer and resolve any
  semantic defect in a separately documented scope before taking it as truth.
- [x] Benchmark packed palette, RGB565 RLE+delta, recommended v2, and original
  GIF. A normalized GIF was not produced because the agent has no GIF encoder.
  Keep target timings/memory PENDING; see the benchmark report.
- [x] Record encoded bytes including palettes/headers, changed pixels, row spans,
  SPI pixel lower bounds, and decoder-state requirements. Read-call counts remain
  PENDING. The selected decoder does not require a framebuffer.
- [ ] Use the <=161,283-byte sample gate and exact RGB565 equality to select v2;
  if it fails, compare one bounded LZ option or normalized GIF, then revise the
  design for maintainer review instead of implementing a failing recommendation.
- [x] Freeze Section 4's field offsets, codec controls, limits, palette rules,
  errors, route payloads, response schemas, session behavior, and vectors in the
  listed documentation/contracts. Add contract tests for examples and extra keys.
- [x] Run `npm run check` and review the benchmark and contracts. The maintainer
  authorized implementation on 2026-10-28. Hardware tasks remain unverified.

## Task 2: Implement and Verify the Portable Codec

**Consumes:** frozen binary spec and independent fixtures from Task 1.
**Produces:** desktop encoder/decoder and bounded C++ decoder interfaces above.

- [x] Add tests for exact reconstruction, all four codecs, >256 composed
  colors, packed-index boundaries, holds, palette changes and keyframe coverage.
  Desktop validation covers every-byte truncation, trailing data, invalid codecs
  and digest mismatch; fuzzing remains pending.
- [x] Run focused tests; retain existing v1 tests as compatibility coverage.
- [x] Extract the existing composition pipeline without changing current v1 output.
  Implement exact palette selection, RGB565-based row differences, bounded row
  compression/raw escapes, deterministic ties, and independent v2 validation.
- [x] Implement the resumable C++ decoder with checked arithmetic and budgets for
  input, output, and parser operations. Make validation use the same safe decoder
  without display output, while keeping independent golden reference vectors.
- [x] Verify exact frames/delays/lengths in desktop tests and the portable C++
  decoder suite; run native suites with ASan/UBSan and assert decoder layout/read
  bounds. A fuzz harness was not run.
- [x] Run focused media tests and the native codec suite; record memory/layout
  evidence. Stop if a required bound cannot be met.

## Task 3: Integrate Stable Storage and the Incremental Player

**Consumes:** v1 reader, v2 decoder and row metadata.
**Produces:** version-dispatching player with bounded LCD spans and safe lifetimes.

- [ ] Add failing native display/storage regressions for loop transition, holds,
  palette changes, Spotify entry midway through a delta, keyframe resume,
  unrelated cover update, slow rendering, and replacement at a frame boundary.
- [x] Add a stable read-handle adapter and separate animation generation. Keep
  directory/record state bounded and verify there is no reopen per rendered row.
- [x] Dispatch by validated NBIF version; expand one bounded span and send its
  address window using current RGB565 wire order. End SPI before yielding.
  Remove frame-entry clears only in the GIF path; preserve Spotify behavior.
- [ ] Implement missed-deadline handling without dropping dependent deltas or
  unbounded catch-up. Add a full-frame/20 ms fixture that records lateness rather
  than falsely reporting sustained timing; use injected time and bus costs.
- [x] Verify host-panel pixels on frame updates/resume and assert no animation
  loop `fillScreen` or backlight toggle. Run native display and codec tests under
  sanitizers. Physical LCD behavior remains pending.

## Task 4: Add Bounded Upload Sessions and Background Promotion

**Consumes:** format validator and player/storage boundary handshake.
**Produces:** additive authenticated v2 routes and a central media-session owner.

- [ ] Add failing portable session tests for exact receipt, duplicate last chunk,
  offset conflicts, cancellation, idle/total expiry, auth/framing, corrupt payload
  with a valid header/hash, no space, failed writes, rename failure, and reset.
- [ ] Add failing lifecycle tests where no TCP client is active but a media
  session is receiving/verifying/ready; conflicting maintenance/startup operations
  must preserve session/storage invariants and status must remain serviceable.
- [ ] Add failing ownership tests for a v1 cover/animation upload, status-client
  disconnect, and HTTP close/error while a v2 candidate exists. No unrelated
  request may call shared-sink abort/selectAsset or delete that candidate. Also
  verify v1 promotion closes/reopens the persistent player handle safely.
- [ ] Add a playback row split across two decoder ticks with candidate validation
  between them; assert exact output and separate buffer ownership. Measure both
  decoder contexts, validation row, hash state, and file caches together.
- [x] Implement the session state machine and routes in Section 6. Reuse existing
  bounded HTTP buffers, process <=512 bytes per loop, and return 202 before full
  validation. SHA and full decoding happen as background work between requests.
- [x] Keep the old installed handle alive during receipt/validation; close it at
  the frame boundary before one overwrite rename. On failed rename reopen/reset
  the old animation; never unlink it as preparation for promotion.
- [x] Centralize ownership across retained v1 and new v2 routes, including cover
  uploads and HTTP disconnect/error cleanup. Reject conflicting binary requests
  before shared sink mutation; retain safe status/heartbeat/metadata/mode work.
- [x] Enforce reserve/admission and actual-write failures without counting future
  reclaimed bytes. Keep transfer/session errors stable and free of secret bodies.
- [ ] Extend the native host adapters and run restart/fault matrices. Use the
  exact bundled littlefs in a host block emulator for power-cut injection; check
  old-or-verified-new recovery at all program/erase/sync/rename boundaries.
- [ ] Verify control requests can run between chunks and throughout validation;
  document that a stalled client remains subject to the single-client timeout.

## Task 5: Connect Desktop Negotiation, Uploads, and Preview

**Consumes:** v2 contracts, codec, and session routes.
**Produces:** compatible agent behavior with source/converted-size feedback.

- [ ] Add failing tests for legacy 404 negotiation, new capabilities, malformed
  capabilities, 401/timeouts, explicit storage rejection, and old/new agent/device
  combinations. An ambiguous failure must never silently choose legacy uploads.
- [x] Implement v2 capability selection and chunk transfer, servicing pending
  heartbeat/metadata between chunks. Match retries to nextOffset and the permitted
  duplicate-last-chunk rule; use bounded polls and no restart-resume claim. The
  integration awaits the upload job, so scheduler-cycle duration is not bounded.
  Cover transfers wait until the animation session ends.
- [x] Keep v1 conversion/upload for legacy firmware, with its existing space
  check. Explain downgrade preparation and do not send v2 bytes to the v1 route.
- [x] Decode the converted format for preview. Display original/converted bytes,
  compression ratio, frames/duration and safe blocked/error states in English;
  preserve the current session-only original-media lifetime.
- [x] Run agent checks plus offline media, persistence, failures, scene/mode,
  expiry and maintenance-race scenarios against the updated native host.

## Task 6: Verify Offline and Prepare a Separate Hardware Proposal

**Deliverable:** reviewed offline results and an explicit pending-measurement list.

- [x] Run `npm run check`, `npm run test:offline`, all seven portable native
  suites, and sanitizer-enabled native suites. `pio` is unavailable, so native
  tests were compiled directly with cached Unity. No fuzz harness was run.
- [x] Run `git diff --check`; review authorized changes, contract drift,
  English naming/text, bounded allocations, and preserved deployment safeguards.
- [ ] Re-run the size/quality corpus and report all acceptance results as pass,
  fail, or PENDING with evidence. Host estimates cannot pass physical gates.
- [ ] If separately authorized, compile only the existing approved target profiles
  to assess code/static-RAM/stack costs against the then-current baseline. Do not
  select a new board, generate credentials/private artifacts, or install firmware.
- [ ] Prepare a future operation-specific physical test proposal for heap/largest
  block/stack, SPI/FPS/tearing, HTTP/Wi-Fi, near-full LittleFS, replacement, restart,
  and 2-hour/24-hour soak criteria. Explicitly identify every persistent mutation.
- [ ] Stop. Request authorization only for a concrete next work package; do not
  perform device access, OTA, power interruption, commit, or later project phases.

## Implementation Record

The user authorized implementation of this plan on 2026-10-28. Completed local
work and remaining acceptance gates are recorded in
[`animation-codec-benchmark.md`](../../animation-codec-benchmark.md) and the final
execution report. Local validation passed: `npm run check`, `npm run
test:offline` (25 scenarios), 120 agent tests, and 104 portable C++ tests; all
seven C++ suites also passed with ASan/UBSan. `git diff --check` passed. The
original 14-frame GIF is missing, so the 90% central-file gate is PENDING. The
synthetic corpus has exact reconstruction; its v2 reductions versus v1 range
from 48.29% to 99.83%, depending on motion and image content. The v2 HTTP adapter
was not target-compiled or exercised end-to-end in the v1-only host harness.
LittleFS power-cut behavior, runtime heap/cache and code-size measurements, and
physical frame timing/flicker/tearing remain PENDING. No hardware operation or
installable firmware was produced.
