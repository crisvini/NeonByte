# Phase 4 Firmware Core Review

**Date:** 2026-10-26. **Scope:** hardware-independent C++ core and native tests only. Board-specific work, hardware validation, and recovery remain **PENDING**. This review does not complete Phase 4 acceptance.

## Confirmed Defects and Fixes

### Playback Stayed Active While Only Heartbeats Were Fresh

`SceneManager::currentState()` previously required a fresh heartbeat and `isPlaying`, but never expired the stored playback sample. After one playing update, continued heartbeats could leave the Spotify scene active indefinitely, including after progress reached the track duration. Receiving an already stale sample also made it eligible for display.

Playback now requires both fresh presence and fresh metadata. Metadata age includes the nonnegative difference between the device's Unix clock and `sampledAtUnixMs` at receipt, plus monotonic elapsed time afterward. It uses the existing configurable heartbeat timeout, 45 seconds by default; exactly 45 seconds remains fresh. Subtraction checks avoid overflow when combining ages.

Expired metadata selects GIF in `auto` and the waiting state in manual `spotify`, even while `agentAvailable` remains true. A fresh playing update restores playback. Heartbeats do not refresh metadata, and malformed Spotify requests cannot refresh it. Manual GIF behavior is unchanged. The fix adds one 64-bit age field and no heap allocation.

Regression tests first failed against the original behavior, then passed with the fix. Coverage includes continued heartbeats, fresh-update recovery, repeated old samples, the exact timeout boundary, sample age plus elapsed time, and a backward clock change.

### Valid JSON Whitespace Was Rejected

`JsonParser::readKey()` consumed `:` without skipping the following JSON whitespace. String, boolean, and number parsers then encountered whitespace instead of the value. For example, the documented formatted mode and Spotify payloads were rejected with `400 invalid_request` despite satisfying v1.

The parser now skips JSON whitespace after the colon. A regression test first reproduced the rejection and now accepts formatted mode and Spotify objects containing all three value types. Closed-object validation, field types, duplicate rejection, UTF-8 validation, and numeric bounds are preserved. No schema, example, route, or response contract changed.

## Memory and Stack Review

The core uses fixed buffers and non-owning views, with no runtime heap allocations. Host fixture vectors and strings belong only to tests. Measurements below use Linux x86-64, GCC 11.4.0, C++17, and `-Os`; they are not device budgets.

| Type | Host `sizeof`, bytes | Ownership |
|---|---:|---|
| `FixedText` | 1,026 | 1,024 UTF-8 bytes plus length; no required terminator |
| `NowPlaying` | 3,104 | Three fixed text fields and playback timing |
| `SceneManager` | 3,168 | One retained track, service references, mode, and timing |
| `ProtocolHandler` | 24 | Three service references |
| `HttpResponse` | 1,056 | 1,024-byte body plus metadata |
| `AnimationReader` | 24 | Storage reference, metadata, and open flag |

`JsonParser` holds an input view, position, and failure flag. Its local keys use a full `FixedText`, about 1 KiB. Mode parsing also uses a full `FixedText` for its value. The Spotify handler creates a temporary 3,104-byte track before replacing the retained state, which preserves the previous track if validation fails late in the request. These buffers remain unchanged; moving them into persistent objects would change memory ownership without a measured target requirement.

GCC `-fstack-usage` reports the following function frames. Optimized parser functions can be inlined into the handler. These figures exclude callee frames, virtual adapter implementations, and request-body buffering.

| Function | Host frame, bytes |
|---|---:|
| `dispatchOneRequest` | 1,216 |
| `ProtocolHandler::handle` | 4,352 |
| Internal status response builder | 1,232 |
| `JsonParser::parseString` | 64 |
| `JsonParser::parseUnsignedInteger` | 144 |
| `SceneManager::updateNowPlaying` | 16 |
| `SceneManager::currentState` | 32 |
| `AnimationReader::open` | 96 |
| `AnimationReader::readFrameChunk` | 32 |

Dispatch and handler frames alone total 5,568 bytes before deeper calls. This is a material integration constraint, not proof of a target stack overflow: board stack capacity and compiler behavior remain **PENDING**. Measure the complete call path with the eventual adapters before choosing a task stack or claiming compatibility. The review introduces no additional text or response buffers.

Reproduce the host stack reports from the repository root:

~~~sh
mkdir -p /tmp/neonbyte-core-review
for source in protocol scene_manager animation_reader; do
  g++ -std=c++17 -Os -Wall -Wextra -Werror -fstack-usage \
    -Ifirmware/include -c "firmware/src/$source.cpp" \
    -o "/tmp/neonbyte-core-review/$source.o"
done
cat /tmp/neonbyte-core-review/*.su
~~~

## Animation Reader Findings

No confirmed bounds or interrupted-read defect was found. Production reader code is unchanged.

- Opening rejects short headers, incorrect magic/version/dimensions, zero or excessive frames, extra or missing file bytes, delays below 20 ms, and total duration above 30 seconds. Twenty frames at 1,500 ms each are accepted.
- Frame indexes are checked before offset arithmetic. A maximum layout is 2,304,051 bytes, within the 32-bit storage offsets. Pixel chunks stop at the frame boundary even if caller capacity is larger.
- Null destinations, zero capacity, offsets at or beyond the frame end, and calls before a successful open fail. A failed reopen clears public metadata and invalidates the previous open state.
- Header, timing, and pixel read failures propagate. Pixel failures return `bytesRead == 0`, including when storage partially modified the destination before returning false. A retry can succeed; callers must discard a failed chunk and must not render its partially changed bytes.
- The reader trusts storage to honor the requested destination length and accurately report complete reads. The asset must remain stable during validation and playback. Same-size replacement or corruption after opening is not detected; checksum verification, atomic installation, and storage locking remain outside this reader and **PENDING**.

The tests use distinct bytes at the last pixel byte of one frame and the first pixel byte of the next, plus a destination sentinel, to verify the actual offsets and prevent reads crossing a frame boundary.

## Protocol and Authentication Findings

The v1 schemas and examples remain unchanged. Status remains public; every mutating route authenticates before parsing, method checks, state changes, or returning the pending binary-route response. Tests exercise the real bearer authenticator against all five mutating paths and verify rejected requests leave mode, playback, and presence unchanged.

Bearer scheme comparison is case-insensitive; token comparison is exact, rejects an empty configured token, and accumulates differences across equal-length token bytes. The implementation accepts one space after the scheme. It does not claim a cryptographic timing guarantee, provision tokens, or encrypt HTTP. Token storage must outlive the authenticator's non-owning view.

Additional tests cover malformed and truncated JSON, duplicate/missing fields, incorrect types, invalid UTF-8 and surrogate escapes, 256 four-byte code points, embedded escaped controls, integer decimal/exponent forms, and values around `UINT64_MAX`. Invalid requests preserve prior playback. Status serialization fits its fixed response buffer even with both 64-character strings requiring six-byte JSON escapes and maximum free-space digits.

## Verification

The baseline had 16 passing native tests. The reviewed suite has **31 passing native tests**, including three tests that reproduced the corrected defects before implementation.

- `uv tool run --from platformio pio test -d firmware -e native`: 31 passed. The wrapper supplies PlatformIO because `pio` was not on this session's PATH; the project still selects only `native`.
- The same 31 tests compiled with GCC/G++ `-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer`: passed with no sanitizer findings. Build products were kept outside version control under `/tmp/neonbyte-core-review/`.
- `npm run check`: passed Markdown lint, English-language checks, 8 repository tests, the agent build/type checks, and 39 agent tests.
- `git diff --check`: passed.

`npm run check` does not currently invoke the native firmware tests, and the existing CI workflow does not run them. Continue running the native command separately. This review does not claim exhaustive fuzz coverage or hardware verification.

## Remaining Limitations and Gates

- Unix clock synchronization is unspecified. A future sample has zero age at receipt, then expires by monotonic time. With an unsynchronized clock, replaying an old sample cannot reliably be distinguished from receiving a new one. Time synchronization and an integration freshness policy remain **PENDING**; this review adds no protocol field or network service.
- A metadata timeout requires periodic Spotify refreshes even when the agent deduplicates unchanged playback. The future device client must send fresh samples within the configured timeout; a heartbeat alone is insufficient. That client remains Phase 5 work.
- The parser is synchronous and request bodies are non-owning views. Adapter body-size limits, input lifetimes, concurrency/serialization, network buffering, and target stack use remain **PENDING**. Public core callers must supply valid `FixedText` lengths.
- Native tests cover representative malformed inputs, not exhaustive JSON differential testing, randomized fuzzing, concurrent asset replacement, prolonged playback, real storage faults, or authentication timing.
- Binary uploads still return authenticated `415 unsupported_media_type`. Checksums, interrupted-upload recovery, persistent asset replacement, display scheduling, actual RAM/flash limits, pins, partitions, Wi-Fi, OTA, and physical recovery remain **PENDING**.

No hardware adapter, Wi-Fi service, board target, device image, OTA implementation, or physical device operation was added or performed. Stop at this review boundary; further development requires maintainer approval and the existing hardware/recovery evidence gates.
