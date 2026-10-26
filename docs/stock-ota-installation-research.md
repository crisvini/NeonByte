# Wi-Fi-Only Stock OTA Installation Research

**Date:** 2026-10-26. **Scope:** public-source review and offline artifact inspection only. No installation implementation, firmware changes, target compilation, device contact, upload, flash, or clock modification occurred. Third-party source was examined as evidence; no implementation was incorporated into NeonByte.

## Conclusion

**Prefer a direct, uncompressed NeonByte image through the stock OTA interface as the future first-installation candidate. A bootstrap is unnecessary for the current size and would add another application replacement. Deployment remains blocked.**

The measured enabled NeonByte image is **352,304 bytes (344.05 KiB)**, 171,984 bytes below the nominal 524,288-byte stock guard. Its first 4 KiB are byte-for-byte identical to the published Mini-Display v0.3.0 bootstrap's boot region. That bootstrap uses the same modern Arduino CRC placement and is the project's documented stock-OTA entry point. This materially strengthens the packaging case; it does not prove acceptance by the installed stock version or successful NeonByte startup.

The necessary next implementation work concerns first-boot network reachability, filesystem independence, authenticated provisioning, and reviewed release packaging. Renaming today's provisional artifact is insufficient: it disables display activation and OTA, and initialization failures can prevent networking entirely. Neither examined project establishes recovery after an application fails to boot. Existing [hardware](hardware.md), [backup/recovery](recovery.md), and [planning](../PLANNING.md) gates remain in force.

## Evidence and Reproducibility

| Source | Pinned snapshot | Evidence level |
|---|---|---|
| [SmartClock AI](https://github.com/visued/smart-clock/tree/a86a31c31db3cec6189b65157566a66f4abe4fd0) | `a86a31c31db3cec6189b65157566a66f4abe4fd0`, default branch checked | Maintainer installation claim plus source/build-script review; no custom release binary available in the reviewed tree/releases |
| [Home Assistant Mini-Display](https://github.com/piotrkochan/homeassistant-minidisplay/tree/ae012e7a81d873692eb67dc606927c69ab16cf49) | `ae012e7a81d873692eb67dc606927c69ab16cf49`, default branch checked | Source/configuration, installation notes, release workflow, and downloaded artifacts |
| [Mini-Display v0.3.0](https://github.com/piotrkochan/homeassistant-minidisplay/releases/tag/v0.3.0) | Release source commit `bc476b5c0068793a7d6176e7a698e7278f8830fb` | Both binary hashes match release API digests; bootstrap source and both PlatformIO configurations match reviewed branch versions |
| NeonByte | Existing enabled artifact and [integration report](esp8266-integration.md) | Rechecked locally without rebuilding or executing firmware |
| Stock V1.0.6 | [Existing static analysis](stock-firmware-analysis.md) | Bounded disassembly/file evidence; installed version still unknown |

GitHub connector tools supplied pinned source and release metadata. Because the connector does not download binary files, the two public release binaries were downloaded directly from GitHub into `/tmp/neonbyte-ota-research/` for read-only inspection. Nothing was executed from either project. The existing NeonByte Python image inspector checked combined image boundaries, segment checksums, modern CRC, lengths, and SHA-256.

Measured SHA-256 values:

- Mini-Display bootstrap v0.3.0: `c2735cb8ca88dbfa4720b4d01abbcf43bdc84b2526e149e252ffaa6cca5353a0`.
- Mini-Display full v0.3.0: `d2eb41b334f369e3f1e4d50b1e0a83ce4b26469933c639b64309ab868578c7f6`.
- NeonByte enabled validation image: `7609711012073c175d813c5db1a1948524fa88981f5cce3b9c9f19df63735b91`.
- Common first-4-KiB SHA-256 for all three: `0ce1b495ac9a113bfdedadd7abce10fc1de2e551e517cc972dd0c451e0760e75`.

These fingerprints demonstrate file identity and packaging similarity, not successful installation on this unit. Installation success is reported by the upstream maintainers; no stock-to-bootstrap transaction for these downloaded bytes was independently observed.

## SmartClock AI: Direct Installation

The [README](https://github.com/visued/smart-clock/blob/a86a31c31db3cec6189b65157566a66f4abe4fd0/README.md) reports a tested SD PRO installation through the original browser updater and reuse of saved Wi-Fi. The [build script](https://github.com/visued/smart-clock/blob/a86a31c31db3cec6189b65157566a66f4abe4fd0/scripts/build.sh) builds the ordinary PlatformIO `firmware.bin` and copies it to `SDP_SmartClockAI_V1.0.0.bin`. It adds no manufacturer container, CRC conversion, appended signature, or bootstrap stage. This is source evidence for its packaging procedure, not an independent size/CRC measurement of its unpublished custom image.

Its [runtime](https://github.com/visued/smart-clock/blob/a86a31c31db3cec6189b65157566a66f4abe4fd0/firmware/src/main.cpp#L990) mounts LittleFS, initializes the display, and calls parameterless `WiFi.begin()`, which the [Arduino implementation](https://github.com/esp8266/Arduino/blob/3.1.2/libraries/ESP8266WiFi/src/ESP8266WiFiSTA.cpp#L236) uses to connect with SDK configuration. After approximately 15 seconds without station connectivity, it starts a fallback AP and serves its own unauthenticated `/update` service. This helps when the application boots but station Wi-Fi fails; it cannot recover a nonbooting application.

Its [PlatformIO configuration](https://github.com/visued/smart-clock/blob/a86a31c31db3cec6189b65157566a66f4abe4fd0/firmware/platformio.ini) leaves the platform and linker layout unpinned. Under the reviewed PlatformIO 4.2.1 `esp12e` manifest, the inherited layout would be 4m1m. `LittleFS.begin()` has no explicit autoformat disable. That combination must not be assumed to preserve a stock 4m3m filesystem. The fallback AP uses a publicly known fixed password; its security policy is unsuitable for NeonByte.

The README's stock-image restoration instructions require the replacement application and its updater still to work. They do not establish a full backup or independent recovery.

## Mini-Display: Temporary Bootstrap

The [installation guide](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/README.md#install-on-juzipi-sd-pro) requires the matching release bootstrap through stock OTA and prohibits sending the full firmware through that updater. The measured v0.3.0 full image is 941,232 bytes, exceeding the stock guard by 416,944 bytes; its bootstrap is 472,352 bytes, leaving 51,936 bytes below the guard.

The [bootstrap implementation](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/firmware-bootstrap/src/main.cpp) performs this sequence:

1. Initialize the display, clear its EEPROM configuration record, and start an AP/DNS setup portal. It requests Wi-Fi credentials rather than relying on stock SDK reuse. Its AP password is chip-ID-derived, not a cryptographically random secret.
2. Connect using credentials held in its own configuration. On success, save that configuration to EEPROM and enable installation of one compiled release version.
3. Stop the portal and download that release's full image from GitHub over HTTPS. Certificate validation is disabled; integrity/authenticity relies on the expected SHA-256 embedded in the bootstrap.
4. Stream to Arduino update staging while retaining the final byte. Check the complete download against the compiled digest. Retaining a byte prevents incomplete-update abort from finalizing a complete staged image before verification.
5. **Format LittleFS**, save the new EEPROM configuration, write the withheld byte, finalize the updater, and restart. Recoverable download/verification failures attempt to restart the portal while the bootstrap still runs.

The [release workflow](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/.github/workflows/release.yml) builds the full image first, hashes it, and compiles that specific digest/version into the bootstrap. This links the installer to one release; the bootstrap is then replaced by the full application. It is **not a permanently retained rescue image**.

Both profiles use 4m2m. Clearing/saving EEPROM at startup overwrites the record region, and formatting the new filesystem destroys overlapping stock data. Those operations conflict with NeonByte's preservation goal. The full application's [settings code](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/firmware/src/DeviceSettings.cpp) recognizes its own current/legacy layouts, not a decoded stock configuration schema.

## Platform and Hardware Comparison

| Setting | SmartClock AI | Mini-Display SD PRO / bootstrap | NeonByte |
|---|---|---|---|
| Platform / framework | Unpinned espressif8266 / Arduino | espressif8266 4.2.1 / Arduino 3.1.2 | Same pinned platform/core |
| Board manifest | esp12e | esp12e | esp12e, provisional |
| CPU / flash | 80 MHz CPU; DIO; manifest flash defaults | 160 MHz CPU; DIO, 40 MHz, declared 4 MB | 80 MHz CPU; DIO, 40 MHz, declared 4 MB |
| Linker layout | Inherited; 4m1m under reviewed manifest | Explicit 4m2m | Explicit 4m3m |
| Display library | TFT_eSPI | TFT_eSPI | Adafruit ST7789/GFX |
| MOSI / clock / DC / reset / backlight | 13 / 14 / 0 / 2 / 5 | Same | Same provisional pins |
| Display CS | GPIO15 | No CS | No CS, provisional |
| Display speed / color | 40 MHz SPI; BGR | 40 MHz SPI; BGR and inversion enabled | 20 MHz SPI; BGR, inversion, rotation 0; mode 3 |
| Future update service | Generic `/update`, unauthenticated | Own panel/API updater | Bearer-authenticated `/api/v1/firmware`, disabled in provisional artifact |

Sources: [SmartClock configuration](https://github.com/visued/smart-clock/blob/a86a31c31db3cec6189b65157566a66f4abe4fd0/firmware/platformio.ini), [Mini-Display configuration](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/firmware/platformio.ini), [bootstrap configuration](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/firmware-bootstrap/platformio.ini), and [NeonByte integration](esp8266-integration.md).

Shared MCU identification and several matching pins do not reconcile the CS discrepancy or validate this unit's controller, boot straps, polarity, offsets, or SPI timing. Keep the existing researched no-CS profile provisional rather than adopting SmartClock's GPIO15 setting from its product-family claims.

## Image, CRC, and Stock Acceptance

| Artifact | Bytes | Boot / application | Length and CRC metadata |
|---|---:|---|---|
| Stock V1.0.6 | 488,304 | E9 at 0 and `0x1000`; one/five segments | `0xFF8` / `0xFFC` |
| Mini-Display bootstrap v0.3.0 | 472,352 | E9 at 0 and `0x1000`; two/five segments | `0x1010` / `0x1014`; CRC `0x6B02BA72` |
| Mini-Display full v0.3.0 | 941,232 | Same modern structure | Same modern offsets; CRC `0x424B573E` |
| NeonByte enabled artifact | 352,304 | Same modern structure | Same modern offsets; CRC `0xCCEB8BA5` |

The three modern images have identical boot headers (`e9 02 02 40 80 f4 10 40`), identical first 4 KiB, boot entry `0x4010F480`, application entry `0x401000C0`, and DIO/40 MHz/4 MB declarations. All inspected segment checksums and modern whole-image CRCs validate. Modern segment-XOR checking accounts for the post-generation length/CRC patch described in [NeonByte's integration report](esp8266-integration.md).

**Inference:** for a stock updater matching the analyzed V1.0.6 behavior, NeonByte's format and size are plausible direct inputs. A bootstrap is not needed merely to convert old CRC metadata into modern metadata: Mini-Display's documented stock-install artifact already uses the same modern boot region and CRC placement as NeonByte. Do not patch NeonByte's metadata into the old offsets or transplant stock boot code without a demonstrated need.

The independently reviewed [Arduino 2.7.4 updater](https://github.com/esp8266/Arduino/blob/2.7.4/cores/esp8266/Updater.cpp#L427) checks image magic and declared flash capacity; its final header checks do not require old CRC offsets. This supports the generic-update interpretation, but is not identification of every installed manufacturer check. Stock verifier initialization and browser assets remain incomplete evidence. Acceptance by this particular clock is **PENDING**.

### Filename and Request Envelope

Mini-Display's [reverse-engineering notes](https://github.com/piotrkochan/homeassistant-minidisplay/blob/ae012e7a81d873692eb67dc606927c69ab16cf49/notes/reverse-engineering.md) report stock `POST /update_ota`, multipart field `update`, and a browser check for a case-sensitive `SDP` prefix. Both projects distribute or prepare names with that prefix. NeonByte's earlier disassembly found that the backend prefix failure logs and continues; those findings describe different validation layers and are compatible.

A future artifact should therefore retain the complete combined image and use a descriptive name such as `SDP-NeonByte-<version>.bin`, with its hash unchanged by renaming. The stock browser's multipart upload is distinct from NeonByte's later raw authenticated PUT route. There is no evidence of a required fixed model filename, manufacturer wrapper, or mandatory signature in the traced callback; exact browser rules, installed firmware checks, and verifier initialization remain unverified. Never infer that naming alone makes an image safe, or rely on the stock guard to reject oversized/incomplete input cleanly.

## Flash, LittleFS, and Credentials

The [4m1m](https://github.com/esp8266/Arduino/blob/3.1.2/tools/sdk/ld/eagle.flash.4m1m.ld), [4m2m](https://github.com/esp8266/Arduino/blob/3.1.2/tools/sdk/ld/eagle.flash.4m2m.ld), and [4m3m](https://github.com/esp8266/Arduino/blob/3.1.2/tools/sdk/ld/eagle.flash.4m3m.ld) linker scripts distinguish filesystem placement from the app's approximately 1 MiB mapped-code limit:

| Layout | Filesystem flash offsets | OTA space consequence |
|---|---|---|
| Stock-researched / NeonByte 4m3m | `0x100000–0x3FA000` | Running sketch and staged update share space below 1 MiB |
| Mini-Display 4m2m | `0x200000–0x3FA000` | More staging space below 2 MiB, enabling its larger full image after bootstrap |
| SmartClock inherited 4m1m, conditional on manifest | `0x300000–0x3FA000` | Different mount/format range, not stock filesystem compatibility |

All three scripts place EEPROM emulation at `0x3FB000`, RF calibration at `0x3FC000`, and SDK Wi-Fi sectors at `0x3FD000–0x400000`. These are linked locations, not a physical flash measurement. For the measured full image, the 4m2m allocator would stage 942,080 rounded bytes at `0x11A000–0x200000`, inside the old stock filesystem range. This derived overlap exists before the explicit format and before download SHA-256 acceptance; a failed download can therefore still leave stock data changed. SmartClock's possible new mount range and default formatting behavior also prevent treating its reported successful boot as evidence of stock-data preservation.

The upstream Arduino 2.7.4 reference vendors [LittleFS 2.2](https://github.com/littlefs-project/littlefs/blob/a049f1318eecbe502549f9d74a41951985fb956f/lfs.h#L24), while Arduino 3.1.2 vendors [LittleFS 2.5](https://github.com/littlefs-project/littlefs/blob/6a53d76e90af33f0656333c1db09bd337fa75d23/lfs.h#L25). Both declare on-disk format `0x00020000` (2.0). This removes an assumed mandatory disk-format-major conversion from the upstream comparison; it does not identify the exact stock library or prove this unit's volume mounts correctly. No evidence justifies automatic reformatting as a compatibility step.

NeonByte's unchanged 4m3m boundaries and disabled autoformat are preferable for preservation, but mounting and writing still require verified filesystem-version/geometry compatibility. Namespacing prevents application-level filename collisions; it does not freeze filesystem metadata or repair corruption. Its 32 KiB reserve can also prevent initial configuration on a nearly full stock volume. No project supplies a complete backup of this unit.

Stock SDK credentials, EEPROM settings, and filesystem configuration are separate persistence layers. SmartClock attempts SDK reuse. Mini-Display replaces its EEPROM record and requests credentials again. NeonByte currently leaves SDK persistence disabled, uses `/neonbyte/config.bin`, and intentionally does not import stock credentials. Preserving SDK sectors does not automatically connect its present code to the old network or preserve vendor activation/settings semantics.

## Recommended Approach and Necessary Changes

**Architectural recommendation:** keep one NeonByte application and plan a direct stock OTA first install after the existing gates are satisfied. Keep the current 4m3m geometry, normal combined Arduino image, strict NeonByte updater, native environment, and transport/storage/display interfaces. A temporary bootstrap should be reconsidered only if a future artifact exceeds the demonstrated stock budget or requires a separately approved storage migration. It would still not provide independent boot recovery.

Before any installation process is implemented, approve a design addressing:

- **Network startup independent of storage/display:** establish a bounded Wi-Fi attempt and a usable authenticated provisioning/update mode even if LittleFS cannot mount, configuration is invalid/full, or display initialization is unavailable. Current `setup()` returns before HTTP on storage/configuration failure; both current artifacts are unsuitable as first-install releases. The updater also depends on LittleFS staging, so keeping HTTP alive alone is insufficient: a filesystem-independent maintenance update path needs its own design with integrity checked before activation.
- **Explicit credential policy:** optionally attempt SDK Wi-Fi reuse without writing SDK settings, then fall back to provisioning. Define secure pairing and delivery of the operator's setup secret without depending exclusively on a working LCD or valid filesystem. Avoid the other projects' publicly known or chip-ID-derived AP passwords. No new secret belongs in Git, logs, public release metadata, or API responses.
- **Controlled first-boot persistence:** keep autoformat disabled, preserve EEPROM/SDK areas, do not migrate undocumented vendor records, and reject incompatible/insufficient storage without losing networking. Define how nonpersistent setup credentials and pairing survive or are safely reestablished after a reset before configuration can be saved.
- **Separate reviewed installation profile/package:** enable future authenticated OTA and only the validated display profile, retain local deployment guards until separately authorized, pin versions, publish exact image length/hash/profile/format in a non-secret manifest, and enforce a conservative size margin below 512 KiB. No app-only extraction, gzip, legacy CRC patch, partition migration, or filesystem payload is currently necessary.
- **Offline and later spare-unit validation:** add host fault/scheduler tests for these startup paths, then propose separately authorized spare-unit tests. Recheck artifact geometry, CRC, size, and memory after changes. Do not relax bearer authentication or import third-party firmware implementations to obtain an installer.

Likely implementation touchpoints, if separately approved, are [startup](../firmware/src/esp8266/main.cpp), [persistent storage](../firmware/src/esp8266/storage.cpp), [HTTP/OTA handling](../firmware/src/esp8266/http_server.cpp), [display initialization](../firmware/src/esp8266/display.cpp), [build profiles](../firmware/platformio.ini), and a new release-packaging/manifest step. Keep those adapters around the existing core rather than importing either project's installer.

These are proposed requirements, not implemented changes or authorization to remove the current safety gates.

## Realistic Failure Modes

| Trigger | Consequence under Wi-Fi-only constraints |
|---|---|
| Stock variant rejects naming, envelope, header, size, or verifier policy | Upload rejection or unsafe partial staging; clean rejection is not guaranteed by the old guard |
| Power loss during boot/application copy, bad boot image, crash/reset loop before networking | No running updater; permanent loss of software-only recovery is possible |
| Display GPIO/boot strap error or driver hang | Application may fail before Wi-Fi; matching eboot bytes cannot prevent this |
| LittleFS mount/configuration failure or insufficient free space | Current NeonByte never starts HTTP; adding autoformat would risk destroying stock data |
| Lost/mismatched SDK credentials or inaccessible setup secret | No usable station or authenticated AP workflow until a functioning fallback exists |
| Bootstrap download failure | A still-running bootstrap can retry; this does not restore stock firmware, and EEPROM/overlapping stock filesystem data may already have changed |
| Bootstrap filesystem format or 4m2m staging | Stock filesystem data can be destroyed; reinstalling the vendor application does not restore it |
| Successful OTA response followed by failure on reboot | HTTP success proves transfer/finalization only; the replaced stock updater is no longer an independent fallback |

Published replacement firmware, fallback APs, a copy of the manufacturer's application binary, and OTA staging are not equivalent to a unit-specific full backup or protected rollback. Neither examined source establishes a protected Wi-Fi rescue service that survives a bad replacement application.

## Proposed Installation-Validation Checklist

This is a proposal for review. It authorizes no current device interaction.

- [ ] Preserve the installed stock version, confirmed board/module information, physical capacity/layout evidence, and any vendor documentation obtained through separately authorized means.
- [ ] Resolve the existing full-backup and independent Wi-Fi-only boot-recovery gate. If no qualifying method exists, remain blocked; proceeding would require an explicit maintainer decision to change that requirement and accept possible irreversible loss of software-only access.
- [ ] Complete and host-test the independent startup/provisioning design, including bad/full/unmountable storage, invalid configuration, missing display, absent saved Wi-Fi, and interrupted configuration persistence.
- [ ] Freeze one reviewed direct-install candidate; verify uncompressed combined E9 structure, DIO/40 MHz/confirmed capacity, CRC, SHA-256, conservative size margin, exact linker geometry, enabled authenticated future updates, and `SDP` packaging.
- [ ] Demonstrate stock browser/envelope acceptance and first boot on an identical spare under separate authorization, without UART or physical programming. Confirm station/AP access before relying on LCD output.
- [ ] Compare stock filesystem/settings/SDK credentials against a protected pretest backup and the approved preservation policy; do not format or infer preservation from a successful screen.
- [ ] Validate pairing, changed/missing Wi-Fi, reboot persistence, display colors/orientation/backlight, streamed playback, API responsiveness, memory/stack, and a future authenticated NeonByte update on the spare.
- [ ] Use offline fault injection first. Do not deliberately power-cut or install nonbooting firmware on the project unit to test an unproven recovery hypothesis.
- [ ] Obtain explicit approval for any installation procedure and a separate approval for any actual device operation after evidence review.

## Validation and Stop Boundary

Only this report and documentation cross-references are changed. Public artifact hashes and offline image checks passed. `npm run check` and `git diff --check` passed after the documentation update. No firmware was rebuilt, copied into NeonByte, or deployed; no third-party implementation was adopted. Hardware/recovery tasks remain PENDING, and no later phase begins.

**Stop for maintainer review. Direct installation is the recommended candidate, not an approved procedure.**
