# Spotify Layout, GIF Limits, and Color Investigation

**Date:** 2026-10-27. **Scope:** authorized offline source changes, regression
tests, controlled color fixtures and a private rebuild using the exact existing
recovery identity. No device access or OTA is included. The maintainer identifies
the current 180-degree orientation as validated; this change preserves it.
Other physical acceptance and backup/recovery gates remain pending. A later
pre-correction color-chart observation is recorded below; the corrected candidate
still needs visual confirmation.

## Current Firmware Text Behavior (2026-10-28)

The firmware now keeps title and artist fixed at x=8, y=190 and y=211,
using the existing 2x font and colors. Each 224-pixel field fits 18 font
cells; longer text displays the first 17 cells followed by smaller, baseline-aligned
`...` glyphs. Unsupported
Unicode code points still occupy one replacement cell. Only the visible text is
cached and redrawn when it changes or the scene is entered. The full metadata
and track ID remain in the scene state, and cover reads still require the full
matching track ID. The browser preview retains its earlier marquee behavior.

Native display tests cover short and long text, boundary lengths, unchanged
visible prefixes, late artwork, rapid track changes and mismatched cover IDs.
The integration-check profile is compilation-only and is not an installation
artifact. Actual LCD rendering, runtime memory and cover transfers remain pending
physical verification. A missing or mismatched cover, storage read failure, or
failed artwork preparation or transfer can independently leave the cover black;
no physical failure was diagnosed in this offline run.

The following sections describe earlier revisions and their historical results.

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

## Current Spotify Marquee Layout

The later marquee revision supersedes the earlier font-size, two-line truncation,
and preview-font details above. The cover remains 176 by 176 at (32, 4). The
physical title and artist use the built-in 2x font, with one line each at y=190
and y=211. The cover ends at y=180, leaving 10 pixels before the title; the
artist begins 5 pixels below the title's 16-pixel glyph cell. The corresponding
browser preview uses 16px text at the same coordinates and colors. Both views
have no progress bar or playback time.

Metadata values accepted by protocol v1 are kept in full, up to its 256-code-point
limit; unsupported physical glyphs continue to display as `?`. Text wider than
the 224-pixel inset width waits 1.5 seconds, then moves left by 3 pixels every
125 ms. Title and artist maintain independent positions and timers. A 24-pixel
gap separates repeated copies, so each pass returns to its starting position
without a full-screen redraw, pauses, and starts again. Track changes reset both
fields; a change to only one field resets only that field.

The LCD updates only the active 20-pixel text strip during movement. It draws
visible glyphs from fixed 256-byte metadata buffers and keeps the existing
480-byte pixel buffer; it allocates no full-screen framebuffer or dynamic text
storage. The Windows preview clips the moving field to the same 240 by 20 region
and advances it from the browser animation-frame timestamp. Its font metrics
remain browser-dependent, while placement, timing, speed, colors, and looping
match the LCD.

Native and preview tests cover short/static text, long title and artist fields,
independent movement, the initial and end pauses, track-change reset, complete
tail visibility, and unchanged cover pixels during movement. These checks do not
measure physical display latency, panel scanout flicker, runtime heap/stack
margin, or HTTP/Wi-Fi responsiveness. Those hardware measurements remain
**PENDING**.

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
budget. Conversion keeps the centered crop to 240 by 240 RGB565, up to 60 NBIF v2
frames and 30,000 ms. Each output frame needs 115,200 pixel bytes plus a two-byte delay.
NBIF v1 has an 11-byte header and a maximum file size of 2,304,051 bytes; NBIF v2
retains its 2,359,296-byte encoded-file limit. A tiny compressed original can
therefore produce a large converted file. Files over the advertised device frame
limit are rejected; conversion does not silently discard frames.

Decoded logical/frame pixels remain limited to 1,048,576 per canvas/descriptor and
16,777,216 source descriptor pixels per v2 conversion (4,194,304 for the v1 path).
Timing normalization, SHA-256 validation, atomic replacement and firmware storage
admission are unchanged. No runtime dependency is added.

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
private rebuild reuses the exact existing dependency files. The only
evidence-driven color change is the MADCTL RGB/BGR bit described below.

Initialization selects Adafruit rotation 2, MADCTL `0x00`, inversion enabled,
SPI mode 3 and 20 MHz. The dependency probe verifies the larger address window,
240 by 240 bounds and offsets 0/0. The controller documentation assigns MADCTL
bit 3 to RGB/BGR order; the physical chart supplied the unit-specific evidence
for clearing it.
See the [ST7789 controller datasheet](https://newhavendisplay.com/content/datasheets/ST7789V.pdf).

No channel-packing defect was reproduced offline. The maintainer's later physical
chart result supports the previous BGR selection as the cause of red/blue exchange.
Inversion, gamma and physical transport were not changed. Visual confirmation
after applying the RGB setting remains **PENDING**.

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

The maintainer's pre-correction physical test used `lcd-red-240.gif` and reported
the observations below. This confirms a symmetric red/blue exchange with the
other controls intact; it does not verify the corrected candidate. After manual
installation, compare the same chart as a cover and fullscreen animation,
including primary colors, neutral white/black and the existing orientation.
Keep rotation 2 and all geometry bits; do not combine byte order or inversion
changes with the MADCTL correction. Post-correction observation remains pending.

## Stage 1 Offline Color Execution

**Date:** 2026-10-27. The unchanged eight-strip reference chart was generated
locally as an NBIC cover and an NBIF animation. Their byte lengths and SHA-256
values match the generator manifest and independent `sha256sum` output:

| Fixture | Bytes | SHA-256 |
|---|---:|---|
| `primary-colors.nbic` | 115,209 | `d3f4b6b29ca9f1fa613ff6cabbe2b73ffd07dee34799d8e16e40f9534dabb908` |
| `primary-colors.nbif` | 115,213 | `53a6d6793c8920700c7c582bc825483d66464a8deeb5fb718ffff355c09af113` |

| Patch | RGB565 | NBIC/NBIF bytes | SPI bytes | Post-correction LCD appearance |
|---|---|---|---|---|
| Red | `0xF800` | `00 F8` | `F8 00` | PENDING |
| Green | `0x07E0` | `E0 07` | `07 E0` | PENDING |
| Blue | `0x001F` | `1F 00` | `00 1F` | PENDING |
| White | `0xFFFF` | `FF FF` | `FF FF` | PENDING |
| Black | `0x0000` | `00 00` | `00 00` | PENDING |
| Cyan | `0x07FF` | `FF 07` | `07 FF` | PENDING |
| Magenta | `0xF81F` | `1F F8` | `F8 1F` | PENDING |
| Yellow | `0xFFE0` | `E0 FF` | `FF E0` | PENDING |

All eight software patches retain their expected RGB565 words and little-endian
NBIC/NBIF bytes through both cover and decoded GIF conversion. The host SPI
trace emits the expected high byte first for every word. The table records only
post-correction appearances, which remain **PENDING**.

The probes used the existing cached sources without upgrading dependencies.
`firmware/platformio.ini` declares ST7735/ST7789 1.11.0, GFX 1.11.11, and
BusIO 1.17.0. The integration-check cache also has GFX 1.13.0 and BusIO
1.17.4; both declared and cached GFX source paths were checked. BusIO is not
used by the SPI word trace. Arduino ESP8266 core 3.1.2 supplies the `SPI.cpp`
write path. Reviewed dependency source hashes:

| Source | Version | SHA-256 |
|---|---|---|
| `Adafruit_SPITFT.cpp` | GFX 1.11.11 | `17ed08ec557650e7c68885d9faeffe9c68c0ce117860dd6ecaba11236581f95b` |
| `Adafruit_SPITFT.cpp` | cached GFX 1.13.0 | `7bd0deccfa0517d75135bae4eac331c690d0700ef6deabb873115183ba0de597` |
| `Adafruit_ST7789.cpp` | ST7735/ST7789 1.11.0 | `832045ba8b7fbdc0ebdb4ea7730c664e4fe2d7d50bd7bc076aada4bdddae58f3` |
| `SPI.cpp` | Arduino ESP8266 3.1.2 | `4fe5c75f4a892bafefda3239f1e6cf447d20c7c6defaac231ebfe3b7bfab1c01` |

Both GFX versions passed the eight-color wire-byte probe, including its
byte-reversal mutation check. The current compatibility probe confirms 20 MHz
initialization/drawing requests, rotation 2, MADCTL `0x00`, offsets 0/0, and
the full-screen, corner, and 176 by 176 cover windows. Host mutations to both
the prior BGR value `0x08` and stale mirrored value `0xC8` are rejected.

`npm run check` and `npm run test:offline` passed in the initial offline run.
The PlatformIO native suite subsequently passed 82/82 after the MADCTL update.

**Maintainer-supplied pre-correction physical evidence:** in `lcd-red-240.gif`,
`#FF0000`, `#7B292B`, and `#B53030` appeared blue; `#0000FF` appeared red;
`#00FF00`, `#808080`, `#FFFFFF`, and `#000000` appeared correct. This matches
the symmetric RGB/BGR exchange signature while preserving green and neutral
controls. The source now sends MADCTL `0x00` instead of `0x08`. The RGB565
conversion in the agent is unchanged.

**Post-correction state:** host validation confirms MADCTL `0x00`, rotation 2,
offsets 0/0, inversion, SPI mode 3/20 MHz and the existing address windows.
Native tests reject the old `0x08` and stale `0xC8` settings. A private candidate
is prepared using the exact existing recovery identity; its confidential
manifest retains path, size and SHA-256. The maintainer has not yet observed the
corrected candidate on the LCD. Confirm red, green, blue, gray, white, black,
secondary colors, orientation, borders, Spotify layout and flicker after manual
installation. Keep the original GIF/NBIF and checksum before any test that
replaces the installed animation.

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
