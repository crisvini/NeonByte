# GIF Loop Transition Investigation

## Scope and Plan

The maintainer authorized offline investigation and small verified corrections to
the last-to-first-frame transition on `fix/gif-playback-smoothness`. The baseline
is `12ae4d7`. Existing branch changes are preserved. No device operation, private
build, commit, merge, protocol, Spotify, upload, or storage transaction change is
authorized.

- [x] Measure repeated transitions for 14, 20, 48, and 60 frames with the same
  deterministic fixtures and production decoder/display before and after.
- [x] Add a failing regression for redundant keyframe reads and the idle restart
  iteration; implement only the measured reductions within the existing buffers.
- [x] Verify every reconstructed pixel, frame delay, long final holds, read
  failures, raw-row bounds, scene reentry, and repeated restarts.
- [x] Run native/offline checks, ASan/UBSan, repository checks, and both existing
  public ESP8266 compile profiles. Record exact resource and timing limits.

## Initial Evidence

`AnimationDecoder::restart()` only resets fields; it does not reopen the file,
revalidate all directory entries, or add a fixed delay. Frame zero's directory
entry is read once after restart. Its palette is then read in 64-byte chunks.
The full keyframe requires 240 row-producing steps, with a header read and a
payload read per row. `DeviceDisplay::tick()` also spends one iteration returning
after `AnimationComplete` before it begins the new frame.

The installed LittleFS implementation (`lfs_file_rawseek`, Arduino ESP8266 3.1.2)
already returns immediately when the requested position equals the current
position. Removing that call cannot be assumed to eliminate a flash traversal.
Each playback source read still calls `yield()` and the filesystem read adapter.

The implemented read reduction is limited to playback of frame zero. When the next
row header fits after the current payload in the existing 480-byte encoded-row
workspace, read both together and retain only its offset in that workspace. Raw 480-byte
rows keep the old bounded path. Validation-only mode and other frames keep their
existing read behavior. A restart discards any prefetched header.

The scheduler correction processes frame-zero setup in the same tick
that observes `AnimationComplete`. It adds no row burst and preserves the final
frame's deadline and the one-row-per-tick limit.

## Supplied GIF and Likely Cause

The supplied `2576ab3a50ccdae861fc5abcfa20a1dc.gif` has source SHA-256
`0635229c96f86f29c0bf5d0bd8c1cffdb88bbdc9f8db414566c6f8c4d919bdec`.
All 48 source delays are four centiseconds; all converted delays are 40 ms,
including the final frame. There is no intentional one-second pause in this file.
The unchanged converter produces 229,645 bytes with NBIF SHA-256
`c9c799751991e8a46b3618fc576deae9a71af56707e23f9de12fd96879305228`.
Frame zero has 72 palette entries, 240 full-width rows, and 6,868 record bytes.

The strongest remaining explanation is the recurring full-keyframe workload:
240 drawing iterations, palette decoding, filesystem calls and cooperative yields,
plus 115,200 RGB565 pixel bytes on SPI. At 20 MHz the pixel-only lower bound is
46.08 ms, already longer than a 40 ms frame. Host tests demonstrate redundant
adapter calls and one idle scheduling iteration; they do not prove how much of
the observed physical second those costs account for. There is no fixed one-second
restart timer and no whole-directory rescan on a normal loop.

## Reproducible Measurements

The probe compiles the production decoder and `DeviceDisplay` against test-only
storage/panel doubles. `--source-ref 12ae4d7 --measure-only` reads baseline production
files with `git show` into a temporary directory and uses exactly the same current
fixtures, doubles and assertions. It never changes the branch or working files.
Candidate mode additionally checks the generated fixture's read/iteration bounds.
The baseline failed that read bound (482 versus 303) before production edits.

Each fixture performs ten continuous seams. Every reconstructed pixel is checked
after every frame, every decoder frame index/delay is checked on repeated passes,
and final holds of both 20 and 1,000 ms remain intact. The mixed-codec keyframe
contains raw 480-byte rows, RGB565 RLE, packed indices, and indexed RLE. The real
GIF runs ten continuous seams and compares all 48 frames against full RGB565
oracles from the unchanged desktop decoder. The existing pinned frame-hash
regression also passed for the supplied source GIF.

The seam interval starts when the final frame's delay expires and ends after all
240 rows of frame zero have been sent to the fake panel. Counts exclude the final
delay and include the directory/palette work. They stop before the following
`FrameComplete` notification. The time model charges **1 ms per source read plus
1 ms per display tick**, with no SPI cost. This intentionally exposes filesystem
and scheduling overhead; it is not a hardware timing prediction.

| Corpus | Source reads before/after | Bytes before/after | Display ticks before/after | Simulated ms before/after |
|---|---:|---:|---:|---:|
| 14 frames, mixed-codec keyframe | 482 / 303 | 34,468 / 34,468 | 243 / 242 | 725 / 545 |
| 20 frames, same keyframe | 482 / 303 | 34,468 / 34,468 | 243 / 242 | 725 / 545 |
| 48 frames, same keyframe | 482 / 303 | 34,468 / 34,468 | 243 / 242 | 725 / 545 |
| 60 frames, same keyframe | 482 / 303 | 34,468 / 34,468 | 243 / 242 | 725 / 545 |
| Supplied 48-frame GIF | 484 / 245 | 6,888 / 6,888 | 245 / 244 | 729 / 489 |

For the supplied GIF the reduction is 239 source reads (49.38%). Each source read
maps to one invocation each of `yield()`, `File::seek()` and `File::read()` in the
unchanged ESP8266 playback adapter. Those adapter invocation counts therefore
also fall by 239. The probe does not count physical flash block reads or radio
context switches. LittleFS already makes same-position seeks no-ops internally.
Actual bytes, palette contents, full row count and SPI pixel count do not change.
The first row appears on tick 6 versus tick 5 for this asset; only one idle tick
is removed, so the scheduler correction alone cannot explain a one-second pause.

## RAM and Program Size

Both public profiles were built sequentially with the existing cached/pinned
dependencies, ESP8266 platform 4.2.1, core 3.1.2, and compiler 10.3.0. The baseline
was also rebuilt from `git archive 12ae4d7 firmware` in a temporary directory with
the same dependency cache to measure the `.bin` sizes directly.

| Profile | Static RAM before/after | Linked flash before/after | `.bin` before/after |
|---|---:|---:|---:|
| `esp8266-provisional` | 46,692 / 46,692 B | 385,247 / 385,471 B | 389,392 / 389,616 B |
| `esp8266-integration-check` | 46,692 / 46,692 B | 386,287 / 386,511 B | 390,432 / 390,656 B |

The two-byte retained-header offset occupies previous alignment padding. No new
row buffer, palette cache, directory cache, framebuffer, per-frame allocation,
clock change or production diagnostic/logging is added. An intermediate version
with a separate header array added 16 bytes of static RAM; it was replaced before
the final comparison. The final flash cost is 224 bytes per profile (under 0.06%).
These are public compile-only profiles, not a private/installable image. Runtime
heap, fragmentation, stack margin and the existing 22,168-byte free-heap and
21,544-byte largest-block floors have not been remeasured or relaxed.

## Verification and Remaining Physical Work

- Native suite: 119/119 passed, including the optional real-GIF test.
- Loop probe: baseline and candidate passed their applicable pixel/delay/fault
  assertions normally and with ASan/UBSan. Candidate performance gates passed.
- Every first-keyframe source read after open is fault-injected in a dedicated
  decoder test; reopening reconstructs every pixel correctly. A display-level test
  separately fails the directory read immediately after a loop restart and verifies
  recovery from frame zero. Row-buffer canaries remain intact.
- Existing validation/playback mutation, disposable validation scratch, v1/v2,
  scene, atomic replacement and upload regressions passed in the native suite.
- Offline suite: 25/25 passed normally and with ASan/UBSan.
- NBIF v2 HTTP upload/verification/promotion probe passed with ASan/UBSan.
- `npm run check` passed: 11 root tests plus a Windows-only skip; 143 agent tests
  plus one missing optional Polish Waiting source skip. The supplied real astronaut
  regression ran and passed. Markdown, language, build and type checks passed.
- Both existing public ESP8266 profiles compiled offline; `git diff --check` passed.

Playback's dedicated encoded workspace must remain intact between steps because
it now retains a six-byte header there. All production playback callers already
own a dedicated workspace. Validation-only mode does not prefetch and continues
to allow the HTTP transfer workspace to be overwritten between decoder steps.
Open/restart invalidate the retained offset, including scene reentry. Raw rows
that leave no room for six bytes use the previous path without overreading.

Physical acceptance remains pending: compare the same NBIF on the same device,
measure the last-row-to-first-row and first-keyframe-complete gaps, separately
time filesystem/decoding/SPI, check Wi-Fi/HTTP service gaps and watchdog stability,
and verify unchanged pixels/delays/heap floors during prolonged playback. A nearly
50% reduction in adapter calls does not establish a 50% reduction in LCD pause.
The unavoidable full keyframe, bus cost and 240 row-producing iterations remain.

An independent read-only code review found no Critical or Important issues. Its
restart-directory fault-coverage suggestion is included. The optional real-asset
probe deliberately reports metrics for arbitrary supplied files rather than
hard-coding the astronaut's counts; generated-fixture read/tick gates enforce the
optimization in the standard native suite. Physical performance and live resource
acceptance were explicitly outside that review's evidence.

## Commands

Generate ignored local fixtures using the supplied source path:

~~~sh
cd agent
node --import tsx scripts/prepare-animation-loop-fixture.ts /path/to/source.gif
cd ..
export NEONBYTE_LOOP_FIXTURE="$PWD/build/gif-loop"
python3 firmware/scripts/probe_animation_loop.py --source-ref 12ae4d7 --measure-only
python3 firmware/scripts/probe_animation_loop.py
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_animation_loop.py
uv tool run --offline --from platformio pio test -d firmware -e native
npm run test:offline
NEONBYTE_HOST_SANITIZERS=1 npm run test:offline
NEONBYTE_PROBE_SANITIZERS=1 python3 firmware/scripts/probe_animation_v2_http.py
NEONBYTE_ASTRONAUT_GIF=/path/to/source.gif npm run check
PLATFORMIO_OFFLINE=true uv tool run --offline --from platformio pio run -d firmware -e esp8266-provisional
PLATFORMIO_OFFLINE=true uv tool run --offline --from platformio pio run -d firmware -e esp8266-integration-check
~~~

Use the astronaut-specific test environment variable only with the source hash
above. Other GIFs can be converted/probed without enabling that pinned regression.
Run PlatformIO jobs sequentially. Generated media stays under ignored `build/`;
the source GIF and complete oracle images are not added to Git.
