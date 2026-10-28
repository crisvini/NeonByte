# Animation Storage and Playback Optimization Design

**Status:** approved implementation baseline; local offline implementation and
validation were authorized by the maintainer on 2026-10-28.
**Date:** 2026-10-27. **Scope:** design based on local source inspection and public
primary sources. No device access, discovery, OTA, partition operation, credential
access, private installation firmware, or commit is authorized by that request.

The maintainer approved the recommendation below. The existing uncommitted firmware
work must be preserved. No task in
[`PLANNING.md`](../../../PLANNING.md) is completed by this proposal.

## 1. Recommendation and Decision Gate

Recommend **NBIF version 2 with independent compressed rows, exact RGB565 palettes,
and overwrite differences between fully composed frames**. Perform GIF decoding,
disposal, scaling, and difference calculation on the desktop. The ESP8266 expands
one row span at a time directly into the LCD's existing pixel memory, retaining
the current 480-byte output buffer. Preserve an NBIF v1 reader.

Start with packed palette indices and byte-oriented run-length encoding (RLE),
with raw RGB565 rows as an escape for incompressible content. Do not introduce
lossy quantization, automatic frame dropping, a framebuffer, or a general-purpose
compression dependency in the first implementation. A short-block LZ codec is a
separate, evidence-triggered extension if the benchmark misses its size target.

Include bounded application-level upload chunks and background validation in the
design. Compression alone does not fix HTTP starvation in the current server.

Before committing to implementation, benchmark the supplied 14-frame example and
a representative corpus. The actual approximately 20 KB input was not attached
and no tracked GIF/NBIF sample was found during this review. **Its compressed
output size, actual decode time, and physical FPS remain PENDING.**

## 2. Current Implementation and Evidence

| Area | Source evidence | Consequence |
|---|---|---|
| Conversion | `agent/src/media/animation.ts`, `convertGifToAnimation` | Composes disposal 2/3 and transparency, applies centered nearest-neighbor cover scaling, flattens alpha against black, then writes every full RGB565 frame. |
| NBIF v1 size | 11-byte header plus `frameCount * (2 + 240 * 240 * 2)` | Fourteen frames occupy **1,612,839 bytes**, approximately 1.54 MiB. The growth comes from removing palette, spatial compression, and interframe reuse. |
| Input limits | Same converter and `docs/development.md` | Original input 8 MiB; at most 20 frames, 30,000 ms, 1,048,576 pixels per canvas/descriptor, 4,194,304 descriptor pixels in total. Zero delay becomes 100 ms; positive delays below 20 ms become 20 ms. |
| Reading | `firmware/src/animation_reader.cpp` | Fixed v1 offsets and complete-frame sizes; no decoder state or compression support. |
| Playback | `firmware/src/esp8266/display.cpp`, `DeviceDisplay::tick` | One 480-byte row per loop; timing is measured from frame rendering start. A frame longer to draw than its delay runs late. |
| Storage | `firmware/src/esp8266/storage.cpp` | Current playback opens/seeks/closes the installed path for every read. Candidate files are closed, format-checked, hashed, and renamed. Admission retains 32 KiB. |
| Network | `firmware/src/esp8266/http_server.cpp`, `main.cpp` | One active connection. Body and SHA work are incremental, but staged format validation is currently a synchronous call. `yield()` services the SDK; it does not run this application's `http.tick()`. |
| Invalidation | Shared `assetRevision` in storage/display | A cover update can also restart GIF reading. Separate animation generation from cover invalidation in the new player. |
| Resource evidence | `docs/spotify-gif-display.md` | A prior private artifact linked 45,048 bytes of static RAM and 27,011 bytes of IRAM. These historical figures predate some current edits and are not runtime heap measurements. |
| Hardware | `docs/hardware.md`, `PLANNING.md` | ESP8266 module and maintainer-reported orientation evidence exist. Physical flash geometry, runtime memory, timing, durability, and remaining display acceptance are PENDING. |

The current code requests 20 MHz display SPI, rotation 2, MADCTL `0x00`, inversion,
and 0/0 offsets. Preserve these settings and the current fixed Spotify title and
artist fields with compact ellipses. A software
setting is not a measured bus rate or proof of display compatibility.

## 3. Alternatives

| Alternative | Storage behavior | Runtime tradeoff | Decision |
|---|---|---|---|
| Original GIF and an MCU decoder | Keeps the original small file; no conversion expansion. | LZW state, GIF semantics, arbitrary source dimensions, and frame-level scheduling consume resources and integration effort. | Benchmark candidate; not the recommended default. |
| Desktop-normalized GIF | Can resolve scaling/disposal on the PC and keep standard tooling. | Still requires an LZW decoder; re-encoded full frames can be larger than the source. | Stronger GIF candidate than arbitrary original input if direct GIF proves superior. |
| Packed palettes only | At 8 bits/pixel, roughly halves raw pixel storage; 4 bits/pixel gives roughly one quarter before overhead. | Small decoder and exact colors when the final frame fits its palette. | Useful building block; insufficient alone for the requested reduction. |
| RGB565 row RLE and differences | Exact colors; excellent for flat areas and small moving regions. | Very small state, but repeated textured patterns may compress poorly. | Simplest serious baseline in the benchmark. |
| Palettes, row RLE, and differences | Combines exact palette reuse, spatial runs, and unchanged-pixel omission. | Small bounded parser; a custom format requires shared vectors and fuzzing. | Recommended starting architecture. |
| Independent LZ blocks | Can exploit patterns that RLE misses while bounding history by block design. | More code, buffers, license obligations, and malformed-input cases. | Add only after a measured benefit justifies it. |
| JPEG/MJPEG, PNG/APNG, WebP | Some content compresses well. | JPEG adds quality loss; the other choices add decoding/compositing complexity without an established advantage here. | Exclude from the first implementation. |
| Lower resolution, fewer frames, reduced colors | Reduces storage and/or bus traffic. | Alters quality or motion. | Optional explicit user preset only after the exact path is measured. |

### Direct GIF: feasible, but not free

AnimatedGIF offers file callbacks and scanline output. Its default structure has
roughly 24 KB of buffers before application and filesystem costs; the exact target
`sizeof` must be measured. Its COOKED mode requires a canvas, and reducing the LZW
dictionary restricts accepted files. See the upstream
[header](https://raw.githubusercontent.com/bitbank2/AnimatedGIF/master/src/AnimatedGIF.h).

RAW output can preserve transparent pixels in LCD memory without a full canvas.
However, restore-to-previous may need saved pixels, and local palettes and
transparent runs need careful handling. The author documents these constraints in
the [README](https://raw.githubusercontent.com/bitbank2/AnimatedGIF/master/README.md).
GIF disposal semantics are defined by the
[GIF89a specification](https://www.w3.org/Graphics/GIF/spec-gif89a.txt).

`playFrame(false, ...)` removes the timing wait, but its implementation still
decodes a complete frame before returning. Scanline callbacks that merely yield
do not make the custom HTTP server run. A resumable decoder or carefully proven
integration would be needed; recursively calling the server from callbacks risks
mutating a file that is still being decoded. See the upstream
[implementation](https://raw.githubusercontent.com/bitbank2/AnimatedGIF/master/src/AnimatedGIF.cpp).

This does not establish that direct GIF cannot work on ESP8266. It explains why
its small file size alone is insufficient evidence for this application. Do not
ship both decoders initially. Choose GIF instead only if the same corpus passes
all quality, memory, scheduling, and compatibility gates with less total cost.

## 4. Architecture

~~~text
Original GIF on the desktop
  -> bounded GIF parse and full composition
  -> existing 240 x 240 crop, alpha flattening, and RGB565 conversion
  -> compare final RGB565 frames; choose exact palettes and row codecs
  -> NBIF v2, independent decode verification, and whole-file SHA-256
  -> capability negotiation and bounded upload requests

LittleFS candidate
  -> cooperative full structural/decode validation and SHA-256 readback
  -> frame-boundary atomic promotion
  -> persistent read handle and bounded row decoder
  -> existing 480-byte RGB565 output buffer
  -> LCD address window for changed span; no frame erase
~~~

The LCD retains all unchanged pixels. This uses its existing display memory; it
does not assume LCD readback, a second display page, DMA, PSRAM, or a tearing pin.
The desktop owns the previous/next full frames; the MCU never needs them.

### Exact composition and encoding

- Keep current descriptor/input bounds and disposal, crop, color, and timing rules.
  Verify composition against an independent GIF renderer before freezing fixtures.
- Compare **final RGB565 color values**, never palette indices. Reassigning a
  palette must not change colors in skipped regions.
- For each changed row, encode one span from its first to its last changed pixel.
  Include unchanged pixels between those ends. This caps the number of display
  windows at 240 per frame and avoids a window for every isolated changed pixel.
- Build a frame palette only when the final frame has at most 256 distinct RGB565
  values. Use 1/2/4/8-bit indices with exact RGB565 entries; do not quantize again.
  GIF local palettes can leave more than 256 colors on a composed canvas, so the
  RGB565 escape is required even though GIF image tables have at most 256 entries.
- Choose the smallest complete frame representation, including palette and row
  overhead. For each row span choose packed indices, indexed RLE, raw RGB565, or
  RGB565 RLE. Resolve ties deterministically in favor of the simpler codec.
- Frame zero is always a full keyframe. A later frame may be a delta, full
  keyframe, or hold record. Identical frames preserve their individual delays.
- Restart at frame zero after Spotify, replacement, or a decoder error. Every
  loop includes frame zero again. A special last-to-first delta is deferred.
- A delta contains replacement colors, not XOR values. Do not read LCD pixels or
  write reconstruction frames to flash.

### Proposed binary layout

Freeze this layout with cross-language vectors before implementation; all integer
fields are unsigned and multibyte fields are little-endian. Reserved fields must
be zero; unknown flags/codecs are rejected.

| Structure | Fields, in order |
|---|---|
| File header, 24 bytes | `magic[4] = NBIF`, `version:u8 = 2`, `flags:u8 = 0`, `width:u16 = 240`, `height:u16 = 240`, `frameCount:u16`, `durationMs:u32`, `fileBytes:u32`, `reserved:u32 = 0` |
| Directory entry, 20 bytes per frame | `recordOffset:u32`, `recordBytes:u32`, `delayMs:u16`, `kind:u8`, `indexBits:u8`, `paletteCount:u16`, `rowCount:u16`, `reserved:u32 = 0` |
| Frame record | `paletteCount` exact RGB565 words, followed by `rowCount` row records |
| Row record header, 6 bytes | `y:u8`, `x:u8`, `width:u8`, `codec:u8`, `encodedBytes:u16` |
| Row payload | Exactly `encodedBytes`; decodes to exactly `width` RGB565 pixels |

Kinds are 0=keyframe, 1=delta, 2=hold. Codecs are 0=raw RGB565, 1=RGB565 RLE,
2=packed indices, 3=indexed RLE. A hold has no palette/rows/payload and indexBits=0.
A frame without a palette has indexBits=0; otherwise paletteCount is 1..256 and
indexBits is the smallest of 1/2/4/8 that represents its entries. Indexed rows
require a palette. Packed indices are MSB first; unused low bits must be zero.

RLE uses a control byte: 0..127 means `control + 1` literal values; 128..255 means
`(control & 127) + 1` repetitions of the following value. Values are u8 indices or
u16 RGB565 words. Indexed RLE uses byte indices even for a smaller palette. Runs
never cross a row span. A raw escape means the selected payload never needs more
than 480 bytes. Reject extra input, incomplete values, invalid indices, and output
underflow/overflow; consume bounded input even before producing pixels.

Rows must have strictly increasing y, at most one span per row, width 1..240,
x+width<=240, and y<240. Keyframes contain all 240 rows at x=0/width=240.
The directory immediately follows the header; frame records are contiguous in
directory order, with no overlap, gaps, or trailing data. Empty hold records may
share the next offset. Validate offsets/lengths using checked arithmetic.

Keep 1..20 frames, delays >=20 ms, and sum <=30,000 ms. Proposed v2 encoded limit
is **2,359,296 bytes**; it accommodates bounded worst-case raw rows and metadata
without claiming that the device has that space. Decoded work is capped by these
dimensions/rows/frame limits. Retain the external whole-file SHA-256; this format
does not replace integrity validation with a magic/header check.

## 5. RAM, CPU, Flash, SPI, and Scheduling

| Budget | Proposed gate, not a hardware measurement |
|---|---|
| Decoder state | <=2 KiB fixed state per active decoder context: one <=512-byte input window, one <=512-byte palette, <=400-byte directory, and bounded cursors/metadata. Playback reuses the current 480-byte output row. No recursion or heap allocation per row/frame. |
| Concurrent validation | A second bounded decoder context and a separate fixed 480-byte validation output row are allowed only during replacement. A partially decoded playback row can survive a tick; validation must never overwrite it. |
| Whole feature | Target <=6 KiB extra peak live memory, including both concurrent decoder contexts, the extra validation row, upload session, filesystem handles/caches, and hashing relative to the measured current baseline. Count static and heap costs together; reduce retained directory/input state if needed rather than sharing a live output row. |
| Runtime margin | Provisional minimum free heap >=12 KiB and largest free block >=4 KiB under combined load; confirm or revise with measured network/maintenance needs before hardware acceptance. Never assume these margins exist. |
| CPU | Measure at the existing CPU profile; no 160 MHz change. Bound input bytes, output pixels, and parser steps per tick, initially <=512 input bytes and one output span. Target <=2 ms per decoder/display tick. |
| Flash | Keep the linked layout and OTA/maintenance regions unchanged. Account for code size, filesystem allocation, candidate coexistence, metadata, and 32 KiB reserve. No format or partition change. |
| I/O | Retain one installed read handle instead of reopening for every span. Use sequential buffered reads and bounded seek-to-frame-zero. Count handle cache RAM and close it before promotion. |

A full RGB565 frame is 115,200 bytes; an indexed 8-bit canvas is 57,600 bytes and
a 4-bit canvas is 28,800 bytes. None is part of the recommended runtime budget.

At a requested 20 MHz SPI rate, the pixel-only lower bound is
`115,200 * 8 / 20,000,000 = 46.08 ms` per full frame, before commands, conversion,
filesystem, SDK, and loop overhead. Thus a 20 ms full-frame delay is not feasible
at that setting, even with infinitely fast decompression. A 10% changed area has
a 4.608 ms pixel-only bound, but span windows and scheduling add time. Compression
reduces flash reads; only differences reduce the number of LCD pixel writes.

Finish the previous span's SPI transaction before returning to the main loop.
Do not hold a transaction while reading flash, yielding, or serving HTTP. The
ESP8266 core explains cooperative SDK scheduling in its
[timing reference](https://arduino-esp8266.readthedocs.io/en/3.1.2/reference.html#timing-and-delays).

Use frame-start deadlines, preserving current semantics. If a frame misses its
deadline, complete it, record lateness, and start the next frame on a rebased
timeline. Never skip a dependent delta or process an unbounded catch-up burst.
Hold records need no SPI transfer. Report an unsustainable source rate; offer a
slower preset explicitly rather than silently dropping frames.

No periodic `fillScreen`, black intermediate frame, or backlight toggle is allowed
during looping or replacement. Frame zero overwrites the previous content without
an erase. Incremental scanout can still tear: zero physical tearing is not
guaranteed without panel synchronization evidence. Measure it separately from
blanking flicker, especially for the first/full-motion frames.

LittleFS calls and flash erases are synchronous at their lower layers. Small work
items cannot guarantee a hard upper bound on every erase/GC/rename. Measure normal
and nearly full volumes; if latency fails the gate, reduce upload work or defer
replacement while preserving the installed animation. Do not promise hard real
time from an asynchronous-looking API.

## 6. Uploads and Safe Replacement

Keep one transfer session and the existing single HTTP connection architecture.
Use **separate short requests**, not HTTP `Transfer-Encoding: chunked`. Each body
retains exact Content-Length and current authentication/framing checks.

Propose an authenticated media extension under `/api/v2`:

| Route | Proposed behavior |
|---|---|
| `GET /api/v2/media-capabilities` | Advertise nbif-v1/v2, dimensions, frame/duration/encoded limits, 32 KiB reserve, and maxChunkBytes=1024. The implementation uses a conservative 1 KiB body cap to bound temporary RAM. Do not change the closed v1 status schema or claim every API is v2. |
| `POST /api/v2/animation/uploads` | JSON `{sizeBytes, sha256}`. Admit space, create candidate, return 201 with uploadId and nextOffset=0. One session; a competing begin returns 409. |
| `PUT /api/v2/animation/uploads/{id}/chunks?offset=N` | Accept 1..1024 bytes at the next offset, write <=512 bytes per loop, return 204. Replay of the immediately preceding identical chunk succeeds without rewriting; other offset/data conflicts return 409. |
| `POST /api/v2/animation/uploads/{id}/complete` | Only after exact byte receipt; seal and start background verification, return 202 immediately. Repeated completion is idempotent. |
| `GET /api/v2/animation/uploads/{id}` | Return state, nextOffset, and a stable safe error if failed: receiving/verifying/ready/installed/failed/cancelled. Retain one terminal result until a new session starts or for 60 seconds, whichever occurs first; unknown/expired IDs return 404. |
| `DELETE /api/v2/animation/uploads/{id}` | Cancel an uninstalled session and remove only its candidate; repeat cancellation is safe. |

The agent sends heartbeat/playback work between chunks, caps request retries, and
polls completion without holding the connection open. Before the next chunk it
checks pending control work. This provides request boundaries where HTTP can run
without allocating a second large parser. A stalled client can still occupy the
single connection until its bounded timeout; hostile-client concurrency is not
solved by this design.

The current agent awaits the animation upload as one synchronization job, but
calls a bounded control-service callback between chunks and validation polls.
A pending cover upload waits until the animation session ends; Spotify metadata
and heartbeat requests remain eligible. This preserves control traffic but does
not establish a bounded scheduler-cycle duration on the desktop.

Keep a 5-second per-connection inactivity limit; add 60 seconds without session
progress and a 10-minute total session deadline, including validation/promotion.
These are proposed media-session limits, not changes to existing v1 deadlines.
Update retries only on real progress, not repeated identical chunks/polls. After
reset, discard the candidate; resume across a reset is explicitly unsupported.

Replacement transaction:

1. Check actual free bytes against candidate length + 32 KiB reserve + measured
   extra allocation/metadata needs. Free bytes already exclude the installed
   asset: do not subtract it twice or count its eventual deletion as available.
2. Receive to `/neonbyte/animation.part`; keep the installed file and decoder alive.
   Detect short writes and depleted space, aborting the candidate on failure.
3. Flush/close, read back SHA-256, then fully validate every record by decoding to
   the bounded row buffer without touching the panel. Run both jobs across loop
   iterations; no synchronous whole-file validation at request completion/boot.
4. Keep serving controls and playing the old animation while validating. A verified
   candidate is not installed until promotion succeeds. Playback and validation
   have separate output rows and decoder cursors; account for both contexts at
   peak load, even when validation does not retain the whole frame directory.
5. At the current frame boundary, or immediately when GIF playback is inactive,
   close the installed read handle and atomically rename the candidate over
   `/neonbyte/animation.nbif`. Never remove the installed file first. If rename
   fails, reopen the old path and restart its keyframe. If it succeeds, increment
   only the animation generation, reopen, and start the new keyframe without
   clearing the LCD. A safe boundary means no partially decoded/painted frame;
   an already completed frame's hold interval need not expire during explicit
   replacement. Store no separate active-file pointer requiring another
   coordinated rename.
6. Report installed only after successful promotion and opening the validated
   header. A later physical read failure is a distinct runtime error, not proof
   that the old file can still be recovered after its successful replacement.
7. On startup, validate the installed asset cooperatively before playback. Never
   autoformat on failure. A `.part` file is never selected as installed content.

Upstream littlefs documents atomic rename and sync/close requirements in its
[README](https://raw.githubusercontent.com/littlefs-project/littlefs/master/README.md).
Verify them against the exact bundled ESP8266 library and flash driver using
power-cut tests; upstream design guarantees are not measured unit durability.
Preserve current maintenance mutual exclusion. Give one central media owner
exclusive rights to the candidate/sink/hash state across v1 and v2. A receiving,
verifying, or ready session rejects competing v1/v2 binary uploads (including
covers) with 409 before `selectAsset` or any shared-sink mutation. Route v1 animation
promotion through the same frame-boundary close/rename/reopen handshake.
`DeviceHttpServer::close` and error cleanup may abort only the transfer owned by
that request; a status request, disconnect, or unrelated error must never delete
a connection-free v2 candidate. Keep ownership through verification/promotion,
not just during writes.

A media session blocks application mutations that would close/unmount storage;
authenticated status, heartbeat, Spotify metadata, and mode requests remain
serviceable. Defer cover synchronization until the session ends. Check both
session state and active connections before automatic startup/maintenance
transitions. Playback must not write flash. Legacy v1's long single-request upload
retains its documented HTTP exclusivity; the new responsiveness gates apply to
the v2 path and steady playback, not concurrent service inside legacy uploads.

## 7. Compatibility and User Experience

- New firmware reads installed NBIF v1 and v2. Keep the existing v1 upload route
  and validation rules; v2 sessions accept only v2. Cover NBIC v1 is unchanged.
- New agents probe the authenticated capability route. Only a definite 404/known
  unsupported version means legacy mode; timeout/401/malformed response means
  connection/authentication/compatibility failure, not silent fallback.
- An old agent can still upload v1 to new firmware, replacing the sole installed
  animation through the existing transaction. New compressed uploads are never
  sent to old firmware. Keep `contracts/v1/` unchanged if its behavior is unchanged.
- Downgrading firmware after installing v2 is **not** transparent: old firmware
  cannot read v2. Restore an admitted v1 animation with the new firmware before a
  separately authorized downgrade. Do not present a firmware rollback as recovery.
- Keep the original GIF available on the desktop for conversion/retry, subject to
  existing session-only retention. Do not add persistent media storage implicitly.
- Preview the decoded NBIF v2 representation, not merely the browser's source GIF.
  Show original/converted bytes, reduction, frames/duration, and capacity errors.
  Keep project UI/errors in English and avoid a hidden quality downgrade.
- Preserve auto/spotify/gif, independent 45-second freshness, colors, orientation,
  fixed Spotify text, recovery identity, maintenance behavior, and OTA gates. A cover revision
  must not restart animation; animation replacement must not erase Spotify text.

## 8. Benchmark and Test Matrix

Benchmark the original sample, flat pixel art, textured motion, camera movement,
full-screen noise, static/identical frames, and tiny moving objects. Include local
palette changes, transparent checkerboards, disposal 0/1/2/3, partial rectangles,
interlacing, crop/scale inputs, a different last-to-first image, and one-frame GIFs.
Use licensed or generated fixtures and record hashes; no private credentials or
device addresses belong in reports.

Compare v1, packed palettes, RGB565 RLE+delta, recommended v2, original GIF, and
desktop-normalized GIF. Record actual bytes including metadata; conversion time;
target decoder state/code size; bytes read, seeks/opens; pixels/windows sent; frame
lateness; heap/stack; loop gaps; and control latency during transfer/validation.
Host speed is not ESP8266 throughput. Pin any benchmark library revision/license.

If RLE misses the target on repeating textures, compare one bounded LZ alternative
before expanding the format. [Heatshrink](https://github.com/atomicobject/heatshrink)
offers an incremental embedded-oriented design. Independent
[LZ4 blocks](https://github.com/lz4/lz4/blob/dev/doc/lz4_Block_format.md) are another
candidate; the container must supply lengths and bound decoded output/history.
Do not adopt either solely from generic speed or compression claims.

Portable tests must cover:

- Exact RGB565 equality with current conversion, including colors from >256-entry
  composed canvases; unchanged pixels and palette changes; all codec boundaries.
- Every truncated header/record/payload; wrong magic/version/flags; dimensions,
  offsets, integer overflow, overlap/gaps/trailing data; zero/oversized runs,
  invalid indices, padding, missing keyframe rows, unordered/duplicate y, total
  duration, excessive frame count, and encoded/decompressed resource limits.
- Repeated loops, holds, scene changes midway through a delta, restart at keyframe,
  slow rendering, monotonic timer wrap handling, and unrelated cover revisions.
- Interrupted/replayed/out-of-order uploads, authentication/framing, stale sessions,
  checksum mismatch, valid headers with corrupt compressed bodies, no space,
  short reads/writes, rename/open failure, and process restart at each boundary.
- Old/new agent and firmware combinations; new installed formats and legacy v1
  validation; pending session versus maintenance/automatic startup races.
- Fuzzed bounded C++ decoding under ASan/UBSan; independent TypeScript/C++ golden
  vectors; an upstream littlefs block emulator with injected power cuts at
  program/erase/sync/rename steps. Host filesystem rename alone is insufficient.

Physical tests are a future separately authorized work package: measure cold boot,
independent offline looping, Wi-Fi disconnect/reconnect, HTTP during display and
uploads, nearly full LittleFS, memory fragmentation, and 2-hour then 24-hour soak.
Actual power interruption or media upload writes the device and needs its own
explicit authorization. No UART or physical recovery method is assumed.

## 9. Acceptance Criteria

| Area | Pass condition |
|---|---|
| Sample size | For the actual approximately 20 KB/14-frame example, <=161,283 bytes, at least 90% smaller than v1; stretch target <=80,641 bytes, at least 95% smaller. Measure before claiming either. Failure triggers codec review, not automatic quality loss. |
| General content | Report per-fixture results and worst case. No promise that noise will compress or every GIF becomes the original size. Raw escape remains correct and within advertised limits. |
| Quality | Every reconstructed RGB565 frame equals the existing converter's verified output; no additional color quantization, changed crop, omitted frames, or changed normalized delays. |
| Memory | Fixed-state and peak-memory budgets in Section 5 met; no per-frame/row allocation, no sustained leak, and heap/largest-block/stack margins measured under combined load. |
| Playback | Correct loop/resume; no frame clears/backlight pulses; no visible blanking flicker. On the agreed sustainable corpus, at least 99% of frame starts within 10 ms of normalized schedule and no accumulating drift. Report full-frame/20 ms inputs as unsustainable if measured. |
| Scheduling | Decoder/display tick p99 <=2 ms; maximum main-loop service gap <=20 ms during steady playback and <=50 ms during upload/validation, measured including filesystem stalls. Investigate any exceedance before acceptance. |
| HTTP/Wi-Fi | On an agreed stable LAN, control request p95 <=100 ms and p99 <=250 ms during playback/upload/validation; no unexpected timeouts, heartbeat gaps >15 seconds, starvation, watchdog reset, or freshness changes caused by uploads. Fault/outage behavior is tested separately. |
| Replacement | At every injected failure, installed path resolves after restart to the complete old or complete verified new asset, never a candidate/partial file. No-space and validation failures preserve the old installed asset and mode. |
| Compatibility | Legacy v1 tests remain passing, capability fallback is explicit, and downgrade limitations are documented. |
| Hardware | Required measurements and visual acceptance recorded only after separate authorization; flash, partition, recovery, and other unsupported claims remain PENDING. |

Numerical performance/memory thresholds are proposed acceptance gates, not facts
about the current unit. If baseline or filesystem limits make them infeasible,
present measurements and revise the design with the maintainer before marking
the work accepted. Keep slow-client timeout behavior separate from healthy-LAN
latency criteria.

## 10. Risks and Mitigations

| Risk | Mitigation / remaining limit |
|---|---|
| RLE is much worse than LZW for the sample | Benchmark before firmware work; compare a short-block LZ variant or normalized GIF and return with evidence. |
| Compositing/disposal bug is preserved in the new format | Verify source conversion with an independent renderer; test all disposal/palette cases. |
| Delta applied to the wrong LCD contents | Full keyframe on scene entry, replacement, error recovery, and every loop; separate animation generation. |
| Noisy/full-motion content saturates SPI | Raw escape, cost report, explicit supported-rate envelope; no CPU-clock increase or silent quality reduction. |
| Corrupt input monopolizes the loop | Bound input/output/operations, validate all rows before promotion, fuzz and enforce deadlines. |
| Flash GC causes a stall | Real-volume measurements and reserve; throttle/defer replacement if needed. Cooperative code does not remove hardware stalls. |
| Stable reader sees old/new bytes mixed | Frame-boundary close/rename/reopen handshake; no reliance on open-file replacement semantics. |
| Upload session outlives its TCP connection | Central session ownership and explicit startup/maintenance mutual exclusion; abort/expiry tests. |
| New codec exceeds heap/code/OTA budget | Account for static/heap/cache costs and code size; retain existing image caps and deployment guards. |
| Old firmware is restored while v2 is installed | Document and test the v1-media preparation path; no automatic downgrade claim. |

## 11. Implementation Boundaries

The companion [implementation plan](../plans/2026-10-27-animation-storage-optimization.md)
divides the work into benchmark/specification, portable codec, rendering,
transactional upload, desktop integration, and verification packages. Every future
package requires explicit authorization; these are not new completed project
phases. Hardware tests, target builds, private artifacts, installation, and OTA
are separate from this planning delivery.

This proposal neither establishes installation readiness nor changes the current
NO-GO, backup, recovery, or physical acceptance decisions.
