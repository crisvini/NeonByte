# Filesystem-Independent Maintenance OTA Design

**Date:** 2026-10-27

**Status:** Part 3 design implemented offline under Part 4 on 2026-10-27; no device operation or installation.

**Installation:** **NO-GO.** OTA remains disabled in provisional builds.

## Scope and Safety Boundary

This design covers a raw-flash staging path for the authenticated
`PUT /maintenance/v1/firmware` route. The Part 4 implementation lets an already-running
NeonByte maintenance service receive and validate firmware when LittleFS is
missing, corrupt, or full.

This work does not change protocol v1, enable OTA, produce an installation
image or private recovery identity, change the bootloader or flash layout,
contact the clock, or solve independent Wi-Fi recovery after firmware fails to
boot. Existing build and deployment guards remain mandatory. A successful
offline implementation would address only the case where NeonByte boots but
LittleFS cannot stage an update.

The Part 1 [device evidence matrix](device-evidence-matrix.md) remains
**NO-GO**. The exact PCB revision, installed stock firmware, physical flash
capacity and layout, complete unit-specific backup/restore, and independent
failed-boot recovery are still unknown or unproven. The repository's 4 MB,
DIO/40 MHz, and 4m3m settings are provisional build assumptions, not evidence
about the unit.

## Pre-Part 4 Baseline: LittleFS-Staged OTA Path

At the time this Part 3 design was written, the HTTP handler authenticated
maintenance requests with the recovery bearer token, required the application
to be paused, enforced the OTA feature gate, and accepted a nonzero exact
`Content-Length` up to 512 KiB with
`application/octet-stream` and a lowercase `X-Content-SHA256` digest.
The separate 448 KiB private-build preparation cap remained unchanged.

Both baseline firmware routes selected `PersistentStorage` as their
`TransferSink`. The handler wrote the body to `/neonbyte/firmware.part`,
closed it, validated the combined ESP8266 image and Arduino CRC, read it back
in bounded steps for SHA-256, and promoted it to `/neonbyte/firmware.bin`.
`applyFirmware()` checked the linked and physical flash settings, verified the
candidate again, checked available sketch space, then streamed 512-byte chunks
through `Update.begin(size, U_FLASH)` and `Update.write()`. A successful
`Update.end(false)` caused the HTTP server to set its delayed restart state. If
LittleFS could not mount or had insufficient space, the baseline maintenance
route could not reach the raw updater.

The Part 3 proposal was to branch the maintenance route to a separate
raw-flash sink and checked flash-backed `ImageSource` before storage selection
and transfer begin. The existing `/api/v1/firmware` path and all other v1
routes were to retain file-staging behavior. The new maintenance route must
not mount, read, write, format, or otherwise call LittleFS.

## Pinned Updater Behavior

The findings below are from the project's pinned Arduino ESP8266 3.1.2 source:
[Updater begin and allocation](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp#L107-L185),
[finalization](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp#L196-L345),
[buffer writes](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp#L347-L433),
[end checks](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.cpp#L450-L488),
[Updater.h](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Updater.h#L47-L92),
[sketch geometry](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Esp.cpp#L554-L594),
[flash alignment](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Esp.cpp#L714-L870), and
[RTC user-memory use](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/Esp.cpp#L154-L161),
[flash map definitions](https://github.com/esp8266/Arduino/blob/3.1.2/cores/esp8266/flash_hal.h#L58-L73).

| Area | Source behavior | Design consequence |
|---|---|---|
| Staging bounds | `Update.begin()` rounds the candidate size up to a 4 KiB sector. For `U_FLASH`, it places staging immediately below `FS_start` and rejects a start below the current sketch rounded to a sector. | Preflight the exact runtime layout and retain the current one-sector safety margin (`freeSketch > 4096 ? (freeSketch - 4096) & 0xfffff000 : 0`). Treat `Update.begin()` as the final bounds check before writes. |
| Address derivation | `UpdateClass::_startAddress` is private. `ESP.getFreeSketchSpace()` returns `(FS_start - 0x40200000) - roundedCurrentSketchSize`; combined with that same rounded size, it yields the end of the raw staging range. | A flash-backed `ImageSource` can derive the same staging start from the pinned core's public `ESP.getSketchSize()` and `ESP.getFreeSketchSpace()` results. Compare this derivation with the 3.1.2 formula in tests; reject arithmetic overflow, unaligned boundaries, or inconsistent results. |
| Buffering | `Update.begin()` allocates a 4 KiB buffer when free heap exceeds 8 KiB, otherwise 256 bytes. Incoming request chunks do not become one whole-image RAM allocation. | Keep HTTP writes bounded. Do not assume the updater buffer size equals the HTTP chunk size. |
| Erase and programming | `_writeBuffer()` erases a 4 KiB sector when the current write address is sector-aligned, then writes the buffer. The ESP8266 `flashWrite` wrapper handles 4-byte alignment and page boundaries; the final buffer may be shorter than a sector. | Check sector-rounded staging bounds, every write result, and the final partial-buffer path. Do not add direct erase logic around `Update`. |
| Header mode | When staging the first block, `_writeBuffer()` may rewrite image header byte 2 to the mode reported by the currently running image. | Reject a candidate mode mismatch before `Update.begin()`. The accepted image must already match the current DIO mode so the updater cannot change bytes covered by the expected digest or image CRC. |
| `end(false)` | It returns false and resets updater state if there is an error or the exact declared length was not written. If the full length was written, it validates and can write the eboot copy command. | `false` means “do not accept an incomplete image,” not “abort regardless.” Never call it on a complete candidate unless the mandatory fail-closed verifier is installed. Never use `end(true)` for this route. |
| Pre-activation verification | If `installSignature()` supplies a verifier, `end(false)` hashes staged bytes in 128-byte blocks and calls the verifier before `_verifyEnd()` and before `eboot_command_write()`. The updater ignores the return value of its per-block `flashRead()` in that hash loop. `_verifyEnd()` checks a flash read of the first four bytes, magic, and that declared flash size is not greater than physical size; it does not validate the full image. | Use the verifier as the last fail-closed gate, but independently reread every candidate byte through a checked flash-backed `ImageSource`. Run full structural, CRC, length, and SHA-256 checks there; do not rely on the updater's hash loop alone. |
| Abort API and lifetime | `UpdaterClass` exposes `begin`, `write`, and `end`, but no public `abort()`. The verifier and hash pointers installed by `installSignature()` are non-owning and are not cleared by updater reset. | Keep verifier state alive through synchronous finalization. Clear the hook after every result only in a build where this transaction exclusively owns it; the public API has no getter to restore a previous hook. On a complete but invalid candidate, call `end(false)` only with a verifier that is guaranteed to reject it before eboot scheduling. |
| Restart state | Successful `end(false)` writes an eboot raw-copy command. The application schedules its restart only after the updater returns success. | Set restart-pending only after the successful finalizer result. Every failed transaction must have zero eboot commands and zero restart requests. |

Use `installSignature()` with a verifier that reports a zero-length signature:
the pinned updater still calls its verifier, but the image gains no signature
trailer and this does not create a signed package format. The callback must use
the checked flash-backed `ImageSource`; the updater's own unchecked hash pass
is not sufficient.

`Update.end(false)` can therefore serve as the activation gate only when every
call is guarded. An incomplete transfer reaches the updater's incomplete check
and resets without scheduling a copy. A complete but invalid transfer reaches
the installed verifier, which must return false; the updater then resets
before writing the eboot command. The raw sink's `abort()` may call
`Update.end(false)` for cleanup only while its fail-closed verifier is still
alive and configured to reject the current candidate. If the verifier cannot
be installed, its state is unavailable, or checked readback fails, the
transaction must fail closed and must never use an unguarded finalizer.

## Transaction State Machine

| State | Required work | Allowed next action |
|---|---|---|
| `Idle` | No active updater transaction. | Accept a maintenance firmware request. |
| `Preflight` | Authenticate; require maintenance route, paused application, enabled build gate, strict HTTP framing, nonzero exact length, size ceiling, and valid lowercase SHA-256 header. Check flash configuration and exact supported physical size. Derive sector-rounded staging bounds and reject overlap or insufficient space before any write. | Wait for the first four image bytes before beginning raw staging. |
| `Receiving` | Buffer the first four image bytes in bounded RAM and reject unsupported magic, flash mode, frequency, or declared-size fields before `Update.begin()` or any flash write. Then stream bounded chunks to `Update.write()`. Count bytes and reject write errors, overflow, timeout, disconnect, or any byte count other than the declared length. | Continue until exactly the declared number of bytes arrived; otherwise fail inactive. |
| `Verifying` | In the updater's pre-activation verifier, use checked flash reads to verify exact staged length, readback SHA-256 against `X-Content-SHA256`, both E9 images and segment bounds/checksums, modern Arduino CRC/length metadata, accepted DIO/40 MHz/4 MB declaration, and physical/linked geometry. Require all reads and validators to succeed. | Return true from the verifier only when every check passes. Any failure returns false and leaves the staged candidate inactive. |
| `Activated` | `Update.end(false)` has returned true after the verifier and updater end checks; the updater has written one eboot copy command. | Mark restart-pending and use the existing delayed restart behavior. Do not accept another mutation. |
| `FailedInactive` | Authentication, framing, receive, digest, readback, geometry, validation, updater, or finalization failed. | Return an error; never write an eboot command or request restart. The unactivated staging bytes may remain in flash and are not a rollback image. |

The `Verifying` callback is the last authority before activation. It must
compare checked readback bytes to the request digest. The first four body
bytes are held until the current running mode and the candidate's DIO/40 MHz/
4 MB declaration are confirmed; only then may the transaction call
`Update.begin()` and write them. Because the updater may transform the header
mode, rejecting a mismatch before its first write ensures staged bytes remain
identical to the requested image.

The existing image validators require the supported uncompressed combined
image: an E9 boot image followed by an E9 application image, bounded segments,
valid segment checksums, the modern Arduino length/CRC fields, DIO mode,
40 MHz, and a 4 MB declaration. The route must additionally require
`ESP.getFlashChipRealSize()` to equal the supported 4 MiB profile and retain
`ESP.checkFlashConfig(false)`. The core's weaker “declared size is no larger
than physical size” check is not sufficient for this profile.

## Geometry and Preservation Requirements

Use 4 KiB sectors for bounds. For exact candidate length `n`:

```text
sectorSize = 4096
roundedCandidate = alignUp(n, sectorSize)
roundedCurrentSketch = alignUp(ESP.getSketchSize(), sectorSize)
stagingEnd = FS_start - 0x40200000
stagingStart = stagingEnd - roundedCandidate
```

The equivalent public-API derivation is:

```text
stagingEnd = roundedCurrentSketch + ESP.getFreeSketchSpace()
```

The implementation must verify that both calculations agree with the pinned
3.1.2 behavior, that the boundary is sector-aligned, and that
`stagingStart >= roundedCurrentSketch`. Also preserve the current policy's
one-sector reserve in the free-space preflight. The actual running profile and
runtime flash measurements are authoritative; do not hard-code the SD PRO
model's name or assume its flash capacity.

The write/erase range is the sector-rounded raw staging interval ending at
`FS_start`. The intended eboot destination is `[0, exactLength)`, which
replaces the running application in place and provides no rollback slot. Before
implementation, map and check all layout-reserved areas: the current sketch,
LittleFS, EEPROM emulation, SDK/RF data, and flash tail. Do not erase or write
outside the updater's staging interval as part of this design. LittleFS and
configuration files must receive no route access or mutation.

The recovery bearer token and AP password are embedded in a future private
per-device build and may also be present in NeonByte's LittleFS configuration.
The update must preserve the exact private identity through a separately
trusted build/preparation process. The request digest proves byte integrity
against the request header; it is not a publisher signature, identity check, or
proof that the image boots. No identity generation, private build, or
installation package is part of this work.

The updater writes its eboot command to the first 128 bytes of RTC user memory.
Current startup crash-guard state is written at RTC user-memory offset zero, so
that transient guard overlaps the updater command area and must be treated as
overwritten across OTA. It is not a credential store. Part 4 must test the
resulting successful and failed reset behavior; no secret may be placed in that
RTC range.

## Validation Matrix for Part 4

Use injected transfer, flash, updater, LittleFS, eboot-command, and restart
backends. These are test specifications only; this part adds no tests or
firmware code.

| Case | Injected condition | Required result |
|---|---|---|
| LittleFS unavailable | Missing, corrupt/unmountable, and full-volume variants | Maintenance route performs zero LittleFS calls and can complete a valid fake-backend transaction. |
| Authentication | Missing or incorrect recovery bearer token | Reject before `Update.begin()`; no writes, eboot command, or restart. |
| OTA disabled | Feature gate is false | Reject before updater or filesystem access; no eboot command or restart. |
| Framing | Chunked transfer, `Expect`, duplicate sensitive headers, malformed or ambiguous length | Reject before updater begin; no eboot command or restart. |
| Missing bytes | Disconnect, timeout, or short body | Reject and reset incomplete updater state; no eboot command or restart. |
| Extra bytes | Transaction receives bytes beyond its declared count, trailing request bytes, or a declared size over the configured ceiling | Reject without accepting extra data; no eboot command or restart. |
| Expected digest | `X-Content-SHA256` does not match the candidate | Checked verifier rejects; no eboot command or restart. |
| Readback digest | Staged bytes differ from the expected digest | Checked verifier rejects; no eboot command or restart. |
| E9 structure | Bad magic, segment count, entry point, segment destination, segment length, checksum, or trailing/padding bytes | Reject before eboot command. |
| Arduino CRC | Missing or corrupt length/CRC metadata | Reject before eboot command. |
| Flash declaration | Unsupported mode/frequency/declared size, or declared and physical size disagree | Reject using the buffered image header before `Update.begin()` or any flash write; retain full readback checks; no eboot command. |
| Insufficient capacity | Candidate exceeds the runtime free staging limit or the updater's rounded bounds | Reject before updater writes; no eboot command. |
| Boundary overlap | Derived stage range overlaps the current sketch or a reserved region, or public and updater geometry disagree | Reject before updater writes; no eboot command. |
| Flash write failure | Inject erase/program error at first, middle, and final chunk | Reject; no eboot command, restart, filesystem call, or configuration mutation. |
| Flash read failure | Inject checked read failure at first, middle, and final readback chunk | Verifier returns false; no eboot command or restart. |
| Complete invalid image | Entire declared length arrives but image, digest, geometry, or CRC is invalid | Fail-closed verifier rejects `Update.end(false)`; no eboot command or restart. |
| Success | Exact authenticated valid image and successful checked readback | Exactly one eboot command; restart is pending only after successful finalization. No LittleFS call occurs. |
| Preservation sentinels | Sentinels in modeled LittleFS/configuration, EEPROM, SDK/RF, and flash-tail regions | Only candidate staging sectors and the intended application destination change; RTC guard overwrite is explicitly modeled. |

For every failure row, assert zero boot-copy commands, zero restart requests,
zero LittleFS calls on the maintenance route, and no unrelated asset or
configuration mutation. The success test validates ordering: complete body,
checked readback and validation, successful updater finalizer, one eboot
command, then restart-pending. Host mocks cannot establish actual flash
behavior, power-loss safety, or hardware recovery.

## Minimal File-by-File Implementation Plan

Part 4 should implement only the reviewed maintenance path:

| File | Planned change |
|---|---|
| `firmware/include/neonbyte/esp8266/ota_staging.h` | Add the narrow raw-flash transfer sink, checked flash-backed `ImageSource`, and injected updater/flash seams. |
| `firmware/src/esp8266/ota_staging.cpp` | Bind the seam to Arduino 3.1.2 `Update`; derive and validate staging geometry; maintain verifier lifetime; fail closed before eboot scheduling. |
| `firmware/include/neonbyte/esp8266/http_server.h` | Hold the maintenance transaction/sink state without changing public protocol types. |
| `firmware/src/esp8266/http_server.cpp` | Branch to raw staging for `/maintenance/v1/firmware` before storage selection; preserve auth, pause, strict framing, size/digest checks, and OTA gate; keep `/api/v1/firmware` file-staged. Set restart-pending only after successful finalization. |
| `firmware/test/test_integration/test_main.cpp` | Add the injected failure and success cases in the validation matrix, including assertions for no eboot/restart/filesystem use on failure. |
| `docs/safe-first-boot.md`, `docs/recovery.md`, `PLANNING.md` | Record only implementation and host-test results actually observed in Part 4; leave deployment and independent recovery blocked. |

Do not change `contracts/v1/`, `docs/protocol.md`, OTA compile/deployment guards,
or the installation decision for this work.

## Unresolved Assumptions and Review Checks

- The runtime stage-start derivation must match the exact pinned core and
  selected linker profile. Part 4 must test the equation and reject any
  profile where it cannot be proven.
- `installSignature()` must invoke the custom verifier on the exact
  `Update.end(false)` path before eboot scheduling. The hook must stay
  fail-closed, its non-owning pointers must outlive the call, and it must be
  cleared after every outcome in a build where the transaction owns it.
- The global updater may already have a verifier when `ARDUINO_SIGNING` is
  enabled. `installSignature()` exposes no getter for the previous hook, so
  the OTA build must prove exclusive ownership or keep the route disabled.
- The verifier needs checked reads of every staged byte. The pinned updater's
  internal hash loop ignores `flashRead()` results and cannot serve as the only
  readback check.
- The exact unit flash map, installed firmware, stock data regions, and private
  recovery identity remain unverified. No software result can clear the
  full-backup or independent Wi-Fi failed-boot recovery gates.
- The OTA eboot command overwrites the current RTC crash-guard area. The
  restart/guard interaction and power-loss behavior require explicit tests;
  host tests cannot establish physical behavior.
- The request SHA-256 is not signed authenticity. The maintenance service
  remains plaintext HTTP on a trusted network, and this design does not add a
  publisher key or secure transport.

This change would let a booting maintenance service replace firmware despite
LittleFS failure. **It does not solve independent failed-boot recovery**, prove
that the candidate contains the correct private identity, provide rollback, or
change the installation **NO-GO** decision.

## Part 4 Offline Implementation Result

The maintenance route now branches to a portable `TransferSink` and checked
flash-backed `ImageSource` before storage selection. Admission requires an
explicitly paused application with no pending automatic startup, so the
ten-second startup transition cannot write the RTC guard during an upload. The
portable transaction checks request admission, exact length, SHA-256 readback,
E9 structure, modern Arduino CRC, and sector-rounded runtime geometry. It
buffers the first four candidate bytes and rejects a mode/frequency/size
mismatch before calling the ESP8266 updater. Its verifier rejects complete
invalid candidates during `Update.end(false)` cleanup and is the only path
that can permit eboot scheduling. The API v1 firmware path and asset storage
retain file staging.

Native injected backends cover the design matrix's request, filesystem-state,
body, image, geometry, read/write, finalizer, and activation failures. The OTA
fake now erases, programs, and reads through physical-offset-indexed bytes in a
4 MiB host vector, with preservation sentinels outside the computed staging
range. It shares a modeled 128-byte RTC region with startup guard writes; the
success regression checks that an eboot marker survives the delayed-start
deadline after an explicit pause, and a complete invalid image preserves the
prior guard bytes. These offsets and byte-level transitions are host models,
not evidence of the unit's actual flash map, RTC retention, or reset behavior.
The existing `esp8266-integration-check`
profile compiles the binding but remains non-installable and has no usable
recovery identity. The provisional profile and deployment guards remain
unchanged. Physical flash, power-loss, identity preservation in a private
image, independent recovery, and the full-backup gate remain unresolved, so
installation remains **NO-GO**.

Part 4 local validation passed `npm run check`, 19 offline scenarios, all 61
PlatformIO native tests, both compile-only ESP8266 profiles, the synthetic
deployment guard, and `git diff --check`. The profile builds reported 43,900
bytes static RAM and 357,019/358,043 bytes flash use for provisional and
integration-check, respectively.
