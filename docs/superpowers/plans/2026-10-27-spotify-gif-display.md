# Spotify and GIF Display Implementation Plan

**Authorization:** The maintainer requested the complete offline correction and
private rebuild using the existing credentials. No device access, OTA or later
hardware phase is authorized. Work stays in the current checkout for review.

**Goal:** Show larger artwork and longer metadata without periodic flicker, keep
Auto fallback, and explain the original GIF and converted storage limits.

**Design:** Center a 176 by 176 cover at (32, 4). Keep the physical built-in font
at size 1 (6 by 8 character cells). Use two 37-character lines per field, title
at y=188/200 and artist at y=218/228, with safe ASCII ellipsis. Cache only the
bounded rendered text, clear each changed field independently, and stream one
cover or animation row per loop using the existing 480-byte buffer. Preserve the
preview's existing 12px title and 10px artist fonts, fit two lines within the same
field bounds, and remove playback progress from both displays. Progress remains
in protocol v1 for compatibility and freshness logic.

**Approach:** Extend the existing incremental renderer. A full framebuffer is
excluded by the RAM constraint; animated scrolling would reintroduce continuous
text updates. Two bounded static lines prioritize long names without either cost.
Preserve rotation 2, MADCTL 0x08, inversion, SPI mode/frequency and RGB565 transport;
trace the pinned dependency implementation and prepare primary-color fixtures
without running them on the device.

**Constraints:** English project content, no new runtime dependencies, unchanged
authentication, HTTP recovery, deadlines, Wi-Fi recovery, OTA gates, partitions,
45-second independent metadata/heartbeat expiry and GIF conversion/memory limits.
Private artifacts and existing identity stay outside Git with restricted modes.

## Review Focus

- Same track ID with changed title/artist must redraw just the changed field.
- Progress and asset revisions must not erase metadata or clear the entire LCD.
- Missing, late or replaced covers must never be bound to the wrong track.
- Pausing or expiry must restart the installed GIF even without a new upload.
- Converted size can exceed free staging space despite a tiny original GIF.

## Tasks

1. Add failing display regressions for 176-row streaming, independent metadata
   invalidation, long/Unicode text, cover revisions, colors and Auto fallback.
   Extend test doubles to record rectangles, text and every transmitted pixel.
2. Implement bounded two-line metadata formatting and incremental cover rendering.
   Run native display tests before moving on.
3. Add failing dashboard and storage-error tests. Keep preview font sizes, update
   cover geometry/text bounds, remove progress/time, explain 8 MiB original input,
   240 by 240 RGB565, 20 frames, 30 seconds and atomic staging reserve. Reject
   insufficient converted staging space safely; retain retries for transport
   faults and report storage failures without echoing remote response bodies.
4. Trace RGB565 conversion, BGR/MADCTL, inversion and actual pinned SPI byte order.
   Generate local primary/secondary fixtures and document future controlled tests.
5. Run npm run check, native firmware and offline integration suites, ASan/UBSan,
   existing HTTP/recovery/OTA probes and local deployment guard. Review changes.
6. Build the same private target profile using the exact existing recovery header.
   Verify credential-file hashes and embedded values without printing secrets,
   E9/XOR/CRC, provisional geometry, flags, RAM, size and SHA-256. Record results;
   leave physical color validation and all hardware phase tasks pending.

## Execution Record

- Native regressions reproduced 144-row artwork, periodic metadata repaint,
  single-line truncation and asset-triggered text clearing before implementation.
- Preview regressions reproduced old cover geometry and progress/time rendering.
- Capacity regressions reproduced successful uploads with insufficient staging
  storage and the missing blocked state before implementation.
- Independent read-only review found an old-cover/new-title mismatch during track
  changes. A regression fully rendered the old artwork and failed before the fix;
  the renderer now clears only the cover rectangle before new metadata.
- Rendering remains row-streamed. The one-time cover clear is bounded but
  synchronous; measured hardware latency remains pending.
- Final verification passed 62 agent tests, 82 native tests and 20 offline
  scenarios; native and offline suites also passed ASan/UBSan. Both existing
  compile-only profiles and the private profile compiled. Image validators,
  checksums, unchanged identity/dependencies and deployment guards passed.
- Authorized software work is complete. All physical acceptance tasks remain
  pending; no device access, OTA, publication or later phase was performed.
