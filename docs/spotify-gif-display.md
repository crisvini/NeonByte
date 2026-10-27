# Spotify Layout, GIF Limits, and Color Investigation

**Date:** 2026-10-27. **Scope:** authorized offline source changes, regression
tests, controlled color fixtures and a private rebuild using the exact existing
recovery identity. No device access or OTA is included. The maintainer identifies
the current 180-degree orientation as validated; this change preserves it.
Other physical acceptance and backup/recovery gates remain pending.

## Spotify Composition and Invalidation

The cover grows from 144 by 144 to 176 by 176 at (32, 4), horizontally centered
inside the 240 by 240 LCD. The firmware keeps the built-in font at size 1, with
6 by 8 character cells. Title rows begin at y=188 and y=200; artist rows begin
at y=218 and y=228. Each field has up to two 37-character rows and ends with
three ASCII dots when truncated. Unsupported Unicode code points still produce
one question mark each; no UTF-8 byte sequence is split into multiple glyphs.
Supporting additional physical font glyphs remains outside this change.

Two 74-byte visible-text caches replace the periodic redraw timer. The renderer
checks field contents on every cooperative tick but paints a field only when its
visible text changes or Spotify is entered from another scene. Shorter metadata
clears both old rows of that field. Progress changes and asset revisions do not
invalidate text. Changing an asset revision restarts only the cover rows. Changing track IDs first
clears the 176 by 176 cover rectangle before new metadata is painted, preventing
old artwork from appearing beside a new title; new pixels still stream one row
per tick. This one-time rectangle clear is synchronous and requires physical
latency measurement. The whole LCD is cleared only on actual scene entry or
existing startup/setup.

Artwork and missing-cover black pixels are sent one row per tick. Cover sampling
uses `floor(x * 240 / 176)` and `floor(y * 240 / 176)` from the original NBIC data.
Track-bound storage is unchanged. A late cover revision is drawn with no metadata
erase. Both cover and GIF rendering retain the existing 480-byte pixel buffer;
there is no full-frame allocation. The visible-text caches add 152 bytes including
length fields, while the removed redraw timestamp saves 8 bytes before alignment.

The dashboard uses the same cover coordinates and two bounded metadata fields.
Its existing 12px title and 10px artist fonts remain unchanged. It fits Unicode
code points using measured browser widths rather than slicing UTF-16 code units.
Browser fonts and Unicode glyph support already differed from the physical
6 by 8 font; the preview is a composition preview, not an exact glyph raster.
Progress bars and playback times are removed from both views. Protocol v1 retains
duration/progress/timestamps and existing correction logic for compatibility.

## Auto and Installed GIF Preservation

Scene selection, manual modes and the independent 45-second heartbeat and metadata
expiry rules are unchanged. Auto shows Spotify only for fresh confirmed playback;
pause, no playback or expiry returns to the installed GIF. Native display tests
exercise that switch through the real renderer and verify frame zero is read from
the previously installed asset. Existing offline tests retain persistence,
interrupted replacement, zero-capacity replacement and process-restart coverage.

## Original GIF and Converted Storage Limits

The panel now explicitly describes 8 MB as the original GIF input limit on the
Windows agent: exactly 8 MiB, or 8,388,608 bytes. It is not a device animation
budget. Conversion keeps the centered crop to 240 by 240 RGB565, up to 20 frames
and 30,000 ms. Each output frame needs 115,200 pixel bytes plus a two-byte delay.
NBIF has an 11-byte header, so its maximum is 2,304,051 bytes. A tiny compressed
original can therefore produce a large converted file. Files over the frame limit
are rejected; this change does not silently discard frames or increase limits.

Decoded logical/frame pixels remain limited to 1,048,576 per canvas/descriptor and
4,194,304 across descriptors. Timing normalization, SHA-256 validation, atomic
replacement and firmware storage admission are unchanged. No runtime dependency
is added.

Before uploading an animation the agent checks its converted length against the
device's reported free storage, retaining the existing 32 KiB staging reserve and
installed asset. Insufficient space produces a distinct `blocked` dashboard state
with advice to choose fewer frames and confirmation that the installed GIF remains
available. Synchronization and heartbeats continue, and each subsequent cycle
rechecks space; ordinary communication failures retain existing retries. A device
413 response also maps to a fixed safe capacity message without echoing its body.
The status check is advisory: filesystem allocation or concurrent changes can
still reject an upload with the existing generic conflict/retry behavior.

## Color Investigation

The conversion tests verify red `0xF800`, green `0x07E0`, blue `0x001F`, white,
black, cyan, magenta and yellow through both GIF palettes and RGBA cover inputs.
NBIF/NBIC store each RGB565 word little-endian; the renderer explicitly rebuilds
the numeric 16-bit word and passes it unchanged to `SPI_WRITE16`.

The installed GFX `SPI_WRITE16` delegates to ESP8266 `SPIClass::write16`.
The driver initializes SPI with `MSBFIRST`; the core swaps the word into its
transmit register so high byte precedes low byte on SPI. A host probe compiles
these actual dependency function bodies with register/transport doubles, verifies
all eight color byte pairs and detects an intentionally reversed byte-order input.
This validates software packing, not electrical transport or panel scanout.

There is a preexisting dependency-resolution discrepancy: the configuration
declares GFX 1.11.11 and BusIO 1.17.0, but both the previous private build's cached
libraries and the local integration environment contain GFX 1.13.0 and BusIO
1.17.4. Their actual source versions are recorded for this investigation. The
private rebuild reuses byte-identical dependency files; no library or color
configuration change is used as a speculative fix.

Initialization still selects Adafruit rotation 2, MADCTL `0x08`, inversion enabled,
SPI mode 3 and 20 MHz. The dependency probe verifies the larger address window,
240 by 240 bounds and offsets 0/0. The controller documentation assigns MADCTL
bit 3 to RGB/BGR order; it does not identify this unit's required panel setting.
See the [ST7789 controller datasheet](https://newhavendisplay.com/content/datasheets/ST7789V.pdf).

No channel-packing defect explaining the reported purple reds was reproduced
offline. BGR choice, panel inversion behavior, gamma and physical transport remain
candidates requiring controlled observation. The existing settings are preserved;
physical color fidelity remains **PENDING**.

## Controlled Color Fixtures

Generate fixtures locally without enabling device integration:

~~~sh
cd agent
node --import tsx scripts/prepare-display-colors.ts
~~~

The ignored `build/display-color-fixtures/` directory contains a reference PNG,
NBIC cover, one-frame NBIF animation and a manifest with RGB565 words, asset bytes,
expected SPI bytes and SHA-256. Eight vertical strips, each 30 pixels wide, are
red, green, blue, white, black, cyan, magenta and yellow from left to right.
The generator performs no device request.

A future separately authorized hardware test should first compare the same
unchanged chart as a cover and fullscreen animation, recording primary colors,
neutral white/black and the existing orientation. Matching host values with
incorrect physical channels would narrow the investigation beyond conversion.
Only then compare one controlled setting at a time, preserving rotation 2 and
all geometry bits; do not combine byte order, BGR and inversion changes.
No such test was performed in this task.

## Offline Verification and Private Artifact

Repository checks passed 62 agent tests, TypeScript build/type checks, Markdown,
language policy and 9 root tests with one Windows-only skip. All 82 native tests
and 20 offline integration scenarios passed both normally and under ASan/UBSan.
The existing HTTP lifecycle, diagnostics, stock HTTP and compatibility probes and
the new SPI color probe passed under ASan/UBSan. The real-SHA-256
stock-restoration transaction probe and synthetic deployment-guard tests passed. Independent review identified one stale-artwork
issue; a failing regression reproduced it and the final native suite verifies
the cover-only clear correction.

Both existing ESP8266 profiles and the same private profile compiled without
network access. The final private image is 368,064 bytes, below the unchanged
458,752-byte preparation cap. Linked static RAM is 45,048 bytes, an increase of
144 bytes over the previous private image; IRAM remains 27,011 bytes. These are
linked budgets, not measured runtime free heap or stack margin.

Independent Python inspection and the production C++ validators accepted the
combined E9 image, segment XOR and modern whole-image CRC. SHA-256 calculations
agree. The existing recovery header and credential record remain byte-identical;
both recovery values are present in the previous and new private binaries without
being printed. Actual dependency files, feature gates, DIO/40 MHz declaration,
4m3m linked addresses and maintenance-on-boot selection are preserved. The private
artifact and non-secret manifest have mode 0600 under a 0700 directory outside
Git; no new credentials were generated. Exact artifact details are recorded in
that local manifest; credentials are never included in public documentation.

Physical colors, sustained radio/display responsiveness, runtime free heap, actual
flash geometry and independent failed-boot recovery remain unmeasured. Offline
success does not advance any physical acceptance checklist or authorize OTA.
