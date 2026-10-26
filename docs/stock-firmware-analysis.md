# Stock Firmware Binary Analysis

**Date:** 2026-10-26. **Scope:** static investigation of `SDPro_V1.0.6_20260525_174828.bin`. No firmware was executed, compiled for a device, uploaded, or sent to a device. No device endpoints were contacted. Hardware validation and recovery remain **PENDING**.

**Subsequent Phase 4 update:** the hardware-independent C++ core now has a PlatformIO native test environment. No device board target has been selected or built, and no device endpoint or physical unit has been accessed.

## Assessment

The supplied file is a combined ESP8266 bootloader/application update image with valid segment checksums and an additional valid whole-image CRC. It declares DIO, a 40 MHz flash interface, and 4 MB flash. Code references identify a LittleFS configuration beginning at flash offset `0x100000`, but the file does not include that filesystem or the device's settings.

The stock updater is a plausible path for a future custom ESP8266 image. Static analysis identifies `POST /update_ota`, an Arduino-style update sequence, and a nominal 512 KiB upload guard. The `SDP` filename-prefix check logs an error without rejecting the upload in the traced callback. **Acceptance of NeonByte is unverified, boot compatibility is unverified, and installation is not approved.** No NeonByte firmware exists to assess yet, and the installed stock version and board remain unidentified.

## Evidence and Reproducibility

### Artifact Identity

| Property | Verified value |
|---|---|
| Filename | `SDPro_V1.0.6_20260525_174828.bin` |
| Length | 488,304 bytes (`0x77370`; approximately 476.86 KiB) |
| SHA-256 | `058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b` |
| Git blob SHA-1 | `cfb5e12cafe4ce444f12cb06e41b14c8f8c58b03` |
| Manufacturer snapshot | `JUZIPi-tech/SD_PRO`, commit `5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d` |

The local Git blob SHA-1 was calculated over `b"blob " + decimalLength + b"\0" + fileBytes`. It matches the object and size in the [manufacturer's pinned repository tree](https://api.github.com/repos/JUZIPi-tech/SD_PRO/git/trees/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d). This confirms identity with the published file; it is not a manufacturer signature or a match to this physical clock. The [pinned firmware page](https://github.com/JUZIPi-tech/SD_PRO/blob/5dc22a11d6ca5ffa8cc2aad103cd82e7c77d7e1d/SDPro_V1.0.6_20260525_174828.bin) preserves the reference.

The complete repository tree contains a README, V1.0.4 and V1.0.6 binaries, and the manual. It supplies no firmware source, schematic, board manifest, or linker script. The manual's previously reviewed setup instructions do not establish recovery. Binary contents and public documentation were treated as evidence, not instructions to perform device operations.

### Methods

- Python 3.10.12: read-only image parsing, bounds and checksum verification, Git object hashing, signature searches, and bounded attempts to decode candidate compressed streams.
- esptool 5.1.0: `image-info` on the original file and on an application-only derivative in a temporary directory. Neither command opens a serial connection.
- GNU `strings` and `xxd`: offsets, headers, resource paths, and diagnostics.
- binwalk 2.3.3: signature scan only, without extraction or execution helpers.
- GNU Xtensa LX106 objdump 2.38: static disassembly of copied code segments, mapped to their declared addresses. Function names below are analyst identifications from arguments, control flow, and upstream comparisons; this binary has no ELF symbol table.

Analysis tools and derived segment files were kept outside the project in `/tmp/neonbyte-static-analysis` or the host tool cache. No project dependency was added. A standard-library verification procedure appears at the end of this report. The original file's SHA-256 was checked again after investigation.

## Binary Structure

All file offsets and range ends below are hexadecimal; range ends are exclusive. These are image offsets and declared memory addresses, not a measured flash map of the clock.

### Image Headers

| Field | Boot image at `0x0000` | Application at `0x1000` |
|---|---|---|
| Raw header | `E9 01 02 40 5C F4 10 40` | `E9 05 02 40 B8 00 10 40` |
| Format | ESP8266 E9 / version 1 | ESP8266 E9 / version 1 |
| Segments | 1 | 5 |
| Entry point | `0x4010F45C` | `0x401000B8` |
| Flash mode byte | `0x02`: DIO | `0x02`: DIO |
| Flash size/frequency byte | `0x40`: 4 MB / 40 MHz | `0x40`: 4 MB / 40 MHz |

Espressif defines the eight-byte header and address/length segment records in its [ESP8266 image-format documentation](https://docs.espressif.com/projects/esptool/en/latest/esp8266/advanced-topics/firmware-image-format.html). Flash frequency is not CPU frequency; declared capacity is not a flash-chip measurement. The headers establish an ESP8266 image target, not the installed module, display controller, pins, or board revision.

### Segments

| Image / segment | Segment header | Payload range | Length | Declared address | Interpretation |
|---|---|---|---|---|---|
| Boot / 0 | `0x000008` | `0x000010–0x000E10` | `0xE00` / 3,584 | `0x4010F000` | Boot code in instruction RAM |
| App / 0 | `0x001008` | `0x001010–0x06E05C` | `0x6D04C` / 446,540 | `0x40201010` | Flash-mapped code/data, IROM |
| App / 1 | `0x06E05C` | `0x06E064–0x06E168` | `0x104` / 260 | `0x40100000` | Instruction RAM |
| App / 2 | `0x06E168` | `0x06E170–0x0751B4` | `0x7044` / 28,740 | `0x40100104` | Instruction RAM |
| App / 3 | `0x0751B4` | `0x0751BC–0x075884` | `0x6C8` / 1,736 | `0x3FFE8000` | Initialized data RAM |
| App / 4 | `0x075884` | `0x07588C–0x077364` | `0x1AD8` / 6,872 | `0x3FFE86D0` | Initialized data RAM / constants |

Application IRAM payload totals 29,000 bytes; initialized DRAM payload totals 8,608 bytes. These totals exclude zero-initialized storage, stacks, heap, SDK allocations, and runtime buffers, so they do not establish available RAM or animation capacity.

The boot image ends after its checksum at `0xE1F`. Bytes `0xE20–0xFF8` are 472 bytes of `0xAA` padding. Two metadata words occupy `0xFF8–0x1000`. The application footer ends exactly at EOF, `0x77370`.

This organization matches the older Arduino ESP8266 [image assembly convention](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/tools/elf2bin.py#L165) and [eboot memory origin](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/bootloaders/eboot/eboot.ld#L7). It supports identifying the first image as eboot-style code, without proving an exact core version or an unmodified upstream bootloader. The SDK version string at file offset `0x7588C` is `2.2.2-dev(38a443e)`; the product string at `0x7610B` is `SD Pro V1.0.6`.

## Integrity Results

| Mechanism | Stored value / location | Independently calculated result |
|---|---|---|
| Boot segment XOR | `0xB0` at `0xE1F` | `0xB0`, valid |
| Application segment XOR | `0xA5` at `0x7736F` | `0xA5`, valid |
| Whole-image length | `0x00077370` at `0xFF8` | 488,304 bytes, matches EOF |
| Whole-image CRC | `0xCCC59B3F` at `0xFFC` | `0xCCC59B3F`, valid |

Each ESP8266 checksum starts with `0xEF` and XORs segment payload bytes; headers and inter-image padding are excluded. The boot checksum has 15 preceding zero padding bytes; the application checksum has 11. These results agree with Espressif's documented footer format. `image-info` on the entire file validates only the initial one-segment image. The separate application parse validates all five application payloads. Its IROM warning is reported by esptool when that flash-mapped segment is parsed as a standalone V1 image; its bounds, flash-address mapping, and checksum were independently checked.

The extra CRC starts with `0xFFFFFFFF`, processes bits MSB first with polynomial `0x04C11DB7`, and has no final XOR. Both metadata words at `0xFF8–0x1000` are treated as zero during calculation over the complete file. This exactly matches Arduino ESP8266 2.7.4's [CRC algorithm and insertion](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/tools/elf2bin.py#L103). Do not apply newer core metadata offsets at `0x1010/0x1014` to this artifact.

No bytes remain after the application checksum, so this artifact has no separate appended SHA-256 digest or Arduino-style signature trailer. XOR and CRC detect corruption; neither authenticates a publisher. The SHA-256 above is an investigation fingerprint, not an embedded integrity field.

The binary includes generic MD5 and signature-failure diagnostics at `0x6D7A4` and `0x6D784`. Their presence does not prove mandatory signed updates or a supplied expected MD5. The traced OTA callback does not configure either verifier. Generic upstream [Updater verification](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/Updater.cpp#L231) is conditional. Whether other initialization code enables a verifier remains **PENDING**. Likewise, a valid embedded CRC does not prove that every stock upload or boot path checks it; the upstream [runtime CRC function](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/Esp.cpp#L455) is distinct from the updater's header checks.

## Filesystem and Memory Layout

### Confirmed Build Configuration

The filesystem constructor at mapped address `0x402149F4` loads literals at file offsets `0x149C4–0x149D4`: `0x40300000`, `0xBFE00000`, `0x405FA000`, `0x100`, and `0x2000`. Its arithmetic subtracts the mapping base `0x40200000` and constructs a LittleFS instance with the following geometry. The EEPROM code also references `0x405FB000` at file offset `0x1DF78`.

| Region or setting | Binary-configured value | Meaning and limit |
|---|---|---|
| Code/update area boundary | Flash offset `0x100000` | Filesystem start used by free-sketch-space and updater code |
| LittleFS range | `0x100000–0x3FA000` | 3,121,152 bytes configured; not measured free space |
| Configured page / block | `0x100` / `0x2000` | 256 / 8,192 bytes; page value is not a demonstrated write granularity |
| Gap after filesystem | `0x3FA000–0x3FB000` | Outside configured filesystem; contents absent |
| EEPROM emulation base | Flash offset `0x3FB000` | Reference establishes a configured base, not contents or a decoded settings schema |
| Remaining flash tail | Above that base to declared `0x400000` | Device settings/SDK regions require a full dump and applicable SDK documentation |

These values exactly match the upstream [4m3m linker configuration](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/tools/sdk/ld/eagle.flash.4m3m.ld#L17), [flash address mapping](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/flash_hal.h#L33), and [LittleFS construction](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/libraries/LittleFS/src/LittleFS.cpp#L206). This identifies this binary's linked layout. It does not validate the physical flash size, installed layout, or a reusable PlatformIO board configuration. No ESP32-style partition table was identified or is needed to explain this ESP8266 layout.

### Filesystem Contents Are Missing

The update file ends at `0x77370`, before the linked filesystem begins. References include `/index.html`, `/indexkey.html`, `/indexwifi.html`, `/style.css`, `/javascript.js`, `/photo-setting.html`, `/photo_config.json`, `/theme_config.txt`, `/photo/`, `/ico/`, `/ico2/`, `/weather/`, and numbered GIF paths. These are referenced names, not extracted files. In particular, the stock updater's HTML/JavaScript and exact browser-side validation cannot be recovered from this application image alone.

binwalk finds the LittleFS source path at `0x6D156` and two apparent GIFs at `0x7709A` and `0x770A0`. The latter are adjacent null-terminated decoder comparison strings, `GIF89` and `GIF87`, not valid GIF headers or bundled animation files. Signature searches found no gzip or ZIP headers, and candidate zlib headers did not produce a complete valid stream. The two lowercase `littlefs` matches belong to program strings, not an extracted filesystem superblock. These negative scans support the structural result; they do not establish what the physical flash contains.

## OTA Implementation

### Route and Control Flow

The string `/update_ota` is at file offset `0x76340`. Registration at `0x4020F404–0x4020F42A` associates it with method value `3`, completion callback `0x402126B4`, and upload callback `0x40206E74`. Method and upload-state values agree with the upstream [ESP8266WebServer declarations](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/libraries/ESP8266WebServer/src/ESP8266WebServer.h#L34): POST, with start/write/end states `0/1/2`.

| Evidence address | Observed behavior | Assessment |
|---|---|---|
| `0x40206E9F–0x40206EAE` | Tests the upload filename against `SDP`; a false result prints the filename error | Case-sensitive prefix expectation, but no rejecting return or branch follows the error log |
| `0x40206EB1–0x40206ECA` | Calls free-sketch-space code, subtracts `0x1000`, masks with `0xFFFFF000`, then calls the updater with command `0` | Arduino-style `Update.begin((freeSpace - 0x1000) & 0xFFFFF000, U_FLASH)` |
| `0x40206EDF–0x40206EFA` | Adds current upload chunk size to updater progress; skips the write if greater than `0x80000`; otherwise calls the buffered writer | Nominal 512 KiB guard; no explicit size error is set on the skipped-write branch |
| `0x40206F3D–0x40206F45` | On upload-end state, calls updater end with argument `1` | Consistent with `Update.end(true)`, accepting the amount received rather than the initially reserved maximum |
| `0x402126E5–0x40212717` | Uses updater error state for HTTP 200/500, sends a restart message, delays, and calls restart | Completion attempts restart on either result; successful HTTP handling is not a boot test |

The prefix literal is at `0x75D65`; its diagnostic begins at `0x75D69`. The `startsWith` interpretation is supported by the wrapper at `0x40206D70` and prefix-comparison code at `0x40220950`. The important branch sequence is:

~~~text
0x40206EA4  call prefix comparison
0x40206EA7  branch on match to 0x40206EB1
0x40206EA9  load filename error text
0x40206EAE  call log output
0x40206EB1  continue into free-space calculation and Update.begin
~~~

There is no full fixed filename, extension check, version whitelist, model identifier check, configured expected MD5, or authentication call in this traced upload/completion sequence. This is a bounded static observation, not proof that no other code or browser layer imposes a requirement. The exact multipart form field, browser checks, and behavior of the installed firmware remain **PENDING**. No endpoint was probed.

### Upload Budget and Validation Limits

For a device actually running this exact image and linked map, the parsed sketch size rounds to `0x78000`. The filesystem boundary gives `0x88000` free sketch space, and the callback reserves `0x87000` bytes (552,960) for `Update.begin`. The upstream-style allocator then stages at `0x79000`. These are derived values corroborated by the binary's `0x4021E0E8`/`0x4021E160` size functions and `0x4021F730` allocator; they are not device measurements. Compare the upstream [sketch-space calculation](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/Esp.cpp#L582) and [updater allocation](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/Updater.cpp#L76).

The separate `0x80000` threshold is 524,288 bytes. The published image is 35,984 bytes below it. This threshold must not be treated as a proven, clean maximum upload size: upstream-style [progress accounting](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/Updater.h#L131) excludes buffered bytes, the callback silently skips a chunk beyond its guard, and it subsequently finalizes with `end(true)`. Oversized or interrupted transfers could therefore produce a partial staged image rather than a reliable rejection. That failure hypothesis has not been exercised.

Binary updater code and its diagnostics are consistent with checks for boot state, available staging space, existing flash configuration, a recognizable image header, and declared image flash capacity versus detected capacity. Generic upstream [final validation](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/cores/esp8266/Updater.cpp#L443) is not a board, display, filesystem, or application-compatibility test. It does not justify assuming that a valid XOR/CRC or a renamed file is safe to install.

## Custom NeonByte Compatibility

| Question | Conclusion |
|---|---|
| Could a custom image reach the stock updater? | Plausible for a compatible ESP8266 bootloader/application package; the traced path is generic and the prefix error alone does not reject it |
| Is a manufacturer signature demonstrated as mandatory? | No; the artifact has no appended signature, and signature diagnostics alone are insufficient. Initialization elsewhere remains unverified |
| Is renaming a file sufficient? | No; packaging, size, flash configuration, memory addresses, staging, and runtime hardware behavior still matter |
| Has NeonByte acceptance been established? | No device firmware has been built and no upload has been attempted; the later hardware-independent core is host-tested only |
| Would an accepted image boot and drive this clock? | PENDING: board/module, pins, power, display, flash capacity, and installed layout are unverified |
| Can the stock updater restore a failed custom image? | Not established; once replaced, the stock web server may no longer exist or run |

The two E9 images are bootloader plus application, not two application slots providing rollback. The traced use of `U_FLASH` and the upstream [eboot copy mechanism](https://github.com/esp8266/Arduino/blob/2843a5ace10eb696f19c9d754be7bbf6331046b5/bootloaders/eboot/eboot.c#L42) are consistent with staging followed by copying over the boot/application area. Treat protected rollback and power-loss recovery as **PENDING**, not features of this image.

## Installation Risks and Recovery Limitations

- **Bootloader replacement:** this update package includes boot code. A future image with incompatible boot conventions, entry points, headers, or copy behavior can eliminate the running updater. The on-chip ROM loader is separate; board access to it is unverified.
- **Filesystem overlap or reformatting:** the stock binary links a specific LittleFS geometry. A different linker map or automatic format-on-mount-failure behavior could overwrite web assets, animations, themes, or settings. Preserving offsets alone does not prove compatible filesystem versions or configuration formats.
- **Configuration migration:** EEPROM/Wi-Fi/settings content and field layouts are not included or decoded here. Reusing or overwriting those regions can break provisioning or expose saved credentials. Product activation/device-key references exist, but their persistence and recovery requirements remain unverified.
- **Capacity and transfer handling:** the nominal 512 KiB guard, buffered accounting, staging allocation, and `end(true)` behavior require controlled validation before any installation. Do not test their edge cases on the project unit.
- **Electrical and display compatibility:** a correct ESP8266 image says nothing sufficient about the board's boot straps, GPIO loading, display initialization, or power input. The candidate pin map remains unvalidated.
- **Interruption and rollback:** no working rollback or independently verified recovery path was established. A power failure during overwrite can leave the updater unavailable; a web upload route is not an emergency recovery interface.

This is an **update image, not a full-flash backup**. It includes initial boot/application bytes but stops at `0x77370`; a complete dump of the declared 4 MB address space would be 4,194,304 bytes. It omits the linked filesystem, EEPROM contents, flash tail, and unit-specific provisioning. Reinstalling this file alone cannot recreate erased filesystem assets or settings, and cannot prove restoration of the original device state. It is not a ROM bootloader dump either.

See [the recovery gate](recovery.md) before any later device work. The repository has neither a full backup of this unit nor a recovery procedure proven on an identical spare.

## Confirmed Findings Versus Open Hypotheses

**Confirmed from this file or repository metadata:** published-file identity; two bounded E9 images and their fields; valid XOR checksums; valid older Arduino whole-file length/CRC; no appended trailer; LittleFS-linked geometry and EEPROM base references; filesystem asset path references; OTA route registration and the control-flow observations above.

**Supported interpretations:** an older Arduino ESP8266/eboot-compatible build; generic application OTA using temporary staging; potential acceptance of a suitably packaged custom image; potential truncation risk from the upload guard and finalization sequence. The source comparison uses Arduino 2.7.4 as a pinned reference, not an identification of the exact manufacturer toolchain.

**PENDING:** the installed stock version, exact MCU/module and board revision, physical flash capacity, pinout, display configuration, actual filesystem contents and free space, EEPROM schema, all verifier initialization, browser-side validation, precise safe upload limits, successful custom boot, full backup, serial access, and tested restore/rollback. Hardware validation is not complete.

## Recommended Next Steps

1. Keep this binary unchanged and preserve its hash and pinned manufacturer reference. Keep all Phase 4 hardware-validation tasks open.
2. Obtain the project unit's label, board/module identification, and displayed stock version without invoking an update. Obtain vendor documentation tied to that revision.
3. Ask the manufacturer for matching filesystem assets, the exact stock updater constraints, configuration/activation preservation requirements, and full backup/recovery instructions.
4. After separate maintainer authorization, use an identical spare to identify safe UART/boot access and make two complete flash reads with matching hashes. Store backups securely outside version control.
5. Analyze those authorized backup files offline to recover the stock web assets, confirm filesystem geometry and settings boundaries, and inspect the complete verifier setup. Prove restoration on the spare before considering a custom firmware plan.
6. Only after evidence review and explicit approval, define a board-specific firmware package and test its boot, update, interruption, configuration preservation, and recovery behavior on the spare.

This report documents the static investigation and does not authorize a device-target build, flashing, OTA, erase, partition changes, or endpoint probing. Hardware-independent development is covered by [firmware development](firmware-development.md); physical validation and recovery remain pending.

## Investigation Validation

The documented Python procedure passed, independently confirming both image checksums, the length/CRC fields, the file bounds, and both artifact hashes. Separate esptool inspections agreed with both XOR results. At the time of the investigation, `npm run check` passed Markdown lint, the English-language check, eight root tests, the agent build/type checks, and 39 agent tests. Those repository checks do not validate the clock. An independent review found no material inconsistency in the reported disassembly or evidence boundaries. Hardware-specific Phase 4 tasks and recovery blockers remain open.

## Read-Only Verification Procedure

The following Python procedure reads the supplied file, prints the image records, and asserts the observed hashes, checksums, metadata, and final bounds. It does not execute or alter firmware and requires no third-party modules. Run it from the repository root.

~~~sh
python3 - <<'PY'
from pathlib import Path
import hashlib
import struct

imageBytes = Path("SDPro_V1.0.6_20260525_174828.bin").read_bytes()
expectedSha256 = "058e2ebcb9a35bc6a8c4e18a5441a26a88fae74d0e7684053a3bdea496cf529b"
assert hashlib.sha256(imageBytes).hexdigest() == expectedSha256
blobHeader = b"blob " + str(len(imageBytes)).encode("ascii") + b"\0"
assert hashlib.sha1(blobHeader + imageBytes).hexdigest() == "cfb5e12cafe4ce444f12cb06e41b14c8f8c58b03"

for imageOffset, expectedCount, expectedChecksum, expectedEnd in (
    (0, 1, 0xB0, 0xE20), (0x1000, 5, 0xA5, len(imageBytes))
):
    magic, count, mode, sizeFrequency, entry = struct.unpack_from("<BBBBI", imageBytes, imageOffset)
    assert (magic, count, mode, sizeFrequency) == (0xE9, expectedCount, 2, 0x40)
    position = imageOffset + 8
    checksum = 0xEF
    print("image", hex(imageOffset), "entry", hex(entry))
    for segmentIndex in range(count):
        address, length = struct.unpack_from("<II", imageBytes, position)
        position += 8
        assert position + length <= len(imageBytes)
        print("segment", segmentIndex, hex(position), hex(address), hex(length))
        for value in imageBytes[position:position + length]:
            checksum ^= value
        position += length
    checksumOffset = position | 15
    assert imageBytes[position:checksumOffset] == bytes(checksumOffset - position)
    assert imageBytes[checksumOffset] == checksum == expectedChecksum
    assert checksumOffset + 1 == expectedEnd
    print("checksum", hex(checksumOffset), hex(checksum), "valid")

assert imageBytes[0xE20:0xFF8] == b"\xAA" * 472
declaredLength, storedCrc = struct.unpack_from("<II", imageBytes, 0xFF8)
assert declaredLength == len(imageBytes) == 0x77370
crcInput = bytearray(imageBytes)
crcInput[0xFF8:0x1000] = bytes(8)
crc = 0xFFFFFFFF
for value in crcInput:
    crc ^= value << 24
    for bitIndex in range(8):
        crc = ((crc << 1) ^ (0x04C11DB7 if crc & 0x80000000 else 0)) & 0xFFFFFFFF
assert crc == storedCrc == 0xCCC59B3F
print("length", declaredLength, "CRC", hex(crc), "valid")
print("SHA-256", hashlib.sha256(imageBytes).hexdigest())
PY
~~~

For independent tool checks, run `esptool --chip esp8266 image-info` against the original and a temporary copy of bytes starting at `0x1000`; binwalk should use signature scanning without extraction. For the disassembly above, copy payload `0x1010–0x6E05C` to a temporary file and use `xtensa-lx106-elf-objdump -D -b binary -m xtensa --adjust-vma=0x40201010`, selecting the reported function addresses. These operations inspect files only.
