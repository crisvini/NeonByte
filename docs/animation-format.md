# NBIF Animation Format

NBIF v2 is the desktop-compressed animation format used by the agent and the
ESP8266 player. The agent composes GIF disposal, transparency, crop, and scaling
before encoding. RGB565 values are exact; v2 does not quantize colors or drop
frames. NBIF v1 remains readable and uploadable for older agents and firmware
compatibility.

## File Layout

All multibyte integers are unsigned and little-endian. Reserved fields and unknown
flags must be zero. Record offsets are absolute from the beginning of the file.

| Structure | Fields |
|---|---|
| File header, 24 bytes | `magic[4] = NBIF`, `version:u8 = 2`, `flags:u8 = 0`, `width:u16 = 240`, `height:u16 = 240`, `frameCount:u16`, `durationMs:u32`, `fileBytes:u32`, `reserved:u32 = 0` |
| Directory entry, 20 bytes per frame | `recordOffset:u32`, `recordBytes:u32`, `delayMs:u16`, `kind:u8`, `indexBits:u8`, `paletteCount:u16`, `rowCount:u16`, `reserved:u32 = 0` |
| Frame record | Exact RGB565 palette words, then row records |
| Row header, 6 bytes | `y:u8`, `x:u8`, `width:u8`, `codec:u8`, `encodedBytes:u16` |
| Row payload | Exactly `encodedBytes`; decodes to exactly `width` RGB565 pixels |

Frame kinds are `0=keyframe`, `1=delta`, and `2=hold`. Codecs are `0=raw RGB565`,
`1=RGB565 RLE`, `2=packed palette indices`, and `3=indexed RLE`. A keyframe has
exactly 240 full-width rows. A delta has one span at most per changed row; spans
replace pixel values and never XOR with the prior image. A hold has no palette,
rows, or payload and retains its own delay.

A palette is present only when the final composed frame uses at most 256 distinct
RGB565 values. `indexBits` is the minimum of 1, 2, 4, or 8 needed for its entries.
Packed indices are most-significant bit first; unused trailing bits are zero.
Indexed RLE stores one-byte indices even when fewer bits would suffice. Palette
entries are exact RGB565 words, so palette reorderings cannot alter unchanged
pixels.

RLE controls `0..127` encode the next `control + 1` literal values. Controls
`128..255` repeat the following value `(control & 127) + 1` times. RGB565 values
are two-byte little-endian words; indexed values are one byte. Runs never cross a
row. The encoder selects the smallest complete record, including palette and row
headers, from raw RGB565, RGB565 RLE, packed indices, and indexed RLE.

Records are contiguous in directory order, without overlap, gaps, or trailing
bytes. Rows have increasing `y`, a width from 1 to 240, and `x + width <= 240`.
Files contain 1–20 frames, each delay is at least 20 ms, total duration is at most
30 seconds, and the upload limit is 2,359,296 bytes. Implementations reject
invalid indexes, malformed run lengths, truncated values, nonzero reserved data,
incorrect row coverage, and arithmetic overflow.

## Streaming and Memory

Composition and encoding run on the desktop. Playback reads the directory once,
then decodes a row span incrementally into the firmware's existing 480-byte RGB565
pixel buffer. The decoder keeps a bounded directory, one bounded palette, and one
row payload. It does not allocate a 240 × 240 framebuffer, read LCD pixels, or
write reconstruction frames to flash. On the LCD, unchanged pixels remain in
place; a delta only opens windows for rows containing a changed span.

The firmware verifies the complete SHA-256 and independently decodes every row
before marking a candidate ready. Playback promotes candidates only at a completed
frame boundary, or while Spotify is active/animation playback is idle. Failed
verification or rename leaves the installed animation intact. The same boundary
promotion applies to legacy v1 uploads; the server acknowledges v1 after promotion.

## Compatibility

New firmware reads installed NBIF v1 and v2. New agents use authenticated v2
capability negotiation and send v2 only when supported. Only an explicit v2
capability `404` allows the retained v1 copy to be uploaded to old firmware.
Existing `/api/v1/animation` uploads remain v1 and are never reinterpreted as v2.
Old firmware cannot read a v2 asset after downgrade; restore a v1 asset before any
separately authorized downgrade.
