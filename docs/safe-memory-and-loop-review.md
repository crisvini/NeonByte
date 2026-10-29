# Safe Memory and Main-Loop Review

## Authorized Scope and Design

The original 2026-10-28 optimization cycle worked only on `integration/spotify-marquee-gif-smoothness`,
starting at `12b23a1`, and compares the retained private `4531e23` and `12b23a1`
artifacts. Preserve independent marquee motion, endpoint pauses, static short
text, cover priority, all 60 animation frames, delays, clocks, and the existing
keyframe read coalescing. No device access, inbox copy, credential change,
commit, push, merge, or replacement of an existing private package was authorized
in that original cycle. The separately authorized 2026-10-29 commit/package
closeout is documented in [optimized firmware finalization](optimized-firmware-finalization.md).

The selected memory change reuses the playback encoded-row workspace for two
bounded ASCII metadata caches while Spotify is active. Its capacity becomes
512 bytes; the decoder still receives exactly 480 bytes. Cover pixels keep their
separate 480-byte row. Marquee timing/length/offset state stays separate. Entering
Spotify always repopulates both text caches; entering GIF always opens the
decoder, invalidating its prefetched header before the workspace is read again.
Use an ordinary byte array, without unions, heap allocation, or borrowed metadata
pointers. Test repeated scene changes while a keyframe header is prefetched.

Alternatives: field reordering alone saves little; lossy hashes or borrowed
metadata cannot safely replace content comparison; sharing the cover output row
would conflict with cover loading. No such changes are selected.

Add only four accumulated millisecond maxima for HTTP, startup, display, and
background service, exposed through a separate authenticated loop-diagnostics
route. Preserve the original diagnostics response's exact field set, because
the deployed maintenance client rejects additional fields there.
These inclusive stage durations distinguish startup from steady playback without
per-frame logging or allocation. They do not identify individual flash/SPI/radio
operations or correlate a historical maximum with a specific animation frame.

## Execution Plan

- [x] Attribute the static RAM difference using retained ELF symbols and sections.
- [x] Add memory-budget, full-length metadata, and workspace scene-lifetime tests;
  observe the budget failure before changing production code.
- [x] Reuse only the inactive encoded workspace, retaining decoder read bounds.
- [x] Test loop-stage accumulation, clock rollover, stage attribution, and
  authenticated bounded diagnostics before adding the instrumentation.
- [x] Run repository/offline/native/sanitizer/display/cover/loop tests and both
  existing compilation-only ESP8266 profiles.
- [x] Only after tests pass, compile a uniquely named private candidate offline
  with the unchanged existing identity and equivalent flags/dependencies.
- [x] Record section/symbol/flash/binary/stack evidence, remaining physical
  limits, and the recommendation. Keep live resource floors pending.

## Origin of the Additional 524 Bytes

The retained private ELFs, examined with `xtensa-lx106-elf-size -A` and
`xtensa-lx106-elf-nm -S -C`, account for the entire difference:

| Private artifact section/object | Installed `4531e23` | Integrated `12b23a1` | Change |
|---|---:|---:|---:|
| `.data` | 1,748 B | 1,748 B | 0 B |
| `.rodata` | 5,896 B | 5,892 B | -4 B |
| `.bss` | 38,728 B | 39,256 B | +528 B |
| `neonbyte::display`, included in `.bss` | 2,816 B | 3,344 B | +528 B |
| `neonbyte::http`, included in `.bss` | 8,336 B | 8,336 B | 0 B |
| `neonbyte::storage`, included in `.bss` | 1,372 B | 1,372 B | 0 B |
| Total static RAM | 46,372 B | 46,896 B | **+524 B** |

Target-compiler layout probes confirm that the former 18-cell `SpotifyText`
occupies 22 bytes with alignment 2, while each integrated `SpotifyMarquee`
occupies 280 bytes with alignment 8. Two instances add 516 bytes; the added
`displayNowMs_` adds 8 bytes, and enclosing-object padding adds 4 bytes. Together
these explain the display object's 528-byte increase. The small `.rodata`
difference is independent of the object; this review does not assign its exact
four bytes to a particular pooled literal. The decoder's retained-header offset
used existing padding; it did not grow the retained private HTTP/storage objects.

The long text caches are necessary for complete marquee text. The opportunity
is their lifetime: the encoded GIF row is idle while those caches are used.

## Applied Changes and Actual Gains

- `SpotifyMarquee` now contains only its independent 64-bit timestamp, length,
  pixel offset, and direction: **16 bytes**, with natural alignment 8. No packed
  attributes, shortened clocks, hashes, or borrowed `NowPlaying` pointers.
- Removing the two resident 256-byte text arrays and associated padding saves
  528 bytes. Growing the existing encoded workspace from 480 to 512 bytes costs
  32 bytes: **496 bytes saved in `DeviceDisplay`**, now 2,848 bytes.
- The two 256-byte ASCII caches occupy that workspace only in Spotify. The
  decoder still receives a capacity of 480, and its retained header remains
  intact throughout GIF playback. Scene entry always rebuilds the relevant
  contents. Cover output uses its original independent 480-byte row.
- Four accumulated stage maxima cost **16 bytes** in the HTTP object, now
  8,352 bytes. The path and JSON formatting for the new route are in flash.
  Net static saving versus `12b23a1`: **480 bytes**, recovering 91.6% of the
  524-byte increase. Static RAM remains 44 bytes above the installed private
  build. This is not a heap prediction.
- No per-frame allocation, new framebuffer, frame skipping, clock change, delay
  change, decoder rewrite, or additional playback source read was introduced.
  Each field retains its own pauses/motion, short text remains static, and a
  pending cover still takes priority over marquee updates.

Existing allocations were inspected, not moved onto the stack: HTTP JSON bodies
up to the existing limit plus a terminator, at most 1,024 bytes for an upload
chunk, hash-job/file-source objects, and application scene/protocol objects.
LittleFS cover loading still opens a file and compares its track prefix for
every output row. Caching that file or sharing HTTP validation memory with
playback would require broader lifecycle/error changes and could change heap
fragmentation or upload isolation; neither was selected in this cycle.

## What the 1,109 ms Value Measures

`DeviceHttpServer::tick()` compares successive monotonic timestamps supplied at
the top of `loop()`, clamps the difference to `UINT32_MAX`, and retains the
maximum since boot. It does not reset when diagnostics are read or when Spotify
or GIF becomes active. The first timestamp is excluded. HTTP work, startup,
display, storage operations, SDK/background work and cooperative waits between
subsequent timestamps all contribute. A `yield()` services the SDK; it does not
reenter the application HTTP loop. `resetReason: 0` does not localize the gap.

The user's 1,109 ms is evidence of a service gap, not a measurement of a GIF
frame, decoder step, or last-to-first transition. Its time within the boot and
the active scene were not recorded. In particular, it may include startup.

| Path | Evidence in the installed/cached source | Remaining uncertainty |
|---|---|---|
| LCD/application startup | GFX resets the LCD with 100 + 100 + 200 ms waits; ST7789 initialization adds 150 + five 10 ms waits: **600 ms of explicit delays**, before drawing and other startup work. Startup runs after HTTP in the main loop. | Whether the observed maximum occurred in this startup iteration. Do not remove hardware initialization delays speculatively. |
| HTTP close/write | `WiFiClient::stop()` flushes pending ACKs. The cached core uses a 300 ms no-progress timeout, reset when the send buffer changes; it is not a strict 300 ms total bound. A write may also cooperate/wait. | Actual ACK/RF conditions, pending bytes and elapsed HTTP time. Keep delivery/close semantics unchanged. |
| Normal GIF seam | `restart()` resets fields without reopening or rescanning the directory. The first keyframe still draws 240 rows in separate display ticks; no one-second restart timer exists. | Real LittleFS/yield/SPI time per row and perceptible complete-keyframe latency. A multi-iteration keyframe time is distinct from one loop gap. |
| GIF open/reopen | Opening validates the header plus up to 60 directory entries synchronously. This happens on scene entry, replacement or read-error recovery, not every normal seam. | Flash/cache/RF latency during that call. |
| LittleFS and cover loading | Reads, file opens, writes, flushes, closes and promotion/rename are synchronous. Playback retains an open animation file; cover rows open their own file and reread the track association. | Cache misses, nearly full filesystem/GC stalls, media upload and promotion timing. No normal seam promotion I/O occurs without a ready candidate. |
| NBIF decoding and SPI | Each display tick decodes at most one row; restart may also do frame-zero setup in that tick. Full-keyframe pixels alone need at least 46.08 ms at 20 MHz, spread across rows. Full-screen clears are synchronous on scene entry. | Measured per-step latency, SPI overhead and SDK scheduling. These bus calculations are not physical timing measurements. |
| Wi-Fi/time/startup services | Station retries are cooperative; `configTime()` configures and starts SNTP without an explicit wait-for-time loop. SDK work also runs during yields and `delay(0)`. | SDK/RF stalls, connection retries, mount/startup duration and time callbacks on this unit. |

No blocking path was shortened without evidence that its semantics could be
preserved. In particular, reducing ACK flushing, removing yields or reset waits,
and speculative filesystem caching were rejected.

## Lightweight Instrumentation and Compatibility

Recovery-authenticated `GET /maintenance/v1/loop-diagnostics` with an empty body
returns the original `maxLoopGapMs` plus:

- `maxHttpTickMs`: inclusive duration of `http.tick()`.
- `maxStartupTickMs`: inclusive duration of `startup.tick()`, including application
  initialization when it occurs there.
- `maxDisplayTickMs`: inclusive duration of the display stage, including any
  filesystem, decoder, SPI, or SDK yield inside it.
- `maxBackgroundMs`: the final `delay(0)` and its background work.

There are five additional `millis()` samples per iteration and four maximum
comparisons. No log, allocation, histogram, per-frame event, or new work buffer
is added. Unsigned differences handle clock rollover. The overhead has not been
benchmarked on hardware. Separate maxima cannot be summed to reconstruct the
same iteration, associate a frame with the historical maximum, or separate
filesystem/SPI/SDK time inside the display stage. Sampling reports previously
completed iterations and does not reset counters. An operation that never
returns cannot update its stage maximum.

The existing `/maintenance/v1/diagnostics` retains exactly its original 13 fields.
The deployed maintenance client's exact-field validator was inspected: adding
fields there would break its existing checks. A regression failed on that
incompatible intermediate response, then passed with the separate route. No
agent, OTA admission, stock-restoration, Wi-Fi, identity or secure-storage code
was changed. Existing API v1 schemas/examples remain unchanged.

## Equivalent Resource Comparisons

Static RAM is `.data + .rodata + .bss`; linked flash is PlatformIO's program-space
total, excluding `.bss`. `.noinit` remains unchanged and outside that reported
RAM sum. Binary size is the complete combined `.bin`, including its boot image.

All comparisons use ESP8266 platform 4.2.1, core 3.1.2, compiler 10.3.0 and the
existing ESP-12E/DIO/4m3m/40 MHz flash configuration. The actual cached dependency
files are retained, not updated: ST7789 library 1.11.0, GFX **1.13.0**, BusIO
**1.17.4**. The configuration's direct older GFX/BusIO requests do not describe
the versions actually present in this retained dependency tree. Candidate
private dependency files were copied from `12b23a1` and compared by SHA-256.

### Private Profile

These are the exact retained private baseline artifacts and the fresh candidate,
with matching enabled display/OTA/stock-restore flags, maintenance-on-power-on
disabled, existing identity/profile, linked layout and 40-character Build IDs.
Private builds are compiled offline only and do not validate the target hardware.

| Private artifact | Static RAM | Linked flash | Complete binary |
|---|---:|---:|---:|
| Installed `4531e23` | 46,372 B | 386,303 B | 390,448 B |
| Integrated `12b23a1` | 46,896 B | 387,147 B | 391,296 B |
| Optimized candidate | **46,416 B** | **387,535 B** | **391,680 B** |
| Candidate minus integrated | **-480 B** | +388 B | +384 B |
| Candidate minus installed | +44 B | +1,232 B | +1,232 B |

Build ID: `neonbyte-20261028-mem-loop-exp01-12b23a1`. The restricted new directory is
`/home/crisvini/.local/share/neonbyte/private-builds/2026-10-28-safe-memory-loop-exp01-12b23a1/`.
It contains the compiler output and validation records; no Windows inbox copy or
installation manifest/package was issued. Existing package/profile/record files
and the existing identity header were checked unchanged by SHA-256.

### Public Compilation Profiles

Both baselines were freshly rebuilt from `git archive` in ignored isolated
directories. Each profile uses the same configuration/dependency cache across
all three revisions. Compare within a profile; public images have no private
identity and have different maintenance/stock gates from the private artifact.

| Profile | Revision | Static RAM | Linked flash | Complete binary |
|---|---|---:|---:|---:|
| Provisional | `4531e23` | 46,160 B | 384,643 B | 388,800 B |
| Provisional | `12b23a1` | 46,692 B | 385,471 B | 389,616 B |
| Provisional | Candidate | **46,212 B** | 385,875 B | 390,032 B |
| Integration check | `4531e23` | 46,160 B | 385,667 B | 389,824 B |
| Integration check | `12b23a1` | 46,692 B | 386,511 B | 390,656 B |
| Integration check | Candidate | **46,212 B** | 386,915 B | 391,072 B |

Compiler per-function stack reports, integrated versus candidate: loop 32 → 48 B;
display tick 112 → 128 B; Spotify renderer 96 → 96 B; text drawing 80 → 80 B;
decoder step 144 → 144 B; HTTP JSON dispatch 1,344 → 1,344 B. The 16-byte increases
are bounded scalar state/arguments, not moved text arrays. These reports do not
measure the nested stack peak, SDK callbacks, stack/heap collision or live margin.

## Test Results and Reproduction

- `npm run check`: Markdown/language/contracts, 11 root tests passed with one
  Windows-only skip; 142 agent tests passed, two optional source-GIF skips.
- `npm run test:offline`: **25/25**, normally and with ASan/UBSan.
- Complete native suite: **121/121**, normally and with ASan/UBSan, including the
  optional real NBIF fixture. Display/cover/marquee tests: **21/21**.
- New tests cover the state budget, independent full 256-character title/artist
  tails, cover loading and repeated interruption of a prefetched keyframe by
  Spotify followed by GIF reconstruction. Existing endpoint pause, short/static
  text, Unicode, rapid track, cover binding, error and timing tests pass.
- Loop probe: every pixel/delay/fault assertion passes for 14/20/48/60 frames and
  ten seams of the existing 48-frame real-GIF fixture, also under sanitizers.
  Its supplied NBIF/oracle was reused locally; original GIF source files are
  absent here, accounting for the two separate desktop test skips.
- Real fixture seam source reads: **484 at `4531e23`, 245 at `12b23a1`, 245 in the
  candidate**; bytes stay 6,888. The existing **49.38%** reduction remains intact.
  Current generated fixtures stay at 303 reads/242 ticks; the real fixture stays
  at 245 reads/244 ticks. Host simulated milliseconds are not device measurements.
- Loop timing, authenticated old/new diagnostic routes, HTTP lifecycle, NBIF v2
  HTTP validation/promotion, stock HTTP/restoration, display compatibility/color
  and synthetic deployment-guard probes pass; relevant HTTP/loop probes also ran
  with ASan/UBSan. Both public profiles and the private candidate compile.
- Independent image inspection and production structure/CRC validation pass for
  all three candidate images. Existing protected inputs remain unchanged.
- One initial native sanitizer invocation failed before execution because its
  linker omitted the non-PIE/sanitizer options. The isolated configuration adds
  `-fsanitize=address,undefined -no-pie` to linker flags as well as compile flags;
  the complete subsequent run passed 121/121. No firmware change was made for
  that host configuration failure.
- Independent review found no Critical/Important source-lifetime issues. Its
  coverage suggestions were addressed: CI runs the loop-timing probe, and that
  probe extracts the real accumulator as well as the real loop. The subsequent
  strict-client compatibility issue was found in self-review, reproduced and
  corrected with the separate route and regression described above.

Local logs, layout probes and resource JSON are under ignored
`build/safe-memory-review/`. Primary commands:

~~~sh
npm run check
npm run test:offline
NEONBYTE_HOST_SANITIZERS=1 npm run test:offline
export NEONBYTE_LOOP_FIXTURE=/home/crisvini/projects/NeonByte/build/gif-loop
uv tool run --offline --from platformio pio test -d firmware -e native
uv tool run --offline --from platformio pio test -d firmware -e native \
  -c "$PWD/build/safe-memory-review/platformio-sanitizers.ini"
python3 firmware/scripts/probe_animation_loop.py --source-ref 4531e23 --measure-only
python3 firmware/scripts/probe_animation_loop.py --source-ref 12b23a1
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_animation_loop.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_loop_timing.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_http_diagnostics.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_http_lifecycle.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_animation_v2_http.py
PLATFORMIO_OFFLINE=true uv tool run --offline --from platformio pio run \
  -d firmware -e esp8266-provisional
PLATFORMIO_OFFLINE=true uv tool run --offline --from platformio pio run \
  -d firmware -e esp8266-integration-check
~~~

## Remaining Risks and Recommendation

The maintainer supplied these real measurements for installed
`neonbyte-20261028-nbif-v2-60-exp-4531e23`: application running, free heap
22,624 bytes, largest block 21,688 bytes, maximum loop gap 1,109 ms and reset
reason 0. The retained floors are **22,168 / 21,544 bytes**, giving baseline
margins **456 / 144 bytes**. Earlier archive projections are not substituted for
these current observations.

Candidate heap/largest block, minimum values during upload or scene changes,
fragmentation, actual nested stack, timing overhead, physical seam/tearing and
HTTP/Wi-Fi latency are **PENDING**. Static savings do not approve either resource
floor or explain the historical one-second event. The new stage maxima still
need to be observed on the ESP8266. Nearly full LittleFS, RF stalls, full-screen
scene clears, initialization waits and a complete 240-row keyframe remain.

For a separately authorized physical test, prefer this optimized candidate over
the uninstalled `12b23a1`: it retains the marquee and keyframe optimization while
recovering 480 bytes of static RAM. Keep the working `4531e23` installed until
that physical operation is separately authorized. Verify live floors under
Spotify, repeated covers, GIF loops and transfers; sample the separate stage
diagnostics after startup and during repeated seams, and verify pixels, delays,
responsiveness and sustained stability. Do not promote it based on linker data.

No clock/device endpoint, flash, OTA, Windows inbox, credential/identity setting,
main branch, commit, push or merge was touched by the original optimization cycle. No later phase or
physical acceptance item is marked complete.
