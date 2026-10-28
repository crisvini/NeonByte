# NBIF v2 RAM Optimization

The private ESP8266 profile was compiled locally with the retained identity,
display, OTA, and stock restore enabled, and maintenance on clean power-on
disabled. No device operation was performed. The matching profile was copied
from the archived private build, including its pinned library dependencies.

## Installed Baseline and Linked RAM

The `2026-10-28-spotify-ellipsis-v1` private build record identifies
`neonbyte-20261028-spotify-static-v1` as the build reported installed by the
maintainer. That installed build's linker report is 45,472 bytes of static RAM.
The archive does not contain live heap or largest-block diagnostics for it. The
earlier `stage3-panel-b2` observation is useful historical evidence, but is not
a measurement of the later installed build.

| Private build | `.data` | `.rodata` | `.bss` | Static RAM |
|---|---:|---:|---:|---:|
| Installed build reported by maintainer | 1,748 B | 7,020 B | 36,704 B | 45,472 B |
| NBIF v2 before this work | 1,748 B | 9,104 B | 40,416 B | 51,268 B |
| NBIF v2 after this work | 1,748 B | 5,872 B | 39,080 B | 46,700 B |

Static RAM is the PlatformIO sum of `.data`, `.rodata`, and `.bss`; it is not
free heap. The optimized build is 4,568 bytes smaller than the previous NBIF v2
build and remains 1,228 bytes above the reported installed build. The exact
runtime effect and a conservative post-OTA margin cannot be established from
these static figures. The prior manifest floors remain 22,168 bytes free heap
and 21,544 bytes in the largest free block.

## Savings With the Same Build ID

The comparison below uses a separate private build ID held constant throughout
the measurements. Its initial 51,284-byte result differs by 16 bytes from the
previous 51,268-byte build because the build ID is longer.

| Change | Static RAM after change | Incremental saving |
|---|---:|---:|
| Initial comparison build | 51,284 B | — |
| Reuse transfer workspace for the validation output | 50,804 B | 480 B |
| Keep HTTP error messages in flash | 48,384 B | 2,420 B |
| Compact the two validated frame directories | 47,984 B | 400 B |
| Keep HTTP formatting literals in flash | 47,164 B | 820 B |
| Validate rows using the existing transfer workspace | 46,700 B | 464 B |

The target linker's `.bss` symbols include 8,512 bytes for the HTTP server,
3,000 bytes for the display, and 1,372 bytes for storage. Compared with the
installed build, those objects grow by 976, 1,296, and 96 bytes respectively.
The remaining growth is dominated by the separate playback and validation
decoder states, their palettes, and the playback encoded-row buffer. The HTTP
server still retains its bounded request, response, and transfer workspaces.

The wire directory is read once into an existing row workspace at open, checked
in full, and stored in compact form. The compact record length is derived from
the next validated offset. Playback retains separate 480-byte encoded and output
rows and does not add filesystem reads per frame. Validation reads into the
existing HTTP transfer workspace and checks each codec without materializing a
second output row. Each row is consumed before the workspace can be reused.
The binary format, palettes, deltas, frame delays, chunk limits, authentication,
and atomic promotion rules are unchanged. The changes add no framebuffer or
explicit dynamic allocation.

The complete combined image is 390,752 bytes, 68,000 bytes below the Windows
inbox ceiling and 133,536 bytes below the recorded 524,288-byte guard. The
ESP8266 compiler reports 386,599 bytes of program space. Moving HTTP formatting
to flash increases program size; the RAM result does not measure dynamic heap,
stack peak, LittleFS caches, or fragmentation.

With `-fstack-usage`, the compiler reports 80 bytes for playback row decoding
and 144 bytes for the decoder step, unchanged from the earlier NBIF v2 build.
Opening a decoder rises from 144 to 160 bytes, while the validation-only row
checker reports 64 bytes. These are individual function estimates, not a
measurement of the maximum nested stack or ESP8266 heap.

## OTA and Physical Acceptance

No installable inbox pair was prepared. Reaching static parity with the latest
reported installed build requires at least another 1,228 bytes of static RAM
savings; additional headroom cannot be quantified without current diagnostics
and measurements of the candidate. Existing heap floors were not lowered.

The original approximately 20 KB GIF was not available. The existing generated
14-frame fixtures cover small and full-screen motion and verify exact RGB565
reconstruction and frame durations. Pixel-transfer lower bounds and host tests
do not establish physical FPS, perceptible progressive drawing, tearing,
flicker, Wi-Fi latency, or actual post-OTA heap. Those checks remain pending on
the clock under a separately authorized physical test.
