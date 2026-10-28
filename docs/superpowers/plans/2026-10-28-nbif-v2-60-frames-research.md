# NBIF v2: 60-Frame Feasibility and Proposed Plan

**Date:** 2026-10-28. **Status:** research complete; stages A–C implemented and verified offline under the maintainer's authorization. Offline builds of the two existing ESP8266 profiles were also explicitly authorized and completed. Runtime resource acceptance and physical playback remain pending. Device access, OTA, flash, installation packaging, commits, and merges are not authorized.

**Goal:** accept up to 60 frames through NBIF v2 while preserving source frame count, normalized delays, exact RGB565 output, bounded device memory, and existing NBIF v1/v2 files.

**Baseline:** `research/nbif-v2-60-frames`, created from current `main` at `286689a3e31edbbbfdc95af4d61646ce309ff7a4`. The checkout was clean. SSH fetch failed authentication; HTTPS fetch succeeded without changing the configured remote. Local `main`, `origin/main`, and the new branch had the same commit before this report was added.

The maintainer reports working NBIF v2 on an ESP-12F/ESP8266 with a 240 × 240 ST7789. That supersedes older documentation's statements that no device has run NeonByte for this specific fact. It does not establish the current installed build ID, free heap, largest block, flash capacity, filesystem free space, physical SPI throughput, or recovery behavior. Those measurements remain **PENDING**. No historical acceptance checkboxes were changed.

## 1. Recommendation

**60 is a reasonable NBIF v2 admission ceiling, with conditional playback feasibility.** Frame count is not the main playback cost. The number and width of row spans, decoder/filesystem overhead, and the requested delays determine whether an asset runs smoothly. Keep independent limits for encoded bytes, duration, source decoding, safe replacement space, and measured playback cost.

Keep the existing 240 × 240 geometry, 2,359,296-byte NBIF v2 ceiling, 30,000 ms duration ceiling, 480-byte rows, 1,024-byte upload chunks, 512-byte upload/hash steps, and 32 KiB storage reserve. Retain the NBIF v2 binary layout and NBIF v1's existing 20-frame limit. Do not increase CPU/SPI clocks or change partitions as part of this proposal.

The real astronaut is a promising candidate: its selected v2 records project to **229,645 bytes**, with 47 delta frames requiring only **6.64–8.47 ms of pixel transfer each** at the requested 20 MHz. This is not an LCD timing measurement. The 148–172 delta spans per frame still require substantial loop/filesystem work.

There is a strict limitation: every loop currently redraws frame zero as a complete keyframe. Its pixel transfer alone takes **46.08 ms**, exceeding a 40 ms period at 25 FPS. This applies even to otherwise small-motion content. Uniform 40 ms presentation of every frame cannot be promised with the current renderer and clock. Measure the loop seam and distinguish bounded lateness from accumulating drift before accepting this asset.

## 2. Real Assets and Research Method

The supplied files were read directly from the Windows desktop through `/mnt/c`. Neither original was modified or copied into Git.

| Property | Astronaut | Polish Waiting control |
|---|---:|---:|
| Source filename | `2576ab3a50ccdae861fc5abcfa20a1dc.gif` | `Polish Waiting GIF by Loud Lacquer.gif` |
| Source bytes | 595,533 | 20,304 |
| Source geometry | 800 × 600 | 220 × 220 |
| Image frames | 48 | 14 |
| Original delay per frame | 40 ms | 100 ms |
| Total duration | 1,920 ms | 1,400 ms |
| Sum of source descriptor pixels | 8,442,009 | 312,988 |
| Largest descriptor | 480,000 pixels | 48,400 pixels |
| Disposal | 1 on every frame | 1 on every frame |
| NBIF v1 bytes at 240 × 240 | 5,529,707, research intermediate only | 1,612,839 |
| NBIF v2 bytes | 229,645, projected record sum | 53,489, complete validated file |
| Reduction against v1 | 95.85% | 96.68% |

Source SHA-256 values:

- Astronaut: `0635229c96f86f29c0bf5d0bd8c1cffdb88bbdc9f8db414566c6f8c4d919bdec`.
- Polish Waiting: `d79a0eabf792bace74042eb937ef653fb504eca7ca3a115f6d05bc77d046e19a`.
- Complete Polish Waiting NBIF v2: `18463a47694680e1fa72b74b1fea74b5687e3b621e8b1a4622314da74b1e8bd8`.

The unchanged production converter rejects the astronaut at 20 frames. Setting only its existing `maxFrames: 60` research option then rejects the 4,194,304-pixel cumulative budget. For analysis, `convertGifToAnimation` was invoked with its existing options `maxFrames: 60` and `maxTotalFramePixels: 16_777_216`. It composed every original frame with the existing crop, disposal, transparency, and RGB565 conversion. No source code or defaults were changed.

The existing v2 encoder and decoder still reject complete files above 20 frames. Consequently, no complete 48-frame NBIF v2 was generated. Instead, the unchanged encoder encoded frame zero alone and each subsequent adjacent pair. Its frame selection depends only on the current and previous frame. Summing the selected records plus `24 + 48 × 20` projects the future complete file size. Each selected pair was independently decoded and compared exactly with the composed RGB565 pixels and 40 ms delay. This proves those record choices, not complete 48-frame file validation or firmware playback.

Astronaut record analysis:

- One keyframe and 47 deltas; 69–72 exact palette entries per frame.
- 7,737 total row spans; 1,027,942 RGB565 pixel bytes sent to the LCD per loop.
- Pixel-only transfer: 411.18 ms per 1.92-second nominal loop; median 7.77 ms per frame, p95 8.45 ms, maximum 46.08 ms for frame zero.
- Delta frames contain 148–172 spans. Their 6.64–8.47 ms pixel time excludes commands, two reads per span, palette work, HTTP, Wi-Fi, and yields.
- Completing 7,737 spans in 1.92 seconds requires about 4,030 row-producing loop iterations per second, plus decoder transition/palette iterations.
- One WSL/Linux Node.js 22.12.0 process measured about 517 ms for composition and a maximum RSS of 239,184 KiB across the research run. RSS includes tsx, earlier rejected parses, the retained v1 output, and repeated pair encodes. It is neither isolated conversion peak nor Windows-native performance.

The Polish Waiting asset was converted and fully decoded with the unchanged production v2 path. All 14 RGB565 frames matched the retained v1 copy exactly; all 100 ms delays survived. It sends 200,694 pixel bytes in 1,867 spans per loop. This supplies a real regression control, not a substitute for the astronaut or a 60-frame test.

## 3. Existing Limits and Their Locations

| Area | Current behavior and relevant files/functions | Classification |
|---|---|---|
| GIF input | 8,388,608 bytes in `animation.ts:48`, `server.ts:17`, and browser `MAX_GIF_BYTES` | Desktop admission policy; unrelated to compressed device size |
| Source frame count | `DEFAULT_LIMITS.maxFrames = 20`; `convertGifToAnimation()` at `agent/src/media/animation.ts:207` rejects before decompression | Policy backed by current pipeline budgets |
| Source canvas/descriptor | 1,048,576 pixels per canvas/descriptor; `assertDimensions()` also uses this default directly; `validateGifFrameDescriptors()` checks bounds before LZW | Desktop safety budget, not LCD resolution |
| Total source descriptors | 4,194,304 pixels in `validateGifFrameDescriptors()` | Desktop CPU/retained-decoding budget; astronaut exceeds it |
| Output resolution | 240 × 240 in agent format/converter, firmware reader/decoder, capabilities, and browser | Current format/profile contract; unchanged |
| v2 frames | `NBIF_V2_MAX_FRAMES = 20` in `animation-format.ts:6`; encoder checks at `animation-encoder.ts:226`; decoder checks at `animation-decoder.ts:181` | Implementation/admission limit, not binary field capacity |
| Firmware v2 frames | Independent `MAX_FRAMES = 20` in `animation_decoder.cpp:11` | Implementation limit; must agree with allocation and capabilities |
| v2 bytes | 2,359,296 in agent format, `animation_decoder.h:14`, `animation_upload.h:12`, and v2 schemas | Deliberate storage/admission ceiling; not format u32 capacity |
| Duration/delay | Sum ≤30,000 ms; each normalized delay ≥20 ms; delay is u16 | Policy and timing compatibility; sufficient for 48/60 frames at 25 FPS |
| v2 directory | Wire entries are 20 bytes; compact entries are 10 bytes; 20 entries consume 200 bytes per decoder | Fixed resident RAM proportional to maximum count |
| Directory scratch | `AnimationDecoder::open()` at `animation_decoder.cpp:96` reads the entire wire directory into a 480-byte caller row | Actual safety coupling; 60 entries need 1,200 bytes and cannot fit |
| Directory guards | `animation_decoder.h:19` asserts `20 × 20 <= 480`; codec test asserts decoder size ≤832 B; HTTP header asserts server size ≤8,600 B | Deliberate memory guards; must be reviewed, not deleted |
| Playback rows/palette | Display owns separate 480-byte encoded and output rows; each decoder has a 512-byte palette | Fixed bounded working set independent of frame count |
| Validation rows | `DeviceHttpServer` uses its existing 512-byte `chunk_` as encoded workspace, with no output row; separate decoder remains resident | Existing RAM optimization to preserve |
| Legacy v1 | `ANIMATION_MAX_FRAMES = 20` in `animation_reader.h:9`; `ANIMATION_BYTES_LIMIT` in `http_headers.h:14` is 2,304,051 B | Existing route/file contract; leave unchanged |
| Capabilities | Firmware `dispatchAnimationV2()` emits literal `maxFrames:20`; schema has `const:20`; client `validMediaCapabilities()` requires equality to 20 | Protocol/validation coupling, not a UI-only limit |
| Browser | `decodeAnimationV2()` in `app.js:286` rejects >20; `index.html:112` advertises 20 | Independent validation and UI policy |
| Filesystem capacity | `PersistentStorage::freeBytes()` reads runtime LittleFS totals; 4m3m profile has nominal `0x100000–0x3FA000` | Runtime storage constraint; linked geometry is not measured installed capacity |
| Replacement reserve | Candidate bytes +32 KiB must fit in currently free storage in `AnimationUploadSession::begin()` and `PersistentStorage::begin()` | Safety budget; installed file already counts as used storage |
| Upload work | 1,024-byte requests, ≤512-byte write/hash steps; separate candidate; independent decode verification | Bounded memory/work, unchanged for 60 frames |
| Upload lifetime | 60-second session inactivity, 600-second total, 60-second terminal retention in `animation_upload.h` | Transport/lifecycle policy, distinct from 30-second animation duration |
| Playback scheduling | One `AnimationDecoder::step()` per `DeviceDisplay::tick()`, at most one span write; deadlines use actual `frameStarted_` | Main-loop throughput and accumulated-delay risk |

Binary fields already have room: v2 frame count is u16, duration/file sizes/offsets are u32, and frame indices in firmware are u16. Sixty frames needs no new binary version or field widening. The one-byte row coordinates and span width support the existing 240-pixel geometry only; they are not a reason to change resolution here.

At 240 × 240, 60 full source descriptors total 3,456,000 pixels and already fit the desktop's current cumulative budget. At 256 × 256, 60 total 3,932,160 and also fit. Sixty full 300 × 300 or 512 × 512 descriptors fail. These outcomes were checked with the existing descriptor validator. The real 800 × 600 astronaut requires a separately bounded higher source budget.

## 4. Playback Feasibility and Timing

### 4.1 Cost follows spans rather than total frames

`AnimationDecoder::step()` reads a palette in 64-byte pieces, then a six-byte row header and at most 480 payload bytes per span. It decodes raw RGB565, RGB565 RLE, packed palette indices, or indexed RLE directly to one output row. A hold draws nothing. A delta draws one bounding span per changed row, including unchanged pixels between separated changes on that row. Count transferred span pixels rather than only changed pixels.

At most 240 output pixels are decoded per row. Packed indices require up to eight bit iterations per pixel. Palette duplicate detection compares each new entry with prior entries: at 256 entries that is 32,640 comparisons per palette, distributed across chunks. The astronaut uses at most 72 entries, hence at most 2,556 such comparisons per frame. More frames increase work per loop, but do not increase work for a frame with the same content.

Palettes and RLE reduce stored/read bytes. They do not reduce RGB565 bytes sent for a selected LCD span. Deltas and holds reduce display traffic. The encoder chooses the smallest stored record, so a keyframe selected for smaller storage can still have greater LCD cost; retain this behavior initially and measure it before considering a different encoding preference. No mandatory periodic keyframes should be added.

`PersistentStorage::readAnimationAt()` and candidate reads retain open file handles, but call `yield()`, `seek(offset)`, and `read()` for every request. Data offsets normally increase through a frame. This is not a single bulk sequential read. There are normally two reads per nonempty span, plus palette reads, and a seek back on loop restart. Optimize redundant seeks only if measurements identify them as material; do not add a large read cache speculatively.

### 4.2 SPI and the loop seam

`DeviceDisplay::writeAnimationPixels()` at `display.cpp:108` opens one window, sends RGB565 words, and closes the SPI transaction before returning. `beginAnimationFrame()` and `endAnimationFrame()` do not buffer or swap a complete frame.

At the requested 20 MHz, `115,200 × 8 / 20,000,000 = 46.08 ms` is the pixel-only bound for a complete screen. A 40 ms budget can carry at most 100,000 pixel bytes, or 50,000 pixels, even with no other work. Thus full-screen 25 FPS exceeds the bus budget. Full-screen highly compressed solid-color changes still send full RGB565 spans with this renderer.

The astronaut's deltas offer substantial bus headroom, but 148–172 row-producing iterations per 40 ms remain demanding. The current first keyframe is redrawn at every `AnimationComplete`/`restart()`, including the 47→0 transition. A longer sequence amortizes that cost but cannot eliminate its visible seam. Avoid calling a low average pixel time proof of uniformly sustainable 25 FPS.

There is no complete framebuffer or demonstrated panel synchronization in this path. Incremental drawing can show mixed old/new rows while LCD scanout continues. No blank clear/backlight pulse is needed, but absence of flicker, tearing, or visible progressive drawing requires physical observation. Adding a framebuffer, reading back LCD pixels, assuming a TE pin, or raising SPI speed is outside the small-change proposal.

### 4.3 Deadlines and cooperative services

`DeviceDisplay::tick()` at `display.cpp:151` sets `nextFrame_ = frameStarted_ + delayMs`. It avoids adding the whole decode time to every delay when rendering finishes early. However, it rebases on actual starts; a late frame permanently shifts subsequent timing. Decoder transitions take additional loop iterations, holds rebase on completion, and loop restart resets the deadline to `now`. These details can accumulate phase error across frames/loops.

First add fake-clock tests and bounded timing diagnostics. If measured/tested drift is material, use a monotonic nominal frame-start schedule through transitions, holds, and loop restart. Complete dependent deltas in order, never drop a frame, never run an unbounded catch-up burst, and explicitly report unsustainable schedules. Record actual starts, render completion, deadline misses, and cumulative phase error separately. Timestamp actual operations rather than treating the main loop's pre-HTTP `now` as a precise SPI start.

Preserving encoded delays is provable offline. Meeting every physical presentation interval is a separate claim; the unavoidable 46.08 ms keyframe prevents promising exact 40 ms starts throughout this asset. Bounded lateness and its visual effect need explicit acceptance. A schedule change must not silently substitute a lower FPS or discard frames.

The main loop services HTTP and startup before display work and ends with `delay(0)`. Upload verification also performs one decoder step per HTTP tick. Preserve these work boundaries and separate playback/validation state. Measure LittleFS GC/erase/rename stalls on nearly full volumes; small work buffers do not make synchronous filesystem operations hard real time.

## 5. Memory, Storage, and Flash Impact

### 5.1 Firmware RAM options

| Design | Resident directory impact for two contexts | Tradeoff |
|---|---:|---|
| Recommended initial candidate: 60 compact entries in each decoder | 400 B →1,200 B total, **+800 B** | Smallest conceptual change; no new per-frame directory reads after open |
| Cache only current wire entry, validate directory sequentially at open | O(1) metadata; potentially smaller than current directories | More decoder-state changes and one bounded directory read/seek per frame; preserve cached access during every row |
| Keep wire directories or enlarge row buffers to 1,200 B | Unnecessary RAM growth | Reject: does not improve playback and undoes the existing row-workspace optimization |

For the first option, open the wire directory in bounded pieces, such as one 20-byte entry or a batch that fits the existing row. Validate every entry, contiguous offsets, overflow, duration, and first-keyframe rules before exposing a valid decoder. Compact each validated entry immediately. Preserve separate caller-owned encoded/output rows and validation's reuse of the HTTP workspace. Bound and measure opening time; if cooperative opening is necessary, use an explicit pending state and never expose a partially checked file.

Changing only `MAX_FRAMES` and array length is unsafe: the old whole-directory read would overflow its scratch row. Updating all three limits without redesigning open is not an implementation option.

The existing RAM report records 46,700 B static RAM and a 390,752 B combined image for an earlier matching private profile. It is historical evidence, not a new measurement or guaranteed installed baseline. Under exactly that profile, directories alone project static RAM to approximately **47,500 B**. Palette and row sizes do not change. There is no reason for per-frame/row device allocation or growth of TCP/upload buffers. Existing bounded dynamic upload bodies, hash objects, filesystem caches, and stack still contribute to peak live RAM.

The reported HTTP object is 8,512 B; another 400 B projects 8,912 B, exceeding the existing 8,600-byte assertion. The host decoder assertion of 832 B would also need review for its +400 B directory. Do not simply remove guards. Account for the new measured object sizes and total live-memory budget, or use current-entry metadata for validation/playback if the margin is insufficient.

Historical private-manifest floors are 22,168 B free heap and 21,544 B largest block. Preserve those floors and any stricter currently approved floors; do not infer they are met by subtracting static numbers. Measure current/candidate minimums under combined load, stack high-water mark, and leak/fragmentation trends. Failure selects a smaller metadata design or pauses implementation; it does not justify lowering floors silently.

### 5.2 Encoded storage is independent of frame count

All figures below are calculated file sizes for the stated representation, not guaranteed encoder outcomes. Raw/palette cases include headers and full-frame row headers.

| Representation | 20 frames | 48 frames | 60 frames |
|---|---:|---:|---:|
| Legacy v1 RGB565 | 2,304,051 B | 5,529,707 B | 6,912,131 B |
| v2 full raw RGB565, no palette | 2,333,224 B | 5,599,704 B | 6,999,624 B |
| v2 packed 8-bit palette, 256 entries/frame | 1,191,464 B | 2,859,480 B | 3,574,344 B |
| v2 packed 4-bit palette, 16 entries/frame | 605,864 B | 1,454,040 B | 1,817,544 B |
| Wire directory only | 400 B | 960 B | 1,200 B |

The unchanged 2,359,296-byte v2 ceiling rejects some 48/60-frame assets. This is expected admission behavior. Noise and full-motion content do not have a general compression guarantee. A compact file can still be too expensive to render, and a longer static/hold sequence can be cheap.

The provisional linked LittleFS span is 3,121,152 B before filesystem allocation overhead. Installed compatibility and actual total/free space remain pending. Two 2,359,296-byte files cannot coexist there. Ignoring all other files/overhead, an equal-size old/new pair is limited to `(3,121,152 - 32,768) / 2 = 1,544,192 B` each. This is an explanatory upper bound, not a replacement admission rule.

For the astronaut, candidate plus reserve projects to **262,413 B of currently free space**. A maximum-size installed v1 plus this candidate and reserve totals 2,566,464 B before cover/configuration and filesystem overhead. Always use actual runtime free space and keep both files until verified promotion. Do not add the installed size twice to the free-space check, because it is already used storage. Do not delete the installed asset to admit a candidate.

`AnimationUploadSession`, SHA-256 readback, complete decoder validation, and `promoteAnimationCandidateAtBoundary()` already provide the desired transaction. Failed/truncated uploads, bad checksums, invalid records, no-space, and rename failures must preserve the previous asset. LittleFS documents atomic rename and sync/close durability, but the actual adapter and power-loss behavior still require fault/physical tests.

No partition, raw OTA staging, recovery region, or filesystem-format change is necessary. Program-flash growth from directory-opening logic, limit handling, worker orchestration, and diagnostics is **PENDING** until a separately authorized build. A different frame ceiling by itself does not triple firmware code. Preserve both existing firmware-size guards and maintenance/update exclusions; media storage use must not be assumed irrelevant to every legacy filesystem-staged OTA route.

## 6. Desktop Conversion Proposal

### 6.1 Why changing two numeric limits is insufficient

The current synchronous `convertGifToAnimationV2()` first calls the v1 converter, retaining all decompressed patches and composed RGB565 frames before constructing v1 bytes. It then passes frame views to `encodeAnimationV2()`, which copies them all. `validateAnimationV2()` calls a decoder that allocates and retains every reconstructed frame. Validation runs inside encoding, again in the upload route, before transfer, and when serving the preview.

At 60 frames, one set of RGB565 frames is 6,912,000 B. Several live copies, JavaScript index arrays, candidate records, and source RGBA patches increase the peak substantially. The browser also retains complete RGBA preview images: 13,824,000 B at 60 frames, excluding temporary buffers. This is acceptable to investigate on Windows, not a device allocation strategy.

The astronaut's patches alone contain 33,768,036 RGBA bytes when decoded together; the library also retains LZW pixel arrays. A source RGBA canvas is 1,920,000 B; a disposal-3 saved copy would add another canvas. Raising source budgets while retaining `decompressFrames(gif, true)` scales this avoidable retained state.

### 6.2 Bounded processing and limits

- Keep the 8 MiB input cap and 1,048,576-pixel canvas/descriptor cap. Start with a proposed cumulative descriptor cap of **16,777,216 pixels**, enough for the 8,442,009-pixel astronaut while remaining finite. Sixty full 800 × 600 descriptors would exceed it; do not imply universal high-resolution acceptance. Revisit only from measurements.
- Before LZW, validate dimensions, frame count, offsets, per-frame/total pixels, palettes, durations, GIF sub-block bounds, trailer, and LZW code-size validity. Parsing itself currently precedes the dimension/frame checks; bound parser work and allocation too.
- Use the existing `gifuct-js` single-frame `decompressFrame()` export instead of retaining every patch. Compose disposal/transparency in source coordinates, scale/crop immediately to 240 × 240, encode with only the previous/current RGB565 frame, then release the patch and unneeded canvases. The parsed compressed input may remain under the input cap.
- Resizing only after source decode cannot remove LZW cost. Do not independently resize patches or round disposal rectangles before composition: this can change sampling/transparency. Keep the current composed-canvas output as an exact oracle. A target-sized sampling compositor is an optional later optimization, not necessary for initial support.
- Avoid generating a full v1 intermediate on the v2 path. Keep a compatible v1 fallback only for assets of at most 20 frames, or produce it on demand with the original limit. `AnimationAsset.legacy` is already optional; revise the converter's narrower required-legacy return type and consumers accordingly. Never generate/upload an over-limit v1 fallback or truncate a 48/60-frame GIF.
- Refactor encoding to accumulate bounded encoded records, enforce the encoded ceiling while accumulating, and assemble the small directory at the end. Refactor validation to stream checks/reconstruction through one reusable RGB565 canvas instead of retaining every frame. Keep the existing full decoder for explicit preview/tests if useful.
- Run conversion/validation in one worker with at most one active conversion and one bounded pending request; reject excess work. Use a proposed 10-second conversion deadline, enforced by terminating the worker, and a V8 heap limit plus explicit pixel/output budgets. A worker heap limit alone does not cap external buffers or process RSS. This isolates CPU work from heartbeats, Spotify, and dashboard HTTP without new runtime dependencies.
- Measure Windows-native conversion latency, peak RSS/external memory, event-loop service gaps, cancellation, and repeated conversions. Proposed initial acceptance: target asset completes within 5 seconds, accepted worst-case inputs within 10 seconds, and conversion adds at most 128 MiB peak RSS over the idle agent. These are review targets, not measurements; revise admission limits if exceeded.

The library's installed 2.1.2 LZW implementation fills missing decoded pixels with zero after some early exits; generated patch length alone therefore does not prove a well-formed stream. Add truncation/invalid-code fixtures, strict preflight, and a cancellable decode path. If a malformed stream still becomes a valid-looking image, reject it with decoder completion checks; document any narrowly needed wrapper/library correction before implementation. Do not claim `try/catch` supplies a CPU or integrity bound.

Preserve raw 40 ms astronaut delays exactly. Preserve the existing documented normalization for missing/zero delays (100 ms) and delays below 20 ms (clamped); report that normalization rather than calling it exact preservation of every possible GIF. Test disposal 0/1/2/3, transparent pixels, global/local palettes, interlacing, partial rectangles, and repeated identical frames. Holds retain their own frame count and delay. No frame/FPS reduction or additional color quantization is proposed.

## 7. Protocol and Compatibility Changes

| Component | Proposed change |
|---|---|
| `animation-format.ts`, agent v2 encoder/decoder | Set and consistently enforce v2 maximum 60; leave v1 maximum separate |
| `animation_decoder.h/.cpp` | Shared v2 frame constant, bounded directory opening, compact 60-entry storage or measured O(1) alternative |
| Firmware `dispatchAnimationV2()` | Advertise actual v2 maximum 60 from the decoder limit rather than another literal |
| `contracts/v2/media-capabilities.schema.json` | Accept an integer frame maximum in the supported 1–60 range, including old firmware's 20; provide examples for 20 and 60 |
| `agent/src/device/client.ts` | Include typed `maxFrames`/`maxDurationMs` in capabilities, validate bounds, and compare actual asset count/duration/bytes before opening an upload |
| Browser `app.js` and `index.html` | Accept up to 60 v2 frames, retain bounds/codec validation, explain independent source/device/storage limits and compatibility |
| `animation.ts` and `server.ts` | Bounded single-frame processing, optional legacy fallback, worker lifecycle, unchanged success/error behavior where possible |
| Protocol/format docs and tests | Describe increased v2 admission and unchanged v1 limit, normalized timing, safe staging, and mixed-version behavior |

Keep all v1 schemas, routes, dimensions, file limits, checksum rules, and mode/Spotify semantics unchanged. No new media endpoint or NBIF v3 is required. Existing complete NBIF v1/v2 files remain readable. Old firmware still cannot play new >20-frame files; fail before upload with an actionable unsupported-capacity result and retain its installed file.

There is a rollout incompatibility in the existing client: it requires `maxFrames === 20`, so simply making new firmware advertise 60 breaks that old client's v2 negotiation. Update the agent first to accept 20 and 60 and honor the advertised limit; then deploy firmware only when separately authorized. An unchanged old agent using `/api/v1/animation` remains compatible. File compatibility does not imply every historical v2 client understands the new capability value.

Document `maxFrames` as the v2 transfer capability in this response; legacy v1 remains fixed at 20. Add no fields to closed v1/v2 JSON objects just to report per-format limits. Only an explicit capability `404` permits the existing v1 fallback, and only a valid ≤20-frame legacy copy may be sent. Authentication failures, timeouts, malformed capabilities, or insufficient storage must not trigger fallback.

## 8. Implementation Sequence and Execution Status

The maintainer authorized stages A–C and compile-only validation of the existing ESP8266 profiles. The results below stop at those boundaries; stage D runtime resource acceptance and stage E physical acceptance remain pending.

### Stage A: Reproducible offline fixtures and diagnostics

- [x] Extend GIF and decoder/player coverage to 14, 20, 48, and 60 frames, static holds, small motion, full changes, scattered changes, high entropy, and loop restart. Keep source GIFs outside Git and pin their source hashes.
- [x] Add optional real-asset regressions for the astronaut's 800 × 600/48 × 40 ms descriptors and RGB565 output, plus Polish Waiting pixel/delay equality against v1 and its prior v2 hash.
- [x] Record astronaut record, row, palette, span/pixel counts and pixel-bus-only lower bounds below. Exercise all-hold decoding, slow-frame delay behavior, keyframe loop restart, frame-boundary promotion, and heartbeat service during v2 upload/validation with deterministic timestamps. Physical frame starts and display timing remain unmeasured.
- [x] Verify v1's 20-frame boundary and v2's 60/61 boundary. Exercise a >480-byte wire directory with guarded playback and validation buffers; the 60-frame HTTP upload, validation, promotion, and playback probe also passes ASan/UBSan.

**Exit:** reproducible baseline and explicit evidence for the metadata/scheduling changes; no device claims.

### Stage B: Desktop conversion and backward-compatible negotiation

- [x] Introduce bounded per-frame conversion and validation, one active plus one pending worker job, a 10-second deadline, the 16,777,216-pixel v2 source budget, and on-demand ≤20-frame legacy output. Preserve exact count/delay/RGB565 assertions.
- [x] Change agent/browser v2 limits to 60 and capabilities validation to accept maxima from 1 through 60, including 20-frame firmware. Reject an over-limit asset before `POST` and do not fall back when a capability endpoint responds with an unsupported or invalid result.
- [x] Update v2 schemas/examples, format/protocol docs, preview/error text, and tests together. Preserve v1 limits and 404-only legacy fallback.
- [x] Test worker responsiveness, heartbeat service, malformed-input rejection, deadline/cancellation, and bounded queue behavior on the available Linux host. Windows-native memory and latency measurements were unavailable in this environment and are not claimed.

**Exit:** complete 20/48/60-frame assets decode exactly offline; the real astronaut fits the byte limit; older devices remain usable with compatible assets. No firmware build is needed for desktop/native validation.

### Stage C: Bounded firmware support and timing

- [x] Extend decoder admission to 60 and validate directory entries sequentially through a 20-byte stack entry. Cache only the current entry; retain caller-owned row buffers. Tests confirm the largest decoder read stays at or below 480 bytes.
- [x] Retain both row buffers, palette bounds, upload chunks, storage reserve, hashes, full candidate verification, and frame-boundary promotion. The decoder object-size guard remains in place; equivalent offline ESP8266 builds show lower static RAM.
- [x] Keep the existing delay-from-frame-start scheduling because tests did not establish a benefit from nominal-deadline changes. Preserve order, deltas, holds, cooperation, and restart at the keyframe; report timing limitations below without claiming physical frame rates.
- [x] Pass portable codec, display, upload, and pipeline tests; run the host offline suite and v2 HTTP pipeline probe normally and with ASan/UBSan. `npm run check` and `npm run test:offline` pass.

**Exit:** all portable checks pass, no overwrite or new large allocation, deterministic compatibility/timing behavior, and documented limits. Target layout/resource acceptance is still pending.

### Stage A–C execution findings

The source astronaut GIF is 595,533 bytes, 800 × 600, and has 48 descriptors of 40 ms (1,920 ms total). Its cumulative descriptor area is 8,442,009 pixels, within the v2 desktop budget. The complete v2 file is **229,645 bytes**, below the 2,359,296-byte file limit. The optional real-asset test verifies the source SHA-256, all 48 composed RGB565 frame hashes, and every 40 ms delay. The prior Polish Waiting control also matches its v1 RGB565 frames and 100 ms delays; its v2 output SHA-256 remains `18463a47694680e1fa72b74b1fea74b5687e3b621e8b1a4622314da74b1e8bd8`.

The astronaut's v2 has a 6,868-byte first keyframe (240 full-width rows, 144 palette bytes) and 47 deltas totaling 221,793 record bytes, 7,497 row spans, 6,736 palette bytes, and 513,971 transferred span pixels. Delta frames span 148–172 rows and 8,301–10,592 pixels each. Across the file there are 7,737 row spans and 6,880 palette bytes. At 20 MHz, pixel transfer alone is 46.08 ms for the full keyframe and 6.64–8.47 ms for a delta; the keyframe lower bound already exceeds its 40 ms delay. These calculations exclude row reads, filesystem/decoder work, commands, Wi-Fi, and scheduling, so they do not establish sustained 25 FPS. The current player counts a non-hold frame's delay from its start, prevents a slow render from adding another full delay, and restarts the loop at frame zero; no physical seam or accumulated-drift result is available.

No frame drops, delay rewrites, scheduler changes, whole-frame firmware buffers, or v1 limit increases were introduced. The v2 converter does not create a legacy copy; fallback bytes are generated only on demand for ≤20-frame assets. The full candidate is still hashed and decoded before it can be promoted. The existing 32 KiB storage reserve, 30-second duration limit, 2,359,296-byte file ceiling, 512-byte write/hash chunks, 1,024-byte transfer chunk, and 480-byte row buffers remain in place.

### Stage D: Target resource review

- [x] Compile the two existing offline ESP8266 profiles explicitly authorized for this task and compare linked RAM/program sizes with their equivalent baselines. Do not assume physical board compatibility or alter private credentials.
- [ ] Review expected runtime memory and the current approved heap/block floors before preparing any deployment proposal. Preserve OTA/maintenance conflicts, staging bounds, and recovery policy.

| Existing profile | Baseline static RAM | Current static RAM | Change | Baseline linked flash | Current linked flash | Current `.bin` |
|---|---:|---:|---:|---:|---:|---:|
| `esp8266-provisional` | 46,492 B | 46,160 B | −332 B | 384,935 B | 384,643 B | 388,800 B |
| `esp8266-integration-check` | 46,492 B | 46,160 B | −332 B | 385,959 B | 385,667 B | 389,824 B |

The matching baseline `.bin` sizes were 389,088 B and 390,112 B respectively, so both current images are 288 B smaller. These compile-time figures compare equivalent local profiles only; they do not measure heap, largest free block, stack headroom, a physical board, or an installable package.

**Exit:** measured target resource delta accepted. Compilation would not authorize an upload, OTA, flash, or physical test.

### Stage E: Separately authorized LCD acceptance

- [ ] Obtain operation-specific approval for deployment and physical measurements under the project's current recovery constraints.
- [ ] Compare baseline/candidate on the same clock and LAN, with exact asset hashes, timing, memory, connectivity, replacement interruption, and extended runs described below.
- [ ] Accept 60 as the published ceiling only with the supported-corpus limits and unsustainable cases documented. Stop if the real astronaut fails visual/timing/resource gates; do not silently drop frames or reduce FPS.

## 9. Test Matrix and Objective Gates

| Scenario | Offline proof | Physical acceptance still required |
|---|---|---|
| 20/48/60 frames and 21/61 boundaries | Count, delays, duration, file lengths, exact reconstruction, limits before allocation/upload | Actual sustained timing at the original delays |
| Real astronaut and Polish Waiting | Correct crop/composition/RGB565; complete 48-frame v2 after implementation; record/span counts | Astronaut at 25 FPS, keyframe seam, visual quality |
| Static/holds, small motion, scattered changes | Correct hold count/delay, spans containing separated changes, loop/reentry | Long holds, seams, absence of progressive drawing/flicker |
| Full-screen patterns, noise, large palettes | Correct raw fallback, byte-limit rejection, per-frame work bounds | Known bus-limit behavior and overload reporting; no universal 25 FPS promise |
| GIF disposal/transparency/interlacing | Oracle pixel comparison for disposal 0/1/2/3, local/global palettes, transparency, normalized timing | No additional LCD corruption |
| Malformed inputs | Truncated GIF/LZW, bad palettes/indices, descriptor overflow, source bombs, worker timeout; bad NBIF offsets/RLE/coverage/reserved data | No device mutation before complete verification |
| Directory opening | 1/20/48/60 entries, canaries, source-read failure at each boundary, no scratch overwrite, validation-only mode, restart | Opening and filesystem latency under actual load |
| Interrupted replacement | Fail each write/read/hash/verification/rename stage; cancel/replay/session expiry; restart resolves to complete old or verified new file | Approved power interruptions and LittleFS durability; retained mode and previous animation |
| Low/free-space boundary | Candidate + reserve versus runtime free space; exact boundary and concurrent allocation failures | Nearly full volume, GC stalls, cover/config coexistence |
| Mixed versions | Old/new agents/devices, capability maxima 20/60, malformed capability, 404-only fallback, unchanged v1 files | Installed legacy assets and scene reentry on target |
| Spotify/Wi-Fi/OTA coexistence | Mode/play/pause, metadata/heartbeat during conversion/upload/validation, maintenance conflicts and cancellation, legacy OTA storage admission | Real AP+STA/RF behavior, PC sleep/reconnect, measured live memory and current OTA flow |

Proposed physical gates, following the existing NBIF v2 design where applicable:

- **Integrity:** every frame and original 40 ms astronaut delay remains encoded; no skipped dependent delta, wrong colors, corruption, blanking clear, or backlight pulse. Correct restart and Spotify→GIF reconstruction from a keyframe.
- **Visual:** no visible blanking flicker, objectionable tearing, or perceptible progressive drawing on the agreed corpus. Use high-frame-rate video where possible and explicitly inspect the loop seam, upload completion, and scene switches. Host pixel equality cannot pass this gate.
- **Timing:** at least 99% of frame starts within 10 ms of the nominal schedule on the agreed sustainable corpus. Proposed no-drift check: phase error stays bounded within 10 ms over 100 loops and total elapsed differs from summed delays by no more than 1%, counting initial/loop keyframes explicitly. Report missed deadlines and maximum lateness. If the astronaut cannot meet these gates, its exact 25 FPS support remains unapproved even if every frame is valid.
- **Scheduling:** decoder/display tick p99 ≤2 ms; maximum main-loop service gap ≤20 ms in playback and ≤50 ms during transfer/verification, including filesystem stalls.
- **Connectivity:** on the agreed stable LAN, control latency p95 ≤100 ms and p99 ≤250 ms, no unexpected request timeouts, no heartbeat gap >15 seconds, no upload-induced false pause/freshness expiry, no watchdog or unexpected reset. Measure fault/outage recovery separately.
- **RAM:** no whole-frame device buffer, no per-frame allocation, proposed static growth ≤800 B for directory expansion with all added diagnostics included in the review; minimum free heap/largest block meet current approved floors, never below historical 22,168/21,544 B without a separate evidence-based decision. Stable stack margin and no sustained leak/fragmentation across a two-hour run and repeated replacements.
- **Storage/replacement:** reserve remains ≥32 KiB at admission, allocations are checked through completion, and every interrupted transaction preserves a complete valid installed asset after reboot. Small assets and near-full volumes must both pass.
- **Update behavior:** no weakening of maintenance pause/authentication/size/staging/recovery rules. Offline checks cover existing guards; actual OTA requires its own approval and current procedure, not automatic execution as part of media acceptance.

These numerical gates are proposals for review, not measurements already achieved. Do not relax them silently if the current keyframe or filesystem behavior makes them infeasible.

## 10. Main Risks and Responses

| Risk | Response |
|---|---|
| Scratch overwrite after increasing frame count | Replace whole-directory read; retain small buffers and add canary/sanitizer coverage |
| Tight RAM margin after recent optimization | Explicit +800 B bound; measure both decoder contexts and live floors; use cached current-entry metadata if needed |
| Good compression mistaken for fast LCD playback | Report spans/windows and render latency independently of file size; include the astronaut's high row count and full first keyframe |
| Accumulated delays and a visible loop seam | Fake-clock regressions, nominal schedule diagnostics, bounded overload handling, physical seam gate |
| Worker/validation memory growth or blocked Spotify | Single-frame processing, reusable validation canvas, optional legacy copy, one bounded worker, native Windows resource measurements |
| Source-resolution abuse or malformed LZW accepted | Retain canvas cap, finite cumulative budget, structural checks, bounded decoder completion, worker termination |
| Compatibility regression from literal capability checks | Agent-first rollout, accept and enforce old/new maxima, preserve v1 route and 404-only fallback |
| Interrupted replacement or filesystem stalls | Keep previous file, full readback/decode verification, boundary promotion, allocation checks, near-full/failure tests |
| Overstated hardware evidence | Separate maintainer-reported operation, offline calculations/tests, historical build reports, and new physical measurements |

The more useful long-term limit is **up to 60 frames within independent byte, source-resource, storage, duration, and playback budgets**. A separate 48-frame ceiling offers little benefit: compared with 60 it saves only 120 B of compact metadata per decoder and does not solve per-frame timing. Raising the encoded/file/partition ceiling would add risk without being needed by the measured astronaut. A new codec or format is not justified by these results.

## 11. Verification and Evidence Boundary

The original source GIFs remain outside Git. Tests use source hashes and frame hashes; no full source or generated NBIF asset was added to the repository. No real clock, connected device, LAN endpoint, OTA, flash, credential, private profile, installation package, commit, or merge was used.

`npm run check` passed: Markdown lint checked 48 files with no issues, language checks passed, root tests passed 11 with one Windows-only skip, and agent tests passed 141 with two environment-dependent real-GIF skips. Both real-GIF regressions passed when run with the source files outside Git. `npm run test:offline` passed 25/25 both with and without ASan/UBSan. Portable firmware native tests passed 110/110. The v2 HTTP probe passed a complete 60-frame upload, verification, promotion, and playback path normally and with ASan/UBSan. Both existing ESP8266 profiles compiled offline. Windows-native agent memory/latency measurements and hardware heap/largest-block measurements were unavailable; linked static RAM and program size do not substitute for those runtime measurements.

The historical RAM figures in the original research snapshot above are prior observations, not new runtime measurements. No OTA readiness or physical 25 FPS claim follows from these offline checks.

## 12. References

- [Current NBIF layout and streaming contract](../../animation-format.md).
- [Prior RAM optimization and historical private-build measurements](../../animation-ram-optimization.md).
- [Existing benchmark and its measurement limits](../../animation-codec-benchmark.md).
- [HTTP protocol and additive v2 uploads](../../protocol.md).
- [Prior NBIF v2 design, timing semantics, and acceptance proposals](../specs/2026-10-27-animation-storage-design.md).
- [GIF89a specification](https://www.w3.org/Graphics/GIF/spec-gif89a.txt): descriptor coordinates, color tables, disposal/transparency, and delay units. Use existing normalized presentation semantics consistently.
- [gifuct-js upstream](https://github.com/matt-way/gifuct-js): patch-based decoding; installed 2.1.2 source was inspected for the single-frame export, delay normalization, LZW arrays, and zero-filled short output.
- [LittleFS upstream](https://github.com/littlefs-project/littlefs#usage): atomic filesystem operations and sync/close persistence. These properties do not substitute for testing this device's adapter and flash.

**Review requested:** approve or revise the source-pixel budget, metadata RAM option, timing/visual gates, and proposed offline implementation stages. No implementation begins from this research authorization alone.
