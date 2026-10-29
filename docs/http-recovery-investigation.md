# SD PRO HTTP Recovery Investigation and Correction

**Date:** 2026-10-27. **Scope:** source corrections, local tests and a confidential
offline build. The maintainer reported that playback and artwork initially worked,
then HTTP timed out or closed on both interfaces while TCP port 80 accepted
connections. No clock was contacted, restarted or updated in this work.

## Reproduced Defect

The target server used `WiFiClient` truthiness to decide whether to accept a new
client. In the pinned ESP8266 core, a disconnected client with no buffered input
is false. The server returned from the accept path before clearing the previous
request, transfer and hash state or checking its deadline. A subsequent client
could have its HTTP headers consumed as the old upload body and could reset the
old total deadline. An offline host probe reproduced an interrupted upload still
active after 71 seconds and a subsequent status request entering the old body.
This is a confirmed software defect and a plausible explanation for the reported
symptoms; the specific event on the physical clock remains unconfirmed.

The server now tracks accepted-client ownership independently of socket
truthiness. It closes and clears the previous request before accepting another,
aborting incomplete uploads and freeing their validation resources. Idle and
total deadlines remain bounded. An already activated firmware update retains its
pending reboot and cannot be replaced by a new client; inactive transfer aborts
do not cancel or rewrite an activated OTA transaction. Existing OTA admission,
validation, staging, RTC, authentication and partition rules remain intact.
Both disconnect and error cleanup release the hash job and readback file before
aborting the transfer, so removal of the temporary candidate does not depend on
deleting an open readback handle.

## Finite Upload Deadlines

**2026-10-28 follow-up:** the agent now limits cover uploads to 15 seconds and
refreshes the latest metadata/heartbeat after each settled cover attempt. Cover
download/decoding runs independently on the computer, with one shared job across
scheduler replacements. Animation and firmware deadlines below are unchanged;
the server remains sequential. See [the synchronization report](daily-startup-and-sync.md).

Ordinary requests and firmware updates retain a 60-second firmware deadline.
Cover and animation uploads receive 60 seconds plus one second per started
8,192 bytes, capped by the existing asset-size limits at 342 seconds for the
2,304,051-byte maximum animation. The existing five-second inactivity timeout
continues while reading and sending. Hashing proceeds in 512-byte steps and is
covered by the total deadline. The agent keeps its ten-second ordinary-request
deadline and gives media uploads the firmware budget plus a 15-second response
margin; an explicit agent timeout remains an override.

The server remains strictly sequential. A slow upload can occupy its only HTTP
connection until completion or timeout, delaying status and heartbeat requests.
No simultaneous connection or new upload protocol is introduced. Rendering
continues in cooperative loop iterations, but these offline changes cannot prove
latency if an individual SDK, flash or SPI operation blocks on real hardware.

## Diagnostics and Performance Limits

Authenticated `GET /maintenance/v1/diagnostics` returns numeric free heap,
largest free block, SDK reset reason, accepted/disconnected connections, idle and
total timeouts, started/aborted/completed/failed uploads, uploaded bytes and the
maximum interval observed between HTTP loop calls. Unknown reset reason is
`4294967295`. Counters and loop timing are volatile and reset on restart; 32-bit
counters can wrap. Diagnostics contain no tokens, passwords, SSIDs, addresses,
request bodies or filenames. They are available only when the same recovery HTTP
service can run and cannot report an operation that never returns.

The [safe memory and loop review](safe-memory-and-loop-review.md) adds four
allocation-free, inclusive maxima in milliseconds on the separate authenticated
`GET /maintenance/v1/loop-diagnostics` route: `maxHttpTickMs`,
`maxStartupTickMs`, `maxDisplayTickMs`, and `maxBackgroundMs` (the final `delay(0)`
and its background work). They include cooperative yields within each measured
stage, accumulate from boot, and reset on restart. The original `maxLoopGapMs`
still measures entry-to-entry HTTP service time, including application startup.
Separate maxima do not associate the longest gap with a particular frame or
prove that it occurred during steady playback. Sampling the diagnostics does
not reset the maxima; a response reports completed previous iterations.
The original diagnostics route retains its exact field set for compatibility
with the deployed client's strict response validation.

The display currently renders one animation row per loop and LittleFS reopens
the animation for each row. SDK `yield()` allows background processing but does
not reenter the application HTTP loop during a synchronous call. Full-screen SPI
operations and individual LittleFS reads/writes/flushes remain synchronous.
There is no timing or heap measurement from the affected unit proving which, if
any, caused the incident; speculative filesystem caching or display changes
were therefore not introduced. The existing rotated LCD profile is preserved.

Complete malformed images are checked for layout and SHA-256 before promotion.
An incomplete transfer is now aborted on socket loss or deadline expiry; the
previous animation is retained subject to the existing LittleFS atomicity and
power-loss limitations. Further real-device timing, free-heap/fragmentation,
watchdog and interrupted-flash behavior remain pending.

## Offline Verification

The lifecycle probe exercises the actual target `tick` and cleanup methods with
socket doubles, including disconnected uploads, queued replacement requests,
header/hash/response cleanup, idle and total deadlines, and activated OTA reboot
preservation. The diagnostic probe checks authentication, allowed method/body,
memory and counter fields, and secret non-disclosure. The stock HTTP probe checks
both feature gates, actual upload admission/finalization and unchanged OTA
deadlines. Native fault-injection and agent tests cover additional transaction,
identity and timeout behavior. The local build manifest records final test and
artifact results without containing recovery credentials.

The private build keeps the existing recovery identity, maintenance-on-boot flag,
display/OTA/stock gates and provisional DIO/40 MHz/4 MiB/4m3m layout. It does not
establish physical flash geometry, independent Wi-Fi failed-boot recovery or a
complete unit-specific backup. Installation remains subject to the existing
project gates and operation-specific authorization.

Final local verification passed 75 native firmware tests both normally and with
ASan/UBSan; 20 offline integration scenarios both normally and with sanitizers;
55 agent tests; and `npm run check`, including 36 Markdown files, 9 root tests
and one Windows-only skip. Sanitized lifecycle, diagnostics, stock HTTP and
compatibility probes passed. The sanitized stock transaction probe also accepted
the unchanged local vendor image using real SHA-256 and rejected corruption,
complete abort and changed geometry in its host model. An independent read-only
source review found no Critical or Important defect.

The new private combined E9 image is 367,920 bytes, below the existing
458,752-byte cap. Independent inspection and both production validators accepted
its E9 structure, segment XOR and modern CRC, and independent SHA-256 results
matched. Compiler evidence and linked symbols retain the requested feature gates,
display orientation and provisional geometry. Linked static RAM is 44,904 bytes;
runtime free heap and actual stack margin remain unmeasured. The previous private
credential files and embedded recovery values are unchanged. Exact artifact
details are retained in the non-secret manifest inside the private build directory.
