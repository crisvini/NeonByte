# SD PRO Display Orientation Correction

**Date:** 2026-10-27. **Scope:** local correction, offline tests and a private
rebuild with the existing recovery identity. No clock access or OTA is authorized.
Installation remains **NO-GO** under the existing project gates.

## Evidence and Correction

The maintainer reported that text on the real SD PRO appeared rotated 180 degrees.
This is evidence about the previous image, not an agent-run physical test or
confirmation of the corrected image, wiring, flash geometry or recovery.

The previous adapter selected Adafruit rotation 0 and then explicitly sent MADCTL
`0xC8` (MX, MY and BGR). In the pinned Adafruit ST7735/ST7789 1.11.0 driver,
initialization of a 240 by 240 panel sets two offset pairs. Rotation 0 selects
column/row offsets 0/80; rotation 2 selects 0/0 and clears MX/MY. Sending the old
manual `0xC8` after rotation 2 would restore both mirror bits while retaining
the new offsets, defeating the intended orientation.

`DeviceDisplay::begin()` now selects rotation 2 and sends MADCTL `0x08`, retaining
BGR while leaving MX, MY and MV clear. Both logical dimensions remain 240. Pins,
20 MHz initialization/drawing requests, SPI mode 3, inversion, RGB565 transport,
scene rendering and startup policy are unchanged. No display-library patch,
partition change or deployment-guard change is needed.

**Subsequent Stage 1 color correction (2026-10-27):** the maintainer later
reported a controlled test of `lcd-red-240.gif`: the three red patches appeared
blue, pure blue appeared red, and green, gray, white, and black appeared
correctly. This supports a symmetric RGB/BGR exchange. The current MADCTL value
is therefore `0x00`; rotation 2, offsets 0/0, inversion, SPI mode/frequency,
and geometry remain unchanged. The corrected candidate has not yet been viewed
on the LCD, so post-correction color acceptance remains **PENDING**.

## Offline Regression Coverage

The native display test and the probe using the pinned driver's actual method
bodies both reproduced the old orientation before the production change. The
native regression now checks the half turn and final BGR MADCTL. Existing tests
continue checking SPI/inversion, frame timing and GIF looping.

The dependency probe checks final rotation/MADCTL/offsets, initialization commands
and frequency, full-screen and last-row windows, the cover window and all four
single-pixel corners. Expected address words are literal independently calculated
values. A mutation using rotation 2 with stale MADCTL `0xC8` is rejected. The
corrected probe passed AddressSanitizer and UndefinedBehaviorSanitizer; all 75
native tests passed.

These checks exercise real driver address calculations with transport I/O doubles.
They do not simulate panel scanout, electrical timing or actual pixels. Corrected
orientation, borders and colors on the unit remain pending separately authorized
physical observation.

## Confidential Rebuild

The separate private profile references the exact previously generated recovery
header outside Git. No credential generation or rotation is part of this task.
Preparation checks require the previous header and credential record to remain
byte-identical. Final validation must check that both existing secrets remain
present in the new binary without logging their values.

The existing display, maintenance OTA and stock-restoration gates remain enabled
only as previously selected for the private candidate, with
`NEONBYTE_MAINTENANCE_ON_BOOT=1`. Display initialization still requires an
authenticated application action. The DIO/40 MHz/4 MiB declaration, 4m3m layout,
first-install preparation cap of 458,752 bytes and device-operation guard remain
unchanged. Public test binaries are not inputs to the private rebuild.

The confidential candidate and its credential-free manifest stay outside Git.
Final image validation covers exact bytes, SHA-256, E9 structure, segment XOR,
modern CRC, linked geometry, compiler flags, existing identity and restricted
permissions. No upload, device discovery, clock connection or publication is part
of validation. Full backup and independent Wi-Fi failed-boot recovery remain
unestablished.

## Final Verification Results

`npm run check` passed Markdown/language checks, 9 root tests with 1 Windows-only
skip, agent build/typecheck and 54 agent tests. All 20 offline integration
scenarios passed. The new private source build and both production image
validators passed; the final combined image is 365,104 bytes, below the unchanged
458,752-byte cap. Independent SHA-256 calculations agree. The existing identity
files and both embedded recovery secrets match the previous private candidate.
No new credentials were generated. The exact filename, SHA-256, CRC and local
paths are retained in the confidential build directory's non-secret manifest.
