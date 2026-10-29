# Optimized Firmware Finalization

## Authorization and Scope

On 2026-10-29 the maintainer authorized a final workspace-lifetime and
loop-diagnostics security review, necessary corrections/tests, a local commit on
`integration/spotify-marquee-gif-smoothness`, and a new private review package.
The required Build ID remains `neonbyte-20261028-mem-loop-exp01-12b23a1`.
The `12b23a1` suffix identifies the integration baseline; the final source commit
is recorded separately in the private manifest and build record.

No main-branch change/merge, push, device contact, Windows copy, OTA, flash, or
new physical acceptance is authorized. Earlier private packages stay intact.
The earlier [memory and loop report](safe-memory-and-loop-review.md) retains its
original measurements; the final package's record supplies rebuilt measurements
after the small recovery correction below.

The temporary worktree disappeared between sessions. It was reconstructed from
the saved patch and the two separately retained new files. All 50 firmware
source/header hashes matched the original private source record before further
changes. The existing worktree was moved to the persistent path
`/home/crisvini/projects/NeonByte-integration-spotify-marquee-gif-smoothness`.
No other branch or worktree was replaced.

## Workspace Lifetime Review

| Storage | Lifetime and access | Transition rule |
|---|---|---|
| `encodedWorkspace_[512]` | GIF uses only its first 480 bytes, including a prefetched row header. Spotify uses disjoint 256-byte title and artist caches. | Every Spotify entry rebuilds both caches before use. Every GIF entry reopens the decoder and resets its prefetched-header state before decoding. |
| `pixels_[480]` | One cover or decoded animation output row, consumed synchronously in the same display tick. | Cover output never overwrites the metadata workspace. Animation output is not retained for a later scene. |
| HTTP validation `chunk_[512]` | Separate HTTP-server allocation; the validation-only decoder consumes each row before reuse. | It never aliases the display's encoded/output rows or text caches. |
| Marquee motion state | Separate title/artist timestamps, offsets, lengths and directions. | Reentry resets motion; pending cover loading continues to take priority. |

Application HTTP, startup and display stages execute serially in `loop()`.
The registered station callbacks update association state, not display memory.
The SDK's cooperative `yield()` does not invoke the application loop recursively.
There is no ISR/callback borrower of these display buffers in the current source.
Public renderer entry calls follow the same scene invalidation rules. Temporary
string views remain within synchronous text drawing; no pointer to caller-owned
metadata is retained.

Rapid Spotify-to-GIF-to-Spotify tests interrupt a cover after three rows and
interrupt animation decoding at eleven positions: unopened row state, partial
keyframes/prefetched rows, completion and delta/palette setup.
Every reentry rebuilds both full-length fields and all 176 cover rows; every
sampled cover pixel matches its source oracle. The earlier three complete
256-character marquee round trips and all existing timing/binding tests remain.

## Corrected Entry-Time Read Failure

Independent review reproduced a pre-existing fault: `showGif()` cleared the
reopen flag and ignored `openAnimation()` failure. A transient first version,
header or directory read failure left empty metadata and disabled future retry
until another scene or revision change.

The new regression failed with 0 rendered rows after reads recovered, instead of
the expected 240. The correction retains the failed-open flag and returns from
that entry tick. A subsequent eligible tick retries opening, with at most one
open attempt per display tick. Failed opens wait 1,000 ms before retrying so a
missing/invalid file cannot create continuous filesystem work. This error-only
backoff reuses `nextFrame_` while no frame is valid; new asset revisions bypass
the wait. It is a nonblocking deadline, with no `delay()` or waiting loop. Recovery
after a failed reopen can take up to one second; the loop returns between attempts
to let HTTP and Wi-Fi run. No new state, buffer or allocation was added, and valid frame delays
remain unchanged.
Tests inject each of the five opening reads on cold entry and Spotify reentry,
check the 1/999/1000 ms boundaries and persistent failures, then verify every
reconstructed keyframe row. A revision-change test verifies immediate recovery
during backoff. Normal playback order/delays and
the existing first-keyframe read coalescing remain unchanged.

## Loop-Diagnostics Security Review

`GET /maintenance/v1/loop-diagnostics` is read-only and uses the recovery bearer
credential. Header admission selects recovery authentication for the maintenance
prefix, including while the application is paused and no protocol handler exists.
Dispatch rechecks authentication, exact path length/content, GET and empty body.
The five numeric fields are formatted into the existing bounded response buffer.
No credential, SSID, address, filename, body, counter-reset action or startup
operation is exposed. The original diagnostics route retains exactly 13 fields.

The expanded probe exercises the real header parser, maintenance admission,
path classifiers, pairing authenticator and JSON dispatcher with I/O doubles.
Unrelated binary/animation-upload work is excluded from this diagnostic-only
probe and remains covered by the existing dedicated probes. Cases include:

- Valid recovery access with a paused application and no dynamic body buffer.
- Missing, incorrect and pairing-only credentials: rejected.
- POST, PUT, DELETE and nonempty bodies: rejected; 513 bytes exceed the existing
  512-byte maintenance limit before body copying.
- Short/prefix/suffix paths: no diagnostic response; nonempty and empty query
  suffixes: rejected by admission/parser.
- Duplicate authorization/content length, chunked encoding and `Expect`: rejected.
- Maximum 32-bit values fit the bounded JSON response; the original 13-field
  diagnostics and non-disclosure assertions remain intact.

No production authentication, OTA admission, Wi-Fi, stock-restoration, identity,
storage or API v1 contract change was needed.

## Validation and Package Binding

The final regression suite contains 124 native tests, including 24 display/
marquee/cover tests. Both normal and ASan/UBSan runs pass. The 25 offline scenarios
also pass normally and under sanitizers. Repository checks, generated 14/20/48/60
frame seams, the existing 48-frame NBIF/RGB565 oracle, diagnostics, lifecycle,
v2 HTTP and loop-timing probes pass. The original source GIFs remain absent for
the two optional desktop tests; the native real-NBIF oracle is available.

The reviewed source is committed only on the integration branch. Private
compilation uses a fresh `git archive` of that exact final commit, the retained
identity header, unchanged private flags and byte-checked copies of the retained
library files. Build ID stays fixed as requested; no identity is regenerated.
The private record binds source commit/tree/archive hashes, file hashes, profile,
compiler/dependency evidence, binary/ELF hashes, measured static resources and
validation results. Final exported source is compared byte-for-byte with the
committed source before packaging.

The new restricted directory is
`/home/crisvini/.local/share/neonbyte/private-builds/2026-10-29-mem-loop-exp01-12b23a1-final/`.
Its `package/` holds the firmware and review manifest, source archive, build record,
readiness notes and checksums. Its `validation/` holds logs and integrity evidence.
The review manifest records pending physical gates; it does not assert approved
runtime bounds or constitute an installation-ready Windows inbox manifest.
No previous package/profile/build record is overwritten. Private artifacts,
identity contents and real environment files stay outside Git.

## Installation Blockers

This package supports a decision about a separately authorized physical test.
Installation remains **NO-GO** until the unresolved evidence and authorization
are addressed:

- A complete unit-specific backup, verified coverage/hash, and a demonstrated
  full-region restore procedure, including filesystem, settings and unit data.
  A downloaded stock firmware image is not that backup.
- Independently booting Wi-Fi recovery after a failed application or interrupted
  boot copy, validated on an identified identical spare. The NeonByte maintenance
  AP and authenticated stock-restoration route depend on working firmware and
  do not supply that independent recovery.
- Confirmed unit hardware, flash/layout/staging/preservation evidence and
  operation-specific approval under the existing [recovery gates](recovery.md).
- Candidate runtime free heap/largest block at or above the retained
  **22,168 / 21,544 bytes**, plus stack margin, RF/HTTP responsiveness, visual seam
  behavior and sustained stability. Linker RAM does not pass these measurements.

No new physical observation is claimed. The previously reported 22,624-byte
heap and 21,688-byte largest block belong to installed `4531e23`, not this
candidate. Neither this commit nor this private package authorizes installation.
